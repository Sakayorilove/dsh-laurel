/**
 * 工作树（git worktree）的**纯逻辑层**：路径规划、命名、保留裁决、状态归约。
 *
 * 这一层不做任何 IO，也不认识 git 命令 —— 它只回答「该怎么命名」「该不该删」。
 * 真正的 `git worktree add/remove` 在 `src/worktree.ts`（宿主半边）。
 *
 * 为什么把裁决逻辑单独抽出来：保留/清理策略是**会出错就毁数据**的地方
 * （误删未提交改动 = 用户的工作没了）。所以它必须是可穷举测试的纯函数。
 *
 * 隔离语义（对齐 docs/compatibility-report.md §3.1）：
 * 每个任务一棵独立的 git worktree，通过覆盖 `CreateAgentOptions.meta.cwd`
 * 让子 agent 在那个目录里跑 —— session 的 cwd 既是工具路径解析根，
 * 也是沙箱 workspace-write 边界。
 */
/** 工作树的生命周期状态。 */
export type WorktreeState = 
/** 已创建，任务未开始。 */
'created'
/** 任务正在跑。 */
 | 'active'
/** 任务结束，树干净（无未提交改动、无未跟踪文件）。 */
 | 'clean'
/** 任务结束，树有改动、有未跟踪文件、或有新提交 —— 必须保留。 */
 | 'dirty'
/** 任务结束，但没拿到树状态（git status 失败、目录消失等）—— 必须保留。 */
 | 'unknown'
/** 已移除。 */
 | 'removed';
export interface WorktreeRecord {
    readonly taskId: string;
    readonly runId: string;
    /** 工作树绝对路径。 */
    readonly path: string;
    /**
     * 源仓库（主树）顶层绝对路径。
     *
     * 必须记下来：`git worktree remove` 只能在**主仓库**里执行 ——
     * 在工作树目录里跑会报 "not a git repository"（工作树自己的 .git 是文件不是目录），
     * 在工作树的父目录里跑同样不是仓库。少了这个字段就删不掉树。
     */
    readonly repoPath: string;
    /** 派发时仓库的完整 commit sha，所有并行任务必须一致（同 baseSha 要求）。 */
    readonly baseSha: string;
    /** 分支名，`loom/<runId>/<taskId>`。 */
    readonly branch: string;
    readonly state: WorktreeState;
    readonly createdAt: string;
    readonly updatedAt: string;
    /** 保留/移除的原因，面向用户可读。 */
    readonly reason?: string;
}
/** 保留还是移除。 */
export interface RetentionVerdict {
    readonly action: 'remove' | 'keep';
    readonly nextState: WorktreeState;
    readonly reason: string;
}
/** 任务 id 已经过 `ID_PATTERN` 校验（`^[a-z][a-z0-9_-]{0,63}$`），可以直接进分支名。 */
export declare function worktreeBranch(runId: string, taskId: string): string;
/** 目录名：用 `__` 连接，避免 `/` 造出子目录。 */
export declare function worktreeDirName(runId: string, taskId: string): string;
/**
 * 把任意字符串变成合法的 git ref 段。
 *
 * git ref 的禁用字符比想象的毒：空格、`~^:?*[\`、`..`、`@{`、结尾 `.lock`、
 * 以 `.` 开头或结尾、ASCII 控制字符。任务 id 已经受约束，
 * 但 runId 是 UUID 风格的自造值，这里统一兜一遍，**宁可改写也不让 git 报错**。
 */
export declare function sanitizeRefSegment(raw: string): string;
export declare function worktreePath(root: string, runId: string, taskId: string): string;
/** `git status --porcelain` 的输出摘要（已由 IO 层解析好）。 */
export interface TreeStatus {
    /** 未提交改动（已跟踪文件的修改/删除/重命名）条数。 */
    readonly changed: number;
    /** 未跟踪文件条数。 */
    readonly untracked: number;
    /** 相对 baseSha 的新提交数。 */
    readonly commits: number;
    /** 是否有 stash（工作树里基本不会有，留作扩展）。 */
    readonly stashed: number;
}
export declare const EMPTY_STATUS: TreeStatus;
/**
 * 决定这棵树该不该删。
 *
 * **默认保留。** 只有「三项全零」才删 —— 脏数据比磁盘空间贵得多。
 * `status === null` 表示**没拿到状态**（git 失败、目录没了、超时），
 * 那也必须保留：不知道就等于不安全。
 *
 * @param status 树状态；`null` = 未知。
 */
export declare function decideRetention(status: TreeStatus | null): RetentionVerdict;
/**
 * 扫描一棵树的「有没有值得保留的东西」时，判据只看**这个任务自己的贡献**。
 * 所以 commits 是相对 `baseSha` 数的，不是 `git rev-list --count HEAD`。
 * 这个函数把两个数安全带地相减并夹到非负。
 */
