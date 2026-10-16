/**
 * 任务图 → PTC workflow 脚本编译器。
 *
 * 纪律（00 §3、02 §3.4、03 P1）：
 * - **按依赖批次**编译，批内 `parallel()`，批间由消费端独立验收后再启动下一批。
 * - 带依赖屏障的 DAG **不能**简单翻译成 `pipeline()`（pipeline 是 per-item 阶段链，没有跨批屏障）。
 * - 只生成宿主**公开且已验证**的 hook 调用；不编造 `validateArtifact()` / `merge()`。
 * - 用户提示词作为 JSON 数据嵌入，不当任意 JS 执行。
 * - 只有宿主**真的接受**的 agent() 选项才写进产物；多写一个键就是给未来埋雷。
 */
import { canonicalize, contentDigest, sha256Hex } from './digest.js';
import { LOOM_COMPILER_VERSION } from './model.js';
import { capabilityGaps, isUsable } from './capabilities.js';
import { dependencyLayers, validateAdoptedRevision } from './validate.js';
import { buildTaskPackage } from './prompt.js';
export class CompileError extends Error {
    issues;
    constructor(message, issues = []) {
        super(message);
        this.name = 'CompileError';
        this.issues = issues;
    }
}
function isAgentNode(node) {
    return node.execution.backend === 'configured-agent';
}
/** 把任意字符串安全嵌进 JS 源码的 JSON 字面量（转义 U+2028/U+2029）。 */
export function embedJson(value) {
    return JSON.stringify(canonicalize(value))
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}
/**
 * 宿主 workflow-ptc 的 `ChildStartRequest` **真正接受**的键。
 * 出处：`dsh-workflow-ptc/lib/types/types.d.ts`。
 * 这里多写一个键，宿主不会报错 —— 它会静默忽略，而我们会误以为隔离生效了。
 */
export const ACCEPTED_AGENT_OPTIONS = ['prompt', 'schema', 'provider', 'model'];
/**
 * 派发前的能力闸门。
 * 计划里声明 `isolation: worktree` 但运行时没有工作树能力时**必须拒绝**，
 * 绝不能悄悄退化成「共享 cwd 多代理写代码」。
 *
 * ⚠ 用 `isUsable()` 而不是 `available`（评审 09 E）：
 * `available` 只表示「探测到了」，`isUsable` 要求
 * `implementedByLoom && availableInEnv === true`。
 * 用前者会让「宿主有入口但 Loom 没接线」通过闸门 —— 那正是原实现的漏洞。
 */
