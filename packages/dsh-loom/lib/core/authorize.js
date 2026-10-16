/* ------------------------------------------------------------------ *
 * 破坏性操作的授权（评审 09 A）
 * ------------------------------------------------------------------ */
/** token 有效期。给用户足够时间读确认文案，又不至于长期挂着。 */
export const DESTRUCTIVE_TOKEN_TTL_MS = 5 * 60 * 1000;
export function issueDestructiveOp(req) {
    if (req.token.trim() === '')
        throw new Error('签发破坏性操作需要非空 token');
    if (req.runId.trim() === '' || req.taskId.trim() === '') {
        throw new Error('签发破坏性操作需要 runId 与 taskId');
    }
    if (req.targetPath.trim() === '') {
        throw new Error('签发破坏性操作需要目标路径 —— 用户要能看见自己删的是哪一个');
    }
    const ttl = req.ttlMs ?? DESTRUCTIVE_TOKEN_TTL_MS;
    const issued = Date.parse(req.now);
    if (Number.isNaN(issued))
        throw new Error(`now 不是合法时间：${req.now}`);
    return {
        token: req.token,
        kind: 'worktree-force-remove',
        workspaceId: req.workspaceId,
        runId: req.runId,
        taskId: req.taskId,
        targetPath: req.targetPath,
        willDiscard: req.willDiscard,
        issuedAt: req.now,
        expiresAt: new Date(issued + ttl).toISOString(),
    };
}
/**
 * 核销一次破坏性操作。
 *
 * 七道闸门，任何一道不过都拒绝：
 *   1. token 非空
 *   2. token 在待确认表里（签发过）
 *   3. 未过期
 *   4. 工作区匹配（不能拿 A 项目的 token 删 B 项目的树）
 *   5. run/task 匹配（不能换目标）
 *   6. 目标路径匹配（用户确认的就是这一棵）
 *   7. 不在途，且确实还存在
 *
 * 先查「在途」再查「存在」：在途的树即便存在也必须拒绝，
 * 顺序反了会给出误导性的 ALREADY_GONE。
 */
export function confirmDestructiveOp(pending, req) {
    if (typeof req.token !== 'string' || req.token.trim() === '') {
        return { ok: false, code: 'TOKEN_MISSING', detail: '确认请求没有带 token' };
    }
    const op = pending.find((p) => p.token === req.token);
    if (op === undefined) {
        return { ok: false, code: 'TOKEN_UNKNOWN', detail: `token 不在待确认列表里（可能已用过或从未签发）` };
    }
    const now = Date.parse(req.now);
    const exp = Date.parse(op.expiresAt);
    if (!Number.isNaN(now) && !Number.isNaN(exp) && now > exp) {
        return { ok: false, code: 'TOKEN_EXPIRED', detail: `确认已过期（${op.expiresAt}）。请重新发起删除请求。` };
    }
    if (op.workspaceId !== req.workspaceId) {
        return {
            ok: false,
            code: 'WORKSPACE_MISMATCH',
            detail: `token 签发给工作区「${op.workspaceId}」，确认来自「${req.workspaceId}」`,
        };
    }
    if (op.runId !== req.runId || op.taskId !== req.taskId) {
        return {
            ok: false,
            code: 'TARGET_MISMATCH',
            detail: `token 针对 ${op.runId}/${op.taskId}，确认的是 ${req.runId}/${req.taskId}`,
        };
    }
    if (op.targetPath !== req.targetPath) {
        return {
            ok: false,
            code: 'TARGET_MISMATCH',
            detail: `token 针对路径「${op.targetPath}」，确认的是「${req.targetPath}」`,
        };
    }
    if (req.inFlight) {
        return {
            ok: false,
            code: 'IN_FLIGHT',
            detail: `任务 ${op.taskId} 仍被在途 run 使用，拒绝删除。请先停止派发并等它收敛。`,
        };
    }
    if (!req.targetExists) {
        return { ok: false, code: 'ALREADY_GONE', detail: `目标路径已不存在：${op.targetPath}` };
    }
    return { ok: true, op };
}
/**
 * 「在途」判定：一艘 run 是否还活着。
 *
 * 只看**未终态**的 run 记录。`cancelled` / `failed` / `refused` 都算已收敛 ——
 * 评审要求「停止派发不冒充取消成功」，但反过来也不该把已终止的 run 当作在途，
 * 否则用户永远删不掉树。
 */
export function isRunInFlight(state) {
    switch (state) {
        case 'queued':
        case 'running':
        case 'producing':
        case 'produced':
        case 'validating':
            return true;
        default:
            return false;
    }
}
