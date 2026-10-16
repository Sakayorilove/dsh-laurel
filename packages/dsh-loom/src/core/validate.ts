/**
 * 任务图校验：JSON Schema 层 + 语义层。
 *
 * 纪律：
 * - Schema 合法 ≠ 图可执行。语义层查端口类型、必需输入、无环、ownership、并发与能力。
 * - 每条错误带可定位 path，UI 能聚焦到节点/字段。
 * - 「模型置信度高」不是跳过校验的理由：本模块不读任何 confidence 字段。
 * - 本实现**不放松** planner-output.schema.json 的约束。
 */
import {
  AGENT_KINDS,
  ARTIFACT_TYPES,
  CWD_REFS,
  EXECUTION_BACKENDS,
  ID_PATTERN,
  ISOLATIONS,
  NODE_KINDS,
  REQUIRED_CAPABILITIES,
  STAGES,
  TASK_SCHEMA_VERSION,
  type ArtifactType,
  type CwdRef,
  type ExecutionBackend,
  type Isolation,
  type NodeKind,
  type RequiredCapability,
  type Stage,
  type TaskEdge,
  type TaskNode,
} from './model.js'

export interface LoomIssue {
  readonly code: string
  readonly path: string
  readonly message: string
  readonly severity: 'error' | 'warning'
}

export interface ValidationResult {
  readonly ok: boolean
  readonly errors: readonly LoomIssue[]
  readonly warnings: readonly LoomIssue[]
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

class Ctx {
  readonly errors: LoomIssue[] = []
  readonly warnings: LoomIssue[] = []
  e(code: string, path: string, message: string): void {
    this.errors.push(err(code, path, message))
  }
  w(code: string, path: string, message: string): void {
    this.warnings.push(warn(code, path, message))
  }
}

function checkEnum<T extends string>(
  c: Ctx,
  path: string,
  value: unknown,
  allowed: readonly T[],
  code = 'ENUM',
): value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    c.e(code, path, `必须是 ${allowed.join(' / ')} 之一，收到 ${JSON.stringify(value)}`)
    return false
  }
  return true
}

function checkId(c: Ctx, path: string, value: unknown, code = 'ID_SHAPE'): value is string {
  if (typeof value !== 'string') {
    c.e(code, path, '必须是字符串')
    return false
  }
  if (!ID_PATTERN.test(value)) {
    c.e(code, path, `不符合 id 形状 ^[a-z][a-z0-9_-]{0,63}$：${value}`)
    return false
  }
  return true
}

function checkShortText(c: Ctx, path: string, value: unknown, max = 2000, min = 1): boolean {
  if (typeof value !== 'string') {
    c.e('SHORT_TEXT_TYPE', path, '必须是字符串')
    return false
  }
  if (value.length < min || value.length > max) {
    c.e('SHORT_TEXT_LENGTH', path, `长度必须在 ${min}..${max} 之间，实际 ${value.length}`)
    return false
  }
  return true
}

function checkStringArray(
  c: Ctx,
  path: string,
  value: unknown,
  opts: { maxItems: number; unique?: boolean; minItems?: number; itemMax?: number; idItems?: boolean },
): string[] {
  if (!Array.isArray(value)) {
    c.e('ARRAY_TYPE', path, '必须是数组')
    return []
  }
  if (value.length > opts.maxItems) c.e('ARRAY_TOO_LONG', path, `最多 ${opts.maxItems} 项，实际 ${value.length}`)
  if (opts.minItems !== undefined && value.length < opts.minItems) {
    c.e('ARRAY_TOO_SHORT', path, `至少 ${opts.minItems} 项`)
  }
  const out: string[] = []
  value.forEach((v, i) => {
    if (opts.idItems) {
      if (checkId(c, `${path}[${i}]`, v)) out.push(v)
    } else if (typeof v === 'string') {
      if (opts.itemMax !== undefined && v.length > opts.itemMax) {
        c.e('STRING_TOO_LONG', `${path}[${i}]`, `最长 ${opts.itemMax}`)
      } else {
        out.push(v)
      }
    } else {
      c.e('STRING_TYPE', `${path}[${i}]`, '必须是字符串')
    }
  })
  if (opts.unique && new Set(out).size !== out.length) {
    c.e('ARRAY_NOT_UNIQUE', path, '元素必须唯一')
  }
  return out
}