export function assertIsolationSupported(caps, isolation) {
    if (isolation === 'worktree' || isolation === 'integration-worktree') {
        if (!isUsable(caps.worktreeIsolation)) {
            throw new CompileError(`节点要求 isolation=${isolation}，但运行时探测到工作树隔离不可用。` +
                `缺口：${capabilityGaps(caps.worktreeIsolation).join('；') || '（未说明）'}。` +
                `不接受共享 cwd 多代理写代码的降级。`);
        }
    }
}
/** 校验计划里声明的能力是否都被运行时满足。 */
export function missingCapabilities(caps, workflow) {
    const missing = [];
    const req = new Set(workflow.executionProposal.requiredCapabilities);
    if (req.has('parallel-agents') && !isUsable(caps.parallel))
        missing.push('parallel-agents');
    if (req.has('worktree') && !isUsable(caps.worktreeIsolation))
        missing.push('worktree');
    if (req.has('wsl-execution') && !isUsable(caps.wslExecution))
        missing.push('wsl-execution');
    if (req.has('cancel-cleanup') && !isUsable(caps.cancel))
        missing.push('cancel-cleanup');
    if (req.has('real-parent-agent') && !isUsable(caps.realParentAgent))
        missing.push('real-parent-agent');
    return missing;
}
export function compileWorkflow(workflow, caps, options) {
    const result = validateAdoptedRevision(workflow);
    if (!result.ok) {
        throw new CompileError(`任务 revision 未通过校验，共 ${result.errors.length} 条错误`, result.errors);
    }
    const capabilityNotes = [];
    const missing = missingCapabilities(caps, workflow);
    if (missing.length > 0) {
        capabilityNotes.push(`计划要求但当前不可用的能力：${missing.join('、')}（见 capabilities 表的 evidence）`);
    }
    for (const node of workflow.nodes) {
        assertIsolationSupported(caps, node.execution.isolation);
    }
    if (options.structuredOutput) {
        capabilityNotes.push('请求结构化输出：provider 不支持时结果里不会有 structured，按「未产出」处理，不当作成功。');
    }
    if (options.maxTotalAgents !== undefined && options.maxTotalAgents > 1000) {
        throw new CompileError('maxTotalAgents 超过宿主上限 1000（dsh-workflow-ptc/README.zh.md:43）');
    }
    if (options.provider && options.provider !== caps.engine.subagentProvider) {
        capabilityNotes.push(`本次运行请求 provider=${options.provider}，与探测到的默认 ${caps.engine.subagentProvider} 不同；派发前必须再确认该 provider 已注册。`);
    }
    const { layers } = dependencyLayers(workflow.nodes, workflow.edges);
    const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
    const maxConcurrency = workflow.executionProposal.maxConcurrency;
    // 节点 → 批次号。传给 renderBatchScript，让它能如实标注上游时序（评审 09 B）。
    const batchOf = new Map();
    layers.forEach((nodeIds, index) => {
        for (const id of nodeIds)
            batchOf.set(id, index);
    });
    const batches = layers.map((nodeIds, index) => {
        const nodes = nodeIds.map((id) => byId.get(id)).filter(Boolean);
        const rendered = renderBatch({ workflow, nodes, index, options, batchOf });
        const script = rendered.script;
        const expectations = nodes.map((n) => ({
            nodeId: n.id,
            produces: n.outputs.map((o) => ({ port: o.name, artifactType: o.artifactType })),
            verifiedBy: workflow.edges.filter((e) => e.source === n.id).map((e) => e.target),
            commands: n.acceptance.commands.map((c) => c.argv),
        }));
        return {
            index,
            nodeIds,
            script,
            scriptHash: sha256Hex(script),
            agentCalls: nodes.filter(isAgentNode).length,
            expectations,
            dependencies: rendered.dependencies,
        };
    });
    const planHash = contentDigest({
        workflowId: workflow.workflowId,
        revision: workflow.revision,
        inputDigest: workflow.inputDigest,
        compilerVersion: LOOM_COMPILER_VERSION,
        nodes: workflow.nodes,
        edges: workflow.edges,
        provider: options.provider ?? null,
        model: options.model ?? null,
        structuredOutput: options.structuredOutput === true,
    });
    return {
        workflowId: workflow.workflowId,
        revision: workflow.revision,
        compilerVersion: LOOM_COMPILER_VERSION,
        planHash,
        batches,
        warnings: result.warnings,
        capabilityNotes,
        concurrency: batches.map((b) => Math.max(1, Math.min(maxConcurrency, b.agentCalls || 1))),
    };
}
/**
 * 生成一个批次的 PTC 脚本。
 *
 * 脚本只做两件事：把每个 agent 节点的任务包发给 `agent()`，把结果原样返回。
 * 它**不**做验收、不做合并 —— 那些在消费端（Loom 宿主半边）做。
 */
export function renderBatchScript(args) {
    return renderBatch(args).script;
}
/**
 * 渲染一个批次：脚本 + 依赖清单。
 *
 * 拆成两个导出是因为 `renderBatchScript` 是既有公开 API（返回字符串）；
 * 内部与 `compileWorkflow` 需要额外拿到 `dependencies`，共用同一次渲染，
 * 避免「脚本里有一份依赖、返回值里另算一份」导致两者不一致。
 */
