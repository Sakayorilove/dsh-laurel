/**
 * dsh-loom · 宿主半边：存储层。
 *
 * 纪律：
 * - 路线 A′ 用**不可变 revision + 追加式 JSONL + 原子写**，不引入 SQLite。
 * - 关键写入失败必须**可见**（抛错），不能吞掉异常假装成功。
 * - 事件日志可以容错（它只是排错用）；调度与合并事实不行。
 * - 不复用 DSH 的原生日志格式，Loom 自己的事件独立存。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, win32 } from 'node:path'
import type { PlanningRequest } from './core/initial-planner.js'
import type { RefinementRequest } from './refinement.js'
import type { ArchitectureRevision } from './core/index.js'
import type { WorkflowRevision } from './core/index.js'
import type { FlowPlan } from './core/flow-plan.js'
import type { Presentation } from './core/index.js'
import { contentDigest, type GraphChange } from './core/index.js'
import type { SourceMap } from './core/index.js'
import { checkRevisionGuard, normalizeWorkspaceId, type RevisionGuard } from './core/scope.js'
import { DEFAULT_CONFIG, normalizeConfig, validateConfigPatch, type LoomConfig, ensureDir, loomPaths, loomWorkspacePaths, type LoomPaths, type LoomWorkspacePaths } from './config.js'

/** 原子写：先写 .tmp 再 rename。关键路径失败会抛。 */
export function atomicWrite(file: string, content: string): void {
  ensureDir(dirname(file))
  const tmp = `${file}.${randomUUID()}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try { writeFileSync(fd, content, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
  try { renameSync(tmp, file) } catch (error) { try { unlinkSync(tmp) } catch {}; throw error }
  if (process.platform !== 'win32') {
    const directory = openSync(dirname(file), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file,'utf8')) as T }
  catch (error) { throw new Error('STORAGE_CORRUPT: '+file+'；原文件保留，请诊断或恢复备份', {cause:error}) }
}
function readJsonl<T>(file: string, strict=true): T[] {
  if (!existsSync(file)) return []
  const out:T[]=[]
  try {
    for (const line of readFileSync(file,'utf8').split('\n')) {
      if (!line.trim())continue
      try {out.push(JSON.parse(line) as T)}catch(error){if(strict)throw error}
    }
    return out
  } catch(error) { if(strict)throw new Error('STORAGE_CORRUPT: '+file+'；不能把损坏记录当作空历史', {cause:error});return out }
}

export interface LoomEvent {
  readonly at: string
  readonly kind: string
  readonly detail?: string
  /** 事件归属的工作区。分区写入的事件都应带上，便于按项目回溯。 */
  readonly workspaceId?: string
  readonly workflowId?: string
  readonly revision?: number
  readonly nodeId?: string
  readonly runId?: string
}

/** Terminal receipt retained so users can locate and inspect delivered code. */
export interface RunReceipt {
  readonly completed: readonly string[]
  readonly artifacts: readonly { readonly nodeId: string; readonly port: string; readonly ref: string; readonly contentHash: string }[]
  readonly checks: readonly { readonly argv: readonly string[]; readonly cwd: string; readonly platform: string; readonly pid: number | null; readonly exitCode: number | null; readonly state: string; readonly stdoutHash: string; readonly stderrHash: string; readonly startedAt: string; readonly endedAt: string }[]
  readonly worktrees: readonly { readonly taskId: string; readonly runId: string; readonly path: string; readonly repoPath: string; readonly baseSha: string; readonly branch: string; readonly state: string }[]
  readonly execution?: import('./execution.js').ExecutionRecord
  /** 审计组结论（0.6.1）：由 loom_run 的审计相位写入。 */
  readonly audits?: import('./execution.js').AuditRecord[]
  readonly integrated: false
  readonly error?: string
}

export interface RunRecord {
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly runId: string
  readonly workflowId: string
  readonly revision: number
  readonly planHash: string
  readonly attempt: number
  readonly state: 'queued' | 'running' | 'produced' | 'validating' | 'validated' | 'failed' | 'cancelled' | 'interrupted' | 'refused'
  readonly startedAt: string
  readonly endedAt?: string
  readonly reason?: string
  readonly recoveryOf?: string
  readonly executionRef?: string
  readonly receipt?: RunReceipt
}

export interface DraftState {
  readonly candidate?: WorkflowRevision
  readonly mode: 'auto' | 'manual'
  readonly workflowId: string
  readonly draftRevision: number
  /** 用户锁定的约束。**只对所属工作区生效**。 */
  readonly lockedConstraints: readonly string[]
  readonly updatedAt: string
  /**
   * 方案当前采用的架构 id 与 revision。
   * 指出：改图回传必须读真实基线，不能硬造 `draft.revision - 1`。
   */
  readonly architectureId?: string
  readonly architectureRevision?: number
  /**
   * 归属的工作区。**必填** —— 缺了就无法安全读写。
   * 旧记录没有这个字段，读取时会被判为「旧版全局草案」，需要迁移。
   */
  readonly workspaceId?: string
}

/** 草案写入的结果：要么成功带回新 revision，要么是可定位的冲突。 */
export type DraftWriteResult =
  | { readonly ok: true; readonly draft: DraftState }
  | {
      readonly ok: false
      readonly conflict: {
        readonly currentRevision: number | null
        readonly expectedRevision: number | null
        readonly detail: string
      }
    }

/**
 * 只读 + 追加的文件存储。
 * 每个写方法失败都会抛 —— 调用方决定要不要把它降级成可见错误。
 *
 * Graphs and mutable state are partitioned by workspace. Unowned legacy files
 * stay available to explicit migration tooling, never normal project reads.
 */
export class LoomStore {
  readonly paths: LoomPaths
  private readonly eventLogEnabled: boolean

  constructor(home: string | undefined, options: { eventLog?: boolean } = {}) {
    this.paths = loomPaths(home)
    this.eventLogEnabled = options.eventLog !== false
    ensureDir(this.paths.root)
  }

  /** 取某个工作区的分区路径。id 不合法会抛（不回落全局）。 */
  workspacePaths(workspaceId: string): LoomWorkspacePaths {
    return loomWorkspacePaths(this.paths, workspaceId)
  }

  /** Explicit local project preparation; scoped to one conversation, never all sessions. */
  readExecutionTarget(sessionId: string, workspaceId: string): string | null {
    const value=readJson<{sessionId:string;workspaceId:string;repo:string}>(join(this.paths.root,'execution-targets',contentDigest(sessionId)+'.json'))
    if(!value)return null
    if(value.sessionId!==sessionId||value.workspaceId!==workspaceId||typeof value.repo!=='string'||!isAbsolute(value.repo)||value.repo.includes('\0'))throw new Error('EXECUTION_TARGET_INVALID')
    return value.repo
  }
  writeExecutionTarget(sessionId: string, workspaceId: string, repo: string): void {
    this.workspacePaths(workspaceId)
    if(!sessionId||typeof repo!=='string'||!isAbsolute(repo)||repo.includes('\0'))throw new Error('EXECUTION_TARGET_INVALID')
    atomicWrite(join(this.paths.root,'execution-targets',contentDigest(sessionId)+'.json'),JSON.stringify({sessionId,workspaceId,repo}))
  }

  /** 列出已经分区的所有工作区 id（扫描 `workspaces/` 目录）。 */
  listWorkspaces(): string[] {
    try {
      if (!existsSync(this.paths.workspacesRoot)) return []
      return readdirSync(this.paths.workspacesRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    } catch {
      return []
    }
  }

  /* ---------------- 任务 revision ---------------- */

  listRevisions(workspaceId?: string): WorkflowRevision[] {
    if (workspaceId) { const state = this.readPlanningState(workspaceId); if (state) return state.revisions }
    return readJsonl<WorkflowRevision>(workspaceId ? this.workspacePaths(workspaceId).revisions : this.paths.revisions)
  }

  latestRevision(workflowId: string, workspaceId?: string): WorkflowRevision | null {
    const all = this.listRevisions(workspaceId).filter((r) => r.workflowId === workflowId)
    return all.length ? all[all.length - 1]! : null
  }

  revisionAt(workflowId: string, revision: number, workspaceId?: string): WorkflowRevision | null {
    return (
      this.listRevisions(workspaceId).find((r) => r.workflowId === workflowId && r.revision === revision) ?? null
    )
  }

  /** 追加一条不可变 revision。已存在同 (workflowId, revision) 时抛。 */
  appendRevision(workflow: WorkflowRevision, workspaceId?: string): void {
    const existing = this.revisionAt(workflow.workflowId, workflow.revision, workspaceId)
    if (existing) {
      throw new Error(
        `revision 已存在且不可变：${workflow.workflowId}@${workflow.revision}。请用新的 revision 号。`,
      )
    }
    if (workspaceId && this.updatePlanningState(workspaceId, (state) => { state.revisions.push(workflow) })) return
    const file = workspaceId ? this.workspacePaths(workspaceId).revisions : this.paths.revisions
    ensureDir(dirname(file))
    appendFileSync(file, `${JSON.stringify(workflow)}\n`, 'utf8')
  }

  /* ---------------- 架构 revision ---------------- */

  private architectureEntries(workspaceId?: string): ArchitectureEntry[] {
    if (workspaceId) { const state = this.readPlanningState(workspaceId); if (state) return state.architectures }
    const file = workspaceId ? this.workspacePaths(workspaceId).architectures : this.paths.architectures
    return readJsonl<ArchitectureEntry | ArchitectureRevision>(file).map((r) =>
      'document' in r ? r : { document: r, baseRevision: r.revision, changes: [] })
  }

  listArchitectures(workspaceId?: string): ArchitectureRevision[] {
    return this.architectureEntries(workspaceId).map((e) => e.document)
  }

  latestArchitecture(architectureId: string, workspaceId?: string): ArchitectureRevision | null {
    return this.architectureEntries(workspaceId).filter((e) => e.document.architectureId === architectureId).at(-1)?.document ?? null
  }

  architectureAt(architectureId: string, revision: number, workspaceId?: string): ArchitectureRevision | null {
    return this.listArchitectures(workspaceId).find((a) => a.architectureId === architectureId && a.revision === revision) ?? null
  }

  architectureContext(architectureId: string, workspaceId?: string): ArchitectureEntry | null {
    return this.architectureEntries(workspaceId).filter((e) => e.document.architectureId === architectureId).at(-1) ?? null
  }

  appendArchitecture(architecture: ArchitectureRevision, workspaceId?: string, adopted = false): void {
    const prev = this.architectureContext(architecture.architectureId, workspaceId)
    if (architecture.revision !== (prev?.document.revision ?? 0) + 1) {
      throw new Error('REVISION_CONFLICT: 架构版本必须紧接当前版本，旧窗口不能覆盖')
    }
    if (prev) {
      for (const node of prev.document.nodes.filter((n) => n.locked)) {
        if (contentDigest(node) !== contentDigest(architecture.nodes.find((n) => n.id === node.id) ?? null)) {
          throw new Error(`LOCKED_CONFLICT: 节点 ${node.id} 已锁定，不能修改、删除或解锁`)
        }
      }
      for (const constraint of prev.document.constraints ?? []) {
        if (!(architecture.constraints ?? []).includes(constraint)) throw new Error('LOCKED_CONFLICT: 不能删除已有约束')
      }
    }
    const baseRevision = adopted || !prev ? architecture.revision : prev.baseRevision
    const base = this.architectureAt(architecture.architectureId, baseRevision, workspaceId)
    const entry = { document: architecture, baseRevision, changes: adopted || !prev ? [] : architectureDiff(base!, architecture) }
    if (workspaceId && this.updatePlanningState(workspaceId, (state) => { state.architectures.push(entry) })) return
    const file = workspaceId ? this.workspacePaths(workspaceId).architectures : this.paths.architectures
    ensureDir(dirname(file))
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  /** Only the human CommandRuntime entry calls this capability. One rename
   * commits the new immutable architecture, its baseline, draft and audit fact.
   * Task revisions and SourceMap stay unchanged so their old mapping is stale. */
  unlockArchitectureNode(workspaceId: string, architectureId: string, nodeId: string, expectedRevision: number,
    evidence: { sessionId: string; commandId: string; cwd: string; command: string }): ArchitectureRevision {
    this.checkSessionId(evidence.sessionId)
    if (typeof evidence.cwd !== 'string' || !(isAbsolute(evidence.cwd) || win32.isAbsolute(evidence.cwd)) || normalizeWorkspaceId(evidence.cwd) !== workspaceId) throw new Error('WORKSPACE_MISMATCH: 人类命令的实际会话目录不属于本工作区')
    if (!/^cmd-[a-z0-9]+-[1-9][0-9]*$/.test(evidence.commandId) ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
      evidence.command !== `/loom unlock ${architectureId} ${nodeId} ${expectedRevision}`) throw new Error('HUMAN_ACTION_REQUIRED: 缺少宿主命令执行证据')
    const context = this.architectureContext(architectureId, workspaceId)
    if (!context) throw new Error('ARCHITECTURE_NOT_FOUND: 找不到本工作区的架构')
    if (context.document.revision !== expectedRevision) throw new Error('REVISION_CONFLICT: 架构已变化，请刷新后重新解除冻结')
    const node = context.document.nodes.find(n => n.id === nodeId)
    if (!node) throw new Error('NODE_NOT_FOUND: 找不到架构模块')
    if (node.locked !== true) throw new Error('NODE_NOT_LOCKED: 此模块已经解除冻结，请刷新')
    const at = new Date().toISOString()
    const next: ArchitectureRevision = { ...context.document, revision: expectedRevision + 1, createdAt: at,
      nodes: context.document.nodes.map(n => n.id === nodeId ? { ...n, locked: false } : n) }
    const old = this.readPlanningState(workspaceId)
    const draft = this.readDraft(workspaceId)
    const corresponding = draft && (!draft.architectureId || draft.architectureId === architectureId)
    const state: PlanningState = { format: 1, revisions: this.listRevisions(workspaceId),
      architectures: [...this.architectureEntries(workspaceId), { document: next, baseRevision: next.revision, changes: [] }],
      draft: corresponding ? { ...draft, architectureId, architectureRevision: next.revision, draftRevision: draft.draftRevision + 1, updatedAt: at } : draft,
      sourceMap: this.readSourceMap(workspaceId),
      humanActions: [...(old?.humanActions ?? []), { at, kind: 'unlock', architectureId, nodeId,
        fromRevision: expectedRevision, toRevision: next.revision, ...evidence }] }
    atomicWrite(join(this.workspacePaths(workspaceId).dir, 'planning-state.json'), JSON.stringify(state))
    return next
  }

  /* ---------------- 草案 / 布局 / 来源映射（按工作区分区） ----------------

     ⚠ 这些方法**必须**传 workspaceId。没有它就无法归属，
     而「无法归属」不等于「归属全局」—— 回落全局正是描述的泄漏路径。 */

  /** 读某个工作区的草案。工作区不存在或 id 非法时返回 null（不抛）。 */
  readDraft(workspaceId: string): DraftState | null {
    let paths: LoomWorkspacePaths
    try {
      paths = this.workspacePaths(workspaceId)
    } catch {
      return null
    }
    const state = this.readPlanningState(workspaceId)
    return state ? state.draft : readJson<DraftState>(paths.drafts)
  }

  /**
   * 写草案。**带乐观并发闸门**。
   *
   * `guard.expectedRevision === null` 表示「我认为现在还没有草案」。
   * 若磁盘上已有，返回冲突而不是覆盖 —— 那正是「旧窗口更新静默覆盖新稿」。
   *
   * 返回 `DraftWriteResult` 而不是抛：冲突是**预期内**的正常结果，
   * 调用方要把它转成可定位的 UI 提示，不是当成异常上报。
   * 只有 IO 失败（磁盘满、权限）才抛。
   */
  writeDraft(draft: DraftState, guard: RevisionGuard): DraftWriteResult {
    if (typeof draft.workspaceId !== 'string' || draft.workspaceId === '') {
      throw new Error('写草案必须带 workspaceId —— 无归属的草案会跨项目串数据')
    }
    const paths = this.workspacePaths(draft.workspaceId)
    const current = this.readDraft(draft.workspaceId)
    const verdict = checkRevisionGuard(current?.draftRevision ?? null, guard)
    if (!verdict.ok) return { ok: false, conflict: verdict.conflict! }

    if (!this.updatePlanningState(draft.workspaceId, (state) => { state.draft = draft })) atomicWrite(paths.drafts, JSON.stringify(draft, null, 2))
    return { ok: true, draft }
  }

  readPresentation(workspaceId: string): Presentation | null {
    let paths: LoomWorkspacePaths
    try {
      paths = this.workspacePaths(workspaceId)
    } catch {
      return null
    }
    return readJson<Presentation>(paths.presentation)
  }

  writePresentation(workspaceId: string, p: Presentation): void {
    atomicWrite(this.workspacePaths(workspaceId).presentation, JSON.stringify(p, null, 2))
  }

  /** 流程计划：按工作区分区、按 workflowId 存放（读不到就是 null）。 */
  readFlowPlan(workspaceId: string, workflowId: string): FlowPlan | null {
    let paths: LoomWorkspacePaths
    try {
      paths = this.workspacePaths(workspaceId)
    } catch {
      return null
    }
    const all = readJson<Record<string, FlowPlan>>(join(paths.dir, 'flow-plans.json')) ?? {}
    return all[workflowId] ?? null
  }

  writeFlowPlan(workspaceId: string, workflowId: string, plan: FlowPlan): FlowPlan {
    const paths = this.workspacePaths(workspaceId)
    const file = join(paths.dir, 'flow-plans.json')
    const all = readJson<Record<string, FlowPlan>>(file) ?? {}
    all[workflowId] = plan
    atomicWrite(file, JSON.stringify(all, null, 2))
    return plan
  }

  readSourceMap(workspaceId: string): SourceMap | null {
    let paths: LoomWorkspacePaths
    try {
      paths = this.workspacePaths(workspaceId)
    } catch {
      return null
    }
    const state = this.readPlanningState(workspaceId)
    return state ? state.sourceMap : readJson<SourceMap>(paths.sourcemap)
  }

  writeSourceMap(workspaceId: string, map: SourceMap): void {
    if (!this.updatePlanningState(workspaceId, (state) => { state.sourceMap = map })) atomicWrite(this.workspacePaths(workspaceId).sourcemap, JSON.stringify(map, null, 2))
  }

  /** 旧版全局草案。**只用于迁移预览**，新代码不该调用。 */
  readLegacyDraft(): DraftState | null {
    return readJson<DraftState>(this.paths.legacyDrafts)
  }

  /** 旧版全局文件是否还在。 */
  legacyFilesPresent(): { drafts: boolean; presentation: boolean; sourcemap: boolean } {
    return {
      drafts: existsSync(this.paths.legacyDrafts),
      presentation: existsSync(this.paths.legacyPresentation),
      sourcemap: existsSync(this.paths.legacySourcemap),
    }
  }

  saveRefinementRequest(ws: string, request: RefinementRequest): void {
    const file = join(this.workspacePaths(ws).dir, 'refinement-requests.json')
    const all = readJson<RefinementRequest[]>(file) ?? []
    const next = [...all.filter((r) => r.payloadHash !== request.payloadHash), request].slice(-50)
    atomicWrite(file, JSON.stringify(next))
  }

  readRefinementRequest(ws: string, hash: string): RefinementRequest | null {
    return (readJson<RefinementRequest[]>(join(this.workspacePaths(ws).dir, 'refinement-requests.json')) ?? []).find((r) => r.payloadHash === hash) ?? null
  }

  readConfig(base: LoomConfig = DEFAULT_CONFIG): LoomConfig {
    return normalizeConfig(readJson<unknown>(join(this.paths.root, 'settings.json')), base)
  }

  writeConfig(patch: unknown, base: LoomConfig = DEFAULT_CONFIG): LoomConfig {
    validateConfigPatch(patch)
    const next = normalizeConfig(patch, this.readConfig(base))
    atomicWrite(join(this.paths.root, 'settings.json'), JSON.stringify(next, null, 2))
    return next
  }

  /** 每会话「规划模式」（只规划不做执行动作）。与总开关/会话开关分开存。 */
  readSessionPlanningMode(sessionId: string): boolean {
    const file = join(this.paths.root, 'planning-mode.json')
    try {
      return readJson<Record<string, boolean>>(file)?.[sessionId] === true
    } catch {
      return false
    }
  }

  /** 会话自己有没有记过规划模式（null = 没记过，该用全局默认）。 */
  readSessionPlanningModeExplicit(sessionId: string): boolean | null {
    const file = join(this.paths.root, 'planning-mode.json')
    try {
      const stored = readJson<Record<string, boolean>>(file)?.[sessionId]
      return typeof stored === 'boolean' ? stored : null
    } catch {
      return null
    }
  }

  writeSessionPlanningMode(sessionId: string, enabled: boolean): boolean {
    const file = join(this.paths.root, 'planning-mode.json')
    const current = readJson<Record<string, boolean>>(file) ?? {}
    current[sessionId] = enabled === true
    atomicWrite(file, JSON.stringify(current, null, 2))
    return current[sessionId]
  }

  readSessionActivation(sessionId: string): boolean {
    this.checkSessionId(sessionId)
    return readJson<Record<string, boolean>>(join(this.paths.root, 'session-activation.json'))?.[sessionId] !== false
  }

  writeSessionActivation(sessionId: string, enabled: boolean): { sessionId: string; enabled: boolean } {
    this.checkSessionId(sessionId)
    if (typeof enabled !== 'boolean') throw new Error('SESSION_INVALID: enabled 必须为布尔值')
    const file = join(this.paths.root, 'session-activation.json')
    const current = readJson<Record<string, boolean>>(file) ?? {}
    atomicWrite(file, JSON.stringify({ ...current, [sessionId]: enabled }))
    return { sessionId, enabled }
  }

  private checkSessionId(id: string): void {
    if (typeof id !== 'string' || !id || id.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('SESSION_INVALID: 会话 id 不合法')
  }

  savePlanningRequest(ws: string, request: PlanningRequest): void {
    const file = join(this.workspacePaths(ws).dir, 'planning-requests.json')
    const all = readJson<PlanningRequest[]>(file) ?? []
    atomicWrite(file, JSON.stringify([...all.filter((r) => r.payloadHash !== request.payloadHash), request].slice(-50)))
  }

  readPlanningRequest(ws: string, hash: string): PlanningRequest | null {
    return (readJson<PlanningRequest[]>(join(this.workspacePaths(ws).dir, 'planning-requests.json')) ?? []).find((r) => r.payloadHash === hash) ?? null
  }

  /** 最近一次导出的规划请求。窗口重开后客户端内存里的导出记录会丢，
   * 但项目里的 `.loom/plan.json` 还在：用它记的 requestId 认领那份文件，
   * 才能判断「这个文件是不是为本次请求写的」，而不是见到文件就当候选。 */
  latestPlanningRequest(ws: string): PlanningRequest | null {
    const all = readJson<PlanningRequest[]>(join(this.workspacePaths(ws).dir, 'planning-requests.json')) ?? []
    return all.length ? all[all.length - 1] ?? null : null
  }

  /** One atomic rename commits the architecture, DAG, mapping and draft together.
   * Legacy per-file records are preserved and included in the initial snapshot.
   * Subsequent edits keep this snapshot authoritative, avoiding half-adopted plans. */
  adoptPlanningBundle(ws: string, bundle: { architecture: ArchitectureRevision; workflow: WorkflowRevision; sourceMap: SourceMap }, expected: { architecture: number | null; workflow: number | null; draft: number | null }, mode: 'auto' | 'manual'): DraftState {
    const arch = this.latestArchitecture(bundle.architecture.architectureId, ws)
    const workflow = this.latestRevision(bundle.workflow.workflowId, ws)
    const draft = this.readDraft(ws)
    if ((arch?.revision ?? null) !== expected.architecture || (workflow?.revision ?? null) !== expected.workflow || (draft?.draftRevision ?? null) !== expected.draft) throw new Error('REVISION_CONFLICT: 预览后项目状态已变化，请重新规划')
    if (bundle.architecture.revision !== (arch?.revision ?? 0) + 1 || bundle.workflow.revision !== (workflow?.revision ?? 0) + 1) throw new Error('REVISION_CONFLICT: 新计划版本必须紧接当前版本')
    for (const node of arch?.nodes.filter((n) => n.locked) ?? []) {
      if (contentDigest(node) !== contentDigest(bundle.architecture.nodes.find((n) => n.id === node.id) ?? null)) throw new Error(`LOCKED_CONFLICT: ${node.id} 已锁定`)
    }
    if ([...(arch?.constraints ?? []), ...(draft?.lockedConstraints ?? [])].some((c) => !(bundle.architecture.constraints ?? []).includes(c))) throw new Error('LOCKED_CONFLICT: 不能删除已有约束')
    const nextDraft: DraftState = { workspaceId: ws, workflowId: bundle.workflow.workflowId,
      candidate: bundle.workflow, draftRevision: (draft?.draftRevision ?? 0) + 1, mode,
      lockedConstraints: [...new Set([...(draft?.lockedConstraints ?? []), ...(bundle.architecture.constraints ?? [])])],
      architectureId: bundle.architecture.architectureId, architectureRevision: bundle.architecture.revision,
      updatedAt: new Date().toISOString() }
    const state: PlanningState = { format: 1, humanActions: this.readPlanningState(ws)?.humanActions ?? [], revisions: [...this.listRevisions(ws), bundle.workflow],
      architectures: [...this.architectureEntries(ws), { document: bundle.architecture, baseRevision: bundle.architecture.revision, changes: [] }],
      draft: nextDraft, sourceMap: bundle.sourceMap }
    atomicWrite(join(this.workspacePaths(ws).dir, 'planning-state.json'), JSON.stringify(state))
    return nextDraft
  }

  private readPlanningState(ws: string): PlanningState | null {
    const file = join(this.workspacePaths(ws).dir, 'planning-state.json')
    if (!existsSync(file)) return null
    const state = JSON.parse(readFileSync(file, 'utf8')) as PlanningState
    if (state.format !== 1 || !Array.isArray(state.revisions) || !Array.isArray(state.architectures)) throw new Error('STORAGE_INVALID: planning-state.json 无效，请保留文件并恢复备份')
    return state
  }

  private updatePlanningState(ws: string, update: (state: PlanningState) => void): boolean {
    const state = this.readPlanningState(ws)
    if (!state) return false
    update(state)
    atomicWrite(join(this.workspacePaths(ws).dir, 'planning-state.json'), JSON.stringify(state))
    return true
  }

  /* ---------------- 运行记录 ---------------- */

  listRuns(limit = 200, workspaceId?: string): RunRecord[] {
    const all = readJsonl<RunRecord>(this.paths.runs).filter((r) => !workspaceId || r.workspaceId === workspaceId)
    return all.slice(Math.max(0, all.length - limit))
  }

  appendRun(record: RunRecord): void {
    ensureDir(dirname(this.paths.runs))
    appendFileSync(this.paths.runs, `${JSON.stringify(record)}\n`, 'utf8')
  }

  /** Status is the last fact for a run, not any historical running record. */
  latestRuns(limit = 200, workspaceId?: string): RunRecord[] {
    const latest = new Map<string, RunRecord>()
    for (const run of this.listRuns(Number.MAX_SAFE_INTEGER, workspaceId)) latest.set(run.runId, run)
    return [...latest.values()].slice(-limit)
  }

  /* ---------------- 事件 ---------------- */

  /** 事件是排错用的，写失败不抛。 */
  event(e: Omit<LoomEvent, 'at'>): void {
    if (!this.eventLogEnabled) return
    try {
      ensureDir(dirname(this.paths.events))
      appendFileSync(this.paths.events, `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`, 'utf8')
    } catch {
      /* 事件日志不许影响主流程 */
    }
  }

  readEvents(limit = 200, workspaceId?: string): LoomEvent[] {
    const all = readJsonl<LoomEvent>(this.paths.events, false).filter((r) => !workspaceId || r.workspaceId === workspaceId)
    return all.slice(Math.max(0, all.length - limit))
  }

  /** 给设置页用的摘要。 */
  stats(workspaceId?: string): { revisions: number; architectures: number; runs: number; events: number } {
    return {
      revisions: this.listRevisions(workspaceId).length,
      architectures: this.listArchitectures(workspaceId).length,
      runs: this.listRuns(10000, workspaceId).length,
      events: this.readEvents(10000, workspaceId).length,
    }
  }
}

export { join }

export interface ArchitectureEntry {
  readonly document: ArchitectureRevision
  readonly baseRevision: number
  readonly changes: readonly GraphChange[]
}

/** Derive changes from stored snapshots; request-supplied change lists are not authoritative. */
export function architectureDiff(base: ArchitectureRevision, draft: ArchitectureRevision): GraphChange[] {
  const changes: GraphChange[] = []
  for (const [key, objectKind] of [['nodes', 'architectureNode'], ['edges', 'architectureEdge']] as const) {
    const before = new Map(base[key].map((v) => [v.id, v as unknown as Record<string, unknown>]))
    const after = new Map(draft[key].map((v) => [v.id, v as unknown as Record<string, unknown>]))
    for (const [id, value] of before) {
      if (!after.has(id)) changes.push({ kind: 'remove', objectKind, objectId: id, oldValue: value })
    }
    for (const [id, value] of after) {
      const old = before.get(id)
      if (!old) { changes.push({ kind: 'add', objectKind, objectId: id, newValue: value }); continue }
      for (const field of new Set([...Object.keys(old), ...Object.keys(value)])) {
        if (contentDigest(old[field] ?? null) !== contentDigest(value[field] ?? null)) {
          changes.push({ kind: 'modify', objectKind, objectId: id, field, oldValue: old[field], newValue: value[field] })
        }
      }
    }
  }
  for (const constraint of draft.constraints ?? []) {
    if (!(base.constraints ?? []).includes(constraint)) changes.push({ kind: 'add', objectKind: 'constraint', objectId: constraint, newValue: constraint })
  }
  for (const field of ['openQuestions', 'unmapped', 'note'] as const) {
    if (contentDigest(base[field] ?? null) !== contentDigest(draft[field] ?? null)) {
      changes.push({ kind: 'modify', objectKind: 'architecture', objectId: draft.architectureId, field,
        oldValue: base[field], newValue: draft[field] })
    }
  }
  return changes
}

interface PlanningState {
  format: 1
  revisions: WorkflowRevision[]
  architectures: ArchitectureEntry[]
  draft: DraftState | null
  sourceMap: SourceMap | null
  humanActions?: { at: string; kind: 'unlock'; architectureId: string; nodeId: string; fromRevision: number; toRevision: number;
    sessionId: string; commandId: string; cwd: string; command: string }[]
}
