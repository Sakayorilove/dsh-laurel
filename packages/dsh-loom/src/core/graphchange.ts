/**
 * 用户改动的有类型记录。
 *
 * 纪律：
 * - 只用有类型的 GraphChange，**不开放任意 JSON path、不执行代码**。
 * - 改名保留 ID；删除有明确记录；拆分/合并必须返回来源映射。
 * - 布局（坐标/折叠）不产生 GraphChange —— 它不进语义 payload。
 */
import type { GraphChange } from './graphchange-types.js'
export type { GraphChange, GraphChangeKind, GraphObjectKind } from './graphchange-types.js'

export interface ChangeLogEntry extends GraphChange {
  readonly at: string
  readonly actor: 'user' | 'model' | 'system'
}

/** 只保留会影响执行语义的改动。布局类字段一律被过滤掉。 */
const LAYOUT_FIELDS = new Set(['x', 'y', 'position', 'width', 'height', 'collapsed', 'color', 'zIndex', 'selected'])

export function isSemanticChange(change: GraphChange): boolean {
  if (change.kind === 'add' || change.kind === 'remove' || change.kind === 'relink') return true
  if (change.kind === 'lock' || change.kind === 'unlock') return true
  if (change.kind === 'modify') {
    return change.field === undefined || !LAYOUT_FIELDS.has(change.field)
  }
  return true
}

export function semanticChanges(changes: readonly GraphChange[]): GraphChange[] {
  return changes.filter(isSemanticChange)
}

/**
 * 检查一批改动是否有结构问题（同一对象被删了又改、锁定的对象被改等）。
 * 返回人类可读的冲突列表；空数组表示可以安全应用。
 */
export function detectConflicts(
  changes: readonly GraphChange[],
  lockedObjectIds: readonly string[],
): string[] {
  const conflicts: string[] = []
  const locked = new Set(lockedObjectIds)
  const removed = new Set<string>()
  const touched = new Set<string>()

  for (const c of changes) {
    if (c.kind === 'remove') removed.add(`${c.objectKind}:${c.objectId}`)
  }
  for (const c of changes) {
    const key = `${c.objectKind}:${c.objectId}`
    if (c.kind === 'remove' && touched.has(key)) {
      conflicts.push(`${key} 在本次改动中先被修改又被删除，顺序无法确定`)
    }
    if (removed.has(key) && c.kind !== 'remove') {
      conflicts.push(`${key} 已被删除，不能再改（改动类型 ${c.kind}）`)
    }
    if (locked.has(c.objectId) && (c.kind === 'remove' || c.kind === 'modify' || c.kind === 'unlock')) {
      conflicts.push(`${key} 已被用户锁定，${c.kind} 被拒绝`)
    }
    touched.add(key)
  }
  return conflicts
}