const ALLOWED_ROOT_KEYS = new Set([
  'schemaVersion',
  'workflowId',
  'revision',
  'title',
  'detectedStage',
  'evidence',
  'assumptions',
  'openQuestions',
  'executionProposal',
  'nodes',
  'edges',
  // 采纳后才有的字段；校验候选时也允许出现，便于直接校验一份已采纳 revision。
  'inputDigest',
  'compilerVersion',
  'adoptedAt',
])

const ALLOWED_NODE_KEYS = new Set([
  'id',
  'kind',
  'title',
  'phase',
  'goal',
  'role',
  'sourceRefs',
  'inputs',
  'outputs',
  'ownership',
  'execution',
  'acceptance',
])

const ALLOWED_EDGE_KEYS = new Set([
  'id',
  'source',
  'sourcePort',
  'target',
  'targetPort',
  'artifactType',
  'require',
])

function checkUnknownKeys(c: Ctx, path: string, obj: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      c.e('UNKNOWN_KEY', path ? `${path}.${key}` : key, `不允许的字段：${key}（additionalProperties: false）`)
    }
  }
}

function checkSourceRef(c: Ctx, path: string, v: unknown): void {
  if (!isObj(v)) {
    c.e('SOURCE_NOT_OBJECT', path, 'sourceRef 必须是对象')
    return
  }
  checkUnknownKeys(c, path, v, new Set(['inputId', 'locator', 'observation']))
  checkId(c, `${path}.inputId`, v['inputId'])
  checkShortText(c, `${path}.locator`, v['locator'], 300)
  checkShortText(c, `${path}.observation`, v['observation'])
}

function checkPort(c: Ctx, path: string, v: unknown, side: 'inputs' | 'outputs'): { name: string; type: ArtifactType } | null {
  if (!isObj(v)) {
    c.e('PORT_NOT_OBJECT', path, '端口必须是对象')
    return null
  }
  checkUnknownKeys(c, path, v, new Set(['name', 'artifactType', 'required']))
  const nameOk = checkId(c, `${path}.name`, v['name'], 'PORT_NAME_SHAPE')
  const typeOk = checkEnum(c, `${path}.artifactType`, v['artifactType'], ARTIFACT_TYPES, 'PORT_TYPE_UNKNOWN')
  if (typeof v['required'] !== 'boolean') {
    c.e('PORT_REQUIRED_NOT_BOOLEAN', `${path}.required`, 'required 必须是布尔值')
  } else if (side === 'outputs' && v['required'] === true) {
    c.e('OUTPUT_PORT_REQUIRED', `${path}.required`, '输出端口不能标 required')
  }
  return nameOk && typeOk ? { name: v['name'] as string, type: v['artifactType'] as ArtifactType } : null
}

function checkOwnership(c: Ctx, path: string, v: unknown): void {
  if (!isObj(v)) {
    c.e('OWNERSHIP_NOT_OBJECT', path, 'ownership 必须是对象')
    return
  }
  checkUnknownKeys(c, path, v, new Set(['writes', 'forbiddenWrites', 'sharedResources']))
  const writes = checkStringArray(c, `${path}.writes`, v['writes'], { maxItems: 50, unique: true })
  checkStringArray(c, `${path}.forbiddenWrites`, v['forbiddenWrites'], { maxItems: 50, unique: true })
  checkStringArray(c, `${path}.sharedResources`, v['sharedResources'], { maxItems: 50, unique: true, idItems: true })
  writes.forEach((g, i) => {
    if (/^(?:[A-Za-z]:[\\/]|\/|~)/.test(g)) {
      c.w('OWNERSHIP_ABSOLUTE', `${path}.writes[${i}]`, `${g} 是绝对路径；ownership 应按仓库根写相对 glob`)
    }
    if (g.split('/').includes('..')) {
      c.e('OWNERSHIP_TRAVERSAL', `${path}.writes[${i}]`, `${g} 含 ..，可能越界`)
    }
  })
}