export declare function commitsSince(aheadCount: number | null): number;
export declare function canTransition(from: WorktreeState, to: WorktreeState): boolean;
export declare function assertTransition(from: WorktreeState, to: WorktreeState, taskId: string): void;
/** 终态之外都算「活着」。 */
export declare function isLive(state: WorktreeState): boolean;
export interface IsolationRequest {
    readonly taskId: string;
    readonly repoPath: string;
    readonly baseSha: string;
}
export interface IsolationPlanIssue {
    readonly code: 'EMPTY' | 'DUPLICATE_TASK' | 'DIFFERENT_REPO' | 'DIFFERENT_BASE' | 'BAD_TASK_ID' | 'BAD_BASE_SHA';
    readonly taskId: string;
    readonly detail: string;
}
/**
 * 派发前的隔离前置检查。
 *
 * 「同一基线」是 Loom 的硬要求（03 的验收项）——并行任务如果不在同一 baseSha 上，
 * 合并时会产生无法归因的冲突。所以这里**只在全部一致时才放行**，不一致就报错，
 * 不静默取第一个。
 */
export declare function planIsolation(requests: readonly IsolationRequest[]): IsolationPlanIssue[];
/**
 * `git worktree add` 对**已存在的路径**会直接失败。重跑同一个 run 时
 * 目录可能还在（上一轮保留的脏树）。所以派发前必须换一个不冲突的名字，
 * 或者先确认那棵树是本次 run 的。
 *
 * 返回一个没被占用的后缀（`''` 表示原名可用）。
 */
export declare function pickFreeSuffix(taken: readonly string[], base: string, maxTries?: number): string | null;
/**
 * ── 为什么用 label 传递工作树归属 ──────────────────────────────────────
 *
 * `SubagentStartRequest`（`@deepseek-ai/dsh-subagent`）**没有** cwd 字段，
 * 也不该有：cwd 是会话创建元数据，不是委托参数。可用的传递通道只有 label：
 *
 *   `label?: string` — "Optional short display label persisted with a
 *   session-backed child."
 *
 * 于是 Loom 在派发前把归属编码进 label，provider 在 `start()` 里解回来。
 * 这不是 hack：label 本来就是「这次派发的标识」，而 Loom 需要的正是
 * 「这次派发对应哪棵树」。编码保留了人可读性。
 *
 * ── 为什么必须能明确失败 ────────────────────────────────────────────────
 * label 解析不出来时**绝不能**回落到父会话 cwd —— 那正是「子代理偷偷
 * 在父目录里写代码」这个最危险的失败模式。所以 `parseDispatchLabel()`
 * 返回 null，provider 拿到 null 就抛（见 src/provider.ts）。
 */
/** 派发标签前缀。改它等于改协议，两边必须同步。 */
export declare const DISPATCH_LABEL_PREFIX = "loom";
/** 一个解析成功的派发标签。 */
export interface DispatchLabel {
    readonly runId: string;
    readonly taskId: string;
}
/** 构造派发标签。`runId` / `taskId` 必须已过 `sanitizeRefSegment`（建树时已做）。 */
export declare function dispatchLabel(runId: string, taskId: string): string;
/**
 * 解析派发标签。**不是** Loom 派发的 label 一律返回 null。
 *
 * 认三件事：前缀、恰好 3 段、两个段都非空。多一个冒号就返回 null ——
 * 宁可不认，也不猜哪一段是 id。
 */
export declare function parseDispatchLabel(label: string | undefined): DispatchLabel | null;
/** 派发前的归属裁决：成功。 */
export interface DispatchTarget {
    readonly ok: true;
    readonly runId: string;
    readonly taskId: string;
    readonly path: string;
}
/** 派发前的归属裁决：拒绝。 */
export interface DispatchRefusal {
    readonly ok: false;
    /** 机器可读的原因码。 */
    readonly code: 'NO_LABEL' | 'BAD_LABEL' | 'NO_RECORD' | 'NOT_LIVE' | 'NO_REPO' | 'BAD_PATH';
    /** 给人看的原因，会原样进错误信息。 */
    readonly detail: string;
}
export type DispatchResolution = DispatchTarget | DispatchRefusal;
/**
 * 在「已登记的活树」里找出这次派发该用的那棵。
 *
 * 输入是 `WorktreeRecord` 列表（调用方从 store 里取最近一次状态），
 * 输出是裁决。**五种拒绝各有独立原因码**，因为它们的处置方式不同：
 * `NO_LABEL`/`BAD_LABEL` 是调用方写错，`NO_RECORD` 是顺序错（先派发后建树），
 * `NOT_LIVE` 是树已结算，`NO_REPO`/`BAD_PATH` 是记录损坏。
 */
export declare function resolveDispatch(label: string | undefined, records: readonly WorktreeRecord[]): DispatchResolution;
/**
 * 从一批记录里取「最近一次状态」。store 是追加式的，
 * 同一 `runId/taskId` 可能有多条（created → active → clean）。
 */
export declare function latestRecords(records: readonly WorktreeRecord[]): WorktreeRecord[];
