/** Workspace identities are derived from host-owned cwd. Every project graph,
 * draft, layout and source map is partitioned; unowned legacy logs are not auto-assigned. */
/** 工作区标识。只允许安全字符：它会进文件名。 */
export interface WorkspaceId {
    readonly workspaceId: string;
}
/**
 * 校验工作区标识。
 *
 * 为什么必须严格：它会变成**目录名**。放任 `../` 会写出数据目录之外，
 * 放任空串会让所有项目落回同一个「全局」。
 */
export declare function isValidWorkspaceId(raw: unknown): raw is string;
/**
 * 把任意来源的字符串规范成合法工作区 id。
 *
 * 返回 `null` 表示**无法安全归属** —— 调用方必须拒绝，不许猜一个默认值。
 * 这是刻意的：猜错的代价是把 A 项目的约束注入 B 项目。
 */
export declare function normalizeWorkspaceId(raw: unknown): string | null;
/** 旧版遗留的全局文件名（相对于 loom 根）。 */
export declare const LEGACY_GLOBAL_FILES: readonly ["drafts.json", "presentation.json", "sourcemap.json"];
export type LegacyGlobalFile = (typeof LEGACY_GLOBAL_FILES)[number];
/** 一个工作区的状态目录名。 */
export declare function workspaceDirName(workspaceId: string): string;
/** 迁移计划：把一个旧全局文件搬到某个工作区。纯计算，不落盘。 */
export interface MigrationPlan {
    readonly file: LegacyGlobalFile;
    readonly from: string;
    readonly to: string;
    /** true 表示目标已存在，搬过去会覆盖 —— 调用方必须先决定怎么处理。 */
    readonly targetExists: boolean;
}
export interface MigrationRequest {
    readonly root: string;
    readonly workspaceId: string;
    /** 已存在的老文件（由调用方 stat 得到，本层不做 IO）。 */
    readonly existing: readonly LegacyGlobalFile[];
    /** 目标工作区目录下已存在的文件（由调用方 stat 得到）。 */
    readonly existingInTarget: readonly LegacyGlobalFile[];
    /** 是否把原文件改名成 `.migrated-backup` 保留。评审要求：保留备份。 */
    readonly keepBackup: boolean;
}
export interface MigrationResult {
    readonly plans: readonly MigrationPlan[];
    /** 拒绝执行的原因（非空时 plans 不应被执行）。 */
    readonly blockers: readonly string[];
}
/**
 * 规划旧全局文件 → 工作区的迁移。
 *
 * 纪律（评审步骤 1 第 3 条：「旧全局文件迁移需预览并保留备份，不能猜归属」）：
 *   - 只处理**调用方显式列出**的文件，不自动发现
 *   - 目标已存在 → 记为 blocker，**不静默覆盖**
 *   - `keepBackup` 由调用方决定；默认建议 true
 */
export declare function planMigration(req: MigrationRequest): MigrationResult;
/**
 * 归属检查：某个资源是否属于给定工作区。
 *
 * 用于注入与 HTTP 读写的服务端核对。**不匹配就是拒绝**，
 * 不是「回落到全局」—— 那正是评审 F 描述的泄漏路径。
 */
export interface OwnershipCheck {
    readonly ok: boolean;
    readonly reason?: string;
}
export declare function checkOwnership(resourceWorkspaceId: string | undefined | null, requestWorkspaceId: string | undefined | null): OwnershipCheck;
/** 草案写入请求携带的期望 revision。 */
export interface RevisionGuard {
    readonly expectedRevision: number | null;
}
export interface GuardVerdict {
    readonly ok: boolean;
    /** 冲突时给调用方的可定位信息。 */
    readonly conflict?: {
        readonly currentRevision: number | null;
        readonly expectedRevision: number | null;
        readonly detail: string;
    };
}
/**
 * 乐观并发闸门。
 *
 * 评审步骤 1 第 4 条：「草案写入携带 `expectedRevision`，旧窗口更新返回可定位冲突，
 * 不静默覆盖。」
 *
 * 语义：
 *   - `expectedRevision === null` → 调用方声明「我认为现在没有草案」。
 *     若实际已有草案 → 冲突（旧窗口凭「空」覆盖新稿，正是要拦的）。
 *   - `expectedRevision === n` → 必须与当前一致，否则冲突。
 *   - 当前无草案（null）而 expected 是数字 → 冲突（草案被别人删了或从没写过）。
 *
 * 不用「大于」判断：revision 必须**恰好相等**。允许「基于更旧的版本覆盖」
 * 会让两个窗口各改一半、后提交者赢，静默丢改动。
 */
export declare function checkRevisionGuard(current: number | null, guard: RevisionGuard): GuardVerdict;
