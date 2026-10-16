export declare const PACKAGE_NAME = "dsh-loom";
/**
 * 版本号。**必须与 `package.json` 的 `version` 一致** ——
 * 评审 09 的 H 发现过两处不一致（源码写 0.1.0、package.json 写 0.2.0），
 * 那种不一致会让「包是什么状态」无法核对。`scripts/check-bundle.mjs` 会断言相等。
 */
export declare const VERSION = "0.8.6";
/** 解析 dsh 家目录。 */
export declare function resolveDshHome(): string;
/**
 * 全局路径（**不分区**的那些）。
 *
 * 分区口径（评审 09 F，详见 `src/core/scope.ts` 文件头）：
 *   有「当前状态」语义的（草案/布局/来源映射）→ 按工作区分区。
 *   只追加不覆盖的事实日志（revision/架构/运行/事件/工作树）→ 保持全局，
 *   因为它们自带 workflowId / runId，按标识过滤即可，混在一起反而便于排错。
 */
export interface LoomPaths {
    readonly home: string;
    readonly root: string;
    readonly revisions: string;
    readonly architectures: string;
    readonly events: string;
    readonly runs: string;
    /** 工作树记录（追加式 JSONL）：`$DSH_HOME/loom/worktrees.jsonl`。 */
    readonly worktrees: string;
    /**
     * @deprecated 旧版全局草案文件。**仍可读**（迁移要用），
     * 但新写入一律走 `loomWorkspacePaths()`。本字段在迁移完成后会被移除。
     */
    readonly legacyDrafts: string;
    /** @deprecated 旧版全局布局文件。同 `legacyDrafts`。 */
    readonly legacyPresentation: string;
    /** @deprecated 旧版全局来源映射文件。同 `legacyDrafts`。 */
    readonly legacySourcemap: string;
    /** 工作区分区目录的父目录：`$DSH_HOME/loom/workspaces/`。 */
    readonly workspacesRoot: string;
}
export declare function loomPaths(home?: string): LoomPaths;
/** 一个工作区的分区路径（评审 09 F）。 */
export interface LoomWorkspacePaths {
    readonly workspaceId: string;
    readonly dir: string;
    readonly drafts: string;
    readonly presentation: string;
    readonly sourcemap: string;
    readonly revisions: string;
    readonly architectures: string;
}
/**
 * 取某个工作区的分区路径。
 *
 * ⚠ 工作区 id 不合法时**抛错**，不回落全局 —— 那正是评审 F 描述的泄漏路径。
 * 调用方应先用 `normalizeWorkspaceId()` 把外部输入规范化。
 */
export declare function loomWorkspacePaths(paths: LoomPaths, workspaceId: string): LoomWorkspacePaths;
export declare function ensureDir(dir: string): void;
export interface LoomConfig {
    readonly enabled: boolean;
    readonly defaultMode: 'auto' | 'manual';
    readonly autoCollectReplies: boolean;
    /** 是否允许模型通过工具写草案（默认只允许读与校验）。 */
    readonly allowModelDraftWrite: boolean;
    /** 默认并发上限，不得超过宿主硬上限。 */
    readonly maxRepairRounds: number;
    readonly defaultMaxConcurrency: number;
    /** 是否在 agent 前置步骤注入「当前草案摘要」。 */
    readonly injectDraftSummary: boolean;
    /** 是否在画布连线上画方向箭头。 */
    readonly edgeArrows: boolean;
    /** 新会话是否默认开启规划模式（该会话一旦手动改过就以会话记录为准）。 */
    readonly planningModeDefault: boolean;
    /** 箭头流动：跟随系统动态效果偏好 / 始终流动 / 静止。 */
    readonly edgeMotion: 'auto' | 'on' | 'off';
    /** 规划模式的主色（聊天框着色与发光）。 */
    readonly planningModeColor: string;
    /** 欢迎页题词：开关、字体、字号、颜色、发光强度（0-3）、描边宽度与颜色。 */
    readonly welcomeEnabled: boolean;
    readonly welcomeFont: string;
    readonly welcomeFontSize: number;
    readonly welcomeColor: string;
    readonly welcomeGlow: number;
    readonly welcomeStroke: number;
    readonly welcomeStrokeColor: string;
    /** 注入的最大字符数。 */
    readonly maxInjectChars: number;
    /** 是否把事件写到 $DSH_HOME/loom/events.log。 */
    readonly eventLog: boolean;
    readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}
export declare const DEFAULT_CONFIG: LoomConfig;
export declare function normalizeConfig(input: unknown, base?: LoomConfig): LoomConfig;
export declare function clampInt(value: unknown, min: number, max: number, fallback: number): number;
/** User settings are validated before persistence; malformed values never silently enable execution. */
export declare function validateConfigPatch(input: unknown): void;
