/**
 * 架构图数据模型与校验。
 *
 * 与任务图**分开**（07 §3）：
 * - 架构允许双向关系和环（前后端互相调用/发事件是合法的）。
 * - 架构节点不能被直接派发；它通过 SourceMap 多对多映射到开工任务。
 * - 不往任务 Schema 里加架构字段；这里是独立版本化结构。
 */
import type { ValidationResult } from './validate.js';
export declare const ARCH_SCHEMA_VERSION: 1;
export type ArchNodeKind = 'module' | 'service' | 'data' | 'interface' | 'decision' | 'external';
export declare const ARCH_NODE_KINDS: readonly ArchNodeKind[];
/** 关系类型：调用 / 数据流 / 事件 / 部署。 */
export type ArchEdgeKind = 'call' | 'data' | 'event' | 'deploy';
export declare const ARCH_EDGE_KINDS: readonly ArchEdgeKind[];
export interface ArchNode {
    readonly id: string;
    readonly kind: ArchNodeKind;
    readonly title: string;
    /** 完整责任说明。图节点只显示摘要，这里保留全文。 */
    readonly responsibility: string;
    /** 对外接口/协议摘要。 */
    readonly interface?: readonly string[];
    readonly sourceRefs?: readonly string[];
    /** 用户锁定：模型不得修改。 */
    readonly locked?: boolean;
}
export interface ArchEdge {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly kind: ArchEdgeKind;
    /** 双向关系。架构层合法，转任务时不得直接当成相互等待。 */
    readonly bidirectional?: boolean;
    readonly description?: string;
}
export interface ArchitectureRevision {
    readonly schemaVersion: 1;
    readonly architectureId: string;
    readonly revision: number;
    readonly nodes: readonly ArchNode[];
    readonly edges: readonly ArchEdge[];
    /** 用户锁定的技术栈/接口/目录/环境等约束，权威值来自用户配置。 */
    readonly constraints?: readonly string[];
    readonly openQuestions?: readonly string[];
    readonly createdAt: string;
    /** 未映射进结构的原文残留，必须可见，不能静默丢弃。 */
    readonly unmapped?: readonly string[];
    readonly note?: string;
}
export declare function validateArchitecture(input: unknown): ValidationResult;
/** 架构层的强连通分组，仅用于展示与「转任务时要打断哪些环」的提示。 */
export declare function findArchitectureCycles(nodes: readonly ArchNode[], edges: readonly ArchEdge[]): string[][];
