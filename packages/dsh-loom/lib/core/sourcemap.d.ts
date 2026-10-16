/**
 * 架构 → 任务的多对多来源映射（07 §3、§6）。
 *
 * 纪律：
 * - 一个架构模块可对应多个实现/验收任务；一个共享准备任务可对应多个模块。
 * - 架构改变接口或模块责任时，关联任务标 stale；**不擅改在途运行**。
 * - 架构同名节点不凭名字自动绑定现有任务。
 */
export interface SourceMapEntry {
    readonly architectureNodeIds: readonly string[];
    readonly decisionIds: readonly string[];
    readonly workflowNodeId: string;
    /** 建立映射时任务所依据的架构 revision。 */
    readonly basedOnArchitectureRevision: number;
    /** 建立映射时任务的语义摘要，用于判断是否已经漂移。 */
    readonly workflowFingerprint: string;
}
export interface SourceMap {
    readonly schemaVersion: 1;
    readonly architectureId: string;
    readonly workflowId: string;
    readonly entries: readonly SourceMapEntry[];
}
export interface StaleReport {
    readonly architectureId: string;
    readonly architectureRevision: number;
    readonly stale: readonly {
        readonly workflowNodeId: string;
        readonly reason: string;
    }[];
    readonly fresh: readonly string[];
    /** 新架构里有、但没有任何任务覆盖的模块。 */
    readonly uncoveredArchitectureNodes: readonly string[];
    /** 任务引用了新架构里已经不存在的模块。 */
    readonly danglingArchitectureNodes: readonly string[];
}
/**
 * 判断哪些任务因为架构更新而 stale。
 *
 * @param sourceMap 现有映射
 * @param currentArchitectureRevision 新架构的 revision
 * @param liveArchitectureNodeIds 新架构里仍然存在的模块 id
 */
export declare function computeStale(sourceMap: SourceMap, currentArchitectureRevision: number, liveArchitectureNodeIds: readonly string[]): StaleReport;
export declare function validateSourceMap(map: unknown, workflowNodeIds: readonly string[]): string[];