function checkAcceptance(c: Ctx, path: string, v: unknown): void {
  if (!isObj(v)) {
    c.e('ACCEPTANCE_NOT_OBJECT', path, 'acceptance 必须是对象')
    return
  }
  checkUnknownKeys(c, path, v, new Set(['doneWhen', 'commands', 'independentVerification']))
  checkStringArray(c, `${path}.doneWhen`, v['doneWhen'], { maxItems: 20, minItems: 1 })
  if (v['independentVerification'] !== true) {
    c.e('INDEPENDENT_VERIFICATION_REQUIRED', `${path}.independentVerification`, '必须是 true（const）')
  }
  const cmds = v['commands']
  if (!Array.isArray(cmds)) {
    c.e('COMMANDS_NOT_ARRAY', `${path}.commands`, '必须是数组')
    return
  }
  if (cmds.length > 20) c.e('COMMANDS_TOO_MANY', `${path}.commands`, '最多 20 条')
  cmds.forEach((cmd, i) => {
    const p = `${path}.commands[${i}]`
    if (!isObj(cmd)) {
      c.e('COMMAND_NOT_OBJECT', p, '必须是对象')
      return
    }
    checkUnknownKeys(c, p, cmd, new Set(['argv', 'cwdRef', 'expectedExitCode']))
    checkStringArray(c, `${p}.argv`, cmd['argv'], { maxItems: 50, minItems: 1, itemMax: 500 })
    checkEnum<CwdRef>(c, `${p}.cwdRef`, cmd['cwdRef'], CWD_REFS, 'CWD_REF_UNKNOWN')
    if (cmd['expectedExitCode'] !== 0) {
      c.e('EXPECTED_EXIT_CODE', `${p}.expectedExitCode`, '必须是 0（const）')
    }
  })
}

function checkExecution(c: Ctx, path: string, v: unknown): void {
  if (!isObj(v)) {
    c.e('EXECUTION_NOT_OBJECT', path, 'execution 必须是对象')
    return
  }
  checkUnknownKeys(c, path, v, new Set(['backend', 'isolation', 'timeoutSeconds', 'maxRepairAttempts']))
  checkEnum<ExecutionBackend>(c, `${path}.backend`, v['backend'], EXECUTION_BACKENDS, 'BACKEND_UNKNOWN')
  checkEnum<Isolation>(c, `${path}.isolation`, v['isolation'], ISOLATIONS, 'ISOLATION_UNKNOWN')
  const t = v['timeoutSeconds']
  if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > 14400) {
    c.e('TIMEOUT_RANGE', `${path}.timeoutSeconds`, '必须是 1..14400 的整数')
  }
  const r = v['maxRepairAttempts']
  if (typeof r !== 'number' || !Number.isInteger(r) || r < 0 || r > 2) {
    c.e('REPAIR_RANGE', `${path}.maxRepairAttempts`, '必须是 0..2 的整数')
  }
}

function checkNode(c: Ctx, path: string, v: unknown): TaskNode | null {
  if (!isObj(v)) {
    c.e('NODE_NOT_OBJECT', path, '节点必须是对象')
    return null
  }
  checkUnknownKeys(c, path, v, ALLOWED_NODE_KEYS)
  const idOk = checkId(c, `${path}.id`, v['id'])
  const kindOk = checkEnum<NodeKind>(c, `${path}.kind`, v['kind'], NODE_KINDS, 'NODE_KIND_UNKNOWN')
  if (typeof v['title'] !== 'string' || v['title'].length < 1 || v['title'].length > 160) {
    c.e('TITLE_LENGTH', `${path}.title`, 'title 长度必须是 1..160')
  }
  checkEnum<Stage>(c, `${path}.phase`, v['phase'], STAGES, 'PHASE_UNKNOWN')
  checkShortText(c, `${path}.goal`, v['goal'])
  checkId(c, `${path}.role`, v['role'], 'ROLE_SHAPE')

  const refs = v['sourceRefs']
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 20) {
    c.e('SOURCE_REFS_COUNT', `${path}.sourceRefs`, '必须有 1..20 条 sourceRefs')
  } else {
    refs.forEach((r, i) => checkSourceRef(c, `${path}.sourceRefs[${i}]`, r))
  }

  const inputs = Array.isArray(v['inputs']) ? v['inputs'] : []
  if (!Array.isArray(v['inputs'])) c.e('INPUTS_NOT_ARRAY', `${path}.inputs`, '必须是数组')
  else if (inputs.length > 30) c.e('INPUTS_TOO_MANY', `${path}.inputs`, '最多 30 个输入')
  const outputs = Array.isArray(v['outputs']) ? v['outputs'] : []
  if (!Array.isArray(v['outputs'])) c.e('OUTPUTS_NOT_ARRAY', `${path}.outputs`, '必须是数组')
  else if (outputs.length < 1 || outputs.length > 30) c.e('OUTPUTS_COUNT', `${path}.outputs`, '必须有 1..30 个输出')

  const seenIn = new Set<string>()
  inputs.forEach((p, i) => {
    const parsed = checkPort(c, `${path}.inputs[${i}]`, p, 'inputs')
    if (parsed) {
      if (seenIn.has(parsed.name)) c.e('PORT_NAME_DUPLICATE', `${path}.inputs[${i}].name`, `输入端口名重复：${parsed.name}`)
      seenIn.add(parsed.name)
    }
  })
  const seenOut = new Set<string>()
  outputs.forEach((p, i) => {
    const parsed = checkPort(c, `${path}.outputs[${i}]`, p, 'outputs')
    if (parsed) {
      if (seenOut.has(parsed.name)) c.e('PORT_NAME_DUPLICATE', `${path}.outputs[${i}].name`, `输出端口名重复：${parsed.name}`)
      seenOut.add(parsed.name)
    }
  })

  checkOwnership(c, `${path}.ownership`, v['ownership'])
  checkExecution(c, `${path}.execution`, v['execution'])
  checkAcceptance(c, `${path}.acceptance`, v['acceptance'])

  if (!idOk || !kindOk) return null
  return v as unknown as TaskNode
}

