/**
 * 架构 → 任务的多对多来源映射。
 *
 * 纪律：
 * - 一个架构模块可对应多个实现/验收任务；一个共享准备任务可对应多个模块。
 * - 架构改变接口或模块责任时，关联任务标 stale；**不擅改在途运行**。
 * - 架构同名节点不凭名字自动绑定现有任务。
 */

export interface SourceMapEntry {
  readonly architectureNodeIds: readonly string[]
  readonly decisionIds: readonly string[]
  readonly workflowNodeId: string
  /** 建立映射时任务所依据的架构 revision。 */
  readonly basedOnArchitectureRevision: number
  /** 建立映射时任务的语义摘要，用于判断是否已经漂移。 */
  readonly workflowFingerprint: string
}

export interface SourceMap {
  readonly schemaVersion: 1
  readonly architectureId: string
  readonly workflowId: string
  readonly entries: readonly SourceMapEntry[]
}

export interface StaleReport {
  readonly architectureId: string
  readonly architectureRevision: number
  readonly stale: readonly { readonly workflowNodeId: string; readonly reason: string }[]
  readonly fresh: readonly string[]
  /** 新架构里有、但没有任何任务覆盖的模块。 */
  readonly uncoveredArchitectureNodes: readonly string[]
  /** 任务引用了新架构里已经不存在的模块。 */
  readonly danglingArchitectureNodes: readonly string[]
}

/**
 * 判断哪些任务因为架构更新而 stale。
 *
 * @param sourceMap 现有映射
 * @param currentArchitectureRevision 新架构的 revision
 * @param liveArchitectureNodeIds 新架构里仍然存在的模块 id
 */
export function computeStale(
  sourceMap: SourceMap,
  currentArchitectureRevision: number,
  liveArchitectureNodeIds: readonly string[],
): StaleReport {
  const live = new Set(liveArchitectureNodeIds)
  const stale: { workflowNodeId: string; reason: string }[] = []
  const fresh: string[] = []
  const dangling = new Set<string>()

  for (const entry of sourceMap.entries) {
    const missing = entry.architectureNodeIds.filter((id) => !live.has(id))
    for (const m of missing) dangling.add(m)
    if (missing.length > 0) {
      stale.push({
        workflowNodeId: entry.workflowNodeId,
        reason: `引用的架构模块已不存在：${missing.join('、')}`,
      })
      continue
    }
    if (entry.basedOnArchitectureRevision !== currentArchitectureRevision) {
      stale.push({
        workflowNodeId: entry.workflowNodeId,
        reason: `基于架构 revision ${entry.basedOnArchitectureRevision}，当前是 ${currentArchitectureRevision}`,
      })
      continue
    }
    fresh.push(entry.workflowNodeId)
  }

  const covered = new Set<string>()
  for (const e of sourceMap.entries) for (const id of e.architectureNodeIds) covered.add(id)
  const uncovered = liveArchitectureNodeIds.filter((id) => !covered.has(id))

  return {
    architectureId: sourceMap.architectureId,
    architectureRevision: currentArchitectureRevision,
    stale,
    fresh,
    uncoveredArchitectureNodes: uncovered,
    danglingArchitectureNodes: [...dangling],
  }
}

export function validateSourceMap(map: unknown, workflowNodeIds: readonly string[]): string[] {
  const problems: string[] = []
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return ['SourceMap 必须是对象']
  const m = map as Partial<SourceMap>
  if (m.schemaVersion !== 1) problems.push('schemaVersion 必须是 1')
  if (!Array.isArray(m.entries)) return [...problems, 'entries 必须是数组']
  if (typeof m.architectureId !== 'string' || !m.architectureId) problems.push('architectureId 必须是非空字符串')
  if (typeof m.workflowId !== 'string' || !m.workflowId) problems.push('workflowId 必须是非空字符串')
  const seen = new Set<string>()
  const known = new Set(workflowNodeIds)
  m.entries.forEach((e, i) => {
    if (!e || typeof e !== 'object') {
      problems.push(`entries[${i}] 不是对象`)
      return
    }
    if (typeof e.workflowNodeId !== 'string' || !known.has(e.workflowNodeId)) {
      problems.push(`entries[${i}].workflowNodeId 指向不存在的任务：${String(e.workflowNodeId)}`)
    }
    if (seen.has(e.workflowNodeId)) problems.push(`entries[${i}] 重复任务映射`)
    seen.add(e.workflowNodeId)
    if (!Array.isArray(e.decisionIds) || e.decisionIds.some((id: unknown) => typeof id !== 'string')) problems.push(`entries[${i}].decisionIds 必须是字符串数组`)
    if (!Array.isArray(e.architectureNodeIds) || e.architectureNodeIds.length === 0 || e.architectureNodeIds.some((id: unknown) => typeof id !== 'string')) {
      problems.push(`entries[${i}].architectureNodeIds 必须是非空数组`)
    }
  })
  return problems
}
