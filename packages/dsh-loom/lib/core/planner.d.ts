import { type WorkflowRevision } from './model.js';
import { type LoomIssue, type ValidateOptions } from './validate.js';
/** Schema 定向修复的次数上限（02 §6.3：最多两次）。 */
export declare const MAX_SCHEMA_REPAIRS = 2;
export interface AdoptionOptions extends ValidateOptions {
    readonly inputDigest?: string;
    readonly adoptedAt?: string;
}
export interface AdoptionResult {
    readonly accepted: boolean;
    readonly workflow: WorkflowRevision | null;
    readonly errors: readonly LoomIssue[];
    readonly warnings: readonly LoomIssue[];
    /** 必须显示给用户的阻塞项。 */
    readonly blocked: readonly {
        readonly nodeId: string;
        readonly reason: string;
    }[];
}
/**
 * 把候选提案收成一份不可变 revision。
 * 校验不通过就**不**产出 revision —— 没有「部分接受」这回事。
 */
export declare function adoptPlannerOutput(proposal: unknown, options?: AdoptionOptions): AdoptionResult;
export interface RepairBudget {
    readonly repairsUsed: number;
}
export declare function canRepair(budget: RepairBudget): boolean;
/** 给模型看的修复指令：只带错误路径与原因，不带任何执行权限。 */
export declare function renderRepairInstruction(errors: readonly LoomIssue[]): string;