function checkEdge(c: Ctx, path: string, v: unknown): TaskEdge | null {
  if (!isObj(v)) {
    c.e('EDGE_NOT_OBJECT', path, '边必须是对象')
    return null
  }
  checkUnknownKeys(c, path, v, ALLOWED_EDGE_KEYS)
  const idOk = checkId(c, `${path}.id`, v['id'])
  const srcOk = checkId(c, `${path}.source`, v['source'])
  checkId(c, `${path}.sourcePort`, v['sourcePort'])
  const tgtOk = checkId(c, `${path}.target`, v['target'])
  checkId(c, `${path}.targetPort`, v['targetPort'])
  checkEnum<ArtifactType>(c, `${path}.artifactType`, v['artifactType'], ARTIFACT_TYPES, 'EDGE_TYPE_UNKNOWN')
  if (v['require'] !== 'validated') {
    c.e('EDGE_REQUIRE', `${path}.require`, "必须是 'validated'（const）")
  }
  if (v['source'] === v['target']) c.e('EDGE_SELF_LOOP', path, '不允许自环')
  if (!idOk || !srcOk || !tgtOk) return null
  return v as unknown as TaskEdge
}

/**
 * 无环检查。返回真实存在的环（节点 id 序列），空数组表示无环。
 * DFS 三色法 —— 报出的是图里真实存在的环，不是随便一条路径。
 */
export function findCycle(nodes: readonly TaskNode[], edges: readonly TaskEdge[]): string[] {
  const adj = new Map<string, string[]>()
  for (const n of nodes) adj.set(n.id, [])
  for (const e of edges) adj.get(e.source)?.push(e.target)
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const n of nodes) color.set(n.id, WHITE)
  const stack: string[] = []

  const visit = (id: string): string[] | null => {
    color.set(id, GRAY)
    stack.push(id)
    for (const next of adj.get(id) ?? []) {
      const c = color.get(next)
      if (c === GRAY) return stack.slice(stack.indexOf(next))
      if (c === WHITE) {
        const found = visit(next)
        if (found) return found
      }
    }
    stack.pop()
    color.set(id, BLACK)
    return null
  }

  for (const n of nodes) {
    if (color.get(n.id) === WHITE) {
      const found = visit(n.id)
      if (found) return found
    }
  }
  return []
}

/** 每层批次的解析结果。 */
export interface DependencyLayers {
  readonly layers: readonly (readonly string[])[]
  readonly layerOf: ReadonlyMap<string, number>
}

