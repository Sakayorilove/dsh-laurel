import { type LoomCapabilities } from './core/index.js';
import type { LoomConfig } from './config.js';
import type { LoomStore } from './store.js';
import type { IWorktreeManager } from './worktree.js';
export interface HandlerDeps {
    readonly planning?: import('./planning.js').PlanningController;
    readonly diagnostics?: () => unknown;
    readonly store: LoomStore;
    readonly getConfig: () => LoomConfig;
    readonly setConfig: (patch: unknown) => LoomConfig;
    readonly capabilities: () => LoomCapabilities;
    /** 工作树管理器。懒建。**只有 HTTP 破坏性路由**用它。 */
    readonly getWorktrees?: () => IWorktreeManager;
    /**
     * 解析请求归属的工作区。
     *
     * 评审 09 F：归属必须来自**可信来源**（会话 cwd），不是请求参数。
     * 宿主半边由 `src/index.ts` 注入；解析不出时返回 `null`，
     * 调用方必须拒绝写入 —— **不许回落全局**。
     */
    readonly resolveWorkspace?: (req: unknown) => string | null | Promise<string | null>;
    readonly resolveSessionId?: (req: unknown) => string | null | Promise<string | null>;
    readonly resolveSessionCwd?: (req: unknown) => string | null | Promise<string | null>;
    readonly scmFacts?: (cwd: string, sessionId?: string) => Promise<{
        repo: string;
        head: string;
        dirty: boolean;
    }>;
    readonly authorizeDestructiveRequest?: (req: unknown) => boolean | Promise<boolean>;
    readonly log: {
        warn: (...a: unknown[]) => void;
        error: (...a: unknown[]) => void;
    };
}
export declare function createHandler(deps: HandlerDeps): (req: any, res: any) => Promise<void>;
