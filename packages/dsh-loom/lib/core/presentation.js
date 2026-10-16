/**
 * 布局 / 分组 / 注释 —— 与任务语义**分开**保存（06 §7）。
 *
 * 纪律：
 * - 画布 state 只保存布局和展开状态；React Flow 的内部对象**不是**后端调度的唯一事实源。
 * - 拖节点改布局 → 不改变依赖、不使运行结果失效、不产生语义 diff。
 * - 编译时直接消除 reroute 展示点。
 */
import { contentDigest } from './digest.js';
export const PRESENTATION_SCHEMA_VERSION = 1;
export function emptyPresentation(workflowId, forRevision) {
    return {
        schemaVersion: PRESENTATION_SCHEMA_VERSION,
        workflowId,
        forRevision,
        nodes: [],
        groups: [],
        reroutes: [],
        annotations: [],
    };
}
/** 只比较布局：节点坐标、折叠、分组、注释、视口。 */
export function layoutDigest(p) {
    return contentDigest({
        nodes: p.nodes.map((n) => ({ nodeId: n.nodeId, x: n.x, y: n.y, collapsed: n.collapsed === true })),
        groups: p.groups.map((g) => ({ id: g.id, memberIds: g.memberIds, collapsed: g.collapsed === true })),
        reroutes: p.reroutes.map((r) => ({ id: r.id, x: r.x, y: r.y })),
        annotations: p.annotations.map((a) => ({ id: a.id, text: a.text })),
        viewport: p.viewport ?? null,
    });
}
export function layoutChanged(a, b) {
    return layoutDigest(a) !== layoutDigest(b);
}
/**
 * 简易分层自动初排（不是 ELK/Dagre 的替代品，只是空状态下的默认摆放）。
 * 它**只**产生坐标，不产生任何语义变更，也不启动模型。
 */
export function autoLayout(nodeIdsByLayer, options = {}) {
    const xGap = options.xGap ?? 320;
    const yGap = options.yGap ?? 180;
    const out = [];
    nodeIdsByLayer.forEach((layer, li) => {
        layer.forEach((id, i) => {
            out.push({ nodeId: id, x: li * xGap, y: i * yGap });
        });
    });
    return out;
}
