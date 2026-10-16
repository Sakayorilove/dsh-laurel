/**
 * 架构图数据模型与校验。
 *
 * 与任务图**分开**：
 * - 架构允许双向关系和环（前后端互相调用/发事件是合法的）。
 * - 架构节点不能被直接派发；它通过 SourceMap 多对多映射到开工任务。
 * - 不往任务 Schema 里加架构字段；这里是独立版本化结构。
 */
import type { LoomIssue, ValidationResult } from './validate.js'

export const ARCH_SCHEMA_VERSION = 1 as const

export type ArchNodeKind = 'module' | 'service' | 'data' | 'interface' | 'decision' | 'external'

export const ARCH_NODE_KINDS: readonly ArchNodeKind[] = [
  'module',
  'service',
  'data',
  'interface',
  'decision',
  'external',
] as const

/** 关系类型：调用 / 数据流 / 事件 / 部署。 */
export type ArchEdgeKind = 'call' | 'data' | 'event' | 'deploy'

export const ARCH_EDGE_KINDS: readonly ArchEdgeKind[] = ['call', 'data', 'event', 'deploy'] as const

export interface ArchNode {
  readonly id: string
  readonly kind: ArchNodeKind
  readonly title: string
  /** 完整责任说明。图节点只显示摘要，这里保留全文。 */
  readonly responsibility: string
  /** 对外接口/协议摘要。 */
  readonly interface?: readonly string[]
  readonly sourceRefs?: readonly string[]
  /** 用户锁定：模型不得修改。 */
  readonly locked?: boolean
}

export interface ArchEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly kind: ArchEdgeKind
  /** 双向关系。架构层合法，转任务时不得直接当成相互等待。 */
  readonly bidirectional?: boolean
  readonly description?: string
}

export interface ArchitectureRevision {
  readonly schemaVersion: 1
  readonly architectureId: string
  readonly revision: number
  readonly nodes: readonly ArchNode[]
  readonly edges: readonly ArchEdge[]
  /** 用户锁定的技术栈/接口/目录/环境等约束，权威值来自用户配置。 */
  readonly constraints?: readonly string[]
  readonly openQuestions?: readonly string[]
  readonly createdAt: string
  /** 未映射进结构的原文残留，必须可见，不能静默丢弃。 */
  readonly unmapped?: readonly string[]
  readonly note?: string
}

function err(code: string, path: string, message: string): LoomIssue {
  return { code, path, message, severity: 'error' }
}

