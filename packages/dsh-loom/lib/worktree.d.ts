import { type RetentionVerdict, type WorktreeRecord } from './core/worktree-plan.js';
import type { LoomPaths } from './config.js';
export interface GitResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}
export declare function git(cwd: string, args: readonly string[], timeoutMs?: number): Promise<GitResult>;
export declare class WorktreeError extends Error {
    readonly detail: readonly string[];
    constructor(message: string, detail?: readonly string[]);
}
export interface RepoProbe {
    readonly ok: boolean;
    /** 仓库顶层绝对路径（`git rev-parse --show-toplevel`）。 */
    readonly topLevel?: string;
    /** 当前 HEAD 的完整 sha。 */
    readonly headSha?: string;
    /** 是否在 worktree 里（而非主树）。 */
    readonly isLinkedWorktree?: boolean;
    readonly detail: readonly string[];
}
/**
 * 只读探测一个目录是不是 git 仓库，并拿到 baseSha。
 *
 * 注意 `--show-toplevel` 在 worktree 里返回的是**那棵树自己的**顶层，
 * `--git-common-dir` 才指向共享的 `.git`。我们同时读两个，才能判断
 * 「这个仓库能不能开工作树」（bare 仓库不行）。
 */
export declare function probeRepo(path: string): Promise<RepoProbe>;
export interface WorktreeStore {
    readonly file: string;
    append(record: WorktreeRecord): void;
    listAll(): WorktreeRecord[];
    latest(): Map<string, WorktreeRecord>;
}
export declare function createWorktreeStore(paths: LoomPaths): WorktreeStore;
export interface WorktreeManagerOptions {
    readonly paths: LoomPaths;
    /** 工作树放在哪。默认 `$DSH_HOME/loom/worktrees`。 */
    readonly root?: string;
    readonly log?: {
        debug(msg: string): void;
        info(msg: string): void;
        warn(msg: string): void;
        error(msg: string): void;
    };
}
export interface CreateWorktreesResult {
    readonly ok: boolean;
    readonly repoPath?: string;
    readonly baseSha?: string;
    readonly records: readonly WorktreeRecord[];
    readonly problems: readonly string[];
}
export interface IWorktreeManager {
    /** 建一组工作树（一次 run 的全部任务）。失败时已建的树会被回滚移除。 */
    create(runId: string, repoPath: string, taskIds: readonly string[]): Promise<CreateWorktreesResult>;
    /** 结算一棵树：查状态 → 裁决 → 需要时移除。 */
    settle(runId: string, taskId: string): Promise<RetentionVerdict>;
    /** 结算整个 run。 */
    settleRun(runId: string): Promise<readonly RetentionVerdict[]>;
    /** 列出活着的树。 */
    listLive(runId?: string): WorktreeRecord[];
    /** 查一棵树的记录（不管死活）。找不到返回 null。 */
    find(runId: string, taskId: string): WorktreeRecord | null;
    /** 这棵树应该在的路径（有记录用记录，没记录用路径规划）。 */
    pathFor(runId: string, taskId: string): string;
    /** 这棵树里会被丢弃的东西。供用户确认删除前查看。 */
    describeChanges(runId: string, taskId: string): Promise<readonly string[]>;
    /** 强制移除一棵树（**只由 HTTP 破坏性路由在用户二次确认后调用**）。 */
    forceRemove(runId: string, taskId: string): Promise<{
        ok: boolean;
        detail: string;
    }>;
    /** 路径规划：不落盘，只看会建在哪。 */
    preview(runId: string, taskIds: readonly string[]): {
        taskId: string;
        path: string;
        branch: string;
    }[];
}
export declare function createWorktreeManager(options: WorktreeManagerOptions): IWorktreeManager;
/** 收尾：`git worktree prune` 清掉已经不存在的工作树的元数据。 */
export declare function pruneWorktrees(repoPath: string): Promise<GitResult>;
/** 删除一个分支（树移除之后调用）。失败不抛 —— 分支可能已经被合并删除。 */
export declare function deleteBranch(repoPath: string, branch: string): Promise<GitResult>;
/**
 * 把官方 `childSessionMeta()` 的产物改写成指向本任务工作树。
 *
 * 为什么必须覆盖：官方那个函数**原样继承父 cwd**（见
 * `dsh-subagent/lib/types/child-agent.js:111`），不清空的话所有子代理会
 * 共用一个目录，隔离等于没做。
 *
 * 只改 `cwd`，其余字段（parentSession / isSeeded / origin / delegationDepth /
 * agentPreset）全部保留 —— 那条血缘链是宿主用来重建历史的，动它会把
 * 子会话历史搞坏。
 */
export declare function withTaskCwd<T extends {
    readonly cwd?: string;
}>(meta: T, worktreePath: string): T & {
    readonly cwd: string;
};
/** 断言工作树路径是绝对的 —— 宿主的 session 校验只认绝对路径。 */
export declare function assertAbsoluteForSession(p: string): void;
