/**
 * dsh-loom · 宿主半边：逐任务工作树 provider。
 *
 * ── 这个文件存在的唯一理由 ──────────────────────────────────────────────
 * 官方每个 in-process 子代理都继承**父会话的 cwd**（`childSessionMeta()`
 * 直接把 `parent.session.header.cwd` 抄给子会话，见
 * `@deepseek-ai/dsh-subagent/lib/types/child-agent.js`）。于是「多个子代理
 * 并行写同一个仓库」必然互相踩。
 *
 * Loom 要让每个子代理落在**自己的 git 工作树**里。挂载点不在 workflow 层
 * （`ChildStartRequest` 没有 cwd），而在 provider 层：provider 自己调
 * `parent.ctx.agents.create({ meta })`，而 `meta.cwd` 是公开字段。
 *
 * ── 为什么不直接复用 `startInProcessRun` ────────────────────────────────
 * `@deepseek-ai/dsh-subagent-in-process-driver` 的 `startInProcessRun(request, options)`
 * 只接受 `{ seed? }`，**没有 cwd 通道** —— 它内部写死 `childSessionMeta()`。
 * 所以 Loom 自己写 `start()`，按公开 API 的生命周期契约独立实现，只在 `meta` 那一步换成 `withTaskCwd(...)`。
 * 这样我们复用它的**契约**而不是它的代码，符合「零第三方代码」约束。
 *
 * ── 幂等性要求 ──────────────────────────────────────────────────────────
 * 宿主可能对同一个 provider 调多次 `start()`（并发不同子代理）。
 * 本实现不持有跨 run 的可变状态：每次 `start()` 的局部变量互不干扰。
 */
import { installWslChildFileSystem } from './wsl-fs.js';
import { installWslChildShell } from './wsl-shell.js';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { latestRecords, resolveDispatch, sanitizeRefSegment, } from './core/worktree-plan.js';
import { createWorktreeStore, withTaskCwd } from './worktree.js';
/** 缺哪个 helper 就说哪个，别让人猜。 */
export function assertHostHelpers(helpers) {
    const required = [
        'childSessionMeta',
        'resolveChildDepth',
        'resolveChildAgentOptions',
        'assertSubagentMaxDepth',
        'captureDelegatedPolicyOverrides',
        'appendDelegatedPolicyOverrides',
        'applyChildComposition',
        'createUserMessage',
    ];
    const missing = required.filter((k) => typeof helpers[k] !== 'function');
    if (missing.length > 0) {
        throw new Error(`Loom 工作树 provider 缺少宿主组合辅助函数：${missing.join('、')}。` +
            '这些必须由能 import @deepseek-ai/dsh-subagent 的入口层注入。');
    }
}
/* ------------------------------------------------------------------ *
 * provider 本体
 * ------------------------------------------------------------------ */
/** provider 注册名。`loom_run` 与文档都用这个字符串。 */
export const LOOM_PROVIDER_NAME = 'loom-worktree';
/**
 * 派发前的归属解析：**唯一**决定子代理落在哪棵树的函数。
 *
 * 抽出来是为了它可测：不碰 git、不碰宿主，纯读 store + 纯裁决。
 * 返回 `DispatchRefusal` 时调用方必须抛 —— 绝不回落父 cwd。
 */
export function resolveTaskWorktree(store, label) {
    const records = latestRecords(store.listAll());
    const resolution = resolveDispatch(label, records);
    if (!resolution.ok) {
        return { refuse: `${resolution.code}：${resolution.detail}` };
    }
    const hit = records.find((r) => r.runId === resolution.runId && r.taskId === resolution.taskId);
    if (hit === undefined)
        return { refuse: 'NO_RECORD：解析成功但记录消失了' };
    return hit;
}
/**
 * Loom 的逐任务工作树 provider。
 *
 * ── 为什么 `capabilities.agentOptions` 为 true ─────────────────────────
 * 模型选项、深度与组合策略由宿主公开 API 处理。outputSchema 仅在宿主
 * 提供公开 schema 校验 API 时声明支持；本 provider 注册作用域回执工具，
 * 等工具结果真正成功后捕获，不能把助手正文当作结构化交付。
 *
 * ── 为什么 `inheritsParentContext = false` ────────────────────────────
 * 这是事实陈述，不是策略：我们不给子会话 seed，子代理看到的是空会话。
 * 它决定模型侧工具对用户怎么描述这次委托，说错了就是骗人。
 */
