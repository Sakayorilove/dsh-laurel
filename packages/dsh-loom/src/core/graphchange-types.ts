/** GraphChange 的纯类型定义，单独放一个文件避免循环依赖。 */

export type GraphObjectKind = 'architecture' | 'architectureNode' | 'architectureEdge' | 'workflowNode' | 'workflowEdge' | 'constraint'

export type GraphChangeKind = 'add' | 'remove' | 'modify' | 'relink' | 'lock' | 'unlock'

export interface GraphChange {
  readonly kind: GraphChangeKind
  readonly objectKind: GraphObjectKind
  readonly objectId: string
  /** modify 时指出具体字段。禁止任意 JSON path。 */
  readonly field?: string
  readonly oldValue?: unknown
  readonly newValue?: unknown
  /** 为什么改。会原样进提示词包，方便模型理解意图。 */
  readonly reason?: string
}
