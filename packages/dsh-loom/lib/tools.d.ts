/**
 * dsh-loom · 宿主半边：模型侧工具。
 *
 * ── 为什么不用 `defineTool` ────────────────────────────────────────────
 * `defineTool` 只做两件事：把作者 DSL 编译成 JSON Schema、校验 `timeoutMs`。
 * 这里直接把**编译后的 JSON Schema** 交给 `ctx.tools.register()` ——
 * 那正是 `defineTool` 的返回值，也是官方 README 说的 wire-level 形式。
 * 好处是宿主半边**零非内置 import**（core 会被打包进来，不靠运行时解析）。
 *
 * ── ⚠ `required` 必须是父级字符串数组 ─────────────────────────────────
 * 宿主的 `JsonSchemaNode` 只支持 `required?: string[]`，**没有** `required: boolean`。
 * 写成布尔值会被当未知关键字丢掉：**不报错、不告警，必填校验静默失效**。
 * 所以 `assertRequiredShape()` 在装载期就抛，见下。
 */
import { type LoomCapabilities, type WorkflowRevision } from './core/index.js';
import type { LoomStore } from './store.js';
import type { LoomConfig } from './config.js';
import type { IWorktreeManager } from './worktree.js';
export interface ToolDeps {
    readonly planning?: import('./planning.js').PlanningController;
    readonly store: LoomStore;
    readonly getConfig: () => LoomConfig;
    readonly log: {
        info: (...a: unknown[]) => void;
        warn: (...a: unknown[]) => void;
        error: (...a: unknown[]) => void;
    };
    /** 运行时能力探测结果；缺省用 P0 实测的静态表。 */
    readonly capabilities?: () => LoomCapabilities;
    /**
     * 工作树管理器。只做「建树 / 查状态 / 移除」，
     * 由 `loom_worktree` 工具暴露给用户。
     */
    readonly getWorktrees?: () => IWorktreeManager;
    readonly runWorkflow?: (workflow: WorkflowRevision, exec: unknown, args: Record<string, unknown>) => Promise<any>;
}
/**
 * 守住 `required` 的形状。
 * 宿主的 JSON Schema 子集只有 `required?: string[]`；写成布尔值会静默失效。
 */
export declare function assertRequiredShape(toolName: string, schema: unknown): void;
export declare function createTools(deps: ToolDeps): Record<string, unknown>[];
/** 供测试断言用：暴露一个能构造 WorkflowRevision 的便捷函数。 */
export declare function summarizeWorkflow(wf: WorkflowRevision): string;