export class LoomWorktreeProvider {
    name = LOOM_PROVIDER_NAME;
    get capabilities() {
        return {
            agentOptions: true,
            outputSchema: typeof this.helpers.assertOutputSchema === 'function' && typeof this.helpers.validateOutput === 'function' && typeof this.helpers.ToolArgsError === 'function',
            depthLimit: true,
            toolFilter: true,
            persona: true,
        };
    }
    inheritsParentContext = false;
    store;
    helpers;
    log;
    resolveExecutionRepo;
    constructor(options) {
        this.resolveExecutionRepo = options.resolveExecutionRepo;
        this.store = createWorktreeStore(options.paths);
        this.helpers = options.helpers;
        this.log = options.log ?? { info() { }, warn() { }, error() { } };
    }
    /** 本次 run 用哪棵树 —— 供测试与 `loom_run` 共用。 */
    locate(label) {
        return resolveTaskWorktree(this.store, label);
    }
    async start(request) {
        const h = this.helpers;
        assertHostHelpers(h);
        if (request.outputSchema !== undefined) {
            if (!this.capabilities.outputSchema)
                throw new Error('STRUCTURED_OUTPUT_UNAVAILABLE: 宿主缺少公开 schema 校验 API');
            h.assertOutputSchema(request.outputSchema);
        }
        // 1. 先解析归属。这一步在**任何 await 之前**，因为它是纯读；
        //    失败必须早于子会话创建，否则会留下一个生在父 cwd 的子代理。
        const target = this.locate(request.label);
        if ('refuse' in target) {
            this.log.error(`拒绝派发：${target.refuse}`);
            throw new Error(`Loom 拒绝派发：${target.refuse}。` +
                '不会回落到父会话目录 —— 那会让子代理在共享目录里并行写代码。');
        }
        const worktreePath = target.path;
        const parentCwd = this.resolveExecutionRepo?.(request.parent) ?? request.parent.session.header.cwd;
        if (typeof parentCwd !== 'string' || realpathSync(parentCwd) !== realpathSync(target.repoPath)) {
            throw new Error('WORKSPACE_MISMATCH: 派发标签不能借用其他项目的工作树');
        }
        if (!isAbsolute(worktreePath)) {
            throw new Error(`Loom 工作树路径不是绝对路径：${worktreePath}`);
        }
        h.assertSubagentMaxDepth(request.maxDepth);
        if (request.descriptor === undefined)
            throw new Error('DESCRIPTOR_REQUIRED: 缺少宿主生成的子代理归属描述');
        if (request.signal.aborted) {
            throw new Error('subagent request was aborted before child publication');
        }
        const parent = request.parent;
        const childDepth = h.resolveChildDepth(parent, request.maxDepth);
        const childId = (h.brandString ?? ((raw) => raw))(randomUUID());
        // 快照委托策略 —— 必须同步捕获（父会话之后切换预设属于它的未来）
        const inherited = h.captureDelegatedPolicyOverrides(parent);
        let captured;
        const setup = async (childCtx, child) => {
            h.appendDelegatedPolicyOverrides(child.session, inherited);
            if (request.outputSchema !== undefined) {
                const context = childCtx, staged = new WeakMap();
                let pending;
                context.tools.register({
                    name: 'structured_output', description: '最终交付回执。必须填写当前执行身份并调用本工具；普通文字不是交付。', parameters: request.outputSchema,
                    output: { schema: { type: 'object', properties: { recorded: { type: 'boolean', const: true } }, required: ['recorded'], additionalProperties: false }, render: () => [{ type: 'text', text: 'Structured delivery recorded.' }] },
                    async execute(value, execution) {
                        const violations = h.validateOutput(request.outputSchema, value);
                        if (violations.length)
                            throw new h.ToolArgsError(violations);
                        staged.set(execution, structuredClone(value));
                        execution.concludeTurn();
                        return { recorded: true };
                    },
                });
                context.systemPrompt.section({ name: 'loom:structured-delivery', order: context.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT'), text: '最终结果必须调用 structured_output 工具，严格填写其 schema。禁止用 Markdown 或普通文本代替。' });
                context.tools.guard(() => captured !== undefined || pending !== undefined ? 'LOOM_DELIVERY_RECORDED: 本轮已经交付，不能继续执行工具' : undefined);
                context.on('tools/result', (execution, result) => {
                    if (execution.name === 'structured_output' && staged.has(execution)) {
                        const value = staged.get(execution);
                        staged.delete(execution);
                        if (result.isError)
                            return;
                        if (execution.parent === undefined)
                            captured = value;
                        else
                            pending = { parent: execution.parent, value };
                    }
                    else if (pending && pending.parent === execution.token) {
                        const accepted = pending;
                        pending = undefined;
                        if (!result.isError)
                            captured = accepted.value;
                    }
                });
            }
            h.applyChildComposition(childCtx, parent, {
                persona: request.persona,
                toolFilter: request.toolFilter,
            });
            if (request.persona === 'Loom 独立只读审查') {
                const tools = childCtx.tools;
                if (typeof tools?.guard !== 'function')
                    throw new Error('READONLY_GUARD_UNAVAILABLE');
                tools.guard((execution) => ['read', 'glob', 'grep', 'structured_output'].includes(execution.name) ? undefined : 'LOOM_REVIEW_READ_ONLY: 独立审查不能执行写入、命令或委托工具');
                child.session.append('sandbox/mode', { mode: 'read-only' });
            }
            const context = childCtx;
            if (typeof context.on !== 'function')
                throw new Error('CHILD_HOOK_UNAVAILABLE: 无法记录子代理归属');
            let descriptorRecorded = false;
            context.on('agent/pre-step', async (payload, next) => {
                const decision = await next();
                if (decision?.kind === 'enter' && !descriptorRecorded) {
                    payload.agent.session.append('subagent/descriptor', request.descriptor);
                    descriptorRecorded = true;
                }
                return decision;
            });
            if (child.session.header.cwd !== worktreePath) {
                // 不该发生：meta 是我们传的。真发生了说明宿主改写了 cwd —— 必须可见。
                throw new Error(`CHILD_CWD_MISMATCH: 期望 ${worktreePath}，实际 ${String(child.session.header.cwd)}`);
            }
            if (process.platform === 'win32') {
                await installWslChildFileSystem(childCtx, worktreePath);
                await installWslChildShell(childCtx, worktreePath);
            }
        };
        // 为本任务显式设置子会话 meta.cwd
        const meta = withTaskCwd(h.childSessionMeta(parent, childDepth, false), worktreePath);
        const handle = await parent.ctx.agents.create({
            sessionId: childId,
            parentAgent: parent,
            meta,
            agentOptions: h.resolveChildAgentOptions(parent, request.agentOptions, childDepth),
            signal: request.signal,
            setup,
        });
        this.log.info(`子代理 ${String(childId)} 落在工作树 ${worktreePath}`);
        return this.drive(handle, request.signal, request.prompt, childId, h, request.outputSchema !== undefined ? () => captured : undefined);
    }
    /**
     * 把已发布的子代理包成单个 run 生命周期：信号交接、一轮对话、结果读取、
     * 静默销毁。形状与 `drivePublishedRun()` 一致 —— 顺序是契约的一部分。
     */
    drive(handle, signal, prompt, childId, h, capture) {
        const child = handle.agent;
        const flags = { cancelled: false };
        const onAbort = () => {
            flags.cancelled = true;
            child.cancel({ kind: 'parent' });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted)
            onAbort();
        const result = (async () => {
            try {
                if (!flags.cancelled) {
                    child.followup(h.createUserMessage({ content: prompt, source: { kind: 'user' } }));
                    await child.whenIdle();
                }
                const result = this.readResult(child, flags.cancelled, h);
                if (!capture)
                    return result;
                const structured = capture();
                return structured !== undefined ? { ...result, structured } : { ...result, stopReason: result.stopReason === 'completed' ? 'refusal' : result.stopReason, diagnostic: 'STRUCTURED_OUTPUT_MISSING: 子代理没有通过工具交付有效回执' };
            }
            finally {
                signal.removeEventListener('abort', onAbort);
            }
        })();
        return {
            id: String(childId),
            localAgent: child,
            result,
            async dispose() {
                signal.removeEventListener('abort', onAbort);
                flags.cancelled = true;
                const settled = await Promise.allSettled([handle.dispose(), result]);
                const first = settled[0];
                if (first.status === 'rejected')
                    throw first.reason;
            },
        };
    }
    /**
     * 从子会话事件里读结果。
     *
     * `foldConsumedWork` / `finalAssistantOutput` 是可选的 —— 宿主没给时
     * 退化成「空输出 + 粗粒度 stopReason」，而不是编一个假的 completed。
     */
    readResult(child, cancelled, h) {
        const session = child.session;
        const offset = typeof h.sessionLogOffset === 'function' ? h.sessionLogOffset(0) : undefined;
        const events = typeof session.snapshotEvents === 'function' && offset !== undefined ? session.snapshotEvents(offset) : [];
        let recorded = 'error';
        if (typeof h.foldConsumedWork === 'function') {
            const folded = h.foldConsumedWork(events);
            recorded = toStopReason(folded.end?.data?.reason);
        }
        const output = typeof h.finalAssistantOutput === 'function' ? (h.finalAssistantOutput(events) ?? []) : [];
        const stopReason = cancelled && recorded !== 'completed' ? 'aborted' : recorded;
        return { output, stopReason };
    }
}
/** 把会话轮次结果映射到 subagent 缝的终态词汇（与官方 driver 同表）。 */
export function toStopReason(reason) {
    const kind = reason?.kind;
    switch (kind) {
        case 'completed':
            return 'completed';
        case 'max-tokens':
            return 'max-tokens';
        case 'aborted':
            return 'aborted';
        case 'blocked':
            return 'refusal';
        default:
            return 'error';
    }
}
/** 派发前的自检：给定 label 与已登记记录，会落在哪 / 为什么拒绝。 */
export function describeDispatch(label, records) {
    const resolution = resolveDispatch(label, records);
    if (resolution.ok) {
        return `会落进 ${resolution.path}（run ${resolution.runId} / 任务 ${resolution.taskId}）`;
    }
    return `拒绝（${resolution.code}）：${resolution.detail}`;
}
/** 暴露给 `loom_worktree` 工具：把 runId/taskId 组成宿主 label。 */
export { sanitizeRefSegment };
