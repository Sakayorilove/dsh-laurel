import { architectureDiff, type LoomStore } from './store.js'
import { validateArchitecture, contentDigest, snapshotArchitecture, type ArchitectureRevision } from './core/index.js'

export interface RefinementRequest {
  readonly payloadHash: string
  readonly architectureId: string
  readonly baseRevision: number
  readonly draftRevision: number
  readonly scope: 'all' | readonly string[]
}

/** Recheck the stored export and current graph each time, including adoption. */
export function previewRefinement(store: LoomStore, ws: string, hash: string, reply: any) {
  const request = store.readRefinementRequest(ws, hash)
  if (!request) throw new Error('REQUEST_NOT_FOUND: 请先导出本项目架构提示词')
  const current = store.latestArchitecture(request.architectureId, ws)
  if (!current || current.revision !== request.draftRevision) throw new Error('STALE_REPLY: 导出后架构已变，请重新导出并优化')
  if (!reply || reply.baseRevision !== request.baseRevision) throw new Error('BASE_MISMATCH: AI 回复的 baseRevision 与导出请求不一致')
  if (typeof reply !== 'object' || Array.isArray(reply) || Object.keys(reply).some((key) => !['baseRevision', 'candidate', 'explanation', 'conflicts'].includes(key))) throw new Error('REPLY_SCHEMA: 回复只允许 baseRevision、candidate、explanation、conflicts')
  if (reply.explanation !== undefined && typeof reply.explanation !== 'string') throw new Error('REPLY_SCHEMA: explanation 必须为字符串')
  if (reply.conflicts !== undefined && (!Array.isArray(reply.conflicts) || reply.conflicts.some((v: unknown) => typeof v !== 'string'))) throw new Error('REPLY_SCHEMA: conflicts 必须为字符串数组')
  if (reply.conflicts?.length) throw new Error('REPLY_CONFLICT: ' + reply.conflicts.join('; '))
  const raw = reply.candidate
  if (!raw || raw.architectureId !== current.architectureId) throw new Error('ARCHITECTURE_MISMATCH: 候选架构 id 不一致')
  const candidate: ArchitectureRevision = { ...raw, revision: current.revision + 1, createdAt: new Date().toISOString() }
  const validation = validateArchitecture(candidate)
  if (!validation.ok) throw new Error('INVALID_CANDIDATE: ' + validation.errors.map((e) => `${e.path}: ${e.message}`).join('; '))
  for (const node of current.nodes.filter((n) => n.locked)) {
    if (contentDigest(node) !== contentDigest(candidate.nodes.find((n) => n.id === node.id) ?? null)) throw new Error(`LOCKED_CONFLICT: ${node.id} 已锁定`)
  }
  const locked = [...(current.constraints ?? []), ...(store.readDraft(ws)?.lockedConstraints ?? [])]
  if (locked.some((c) => !(candidate.constraints ?? []).includes(c))) throw new Error('LOCKED_CONFLICT: 候选未保留用户约束')
  const changes = architectureDiff(current, candidate)
  if (request.scope !== 'all') {
    const selected = new Set(request.scope)
    for (const change of changes) {
      if (change.objectKind === 'architectureNode' && !selected.has(change.objectId)) throw new Error(`SCOPE_CONFLICT: ${change.objectId} 超出本次优化范围`)
      if (change.objectKind === 'constraint') throw new Error('SCOPE_CONFLICT: 局部优化不能改变全局约束')
      if (change.objectKind === 'architectureEdge') {
        const oldEdge = current.edges.find((e) => e.id === change.objectId)
        const newEdge = candidate.edges.find((e) => e.id === change.objectId)
        if ([oldEdge, newEdge].some((e) => e && !selected.has(e.from) && !selected.has(e.to))) throw new Error('SCOPE_CONFLICT: 修改了范围之外的关系')
      }
    }
  }
  // Global annotations are graph semantics as well; local optimization cannot replace them.
  if (request.scope !== 'all') {
    for (const field of ['constraints', 'openQuestions', 'unmapped', 'note'] as const) {
      if (contentDigest(current[field] ?? null) !== contentDigest(candidate[field] ?? null)) throw new Error(`SCOPE_CONFLICT: 局部优化不能修改 ${field}`)
    }
  }
  return { candidate, candidateHash: contentDigest(snapshotArchitecture(candidate)), changes,
    expectedRevision: current.revision, payloadHash: hash, warnings: validation.warnings, explanation: reply.explanation ?? '' }
}
