import { randomUUID } from 'node:crypto';
import { normalizeWorkspaceId } from './core/scope.js';
/**
 * 从 pre-step payload 里解析当前 Agent 的工作区 id。
 *
 * 取 `agent.session.header.cwd`。返回 null 表示**解析不出** ——
 * 调用方必须跳过注入，绝不能回落到全局草案。
 */
export function resolveAgentWorkspace(payload) {
    const p = payload;
    const cwd = p?.agent?.session?.header?.cwd;
    return normalizeWorkspaceId(cwd);
}
/**
 * 与宿主 createUserMessage 相同的不可变语义：消息一旦进入步骤批次，
 * 就不允许任何下游监听就地改写。
 */
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value))
            deepFreeze(value[key]);
    }
    return value;
}
export function installInjection(ctx, deps) {
    if (typeof ctx?.on !== 'function')
        return () => { };
    const handler = async (payload, next) => {
        const decision = await next();
        try {
            if (!decision || decision.kind !== 'enter')
                return decision;
            const p = payload;
            const instruction = deps.planning?.beforeStep(p.agent, decision.messages ?? [], p.step ?? 1);
            if (instruction)
                return { ...decision, messages: [...decision.messages, deepFreeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: instruction }], source: { kind: 'loom-planning', form: 'snapshot' } })] };
            const config = deps.getConfig();
            if (config.enabled === false || !config.injectDraftSummary || deps.isSessionActive?.(payload?.agent) === false)
                return decision;
            // 每轮只在第一步注入一次：草案摘要没有逐步骤刷新的语义，
            // 若每一步都追加，同一轮会累积多份完全相同的消息（实机曾一轮 66 份）。
            // 宿主未提供 step 时保持旧行为，提供时 step>1 一律跳过。
            if (typeof payload?.step === 'number' && payload.step !== 1)
                return decision;
            // 归属核对：解析不出工作区就不注入。
            const workspaceId = resolveAgentWorkspace(payload);
            if (workspaceId === null) {
                deps.log.warn('无法从 agent 会话解析工作区（session.header.cwd 缺失或非法），跳过草案注入。' +
                    '不回落全局草案 —— 那会把别的项目的约束注入本会话。');
                return decision;
            }
            const draft = deps.store.readDraft(workspaceId);
            if (!draft)
                return decision;
            // 双保险：草案自己记的归属必须与解析出的一致。
            // 不一致说明文件被手工放到别的目录 —— 宁可跳过并告警，也不注入。
            if (draft.workspaceId !== undefined && draft.workspaceId !== workspaceId) {
                deps.log.warn(`草案归属不一致：文件记的是「${draft.workspaceId}」，当前会话工作区是「${workspaceId}」。已跳过注入。`);
                return decision;
            }
            const summary = renderDraftSummary(draft, config.maxInjectChars);
            if (!summary)
                return decision;
            const messages = Array.isArray(decision.messages) ? decision.messages : null;
            if (!messages)
                return decision;
            // 注入消息必须是宿主形状的 user 消息：官方 prepend 监听会对
            // decision.messages 逐条读 message.source.kind（如 dsh-session-reference、
            // dsh-time-context）。只给 { role, content } 会让这一步在模型请求之前
            // 抛 "Cannot read properties of undefined (reading 'kind')" 并终止整轮。
            const note = deepFreeze({
                id: randomUUID(),
                role: 'user',
                content: [{ type: 'text', text: summary }],
                source: { kind: 'loom-draft', form: 'snapshot' },
            });
            return { ...decision, messages: [...messages, note] };
        }
        catch (error) {
            if (deps.planning && payload?.agent && deps.planning.held(payload.agent.session.id ?? payload.agent.session.header.id, payload.agent))
                return { kind: 'reject', reason: String(error.message) };
            // 普通草案摘要失败可跳过；规划门禁失败必须拒绝。
            deps.log.warn(`草案摘要注入失败（已跳过）：${error?.message ?? error}`);
            return decision;
        }
    };
    ctx.on('agent/pre-step', handler);
    return () => {
        try {
            ctx.off?.('agent/pre-step', handler);
        }
        catch {
            /* 无所谓 */
        }
    };
}
function renderDraftSummary(draft, maxChars) {
    const head = `[Loom] 当前草案：模式=${draft.mode}，工作流=${draft.workflowId}，draftRevision=${draft.draftRevision}。`;
    const locked = draft.lockedConstraints.length
        ? `用户锁定约束：${draft.lockedConstraints.slice(0, 6).join('；')}。`
        : '';
    // 架构基线：评审 09 D 要求改图回传读真实基线。
    const base = draft.architectureId !== undefined && draft.architectureRevision !== undefined
        ? `架构基线：${draft.architectureId}@${draft.architectureRevision}。`
        : '';
    const tail = '这是只读摘要，不是执行授权；需要改草案请显式说明，Loom 不会因为这句话就派发任务。';
    const text = [head, locked, base, tail].filter(Boolean).join(' ');
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
