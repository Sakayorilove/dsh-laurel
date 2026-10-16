/**
 * 布局 / 分组 / 注释 —— 与任务语义**分开**保存。
 *
 * 纪律：
 * - 画布 state 只保存布局和展开状态；React Flow 的内部对象**不是**后端调度的唯一事实源。
 * - 拖节点改布局 → 不改变依赖、不使运行结果失效、不产生语义 diff。
 * - 编译时直接消除 reroute 展示点。
 */
import { contentDigest } from './digest.js'

export const PRESENTATION_SCHEMA_VERSION = 1 as const

export interface NodeLayout {
  readonly nodeId: string
  readonly x: number
  readonly y: number
  readonly width?: number
  readonly height?: number
  readonly collapsed?: boolean
}

/** 分组框：只影响展示与导航，**不改变调度顺序**。 */
export interface GroupFrame {
  readonly id: string
  readonly title: string
  readonly memberIds: readonly string[]
  readonly color?: string
  readonly collapsed?: boolean
}

/** reroute 点：只整理线，不改变任务语义。 */
export interface Reroute {
  readonly id: string
  readonly x: number
  readonly y: number
}

export interface Annotation {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly text: string
}

export interface Viewport {
  readonly x: number
  readonly y: number
  readonly zoom: number
}

export interface Presentation {
  readonly schemaVersion: 1
  readonly workflowId: string
  /** 这份布局对应的任务 revision；切到新 revision 时布局可复用，但语义以 revision 为准。 */
  readonly forRevision: number
  readonly nodes: readonly NodeLayout[]
  readonly groups: readonly GroupFrame[]
  readonly reroutes: readonly Reroute[]
  readonly annotations: readonly Annotation[]
  readonly viewport?: Viewport
}

export function emptyPresentation(workflowId: string, forRevision: number): Presentation {
  return {
    schemaVersion: PRESENTATION_SCHEMA_VERSION,
    workflowId,
    forRevision,
    nodes: [],
    groups: [],
    reroutes: [],
    annotations: [],
  }
}

/** 只比较布局：节点坐标、折叠、分组、注释、视口。 */
export function layoutDigest(p: Presentation): string {
  return contentDigest({
    nodes: p.nodes.map((n) => ({ nodeId: n.nodeId, x: n.x, y: n.y, collapsed: n.collapsed === true })),
    groups: p.groups.map((g) => ({ id: g.id, memberIds: g.memberIds, collapsed: g.collapsed === true })),
    reroutes: p.reroutes.map((r) => ({ id: r.id, x: r.x, y: r.y })),
    annotations: p.annotations.map((a) => ({ id: a.id, text: a.text })),
    viewport: p.viewport ?? null,
  })
}

export function layoutChanged(a: Presentation, b: Presentation): boolean {
  return layoutDigest(a) !== layoutDigest(b)
}

/**
 * 简易分层自动初排（不是 ELK/Dagre 的替代品，只是空状态下的默认摆放）。
 * 它**只**产生坐标，不产生任何语义变更，也不启动模型。
 */
export function autoLayout(nodeIdsByLayer: readonly (readonly string[])[], options: { xGap?: number; yGap?: number } = {}): NodeLayout[] {
  const xGap = options.xGap ?? 320
  const yGap = options.yGap ?? 180
  const out: NodeLayout[] = []
  nodeIdsByLayer.forEach((layer, li) => {
    layer.forEach((id, i) => {
      out.push({ nodeId: id, x: li * xGap, y: i * yGap })
    })
  })
  return out
}