export function renderBatch(args) {
    const { workflow, nodes, index, options, batchOf } = args;
    /**
     * 判定一条上游边相对**本批次**的时序。
     *
     * - `earlier` —— 上游在更早的批次，其产物本次运行已经产出（正常情况）
     * - `same-batch` —— 同批次内有依赖边。批次是按依赖分层切的，同批内按定义无依赖边，
     *   所以这表示**分层结果被破坏了**，要暴露出来而不是当作正常
     * - `later` —— 上游在更晚的批次，说明该任务在上游之前就跑了，产物必然不可用
     * - `unknown` —— 没有批次信息（单独调用 renderBatchScript），不猜
     */
    const originOf = (sourceId) => {
        if (batchOf === undefined)
            return 'unknown';
        const src = batchOf.get(sourceId);
        if (src === undefined)
            return 'unknown';
        if (src < index)
            return 'earlier';
        if (src > index)
            return 'later';
        return 'same-batch';
    };
    /**
     * 一个节点的**全部**上游产物引用。
     *
     * ── 评审 09 B 修正 ────────────────────────────────────────────────────
     * 旧实现多了一个 `&& inBatch.has(e.source)`。这条过滤是**逻辑上的自相矛盾**：
     * 批次是按依赖分层切出来的，同批次内两个节点之间**按定义**没有依赖边
     * （有边就会分到不同批次）。所以「上游在本批次内」永远为假 ——
     * 结果是每个任务的 `upstream` 恒为空数组，任务包里的「输入产物」永远是「（无）」。
     *
     * 子代理因此看不到任何前序批次的产物路径，只能靠猜 —— 这正是
     * 「编译器丢失前序批次的输入」。
     *
     * 现在取**所有**指向该节点的边，用 `originOf` 标注时序可信度。
     */
    const upstreamOf = (nodeId) => workflow.edges
        .filter((e) => e.target === nodeId)
        .map((e) => ({
        nodeId: e.source,
        port: e.sourcePort,
        type: e.artifactType,
        ref: `artifact://${e.source}/${e.sourcePort}`,
        origin: originOf(e.source),
    }));
    const calls = nodes
        .filter(isAgentNode)
        .map((n) => {
        const prompt = buildTaskPackage({
            workflow: {
                workflowId: workflow.workflowId,
                revision: workflow.revision,
                inputDigest: workflow.inputDigest,
            },
            node: n,
            upstream: upstreamOf(n.id),
            contractHash: options.contractHash,
            cwd: options.resolveCwd(n),
            baseSha: options.baseSha,
            allowedChecks: options.allowedChecks ?? n.acceptance.commands.map((c) => c.argv.join(' ')),
        });
        const agentOptions = { label: n.id };
        if (options.provider)
            agentOptions['provider'] = options.provider;
        if (options.model)
            agentOptions['model'] = options.model;
        // 只写宿主真的接受的键。isolation / cwd / agentType 会被静默忽略，
        // 写上去只会让人误以为隔离生效了 —— 所以一个都不写。
        return {
            nodeId: n.id,
            kind: n.kind,
            phase: n.phase,
            prompt,
            options: agentOptions,
            expect: n.outputs.map((o) => ({ port: o.name, artifactType: o.artifactType })),
            /** 声明值，只给消费端核对用；**不**进 agent() 的 options。 */
            declaredIsolation: n.execution.isolation,
        };
    });
    /**
     * 本批次里**所有**节点的依赖清单 —— 包括非 agent 节点。
     *
     * ── 评审 09 B 的第二层修正 ─────────────────────────────────────────────
     * 旧实现只对 `isAgentNode` 的节点生成 `calls`，非 agent 节点（`inspect` /
     * `contract` / `integrate` / `report` 这些确定性节点）的入边**完全不进脚本**。
     * 后果比第一层更隐蔽：
     *   - `integrate` 是集成控制器，职责是「按明确顺序应用三个模块的提交」，
     *     但编译产物里**没有任何一处**告诉它那三份提交的引用是什么；
     *   - `report` 要「把需求映射到真实 commit」，同样拿不到 `integrate` 的产物引用。
     * 这些节点由消费端（宿主半边）执行，所以消费端此前只能自己重新解析图 ——
     * 而脚本是唯一的交接凭证，凭证里没有就等于丢了。
     *
     * 现在每个节点（不论 kind）都带一份 `dependencies`，消费端照着执行即可。
     */
    const dependencies = nodes.map((n) => ({
        nodeId: n.id,
        kind: n.kind,
        phase: n.phase,
        declaredIsolation: n.execution.isolation,
        expects: n.inputs.map((i) => ({ name: i.name, artifactType: i.artifactType, required: i.required !== false })),
        produces: n.outputs.map((o) => ({ name: o.name, artifactType: o.artifactType })),
        upstream: upstreamOf(n.id),
        /** 非 agent 节点的完成条件与验收命令 —— 消费端据此执行与核验。 */
        doneWhen: [...n.acceptance.doneWhen],
        commands: n.acceptance.commands.map((c) => ({
            argv: [...c.argv],
            cwdRef: c.cwdRef,
            expectedExitCode: c.expectedExitCode,
        })),
    }));
    const head = [
        '/* Loom generated batch script',
        ` * compiler: ${LOOM_COMPILER_VERSION}`,
        ` * workflow: ${workflow.workflowId} @ revision ${workflow.revision}`,
        ` * batch: ${index}`,
        ' * 不要手改：本文件由 Loom 编译产生，改动会在下次编译时被覆盖。',
        ' */',
    ].join('\n');
    return {
        script: [
            head,
            `const __loom_meta = ${embedJson({
                workflowId: workflow.workflowId,
                revision: workflow.revision,
                inputDigest: workflow.inputDigest,
                batch: index,
                compilerVersion: LOOM_COMPILER_VERSION,
            })};`,
            // 全部节点的依赖清单（评审 09 B）。消费端据此执行非 agent 节点，
            // 不必自己重新解析图 —— 那正是「凭证里没有就等于丢了」。
            `const __loom_deps = ${embedJson(dependencies)};`,
            `const __loom_tasks = ${embedJson(calls)};`,
            '',
            'const __loom_results = await parallel(__loom_tasks.map((task) => () => agent(task.prompt, task.options)));',
            '',
            'return {',
            '  meta: __loom_meta,',
            '  // 本批次每个节点（含非 agent）的输入/输出/验收条件。',
            '  dependencies: __loom_deps,',
            '  items: __loom_tasks.map((task, i) => ({',
            '    nodeId: task.nodeId,',
            '    expect: task.expect,',
            '    // 普通子 agent 失败时 agent() 以 null 兑现 —— 如实传递，不做美化。',
            '    result: __loom_results[i],',
            '    ok: __loom_results[i] !== null && __loom_results[i] !== undefined,',
            '  })),',
            '};',
        ].join('\n') + '\n',
        dependencies,
    };
}
