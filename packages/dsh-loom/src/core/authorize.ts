
/* ------------------------------------------------------------------ *
 * 破坏性操作的授权
 * ------------------------------------------------------------------ */

/**
 * ── 为什么模型工具里不能有「强制删除」 ──────────────────────────────────
 *
 * 评审 A 的原始缺陷：`loom_worktree` 的 `remove` 分支直接调
 * `manager.forceRemove()`，而 `execute(args)` **连 `exec` 都没接**。
 * 工具说明写「用户显式要求」—— 但那是**模型读到的文本**，不是授权凭据。
 * 模型完全可以在用户只说「清理一下」的时候自己决定传 `action: 'remove'`。
 *
 * 评审给的判据是决定性的：
 *   > 「不能用模型自己传 `confirmed=true` 证明用户同意。」
 *
 * 既然**没有任何工具参数能证明用户同意**，那么正确的修法不是「加强校验」，
 * 而是**把这把刀从模型手里拿走**。所以：
 *   - 模型工具只保留只读列举、预览、受约束的建树与安全结算
 *   - 强制删除改由 HTTP 路由承载（用户从画布/设置页点按钮触发）
 *   - 服务端发一次性 token，用户必须在**单独的确认请求**里带回来
 *
 * 这个模块提供 token 的签发与核销 —— 纯逻辑，无 IO。
 */

/** 一次待确认的破坏性操作。 */
export interface PendingDestructiveOp {
  readonly token: string
  /** 操作类型。目前只有强制移除工作树。 */
  readonly kind: 'worktree-force-remove'
  readonly workspaceId: string
  readonly runId: string
  readonly taskId: string
  /** 目标树路径 —— 让用户核对「我要删的是这个」。 */
  readonly targetPath: string
  /** 会丢什么。必须显式列出，不能只说「有改动」。 */
  readonly willDiscard: readonly string[]
  readonly issuedAt: string
  /** 过期时间。过期后必须重新发起。 */
  readonly expiresAt: string
}

export interface IssueRequest {
  readonly token: string
  readonly workspaceId: string
  readonly runId: string
  readonly taskId: string
  readonly targetPath: string
  readonly willDiscard: readonly string[]
  readonly now: string
  readonly ttlMs?: number
}

/** token 有效期。给用户足够时间读确认文案，又不至于长期挂着。 */
export const DESTRUCTIVE_TOKEN_TTL_MS = 5 * 60 * 1000

export function issueDestructiveOp(req: IssueRequest): PendingDestructiveOp {
  if (req.token.trim() === '') throw new Error('签发破坏性操作需要非空 token')
  if (req.runId.trim() === '' || req.taskId.trim() === '') {
    throw new Error('签发破坏性操作需要 runId 与 taskId')
  }
  if (req.targetPath.trim() === '') {
    throw new Error('签发破坏性操作需要目标路径 —— 用户要能看见自己删的是哪一个')
  }
  const ttl = req.ttlMs ?? DESTRUCTIVE_TOKEN_TTL_MS
  const issued = Date.parse(req.now)
  if (Number.isNaN(issued)) throw new Error(`now 不是合法时间：${req.now}`)
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
  }
}

export type ConfirmVerdict =
  | { readonly ok: true; readonly op: PendingDestructiveOp }
  | { readonly ok: false; readonly code: ConfirmRefusalCode; readonly detail: string }

export type ConfirmRefusalCode =
  | 'TOKEN_MISSING'
  | 'TOKEN_UNKNOWN'
  | 'TOKEN_EXPIRED'
  | 'TARGET_MISMATCH'
  | 'WORKSPACE_MISMATCH'
  | 'IN_FLIGHT'
  | 'ALREADY_GONE'

/** 核销请求。用户必须把待确认操作里的**全部**标识原样带回。 */
export interface ConfirmRequest {
  readonly token: string
  readonly workspaceId: string
  readonly runId: string
  readonly taskId: string
  /** 用户回填的目标路径。不一致说明确认的不是同一棵树。 */
  readonly targetPath: string
  readonly now: string
  /** 该树是否正在被某个在途 run 使用。在途一律拒绝。 */
  readonly inFlight: boolean
  /** 目标路径当前是否还存在。已经不在就不必删。 */
  readonly targetExists: boolean
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
export function confirmDestructiveOp(
  pending: readonly PendingDestructiveOp[],
  req: ConfirmRequest,
): ConfirmVerdict {
  if (typeof req.token !== 'string' || req.token.trim() === '') {
    return { ok: false, code: 'TOKEN_MISSING', detail: '确认请求没有带 token' }
  }
  const op = pending.find((p) => p.token === req.token)
  if (op === undefined) {
    return { ok: false, code: 'TOKEN_UNKNOWN', detail: `token 不在待确认列表里（可能已用过或从未签发）` }
  }

  const now = Date.parse(req.now)
  const exp = Date.parse(op.expiresAt)
  if (!Number.isNaN(now) && !Number.isNaN(exp) && now > exp) {
    return { ok: false, code: 'TOKEN_EXPIRED', detail: `确认已过期（${op.expiresAt}）。请重新发起删除请求。` }
  }

  if (op.workspaceId !== req.workspaceId) {
    return {
      ok: false,
      code: 'WORKSPACE_MISMATCH',
      detail: `token 签发给工作区「${op.workspaceId}」，确认来自「${req.workspaceId}」`,
    }
  }
  if (op.runId !== req.runId || op.taskId !== req.taskId) {
    return {
      ok: false,
      code: 'TARGET_MISMATCH',
      detail: `token 针对 ${op.runId}/${op.taskId}，确认的是 ${req.runId}/${req.taskId}`,
    }
  }
  if (op.targetPath !== req.targetPath) {
    return {
      ok: false,
      code: 'TARGET_MISMATCH',
      detail: `token 针对路径「${op.targetPath}」，确认的是「${req.targetPath}」`,
    }
  }
  if (req.inFlight) {
    return {
      ok: false,
      code: 'IN_FLIGHT',
      detail: `任务 ${op.taskId} 仍被在途 run 使用，拒绝删除。请先停止派发并等它收敛。`,
    }
  }
  if (!req.targetExists) {
    return { ok: false, code: 'ALREADY_GONE', detail: `目标路径已不存在：${op.targetPath}` }
  }

  return { ok: true, op }
}

/**
 * 「在途」判定：一艘 run 是否还活着。
 *
 * 只看**未终态**的 run 记录。`cancelled` / `failed` / `refused` 都算已收敛 ——
 * 评审要求「停止派发不冒充取消成功」，但反过来也不该把已终止的 run 当作在途，
 * 否则用户永远删不掉树。
 */
export function isRunInFlight(state: string): boolean {
  switch (state) {
    case 'queued':
    case 'running':
    case 'producing':
    case 'produced':
    case 'validating':
      return true
    default:
      return false
  }
}
