export declare const PRESENTATION_SCHEMA_VERSION: 1;
export interface NodeLayout {
    readonly nodeId: string;
    readonly x: number;
    readonly y: number;
    readonly width?: number;
    readonly height?: number;
    readonly collapsed?: boolean;
}
/** 分组框：只影响展示与导航，**不改变调度顺序**（06 §5）。 */
export interface GroupFrame {
    readonly id: string;
    readonly title: string;
    readonly memberIds: readonly string[];
    readonly color?: string;
    readonly collapsed?: boolean;
}
/** reroute 点：只整理线，不改变任务语义。 */
export interface Reroute {
    readonly id: string;
    readonly x: number;
    readonly y: number;
}
export interface Annotation {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly text: string;
}
export interface Viewport {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
}
export interface Presentation {
    readonly schemaVersion: 1;
    readonly workflowId: string;
    /** 这份布局对应的任务 revision；切到新 revision 时布局可复用，但语义以 revision 为准。 */
    readonly forRevision: number;
    readonly nodes: readonly NodeLayout[];
    readonly groups: readonly GroupFrame[];
    readonly reroutes: readonly Reroute[];
    readonly annotations: readonly Annotation[];
    readonly viewport?: Viewport;
}
export declare function emptyPresentation(workflowId: string, forRevision: number): Presentation;
/** 只比较布局：节点坐标、折叠、分组、注释、视口。 */
export declare function layoutDigest(p: Presentation): string;
export declare function layoutChanged(a: Presentation, b: Presentation): boolean;
/**
 * 简易分层自动初排（不是 ELK/Dagre 的替代品，只是空状态下的默认摆放）。
 * 它**只**产生坐标，不产生任何语义变更，也不启动模型。
 */
export declare function autoLayout(nodeIdsByLayer: readonly (readonly string[])[], options?: {
    xGap?: number;
    yGap?: number;
}): NodeLayout[];