function warn(code: string, path: string, message: string): LoomIssue {
  return { code, path, message, severity: 'warning' }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function validateArchitecture(input: unknown): ValidationResult {
  const errors: LoomIssue[] = []
  const warnings: LoomIssue[] = []

  if (!isObj(input)) {
    return { ok: false, errors: [err('ROOT_NOT_OBJECT', '', '顶层必须是对象')], warnings }
  }
  if (input['schemaVersion'] !== ARCH_SCHEMA_VERSION) {
    errors.push(err('SCHEMA_VERSION', 'schemaVersion', `必须是 ${ARCH_SCHEMA_VERSION}`))
  }
  if (typeof input['architectureId'] !== 'string' || (input['architectureId'] as string).length === 0) {
    errors.push(err('ARCH_ID_MISSING', 'architectureId', 'architectureId 必须是非空字符串'))
  }
  if (!Number.isInteger(input['revision']) || (input['revision'] as number) < 1) {
    errors.push(err('REVISION_INVALID', 'revision', 'revision 必须是 >= 1 的整数'))
  }
  const keys = new Set(['schemaVersion', 'architectureId', 'revision', 'nodes', 'edges', 'constraints', 'openQuestions', 'createdAt', 'unmapped', 'note'])
  for (const key of Object.keys(input)) if (!keys.has(key)) errors.push(err('UNKNOWN_FIELD', key, '未知字段，请放入 unmapped 并解释'))
  if (typeof input['createdAt'] !== 'string' || Number.isNaN(Date.parse(input['createdAt']))) errors.push(err('CREATED_AT_INVALID', 'createdAt', '需要合法时间'))
  const strings = (value: unknown, path: string) => {
    if (value !== undefined && (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))) errors.push(err('STRING_ARRAY_REQUIRED', path, '必须为字符串数组'))
  }
  for (const key of ['constraints', 'openQuestions', 'unmapped']) strings(input[key], key)
  if (input['note'] !== undefined && typeof input['note'] !== 'string') errors.push(err('NOTE_INVALID', 'note', '必须为字符串'))
  const rawNodes = input['nodes']
  const rawEdges = input['edges']
  if (!Array.isArray(rawNodes)) errors.push(err('NODES_NOT_ARRAY', 'nodes', 'nodes 必须是数组'))
  if (!Array.isArray(rawEdges)) errors.push(err('EDGES_NOT_ARRAY', 'edges', 'edges 必须是数组'))
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) return { ok: false, errors, warnings }

  const ids = new Set<string>()
  rawNodes.forEach((n, i) => {
    if (!isObj(n)) {
      errors.push(err('NODE_NOT_OBJECT', `nodes[${i}]`, '节点必须是对象'))
      return
    }
    const id = n['id']
    strings(n['interface'], `nodes[${i}].interface`)
    strings(n['sourceRefs'], `nodes[${i}].sourceRefs`)
    if (n['locked'] !== undefined && typeof n['locked'] !== 'boolean') errors.push(err('LOCK_INVALID', `nodes[${i}].locked`, 'locked 必须是布尔值'))
    const nodeKeys = new Set(['id', 'kind', 'title', 'responsibility', 'interface', 'sourceRefs', 'locked'])
    for (const key of Object.keys(n)) if (!nodeKeys.has(key)) errors.push(err('UNKNOWN_FIELD', `nodes[${i}].${key}`, '未知节点字段'))
    if (typeof id !== 'string' || id.length === 0) {
      errors.push(err('NODE_ID_MISSING', `nodes[${i}].id`, '缺少 id'))
    } else if (ids.has(id)) {
      errors.push(err('NODE_ID_DUPLICATE', `nodes[${i}].id`, `id 重复：${id}`))
    } else {
      ids.add(id)
    }
    if (typeof n['kind'] !== 'string' || !ARCH_NODE_KINDS.includes(n['kind'] as ArchNodeKind)) {
      errors.push(err('NODE_KIND_UNKNOWN', `nodes[${i}].kind`, `kind 必须是 ${ARCH_NODE_KINDS.join(' / ')}`))
    }
    if (typeof n['title'] !== 'string' || (n['title'] as string).trim() === '') {
      errors.push(err('NODE_TITLE_MISSING', `nodes[${i}].title`, 'title 不能为空'))
    }
    if (typeof n['responsibility'] !== 'string' || (n['responsibility'] as string).trim() === '') {
      errors.push(
        err('NODE_RESPONSIBILITY_MISSING', `nodes[${i}].responsibility`, 'responsibility 不能为空（图里只显示摘要，全文必须保留）'),
      )
    }
  })

  const edgeIds = new Set<string>()
  rawEdges.forEach((e, i) => {
    if (!isObj(e)) {
      errors.push(err('EDGE_NOT_OBJECT', `edges[${i}]`, '边必须是对象'))
      return
    }
    if (e['bidirectional'] !== undefined && typeof e['bidirectional'] !== 'boolean') errors.push(err('BIDIRECTIONAL_INVALID', `edges[${i}].bidirectional`, '必须为布尔值'))
    if (e['description'] !== undefined && typeof e['description'] !== 'string') errors.push(err('DESCRIPTION_INVALID', `edges[${i}].description`, '必须为字符串'))
    const edgeKeys = new Set(['id', 'from', 'to', 'kind', 'bidirectional', 'description'])
    for (const key of Object.keys(e)) if (!edgeKeys.has(key)) errors.push(err('UNKNOWN_FIELD', `edges[${i}].${key}`, '未知关系字段'))
    if (typeof e['id'] !== 'string' || (e['id'] as string).length === 0) {
      errors.push(err('EDGE_ID_MISSING', `edges[${i}].id`, '缺少 id'))
    } else if (edgeIds.has(e['id'] as string)) {
      errors.push(err('EDGE_ID_DUPLICATE', `edges[${i}].id`, `id 重复：${e['id']}`))
    } else {
      edgeIds.add(e['id'] as string)
    }
    for (const end of ['from', 'to'] as const) {
      const v = e[end]
      if (typeof v !== 'string' || !ids.has(v)) {
        errors.push(err('EDGE_ENDPOINT_UNKNOWN', `edges[${i}].${end}`, `找不到节点：${String(v)}`))
      }
    }
    if (typeof e['kind'] !== 'string' || !ARCH_EDGE_KINDS.includes(e['kind'] as ArchEdgeKind)) {
      errors.push(err('EDGE_KIND_UNKNOWN', `edges[${i}].kind`, `kind 必须是 ${ARCH_EDGE_KINDS.join(' / ')}`))
    }
    if (e['from'] === e['to']) {
      errors.push(err('EDGE_SELF_LOOP', `edges[${i}]`, '架构图也不接受自环'))
    }
  })

  // 架构**允许**环 —— 这里只给提示，不算错误。
  const cycles = findArchitectureCycles(
    rawNodes.filter(isObj) as unknown as ArchNode[],
    rawEdges.filter(isObj) as unknown as ArchEdge[],
  )
  if (cycles.length > 0) {
    warnings.push(
      warn(
        'ARCH_HAS_CYCLE',
        'edges',
        `检测到 ${cycles.length} 组通信环（架构层合法）：${cycles.map((c) => c.join(' → ')).join(' | ')}`,
      ),
    )
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** 架构层的强连通分组，仅用于展示与「转任务时要打断哪些环」的提示。 */
export function findArchitectureCycles(
  nodes: readonly ArchNode[],
  edges: readonly ArchEdge[],
): string[][] {
  const adj = new Map<string, string[]>()
  for (const n of nodes) adj.set(n.id, [])
  for (const e of edges) {
    adj.get(e.from)?.push(e.to)
    if (e.bidirectional) adj.get(e.to)?.push(e.from)
  }
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const out: string[][] = []
  let counter = 0

  const strongconnect = (v: string): void => {
    index.set(v, counter)
    low.set(v, counter)
    counter += 1
    stack.push(v)
    onStack.add(v)
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!))
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = []
      for (;;) {
        const w = stack.pop()
        if (w === undefined) break
        onStack.delete(w)
        comp.push(w)
        if (w === v) break
      }
      // 只报真正的环：>1 个节点，或自环。
      const selfLoop = comp.length === 1 && (adj.get(comp[0]!) ?? []).includes(comp[0]!)
      if (comp.length > 1 || selfLoop) out.push(comp.reverse())
    }
  }

  for (const n of nodes) if (!index.has(n.id)) strongconnect(n.id)
  return out
}
