/**
 * dsh-loom · 宿主半边入口
 *
 * ── 这个插件做什么 ─────────────────────────────────────────────────────
 * 把软件项目拆成一张可编辑的节点图，再把图确定性地编译成可执行的批次脚本。
 * 两种模式共享同一份方案：
 *   自动  选资料 → 提示词 → AI 架构回答 → 校验成图 → 用户改图 → 回传优化
 *   手动  空白/模板/自动初排 → 手改 → 导出提示词或任务包
 *
 * 三层数据**分开**存：架构（允许环）/ 开工任务（必须 DAG）/ 运行事实。
 *
 * ── 四条纪律（每条都有出处）─────────────────────────────────────────────
 *   1. **顶层 `inject` 留空**。cordis 的 Context 是受控代理，没写进 `inject`
 *      的服务用 `ctx.X` 访问会直接抛；`ctx.get(name)` + try/catch 更安全，
 *      非 Web 组合（CLI / headless）也能激活。
 *   2. **Web 路由走子插件 + `effect`**，让 cordis 管等待、服务重建与清理。
 *   3. **家目录只认 `DSH_HOME`**，不从 profile 目录往上推。
 *   4. **非关键 IO 吞异常；关键写入必须可见。** 事件日志可以失败，
 *      revision / 授权 / 集成事实不行 —— 不照搬「所有 IO 都吞」。
 */
