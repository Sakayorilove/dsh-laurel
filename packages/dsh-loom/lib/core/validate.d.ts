/**
 * 任务图校验：JSON Schema 层 + 语义层。
 *
 * 纪律（02 §6.3、04）：
 * - Schema 合法 ≠ 图可执行。语义层查端口类型、必需输入、无环、ownership、并发与能力。
 * - 每条错误带可定位 path，UI 能聚焦到节点/字段。
 * - 「模型置信度高」不是跳过校验的理由：本模块不读任何 confidence 字段。
 * - 本实现**不放松** planner-output.schema.json 的约束。
 */
import { type Isolation, type RequiredCapability, type TaskEdge, type TaskNode } from './model.js';
export interface LoomIssue {
    readonly code: string;
    readonly path: string;
    readonly message: string;
    readonly severity: 'error' | 'warning';
}
export interface ValidationResult {
    readonly ok: boolean;
    readonly errors: readonly LoomIssue[];
    readonly warnings: readonly LoomIssue[];
}
/**
 * 无环检查。返回真实存在的环（节点 id 序列），空数组表示无环。
 * DFS 三色法 —— 报出的是图里真实存在的环，不是随便一条路径。
 */
export declare function findCycle(nodes: readonly TaskNode[], edges: readonly TaskEdge[]): string[];
/** 每层批次的解析结果。 */
export interface DependencyLayers {
    readonly layers: readonly (readonly string[])[];
    readonly layerOf: ReadonlyMap<string, number>;
}
/** 最长路径分层：一个节点的所有上游一定在更小的层。 */
export declare function dependencyLayers(nodes: readonly {
    id: string;
}[], edges: readonly {
    source: string;
    target: string;
}[]): DependencyLayers;
export interface ValidateOptions {
    /** 本次运行允许的最大并发（来自 executionProposal）。 */
    readonly maxConcurrency?: number;
    /** 运行时探测到的能力，用于拒绝计划里声明的、实际不支持的能力。 */
    readonly availableCapabilities?: readonly RequiredCapability[];
    /** 哪些 isolation 真的可用。缺省表示不做这项检查。 */
    readonly availableIsolations?: readonly Isolation[];
}
export declare function validateWorkflow(input: unknown, options?: ValidateOptions): ValidationResult;
/** 校验一份已采纳的不可变 revision（额外要求 inputDigest / compilerVersion / adoptedAt）。 */
export declare function validateAdoptedRevision(input: unknown, options?: ValidateOptions): ValidationResult;