/** 最长路径分层：一个节点的所有上游一定在更小的层。 */
export function dependencyLayers(
  nodes: readonly { id: string }[],
  edges: readonly { source: string; target: string }[],
): DependencyLayers {
  const indeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const n of nodes) {
    indeg.set(n.id, 0)
    adj.set(n.id, [])
  }
  for (const e of edges) {
    if (!adj.has(e.source) || !indeg.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
  }
  const layerOf = new Map<string, number>()
  const remaining = new Map(indeg)
  const queue: string[] = []
  for (const [id, d] of indeg) {
    if (d === 0) {
      layerOf.set(id, 0)
      queue.push(id)
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const next of adj.get(id) ?? []) {
      layerOf.set(next, Math.max(layerOf.get(next) ?? 0, (layerOf.get(id) ?? 0) + 1))
      const d = (remaining.get(next) ?? 0) - 1
      remaining.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  const max = Math.max(0, ...[...layerOf.values()])
  const layers: string[][] = Array.from({ length: max + 1 }, () => [])
  for (const n of nodes) {
    const l = layerOf.get(n.id)
    if (l === undefined) layers[0]!.push(n.id)
    else layers[l]!.push(n.id)
  }
  return { layers: layers.filter((l) => l.length > 0), layerOf }
}

export interface ValidateOptions {
  /** 本次运行允许的最大并发（来自 executionProposal）。 */
  readonly maxConcurrency?: number
  /** 运行时探测到的能力，用于拒绝计划里声明的、实际不支持的能力。 */
  readonly availableCapabilities?: readonly RequiredCapability[]
  /** 哪些 isolation 真的可用。缺省表示不做这项检查。 */
  readonly availableIsolations?: readonly Isolation[]
}

export function validateWorkflow(input: unknown, options: ValidateOptions = {}): ValidationResult {
  const c = new Ctx()
  if (!isObj(input)) {
    return { ok: false, errors: [err('ROOT_NOT_OBJECT', '', '顶层必须是对象')], warnings: [] }
  }
  checkUnknownKeys(c, '', input, ALLOWED_ROOT_KEYS)

  if (input['schemaVersion'] !== TASK_SCHEMA_VERSION) {
    c.e('SCHEMA_VERSION', 'schemaVersion', `必须是 "${TASK_SCHEMA_VERSION}"`)
  }
  checkId(c, 'workflowId', input['workflowId'], 'WORKFLOW_ID_SHAPE')
  const revision = input['revision']
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    c.e('REVISION_INVALID', 'revision', 'revision 必须是 >= 1 的整数')
  }
  if (typeof input['title'] !== 'string' || input['title'].length < 1 || input['title'].length > 160) {
    c.e('TITLE_LENGTH', 'title', 'title 长度必须是 1..160')
  }
  checkEnum<Stage>(c, 'detectedStage', input['detectedStage'], STAGES, 'STAGE_UNKNOWN')

  for (const key of ['evidence', 'assumptions', 'openQuestions'] as const) {
    const v = input[key]
    if (!Array.isArray(v)) {
      c.e('ARRAY_TYPE', key, `${key} 必须是数组`)
      continue
    }
    const max = key === 'evidence' ? 100 : 50
    if (v.length > max) c.e('ARRAY_TOO_LONG', key, `最多 ${max} 项`)
    if (key === 'evidence') v.forEach((e, i) => checkSourceRef(c, `${key}[${i}]`, e))
    else v.forEach((e, i) => checkShortText(c, `${key}[${i}]`, e))
  }

  const ep = input['executionProposal']
  if (!isObj(ep)) {
    c.e('EXECUTION_PROPOSAL', 'executionProposal', '必须是对象')
  } else {
    checkUnknownKeys(c, 'executionProposal', ep, new Set(['runtime', 'maxConcurrency', 'requiredBaseline', 'requiredCapabilities']))
    if (ep['runtime'] !== 'wsl') c.e('RUNTIME_MUST_BE_WSL', 'executionProposal.runtime', '必须是 "wsl"（const）')
    const mc = ep['maxConcurrency']
    if (typeof mc !== 'number' || !Number.isInteger(mc) || mc < 1 || mc > 3) {
      c.e('MAX_CONCURRENCY_RANGE', 'executionProposal.maxConcurrency', '必须是 1..3 的整数')
    }
    if (ep['requiredBaseline'] !== 'selected-frozen-commit' && ep['requiredBaseline'] !== 'freeze-after-contract') {
      c.e('REQUIRED_BASELINE', 'executionProposal.requiredBaseline', '枚举不合法')
    }
    const caps = ep['requiredCapabilities']
    if (!Array.isArray(caps)) {
      c.e('CAPS_NOT_ARRAY', 'executionProposal.requiredCapabilities', '必须是数组')
    } else {
      if (new Set(caps).size !== caps.length) {
        c.e('CAPS_NOT_UNIQUE', 'executionProposal.requiredCapabilities', '元素必须唯一')
      }
      caps.forEach((cap, i) =>
        checkEnum<RequiredCapability>(
          c,
          `executionProposal.requiredCapabilities[${i}]`,
          cap,
          REQUIRED_CAPABILITIES,
          'CAPABILITY_UNKNOWN',
        ),
      )
      if (options.availableCapabilities) {
        const avail = new Set(options.availableCapabilities)
        caps.forEach((cap, i) => {
          if (!avail.has(cap as RequiredCapability)) {
            c.e(
              'CAPABILITY_UNAVAILABLE',
              `executionProposal.requiredCapabilities[${i}]`,
              `计划要求能力 ${String(cap)}，但当前运行时探测为不可用；派发前必须拒绝，不能静默忽略`,
            )
          }
        })
      }
    }
  }

  const rawNodes = input['nodes']
  const rawEdges = input['edges']
  if (!Array.isArray(rawNodes)) {
    c.e('NODES_NOT_ARRAY', 'nodes', 'nodes 必须是数组')
    return { ok: false, errors: c.errors, warnings: c.warnings }
  }
  if (!Array.isArray(rawEdges)) {
    c.e('EDGES_NOT_ARRAY', 'edges', 'edges 必须是数组')
    return { ok: false, errors: c.errors, warnings: c.warnings }
  }
  if (rawNodes.length < 1 || rawNodes.length > 200) c.e('NODES_COUNT', 'nodes', '必须有 1..200 个节点')
  if (rawEdges.length > 1000) c.e('EDGES_COUNT', 'edges', '最多 1000 条边')

  const nodes: TaskNode[] = []
  rawNodes.forEach((n, i) => {
    const parsed = checkNode(c, `nodes[${i}]`, n)
    if (parsed) nodes.push(parsed)
  })
  const edges: TaskEdge[] = []
  rawEdges.forEach((e, i) => {
    const parsed = checkEdge(c, `edges[${i}]`, e)
    if (parsed) edges.push(parsed)
  })

  const byId = new Map<string, TaskNode>()
  nodes.forEach((n) => {
    if (byId.has(n.id)) c.e('NODE_ID_DUPLICATE', `nodes[${n.id}]`, `节点 id 重复：${n.id}`)
    else byId.set(n.id, n)
  })
  const edgeIds = new Set<string>()
  edges.forEach((e) => {
    if (edgeIds.has(e.id)) c.e('EDGE_ID_DUPLICATE', `edges[${e.id}]`, `边 id 重复：${e.id}`)
    edgeIds.add(e.id)
  })

  const portOf = (nodeId: string, port: string, side: 'inputs' | 'outputs') =>
    byId.get(nodeId)?.[side].find((p) => p.name === port)

  const incoming = new Map<string, TaskEdge[]>()
  edges.forEach((e, i) => {
    const path = `edges[${i}]`
    const from = byId.get(e.source)
    const to = byId.get(e.target)
    if (!from) {
      c.e('EDGE_SOURCE_UNKNOWN', `${path}.source`, `找不到来源节点：${e.source}`)
      return
    }
    if (!to) {
      c.e('EDGE_TARGET_UNKNOWN', `${path}.target`, `找不到目标节点：${e.target}`)
      return
    }
    const outPort = portOf(e.source, e.sourcePort, 'outputs')
    const inPort = portOf(e.target, e.targetPort, 'inputs')
    if (!outPort) c.e('EDGE_SOURCE_PORT_UNKNOWN', `${path}.sourcePort`, `${e.source} 没有输出端口 ${e.sourcePort}`)
    if (!inPort) c.e('EDGE_TARGET_PORT_UNKNOWN', `${path}.targetPort`, `${e.target} 没有输入端口 ${e.targetPort}`)
    if (outPort && inPort && outPort.artifactType !== inPort.artifactType) {
      c.e(
        'EDGE_PORT_TYPE_MISMATCH',
        path,
        `端口类型不匹配：${e.source}.${e.sourcePort} 是 ${outPort.artifactType}，${e.target}.${e.targetPort} 是 ${inPort.artifactType}`,
      )
    }
    if (outPort && e.artifactType !== outPort.artifactType) {
      c.e(
        'EDGE_DECLARED_TYPE_MISMATCH',
        `${path}.artifactType`,
        `边声明为 ${e.artifactType}，但来源端口是 ${outPort.artifactType}`,
      )
    }
    const key = `${e.target}\u0000${e.targetPort}`
    const list = incoming.get(key)
    if (list) list.push(e)
    else incoming.set(key, [e])
  })

  for (const node of nodes) {
    for (const p of node.inputs) {
      const list = incoming.get(`${node.id}\u0000${p.name}`) ?? []
      if (p.required && list.length === 0) {
        c.e('REQUIRED_INPUT_UNCONNECTED', `nodes[${node.id}].inputs.${p.name}`, `必需输入 ${p.name} 没有来源`)
      }
      if (list.length > 1) {
        c.e(
          'INPUT_MULTIPLE_SOURCES',
          `nodes[${node.id}].inputs.${p.name}`,
          `输入 ${p.name} 有 ${list.length} 个来源；多来源汇合请用集合输入或汇合节点，不要静默覆盖`,
        )
      }
    }
    if ((AGENT_KINDS as readonly string[]).includes(node.kind)) {
      if (node.ownership.writes.length === 0) {
        c.w('AGENT_NO_WRITES', `nodes[${node.id}].ownership.writes`, 'agent 节点没有声明可写范围，无法校验文件归属')
      }
      if (node.execution.backend !== 'configured-agent') {
        c.e(
          'AGENT_BACKEND',
          `nodes[${node.id}].execution.backend`,
          'agent 节点必须用 configured-agent 后端',
        )
      }
    } else if (node.execution.backend === 'configured-agent') {
      c.w(
        'DETERMINISTIC_NODE_AGENT_BACKEND',
        `nodes[${node.id}].execution.backend`,
        `kind=${node.kind} 是程序节点，却声明了 configured-agent；确认这是有意为之`,
      )
    }
  }

  if (c.errors.length === 0) {
    const cycle = findCycle(nodes, edges)
    if (cycle.length > 0) {
      c.e('GRAPH_HAS_CYCLE', 'edges', `任务图必须无环，检测到环：${cycle.join(' → ')}`)
    }
  }

  // 同一批次里写范围重叠 → 要么串行，要么明确标注。只报提示，交给调度器处理。
  if (nodes.length > 1 && c.errors.length === 0) {
    const { layers } = dependencyLayers(nodes, edges)
    layers.forEach((layer, li) => {
      const writers = layer.map((id) => byId.get(id)).filter((n): n is TaskNode => !!n && n.ownership.writes.length > 0)
      for (let i = 0; i < writers.length; i += 1) {
        for (let j = i + 1; j < writers.length; j += 1) {
          const a = writers[i]!
          const b = writers[j]!
          const overlap = a.ownership.writes.filter((g) => b.ownership.writes.includes(g))
          if (overlap.length > 0) {
            c.w(
              'SAME_LAYER_OVERLAP',
              `batch[${li}]`,
              `${a.id} 与 ${b.id} 在同一批次且 ownership 重叠（${overlap.join('、')}），必须串行或加显式依赖`,
            )
          }
        }
      }
    })
  }

  return { ok: c.errors.length === 0, errors: c.errors, warnings: c.warnings }
}

/** 校验一份已采纳的不可变 revision（额外要求 inputDigest / compilerVersion / adoptedAt）。 */
export function validateAdoptedRevision(input: unknown, options: ValidateOptions = {}): ValidationResult {
  const base = validateWorkflow(input, options)
  const extra: LoomIssue[] = []
  if (isObj(input)) {
    if (typeof input['inputDigest'] !== 'string' || (input['inputDigest'] as string).length === 0) {
      extra.push(err('INPUT_DIGEST_MISSING', 'inputDigest', '已采纳 revision 必须有 inputDigest'))
    }
    if (typeof input['compilerVersion'] !== 'string' || (input['compilerVersion'] as string).length === 0) {
      extra.push(err('COMPILER_VERSION_MISSING', 'compilerVersion', '已采纳 revision 必须有 compilerVersion'))
    }
    if (typeof input['adoptedAt'] !== 'string' || (input['adoptedAt'] as string).length === 0) {
      extra.push(err('ADOPTED_AT_MISSING', 'adoptedAt', '已采纳 revision 必须有 adoptedAt'))
    }
  }
  return {
    ok: base.ok && extra.length === 0,
    errors: [...base.errors, ...extra],
    warnings: base.warnings,
  }
}