import { DEFAULT_CONFIG, PACKAGE_NAME, VERSION, normalizeConfig, resolveDshHome } from './config.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LoomWorktreeProvider } from './provider.js';
import { loadHostHelpers } from './host-helpers.js';
import { IsolatedTaskRuntime, createHostDispatcher } from './runtime.js';
import { toolWorkspace } from './workspace.js';
import { requestWorkspace, requestSessionExists } from './workspace.js';
import { ExecutionJournal } from './execution.js';
import { createRequire } from 'node:module';
import { LoomStore } from './store.js';
import { PlanningController } from './planning.js';
import { createTools } from './tools.js';
import { createHandler } from './http.js';
import { installRemote } from './remote.js';
import { installInjection } from './inject.js';
import { createWorktreeManager } from './worktree.js';
import { readScmFacts } from './scm.js';
import { toHostPath } from './bridge.js';
import { registerCommands } from './commands.js';
import { compileFlowSchedule, FLOW_MAX_AGENTS, knownCapabilities, normalizeWorkspaceId } from './core/index.js';
export { PACKAGE_NAME, VERSION };
/** 顶层 inject 故意留空。见纪律 1。 */
export const inject = [];
function requireService(ctx, name) {
    try {
        return ctx.get?.(name) ?? null;
    }
    catch {
        return null;
    }
}
function makeLogger(level = 'info') {
    const rank = { debug: 10, info: 20, warn: 30, error: 40 };
    const min = rank[level] ?? 20;
    const make = (name, fn) => (...args) => {
        if ((rank[name] ?? 20) < min)
            return;
        try {
            fn('[loom]', ...args);
        }
        catch {
            /* 日志不许影响主流程 */
        }
    };
    return {
        debug: make('debug', console.debug.bind(console)),
        info: make('info', console.info.bind(console)),
        warn: make('warn', console.warn.bind(console)),
        error: make('error', console.error.bind(console)),
    };
}
export function apply(ctx, config = {}) {
    const home = resolveDshHome();
    const fromPatch = normalizeConfig(config, DEFAULT_CONFIG);
    const log = makeLogger(fromPatch.logLevel);
    let current = fromPatch;
    const getConfig = () => ({ ...current });
    const setConfig = (patch) => {
        current = normalizeConfig(patch, current);
        runtime?.budget.setLimit(current.defaultMaxConcurrency);
        if (!current.enabled)
            void runtime?.cancelAll().catch(error => log.warn(`停用取消未完成：${String(error)}`));
        writeInstallationStatus();
        return getConfig();
    };
    let store;
    try {
        store = new LoomStore(home, { eventLog: current.eventLog });
    }
    catch (error) {
        // 数据层起不来就停用插件，但**不抛出去** —— 宿主必须能正常启动。
        log.error(`存储初始化失败，插件停用：${error?.message ?? error}`);
        return { status: () => ({ ok: false, data: { error: String(error?.message ?? error) } }) };
    }
    /**
     * 能力探测：当前实现读 P0 实测的静态表（见 docs/compatibility-report.md）。
     * 真实引擎探测需要宿主把 provider 列表暴露出来；拿不到时**不猜**，
     * 如实返回 unknown / false。
     */
    const instanceId = randomUUID();
    let toolCount = 0, commandsReady = false, remoteReady = false, routesReady = false;
    const statusFile = join(store.paths.root, 'installation-status.json');
    const writeInstallationStatus = (active = true) => {
        try {
            if (!active && existsSync(statusFile) && JSON.parse(readFileSync(statusFile, 'utf8')).instanceId !== instanceId)
                return;
            writeFileSync(statusFile, JSON.stringify({ instanceId, package: PACKAGE_NAME, version: VERSION, active,
                at: new Date().toISOString(), pid: process.pid, platform: process.platform, entry: import.meta.url,
                enabled: current.enabled, tools: toolCount, commands: commandsReady, remote: remoteReady, routes: routesReady,
                provider: providerReady, dataRoot: store.paths.root, modelAcceptance: false }, null, 2) + '\n');
        }
        catch (error) {
            log.warn(`安装状态记录失败：${String(error)}`);
        }
    };
    let providerReady = false;
    let providerProbedAt = null;
    const capabilities = () => {
        const probe = requireService(ctx, 'loomCapabilityProbe');
        try {
            if (typeof probe === 'function')
                return probe();
        }
        catch (error) {
            log.warn(`能力探测失败，回退到静态表：${error?.message ?? error}`);
        }
        const baseline = knownCapabilities();
        if (!providerReady)
            return baseline;
        const at = providerProbedAt;
        const fact = (key) => ({
            ...baseline[key], implementedByLoom: true, availableInEnv: true,
            evidence: [...baseline[key].evidence, { kind: 'probe', where: `${process.platform} host + Loom provider registration + public helper checks`, at }],
            limits: ['当前进程已接线；真实模型调用尚未在本次部署中验收'],
        });
        return { ...baseline, probedAt: at, parallel: fact('parallel'), realParentAgent: fact('realParentAgent'),
            cancel: fact('cancel'), worktreeIsolation: fact('worktreeIsolation'), wslExecution: fact('wslExecution'), perCallCwd: fact('perCallCwd') };
    };
    current = store.readConfig(fromPatch);
    const planningServices = new Map();
    const planning = new PlanningController(store, getConfig, name => planningServices.get(name) ?? null);
    for (const name of ['planMode', 'agents'])
        ctx.inject([name], (scope) => { const service = scope.get(name); planningServices.set(name, service); scope.effect(() => () => { if (planningServices.get(name) === service)
            planningServices.delete(name); }, 'loom.planning-' + name); });
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => { const assembled = await next(); const agent = context?.agent, id = agent?.session?.id; if (!id || !planning.held(id, agent))
        return assembled; return { ...assembled, sections: [...assembled.sections.filter((section) => section.name !== 'plan:policy'), { name: 'loom:planning-policy', interpolate: false, text: 'You are in Loom planning mode. Read-only research is allowed. Use the submission tool specified by the current request: loom_submit_plan for a full plan, or loom_resolve_questions for compact preflight answers. Resolve technical uncertainty through read-only research, conservative assumptions and explicit task verification; reserve human questions for scope, authorization or unavoidable blockers. Display the readable proposal, then stop. The human edits the same plan in Loom and approves its current version before implementation. Do not call exit_plan_mode, write, run shell commands or delegate. Turning planning off or accepting a candidate is not approval.' }] }; });
    const isSessionActive = (agent) => {
        const id = agent?.session?.id ?? agent?.session?.header?.id;
        return typeof id === 'string' && store.readSessionActivation(id);
    };
    const scmFacts = (cwd, sessionId) => readScmFacts(store, cwd, sessionId);
    const sessionResolvers = (serviceCtx) => ({
        resolveWorkspace: (req) => requestWorkspace(req, requireService(serviceCtx, 'sessionQuery')),
        // sessionId 的判据是「宿主认这个会话」，**不是**「它已经有 cwd」。
        // 会话态开关（规划模式/总开关）在新对话里就得能用 —— 那时还没有工作区。
        resolveSessionId: (req) => requestSessionExists(req, requireService(serviceCtx, 'sessionQuery')),
        resolveSessionCwd: async (req) => {
            const query = requireService(serviceCtx, 'sessionQuery');
            const id = req.headers?.['x-loom-session'];
            if (typeof id !== 'string' || !await requestWorkspace(req, query))
                return null;
            const snapshot = await query.readTitleSnapshot(id);
            return typeof snapshot?.session?.cwd === 'string' ? snapshot.session.cwd : null;
        },
        scmFacts, planning,
    });
    const diagnostics = () => {
        let installedVersion = null, hostVersion = null;
        try {
            installedVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
        }
        catch { }
        try {
            if (process.argv[1])
                hostVersion = createRequire(process.argv[1])('@deepseek-ai/dsh/package.json').version;
        }
        catch { }
        let executions, executionError = null;
        try {
            executions = new ExecutionJournal(store.paths.root).list();
        }
        catch (error) {
            executionError = String(error.message);
        }
        return { installedVersion, loadedVersion: VERSION, hostVersion, instanceId, platform: process.platform,
            services: { provider: providerReady, commands: commandsReady, remote: remoteReady, routes: routesReady, tools: toolCount },
            execution: { healthy: !executionError, error: executionError, recordedRuns: executions?.length ?? null },
            recommendations: [...(installedVersion && installedVersion !== VERSION ? ['安装与运行版本不同，请完全退出并重新打开 Harness'] : []), ...(executionError ? ['执行记录校验失败，保留原文件后诊断；不能当作没有历史运行'] : [])] };
    };
    const deps = { store, getConfig, log, capabilities, diagnostics };
    /**
     * 工作树管理器。懒建：只有真正要跑隔离任务时才碰磁盘与 git。
     * 构造本身不执行任何 git 命令，所以放在这里是安全的。
     */
    let worktrees = null;
    const getWorktrees = () => {
        if (worktrees === null) {
            worktrees = createWorktreeManager({ paths: store.paths, log });
        }
        return worktrees;
    };
    Object.assign(deps, { getWorktrees });
    let runtime = null;
    const registerProvider = (providerCtx) => {
        // Windows children use native UNC file access and their own public WSL ShellExecutor.
        if (process.platform !== 'win32' && (process.platform !== 'linux' || !/microsoft/i.test(readFileSync('/proc/sys/kernel/osrelease', 'utf8'))))
            return;
        const subagents = requireService(providerCtx, 'subagents');
        if (!subagents?.registerProvider || !subagents?.start)
            return;
        try {
            const helpers = loadHostHelpers();
            providerCtx.effect(() => {
                const dispose = subagents.registerProvider(new LoomWorktreeProvider({ paths: store.paths, helpers, log, resolveExecutionRepo: parent => {
                        const cwd = parent.session.header.cwd, id = parent.session.id, ws = normalizeWorkspaceId(cwd);
                        const selected = id && ws ? store.readExecutionTarget(id, ws) : null;
                        return selected ? toHostPath(selected) : null;
                    } }));
                providerReady = true;
                providerProbedAt = new Date().toISOString();
                writeInstallationStatus();
                return () => { providerReady = false; dispose?.(); };
            }, 'loom.provider');
            runtime ??= new IsolatedTaskRuntime(store, getWorktrees(), current.defaultMaxConcurrency);
            // A lock-proven cold interruption must be visible before the user tries recovery.
            const recovery = runtime.recoverInactiveRuns().catch(error => log.warn(`执行状态核对：${String(error.message)}`));
            providerCtx.effect(() => () => recovery, 'loom.cold-execution-status');
            Object.assign(deps, { runWorkflow: async (workflow, exec, args) => {
                    if (!providerReady || !runtime || !exec?.agent)
                        throw new Error('RUNTIME_UNAVAILABLE: 必须由真实 Harness Agent 调用');
                    if (!current.enabled || !isSessionActive(exec.agent))
                        throw new Error('LOOM_DISABLED: 总开关或本会话已停用');
                    const ws = toolWorkspace(exec);
                    if (!ws)
                        throw new Error('WORKSPACE_UNRESOLVED');
                    const facts = await scmFacts(exec.agent.session.header.cwd, exec.agent.session.id);
                    if (facts.dirty || facts.head !== String(args.baseSha ?? ''))
                        throw new Error('BASELINE_CHANGED: 请重新审核项目基线');
                    const approvedPlan = planning.consume(exec.agent, ws, workflow, String(args.baseSha ?? ''));
                    const plan = store.readFlowPlan(ws, workflow.workflowId);
                    // 宿主侧并发上限：与流程视图下拉、任务图 schema 用同一个常量
                    // （实测依据见 flow-plan.ts 的 FLOW_MAX_AGENTS 注释与
                    // .verification/subagent-limit-probe.json）。
                    const compiled = plan ? compileFlowSchedule(workflow, plan, FLOW_MAX_AGENTS) : null;
                    if (compiled && !compiled.ok)
                        throw new Error('FLOW_INVALID: ' + compiled.errors.map(e => e.path + ': ' + e.message).join('; '));
                    const schedule = compiled?.schedule ?? null;
                    return runtime.run(workflow, toHostPath(facts.repo), ws, String(args.baseSha ?? ''), createHostDispatcher(subagents, exec.agent), { sessionId: exec.agent.session.id, approvedPlan, signal: exec.signal, runId: args.runId, maxConcurrency: current.defaultMaxConcurrency, maxRepairRounds: current.maxRepairRounds, recoveryOf: args.recoveryOf, ...(schedule ? { schedule } : {}) });
                } });
        }
        catch (error) {
            log.warn(`WSL provider 未启用：${error.message}`);
        }
    };
    try {
        ctx.inject(['subagents'], registerProvider);
    }
    catch (error) {
        log.warn(`provider 订阅失败：${String(error)}`);
    }
    /* ---------------- 工具 ---------------- */
    const registerTools = (toolCtx) => {
        const tools = requireService(toolCtx, 'tools');
        if (!tools?.register)
            return;
        if (typeof tools.guard === 'function') {
            tools.guard((exec) => planning.guard(exec));
            planning.guardReady = true;
        }
        Object.assign(deps, { planning });
        let registered = 0;
        for (const definition of createTools(deps)) {
            try {
                const execute = definition.execute;
                tools.register({ ...definition, execute: async (args, exec) => {
                        if (!['loom_status', 'loom_capabilities'].includes(String(definition.name)) &&
                            (!current.enabled || (exec?.agent && !isSessionActive(exec.agent))))
                            throw new Error('LOOM_DISABLED: 总开关或本会话已停用');
                        return execute(args, exec);
                    } });
                registered += 1;
            }
            catch (error) {
                // 单个工具注册失败不该拖垮其余工具。
                log.warn(`工具 ${String(definition.name)} 注册失败：${error?.message ?? error}`);
            }
        }
        toolCount = registered;
        writeInstallationStatus();
        log.info(`已注册 ${registered} 个工具`);
    };
    /* ---------------- 注入 ---------------- */
    let uninstallInjection = null;
    try {
        if (typeof ctx.on === 'function')
            uninstallInjection = installInjection(ctx, { store, getConfig, isSessionActive, planning, log });
    }
    catch (error) {
        log.warn(`草案摘要注入挂载失败（工具仍可用）：${error?.message ?? error}`);
    }
    /* ---------------- HTTP ---------------- */
    const mountRoutes = (routeCtx) => {
        const webServer = requireService(routeCtx, 'webServer');
        if (!webServer?.register)
            return;
        routesReady = true;
        writeInstallationStatus();
        return routeCtx.effect(() => webServer.register({
            kind: 'prefix',
            path: '/loom',
            handler: createHandler({
                store,
                getConfig,
                setConfig,
                capabilities,
                getWorktrees,
                diagnostics,
                /**
                 * 归属解析器。评审 09 F：**只看 webServer 提供的会话事实**，
                 * 不看 URL 参数。宿主没给上下文时返回 null，HTTP 层据此拒绝写入。
                 */
                ...sessionResolvers(routeCtx),
                log,
            }),
        }), 'loom.routes');
    };
    try {
        ctx.inject(['typert', 'sessionQuery'], (remoteCtx) => {
            try {
                installRemote(remoteCtx, { store, getConfig, setConfig, capabilities, getWorktrees, diagnostics,
                    ...sessionResolvers(remoteCtx), log });
                remoteReady = true;
                writeInstallationStatus();
            }
            catch (error) {
                log.warn(`宿主 Remote 数据面未挂载：${String(error)}`);
            }
        });
        ctx.inject(['tools'], registerTools);
        ctx.inject(['commands'], (commandCtx) => {
            registerCommands(commandCtx, { store, getConfig, scmFacts, planning, log,
                runWorkflow: async (workflow, exec, args) => {
                    const run = deps.runWorkflow;
                    if (!run)
                        throw new Error('RUNTIME_UNAVAILABLE: 当前宿主没有可用的隔离执行通路');
                    return run(workflow, exec, args);
                },
                cancelRun: async (id) => runtime ? runtime.cancel(id) : false, });
            commandsReady = true;
            writeInstallationStatus();
        });
        ctx.inject(['webServer', 'sessionQuery'], mountRoutes);
    }
    catch (error) {
        log.warn(`服务订阅失败：${error?.message ?? error}`);
    }
    ctx.effect?.(() => () => runtime?.cancelAll(), "loom.runtime");
    ctx.effect?.(() => {
        const timer = setTimeout(() => writeInstallationStatus(), 250);
        return () => { clearTimeout(timer); writeInstallationStatus(false); };
    }, 'loom.installation-status');
    const stats = store.stats();
    store.event({
        kind: 'ready',
        detail: `host ${VERSION} · revision ${stats.revisions} · 架构 ${stats.architectures} · 事件 ${stats.events}`,
    });
    log.info(`已挂载：revision ${stats.revisions} 条 · 架构 ${stats.architectures} 条 · 数据目录 ${store.paths.root} · 注入=${current.injectDraftSummary ? '开' : '关'}`);
    return {
        /** 给宿主/测试看的只读快照。 */
        status: () => ({
            ok: true,
            data: {
                package: PACKAGE_NAME,
                version: VERSION,
                home,
                config: getConfig(),
                capabilities: capabilities(),
                stats: store.stats(),
                paths: store.paths,
            },
        }),
        dispose: () => {
            try {
                uninstallInjection?.();
            }
            catch {
                /* 无所谓 */
            }
        },
    };
}
