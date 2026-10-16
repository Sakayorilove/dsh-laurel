import { ExecutionCoordinator } from './coordinator.js'
import { ExecutionJournal, type AuditRecord, type ExecutionRecord, type TaskAttempt } from './execution.js'
import { verificationSnapshot } from './verification.js'
import { materializeInputs, unchangedInput, type VerifiedSnapshot } from './input-bundle.js'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { executeWsl, toHostPath, type CommandReceipt } from './bridge.js'
import { buildTaskPackage, computeStale, contentDigest, dispatchLabel, validateAdoptedRevision, type TaskNode, type WorkflowRevision } from './core/index.js'
import { git as worktreeGit, type IWorktreeManager } from './worktree.js'
import type { FlowSchedule } from './core/flow-plan.js'
import type { LoomStore } from './store.js'

const git = async (cwd: string, args: string[]) => { const result = await worktreeGit(cwd, args, 30_000); if (result.code !== 0) throw new Error(`GIT_FAILED: ${result.stderr}`); return result.stdout.trim() }

export interface VerifiedArtifact { readonly nodeId: string; readonly port: string; readonly ref: string; readonly contentHash: string; readonly attemptId?: string }
export interface DispatchContext { readonly node: TaskNode | null; readonly cwd: string; readonly runId: string; readonly baseSha: string; readonly prompt: string; readonly signal: AbortSignal; readonly attemptId: string; readonly phase: 'implementation' | 'review' | 'audit' | 'supervision' | 'coordination'; readonly snapshotHash?: string; readonly targetTaskId?: string; readonly memberId?:string }
export type TaskDispatcher = (context: DispatchContext) => Promise<{ readonly verdict: string; readonly artifactRefs: readonly VerifiedArtifact[]; readonly attemptId?: string; readonly snapshotHash?: string; readonly findings?: readonly string[]; readonly messages?: readonly {to:string;body:string}[] }>

/** One limiter is shared by every session/run in the plugin process. */
export class TaskBudget {
  private active = 0
  private readonly waiting: (() => void)[] = []
  constructor(public limit: number) { if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw new Error('invalid task budget') }
  setLimit(limit: number): void { if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw new Error('invalid task budget'); this.limit = limit; for (const wake of this.waiting.splice(0)) wake() }
  async acquire(signal: AbortSignal): Promise<() => void> {
    while (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal.removeEventListener('abort', abort); resolve() }
        const abort = () => { const i = this.waiting.indexOf(wake); if (i >= 0) this.waiting.splice(i, 1); reject(new Error('cancelled while waiting for budget')) }
        this.waiting.push(wake); signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    }
    if (signal.aborted) throw new Error('cancelled before dispatch')
    this.active += 1
    let released = false
    return () => { if (released) return; released = true; this.active -= 1; this.waiting.shift()?.() }
  }
}

function matches(path: string, pattern: string): boolean {
  const source = pattern.split(/(\*\*|\*)/).map((s) => s === '**' ? '.*' : s === '*' ? '[^/]*' : s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('')
  return new RegExp(`^${source}$`).test(path)
}

/** A fresh approval may repair acceptance wording, never reuse drafts under changed ownership or execution permissions. */
export function compatibleRecoveryWorkflow(previous: WorkflowRevision, current: WorkflowRevision): boolean {
  const shape=(workflow:WorkflowRevision)=>({workflowId:workflow.workflowId,executionProposal:workflow.executionProposal,edges:workflow.edges,nodes:workflow.nodes.map(node=>({...node,acceptance:{...node.acceptance,doneWhen:[]}}))})
  return previous.revision<=current.revision && contentDigest(shape(previous))===contentDigest(shape(current))
}

export class IsolatedTaskRuntime {
  readonly journal: ExecutionJournal
  private readonly coordinator: ExecutionCoordinator
  readonly budget: TaskBudget
  private readonly activeOwnership = new Map<string, readonly TaskNode[]>()
  private readonly activeRuns = new Map<string, { controller: AbortController; settled: Promise<void>; finish: () => void }>()
  constructor(private readonly store: LoomStore, private readonly trees: IWorktreeManager, concurrency = 2) { this.budget = new TaskBudget(concurrency); this.journal = new ExecutionJournal(store.paths.root); this.coordinator = new ExecutionCoordinator(store.paths.root) }

  async run(workflow: WorkflowRevision, repoPath: string, ws: string, baseSha: string,
    dispatch: TaskDispatcher, options: { sessionId?: string; signal?: AbortSignal; runId?: string; maxConcurrency?: number; maxRepairRounds?: number; recoveryOf?: string; approvedPlan?:ExecutionRecord['approvedPlan']; schedule?: FlowSchedule } = {}) {
    const maxRepairs = options.maxRepairRounds ?? 0
    if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 3) throw new Error('INVALID_REPAIR_BUDGET')
    if (options.maxConcurrency !== undefined) this.setConcurrency(options.maxConcurrency)
    const effectiveConcurrency = Math.min(workflow.executionProposal.maxConcurrency, options.maxConcurrency ?? this.budget.limit, options.schedule ? Math.max(1, options.schedule.concurrency) : Number.POSITIVE_INFINITY)
    const validation = validateAdoptedRevision(workflow)
    if (!validation.ok) throw new Error('INVALID_WORKFLOW: 运行前必须通过任务图校验')
    const architectures = this.store.listArchitectures(ws)
    if (architectures.length) {
      const map = this.store.readSourceMap(ws)
      const arch = map ? this.store.latestArchitecture(map.architectureId, ws) : null
      if (!map || !arch || map.workflowId !== workflow.workflowId) throw new Error('SOURCE_MAP_REQUIRED: 架构与任务之间需要显式映射')
      const stale = computeStale(map, arch.revision, arch.nodes.map((n) => n.id))
      if (stale.stale.length || workflow.nodes.some((n) => !map.entries.some((e) => e.workflowNodeId === n.id && e.workflowFingerprint === contentDigest(n)))) throw new Error('STALE_TASKS: 架构或任务已变更，请重新规划与确认映射')
    }
    // This first executable slice accepts frozen-baseline module DAGs only.
    // Unsupported deterministic/contract phases fail before any tree or child is created.
    const unsupported = workflow.nodes.filter((n) => n.execution.backend !== 'configured-agent' || n.execution.isolation !== 'worktree')
    if (unsupported.length) throw new Error('UNSUPPORTED_STAGE: inspect/contract/verify/gate/integrate/report 需要独立执行器；当前仅接冻结基线上的 worktree 模块 DAG')
    if (!/^[a-f0-9]{40}$/.test(baseSha) || await git(repoPath, ['rev-parse', 'HEAD']) !== baseSha) throw new Error('BASE_MISMATCH: 当前仓库 HEAD 与冻结基线不一致')
    if (workflow.openQuestions.length) throw new Error('OPEN_QUESTIONS: 解决未决问题后才能开工')
    if (workflow.executionProposal.requiredCapabilities.includes('integration')) throw new Error('UNSUPPORTED_STAGE: 当前执行切片不提供自动集成')
    const repo = realpathSync(repoPath)
    for (const [key, active] of this.activeOwnership) {
      if (!key.startsWith(`${repo}:`)) continue
      for (const node of workflow.nodes) for (const other of active) {
        const prefix = (p: string) => p.split('*')[0]!
        if (node.ownership.writes.some((a) => other.ownership.writes.some((b) => prefix(a).startsWith(prefix(b)) || prefix(b).startsWith(prefix(a))))) {
          throw new Error('OWNERSHIP_BUSY: 在途任务声明了相同或重叠的写入范围')
        }
      }
    }
    const runId = options.runId ?? `run-${randomUUID()}`
    if (this.activeRuns.has(runId)) throw new Error('RUN_ALREADY_ACTIVE: 运行 ID 已被在途任务占用')
    const lease = await this.coordinator.acquire()
    let execution: ExecutionRecord
    let recoverySource: ExecutionRecord | undefined
    try {
    for (const [key, active] of this.activeOwnership) {
      if (!key.startsWith(`${repo}:`)) continue
      for (const node of workflow.nodes) for (const other of active) {
        const prefix = (p: string) => p.split('*')[0]!
        if (node.ownership.writes.some((a) => other.ownership.writes.some((b) => prefix(a).startsWith(prefix(b)) || prefix(b).startsWith(prefix(a))))) {
          throw new Error('OWNERSHIP_BUSY: 在途任务声明了相同或重叠的写入范围')
        }
      }
    }
      if (this.journal.read(runId)) throw new Error('RUN_ID_REUSED: 已有执行身份不能重复开工')
      this.recoverWithLease(lease.token)
      if (options.recoveryOf) {
        const original = this.journal.read(options.recoveryOf)
        if(this.journal.list().some(record=>record.recoveryOf===options.recoveryOf&&['running','validated'].includes(record.state)))throw new Error('RECOVERY_ALREADY_ADMITTED: 此运行已有在途或通过验收的恢复执行')
        const previous = original && this.store.revisionAt(original.workflowId,original.revision,ws)
        const samePlan = original?.revision===workflow.revision && original.planHash===contentDigest(workflow)
        const revisedAcceptance = !!(options.approvedPlan && previous && original?.planHash===contentDigest(previous) && compatibleRecoveryWorkflow(previous,workflow))
        if (!original || original.workspaceId !== ws || original.workflowId !== workflow.workflowId || !(samePlan||revisedAcceptance) || original.baseSha !== baseSha || realpathSync(original.repoPath)!==repo || !['failed','cancelled','interrupted'].includes(original.state)) throw new Error('RECOVERY_REFUSED: 旧运行必须已停止且属于相同项目、基线和任务范围；修改验收文字后需批准当前版本')
        recoverySource = original
      }
      execution = { schemaVersion:1,sequence:0,runId,workspaceId:ws,workflowId:workflow.workflowId,revision:workflow.revision,planHash:contentDigest(workflow),...(options.approvedPlan?{approvedPlan:options.approvedPlan}:{}),baseSha,repoPath:repo,ownerToken:lease.token,startedAt:new Date().toISOString(),state:'running',tasks:[],...(options.recoveryOf ? {recoveryOf:options.recoveryOf}: {}) }
      this.journal.write(execution)
    } catch(error) { await lease.release(); throw error }
    this.activeOwnership.set(`${repo}:${runId}`, workflow.nodes)
    const signal = new AbortController()
    let finish!: () => void
    const settled = new Promise<void>((resolve) => { finish = resolve })
    this.activeRuns.set(runId, { controller: signal, settled, finish })
    void lease.lost.then(() => signal.abort(new Error('EXECUTION_LEASE_LOST')))
    const abort = () => signal.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort()
    const startedAt = new Date().toISOString()
    const record = (state: 'running' | 'validated' | 'failed' | 'cancelled', reason?: string) => this.store.appendRun({ workspaceId: ws, sessionId:options.sessionId, runId,
      workflowId: workflow.workflowId, revision: workflow.revision, planHash: contentDigest(workflow), attempt: 1, state, startedAt, executionRef: this.journal.path(runId), ...(options.recoveryOf ? { recoveryOf: options.recoveryOf } : {}),
      ...(state !== 'running' ? { endedAt: new Date().toISOString(), receipt: { completed: [...completed], artifacts: [...artifacts],
        checks: checks.map(({ argv, cwd, platform, pid, exitCode, state, stdoutHash, stderrHash, startedAt, endedAt }) => ({ argv, cwd, platform, pid, exitCode, state, stdoutHash, stderrHash, startedAt, endedAt })),
        worktrees: this.trees.listLive(runId), execution: structuredClone(execution), audits: execution.audits ?? [], integrated: false as const,
        // 每步实际并发峰值（S6）：计划里写的是额度，这里记的是**真的同时开了几个**。
        ...(options.schedule ? { stepConcurrency: options.schedule.steps.map((s, i) => ({ id: s.id, agents: s.agents, peak: stepPeak.get(i) ?? 0 })) } : {}),
        ...(reason ? { error: reason } : {}) } } : {}), ...(reason ? { reason } : {}) })
    const artifacts: VerifiedArtifact[] = []; const checks: CommandReceipt[] = []; const verifiedChecks = new Map<string, CommandReceipt[]>()
    const verifiedSnapshots = new Map<string, VerifiedSnapshot>()
    const completed = new Set<string>(); const pending = new Set(workflow.nodes.map((n) => n.id))
    const jobs = new Map<string, Promise<void>>()
    // 真分步调度（S6）：第 k 步的代理额度只作用在第 k 步。这三个表必须在 record()
    // 之前声明 —— 收据在早期失败路径（建树失败等）也会读它们，晚声明会踩 TDZ。
    const stepPlan = new Map<string, { index: number; agents: number }>()
    const stepLive = new Map<number, number>()
    const stepPeak = new Map<number, number>()
    let failure: Error | null = null
    const reviewRequired = options.maxRepairRounds !== undefined
    const assertCurrent = (attempt: TaskAttempt) => { if (signal.signal.aborted) throw new Error('cancelled'); this.journal.assertAttempt(execution, attempt) }
    try {
      if (signal.signal.aborted) throw new Error('cancelled before tree creation')
      const created = await this.trees.create(runId, repo, workflow.nodes.map((n) => n.id))
      if (!created.ok || created.baseSha !== baseSha) throw new Error('BASE_MISMATCH: 建树失败或基线在建树前发生变化')
      record('running')
      const start = async (node: TaskNode) => {
        const release = await this.budget.acquire(signal.signal)
        const taskAbort = new AbortController()
        const cancelTask = () => taskAbort.abort(signal.signal.reason)
        signal.signal.addEventListener('abort', cancelTask, { once: true })
        const timeout = setTimeout(() => taskAbort.abort(new Error('TASK_TIMEOUT')), node.execution.timeoutSeconds * 1000)
        try {
          if (signal.signal.aborted) throw new Error('cancelled')
          const cwd = this.trees.find(runId, node.id)!.path
          this.store.event({ workspaceId: ws, kind: 'task-started', runId, nodeId: node.id, detail: cwd })
          const dependencies = workflow.edges.filter(e => e.target === node.id)
          const inputs: VerifiedSnapshot[] = []
          for (const id of new Set(dependencies.map(e => e.source))) {
            const snapshot = verifiedSnapshots.get(id)
            if (!snapshot) throw new Error('MISSING_ARTIFACT: 未验收的输入不能交给下游')
            const current = await verificationSnapshot(this.trees.find(runId,id)!.path,baseSha,artifacts.filter(a=>a.nodeId===id),verifiedChecks.get(id)??[])
            if (current.hash !== snapshot.hash) throw new Error('UPSTREAM_CHANGED: 上游已验快照发生变化')
            inputs.push(snapshot)
          }
          const inherited = materializeInputs(cwd, inputs)
          let recoveryPrompt = ''
          if (recoverySource) {
            const previous = this.trees.find(recoverySource.runId,node.id)
            if (previous && previous.baseSha===baseSha && realpathSync(previous.repoPath)===repo) {
              const draft = await verificationSnapshot(previous.path,baseSha,[],[])
              const files = draft.data.files.filter(file=>node.ownership.writes.some(p=>matches(file.path,p))&&!node.ownership.forbiddenWrites.some(p=>matches(file.path,p)))
              if (files.length) {
                materializeInputs(cwd,[{...draft,data:{...draft.data,files}}])
                recoveryPrompt = '\n旧运行的本任务范围内文件已复制到本工作树，仍是未验收草稿；须重新修改、运行验收和独立审查。旧错误：'+(recoverySource.tasks.filter(t=>t.nodeId===node.id).at(-1)?.error??'')
                this.store.event({workspaceId:ws,kind:'task-recovery-inputs',runId,nodeId:node.id,detail:JSON.stringify({sourceRunId:recoverySource.runId,sourceHash:draft.hash,files:files.map(f=>({path:f.path,sha256:f.sha256})),verified:false})})
              }
            }
          }
          const upstream = dependencies.flatMap(e => {
            const references = artifacts.filter(a => a.nodeId === e.source && a.port === e.sourcePort)
            if (!references.length) throw new Error('MISSING_ARTIFACT: 缺少上游输出端口')
            return references.map(a=>({ ...a, ref:resolve(cwd,relative(this.trees.find(runId,e.source)!.path,a.ref)),type:e.artifactType,origin:'earlier' as const }))
          })
          const member=options.schedule?.organization?.members.find(m=>m.role==='executor'&&m.taskIds.includes(node.id))
          const memberPrompt=member?'\n执行成员：'+JSON.stringify(member):''
          const prompt = memberPrompt+buildTaskPackage({ workflow, node, upstream, cwd, baseSha, allowedChecks: node.acceptance.commands.map((c) => c.argv.join(' ')), includeReceipt: false })+recoveryPrompt
            + (inherited.size ? '\n上游已验文件已投影到本工作树，可读取和运行；它们不是本任务的改动，只能修改声明拥有的文件。输入来源：'+JSON.stringify(inputs.map(s=>({snapshotHash:s.hash,files:s.data.files.map(f=>({path:f.path,sha256:f.sha256}))}))) : '')
          let lastError = ''
          const repairRounds=Math.min(maxRepairs,node.execution.maxRepairAttempts)
          for (let number = 1; number <= repairRounds + 1; number++) {
          const attempt: TaskAttempt = { nodeId:node.id,number,attemptId:randomUUID(),phase:'implementation',active:true,cwd }
          execution.tasks.push(attempt); this.journal.write(execution)
          try {
          assertCurrent(attempt)
          const taskChecks: CommandReceipt[] = []
          const result = await dispatch({ node, cwd, runId, baseSha, prompt: prompt + (lastError ? '\n修复上一轮问题后重新交付：'+lastError : ''), signal: taskAbort.signal, attemptId:attempt.attemptId, phase:'implementation',memberId:member?.id })
          assertCurrent(attempt)
          if (result.attemptId !== undefined && result.attemptId !== attempt.attemptId) throw new Error('STALE_ATTEMPT: 回执执行身份过期')
          if (taskAbort.signal.aborted || result.verdict !== 'ready') throw new Error('TASK_NOT_READY: 任务被取消或未交付可验收结果')
          const produced: VerifiedArtifact[] = []
          for (const output of node.outputs) if (!result.artifactRefs.some(a=>a.nodeId===node.id&&a.port===output.name)) throw new Error('MISSING_ARTIFACT: 缺少合法产物回执')
          const seenArtifacts = new Set<string>()
          for (const a of result.artifactRefs) {
            if (a.nodeId!==node.id || !node.outputs.some(o=>o.name===a.port) || !/^[0-9a-f]{64}$/.test(a.contentHash)) throw new Error('INVALID_ARTIFACT: 输出身份或端口不属于当前任务')
            const file = realpathSync(resolve(cwd, toHostPath(a.ref)))
            const rel = relative(realpathSync(cwd), file)
            if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('ARTIFACT_ESCAPE: 产物路径越出分配目录')
            if (!node.ownership.writes.some(p=>matches(rel,p)) || node.ownership.forbiddenWrites.some(p=>matches(rel,p))) throw new Error('OWNERSHIP_VIOLATION: 产物不属于本任务')
            const identity = a.port+'\0'+file
            if (seenArtifacts.has(identity)) throw new Error('INVALID_ARTIFACT: 重复产物回执')
            seenArtifacts.add(identity)
            const hash = createHash('sha256').update(readFileSync(file)).digest('hex')
            if (hash !== a.contentHash) throw new Error('HASH_MISMATCH: 产物内容与回执不符')
            produced.push({ ...a, ref: file, attemptId:attempt.attemptId })
          }
          const checkOwnership = async () => {
            const changed = [...(await git(cwd, ['diff', '--no-renames', '--name-only', '-z', baseSha])).split('\0'), ...(await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0')].filter(Boolean)
            for (const file of changed) {
              if (unchangedInput(cwd,file,inherited.get(file))) continue
              if (!node.ownership.writes.some((p) => matches(file, p)) || node.ownership.forbiddenWrites.some((p) => matches(file, p))) throw new Error(`OWNERSHIP_VIOLATION: ${file} 超出任务写入范围`)
            }
          }
          attempt.phase='verification'; this.journal.write(execution)
          await checkOwnership()
          if (!node.outputs.length && !node.acceptance.commands.length) throw new Error('NO_VERIFICATION: 没有任何可独立核验的产物或命令')
          for (const command of node.acceptance.commands) {
            if (command.cwdRef !== 'node-worktree') throw new Error('CHECK_CWD_UNSUPPORTED: 不能把验收命令放进其他任务目录')
            const check = await executeWsl(command.argv, cwd, { signal: taskAbort.signal, timeoutMs: node.execution.timeoutSeconds * 1000 })
            checks.push(check); taskChecks.push(check)
            if (check.state === 'cancelled' || check.state === 'timed-out' || check.exitCode !== command.expectedExitCode) throw new Error('CHECK_FAILED: 独立验收未通过')
          }
          await checkOwnership()
          if (taskAbort.signal.aborted) throw new Error('TASK_TIMEOUT: 验收阶段超时或取消')
          for (const a of produced) {
            if (createHash('sha256').update(readFileSync(a.ref)).digest('hex') !== a.contentHash) throw new Error('ARTIFACT_CHANGED: 验收期间产物被更改')
          }
          if (reviewRequired) {
            const snapshot = await verificationSnapshot(cwd,baseSha,produced,taskChecks)
            attempt.phase='review'; attempt.snapshotHash=snapshot.hash; this.journal.write(execution)
            const review = await dispatch({node,cwd,runId,baseSha,signal:taskAbort.signal,attemptId:attempt.attemptId,phase:'review',snapshotHash:snapshot.hash,
              prompt: '你是独立审查 Agent。只读审查任务范围、要求、变更和验收证据；不得修改文件或提交。声明的验收命令已由协调器在本工作树真实执行，结果位于快照 checks；本审查不提供 bash，不能把禁止重跑命令本身当作实现缺陷。若确实缺少必要的额外验证，返回 fail 并指出需要补充的证据。指出实际缺陷，不以完成任务数代替验收。只有所有要求与当前产物一致才 pass。\n任务：'+prompt+'\n本次已验快照：'+JSON.stringify(snapshot.data) })
            assertCurrent(attempt)
            if (taskAbort.signal.aborted) throw new Error('REVIEW_CANCELLED')
            if (review.attemptId !== attempt.attemptId || review.snapshotHash !== snapshot.hash || !Array.isArray(review.findings) || review.findings.some(x=>typeof x!=='string') || !['pass','fail'].includes(review.verdict)) throw new Error('INVALID_REVIEW: 审查必须绑定本次执行与产物快照')
            const after = await verificationSnapshot(cwd,baseSha,produced,taskChecks)
            if (after.hash !== snapshot.hash) throw new Error('REVIEW_REVISION_CHANGED: 审查期间提交或文件字节改变，审查失效')
            attempt.review={verdict:review.verdict as 'pass'|'fail',snapshotHash:snapshot.hash,findings:[...review.findings]}
            if (review.verdict !== 'pass' || review.findings.length) throw new Error('REVIEW_FAILED: '+review.findings.join('; '))
          }
          assertCurrent(attempt)
          attempt.phase='validated'; attempt.active=false; this.journal.write(execution)
          verifiedChecks.set(node.id, taskChecks); artifacts.push(...produced); completed.add(node.id)
          verifiedSnapshots.set(node.id, await verificationSnapshot(cwd,baseSha,produced,taskChecks))
          this.store.event({ workspaceId: ws, kind: 'task-validated', runId, nodeId: node.id, detail: 'content hashes, ownership and declared commands verified' })
          break
          } catch(error) {
            attempt.phase=taskAbort.signal.aborted?'cancelled':'failed'; attempt.active=false; attempt.error=String((error as Error).message); lastError=attempt.error; this.journal.write(execution)
            if (taskAbort.signal.aborted || signal.signal.aborted || number > repairRounds || /STALE_ATTEMPT|EXECUTION_LEASE|ARTIFACT_ESCAPE|OWNERSHIP_VIOLATION/.test(lastError)) throw error
            this.store.event({workspaceId:ws,kind:'task-repair',runId,nodeId:node.id,detail:'独立验收未通过，开始有限修复 '+number+'/'+repairRounds})
          }
          }
        } finally { clearTimeout(timeout); signal.signal.removeEventListener('abort', cancelTask); release() }
      }
      const stepIndexOf = (() => {
        const map = new Map<string, number>()
        if (options.schedule) options.schedule.steps.forEach((step, index) => step.taskIds.forEach((id) => map.set(id, index)))
        return (id: string) => map.get(id) ?? Number.MAX_SAFE_INTEGER
      })()
      const scheduledNodes = options.schedule ? [...workflow.nodes].sort((a, b) => (stepIndexOf(a.id) - stepIndexOf(b.id)) || 0) : workflow.nodes
      if (options.schedule) options.schedule.steps.forEach((step, index) => step.taskIds.forEach((id) => stepPlan.set(id, { index, agents: step.agents })))
      /**
       * 还没做完的最早那一步。并发额度按它算 —— 这样「第 k 步的代理数」只作用于第 k 步，
       * 后面步骤的任务不会提前把前一步的额度花掉（依赖未满足本来也开不了）。
       */
      const currentStep = () => {
        let best: { index: number; agents: number } | null = null
        for (const node of scheduledNodes) {
          if (completed.has(node.id)) continue
          const at = stepPlan.get(node.id)
          if (at && (!best || at.index < best.index)) best = at
        }
        return best
      }
      const stepCount = (index: number, delta: number) => {
        const live = Math.max(0, (stepLive.get(index) ?? 0) + delta)
        stepLive.set(index, live)
        if (live > (stepPeak.get(index) ?? 0)) stepPeak.set(index, live)
      }
      const audited = new Set<string>()
      const communications:{id:string;runId:string;groupId:string;attemptId:string;snapshotHash:string;from:string;to:string;body:string;round:number}[]=[]
      const supervisionReports:{groupId:string;memberId:string;findings:readonly string[];snapshotHash:string}[]=[]
      const acceptMessages=(value:any,groupId:string,memberId:string,attemptId:string,snapshotHash:string,round:number)=>{
        if(value.messages===undefined)return
        if(!Array.isArray(value.messages)||value.messages.length>6)throw new Error('COMMUNICATION_INVALID')
        for(const message of value.messages){
          if(typeof message.body!=='string'||message.body.length>4000||!options.schedule?.groups.some(g=>g.supervisorId===message.to)||message.to===memberId)throw new Error('COMMUNICATION_INVALID: 接收人/正文不合法')
          const id=contentDigest({groupId,memberId,to:message.to,body:message.body,round,snapshotHash})
          if(!communications.some(m=>m.id===id))communications.push({id,runId,groupId,attemptId,snapshotHash,from:memberId,to:message.to,body:message.body,round})
        }
        ;(execution as any).communications=communications;this.journal.write(execution)
      }
      const auditReadyGroups = async () => {
        for (const group of options.schedule?.groups ?? []) {
          if (audited.has(group.id) || !group.taskIds.every(id => completed.has(id))) continue
          signal.signal.throwIfAborted()
          const targetTaskId = group.taskIds[0]
          if (!targetTaskId) throw new Error('EMPTY_AUDIT_GROUP')
          const groupArtifacts = artifacts.filter(a => group.taskIds.includes(a.nodeId))
          const groupChecks = [...verifiedChecks].filter(([id]) => group.taskIds.includes(id)).flatMap(([, list]) => list)
          const capture = async () => Promise.all(group.taskIds.map(async id => {
            const cwd = this.trees.find(runId, id)!.path
            const snapshot = await verificationSnapshot(cwd, baseSha, groupArtifacts.filter(a => a.nodeId === id), verifiedChecks.get(id) ?? [])
            return {taskId:id, ...snapshot}
          }))
          const evidence = await capture()
          const snapshotHash = contentDigest(evidence)
          const attemptId = randomUUID()
          const release = await this.budget.acquire(signal.signal)
          const auditAbort = new AbortController()
          const cancel = () => auditAbort.abort(signal.signal.reason)
          signal.signal.addEventListener('abort', cancel, {once:true})
          const timeout = setTimeout(() => auditAbort.abort(new Error('AUDIT_TIMEOUT')), 120000)
          let audit
          try {
            if(group.supervisorId) {
              const leadAttemptId=randomUUID()
              const lead=await dispatch({node:null,targetTaskId,cwd:this.trees.find(runId,targetTaskId)!.path,runId,baseSha,signal:auditAbort.signal,attemptId:leadAttemptId,phase:'supervision',snapshotHash,memberId:group.supervisorId,
                prompt:'你是分管 '+group.supervisorLabel+'。职责：'+group.supervisorResponsibility+'。只读汇总本组合同和证据；需要向其他分管咨询时返回 messages:[{to:成员ID,body:具体接口问题}]，最多6条。不能自批实现，独立审查随后进行。证据不足或阻断问题 verdict=fail。\n可沟通成员：'+JSON.stringify(options.schedule?.groups.filter(g=>g.supervisorId).map(g=>({id:g.supervisorId,groupId:g.id})))+'\n合同：'+JSON.stringify(workflow.nodes.filter(n=>group.taskIds.includes(n.id)))+'\n证据：'+JSON.stringify(evidence)+'\n收件：'+JSON.stringify(communications.filter(m=>m.to===group.supervisorId))})
              auditAbort.signal.throwIfAborted()
              if(lead.attemptId!==leadAttemptId||lead.snapshotHash!==snapshotHash||!['pass','fail'].includes(lead.verdict)||!Array.isArray(lead.findings))throw new Error('SUPERVISION_INVALID')
              supervisionReports.push({groupId:group.id,memberId:group.supervisorId,findings:lead.findings,snapshotHash});(execution as any).supervisionReports=supervisionReports
              acceptMessages(lead,group.id,group.supervisorId,leadAttemptId,snapshotHash,0)
              this.journal.write(execution)
              if(lead.verdict!=='pass')throw new Error('SUPERVISION_FAILED: '+lead.findings.join('; '))
            }
            audit = await dispatch({node:null, targetTaskId, cwd:this.trees.find(runId,targetTaskId)!.path, runId, baseSha,
              signal:auditAbort.signal, attemptId, phase:'audit', snapshotHash,memberId:group.auditAgentId,
              prompt:'你是 Loom 独立只读组审查员。以下是当前不可变证据包，包含任务合同、实际文件内容、哈希与命令回执。不得写入、执行命令或委托。发现阻断缺陷返回 fail；一般建议可列 findings 并 pass。证据不足必须 fail，不猜测。\n组：'+JSON.stringify(group)+'\n合同：'+JSON.stringify(workflow.nodes.filter(n=>group.taskIds.includes(n.id)))+'\n证据：'+JSON.stringify(evidence)})
            auditAbort.signal.throwIfAborted()
          } finally {clearTimeout(timeout); signal.signal.removeEventListener('abort', cancel); release()}
          if (audit.attemptId !== attemptId || audit.snapshotHash !== snapshotHash || !Array.isArray(audit.findings) || audit.findings.some(x=>typeof x!=='string') || !['pass','fail'].includes(audit.verdict)) throw new Error('INVALID_AUDIT: 审计必须绑定本次执行、产物快照与结论')
          if (contentDigest(await capture()) !== snapshotHash) throw new Error('AUDIT_REVISION_CHANGED: 审计期间文件或命令证据发生变化')
          execution.audits ??= []
          execution.audits.push({groupId:group.id,auditAgentId:group.auditAgentId,label:group.label,taskIds:[...group.taskIds],snapshotHash,verdict:audit.verdict as 'pass'|'fail',findings:[...audit.findings],at:new Date().toISOString()})
          this.journal.write(execution)
          this.store.event({workspaceId:ws,kind:'audit',runId,detail:group.id+' '+audit.verdict})
          if (audit.verdict !== 'pass') throw new Error('AUDIT_FAILED: '+group.id+' '+audit.findings.join('; '))
          audited.add(group.id)
        }
      }
      while (pending.size || jobs.size) {
        if (!jobs.size) await auditReadyGroups()
        const step = currentStep()
        const limit = step ? Math.min(effectiveConcurrency, step.agents) : effectiveConcurrency
        if (!signal.signal.aborted) for (const node of scheduledNodes) {
          if (jobs.size >= limit) break
          if (step && stepPlan.get(node.id)?.index !== step.index) continue
          if (!pending.has(node.id) || workflow.edges.some((e) => e.target === node.id && !completed.has(e.source))) continue
          pending.delete(node.id)
          const at = stepPlan.get(node.id)
          if (at) stepCount(at.index, 1)
          const job = start(node).catch((error: Error) => { failure ??= error }).finally(() => { jobs.delete(node.id); if (at) stepCount(at.index, -1) })
          jobs.set(node.id, job)
        }
        if (!jobs.size) break
        await Promise.race(jobs.values())
      }
      await Promise.all(jobs.values())
      if (failure) throw failure
      if (signal.signal.aborted || pending.size) throw new Error('cancelled or dependencies blocked')
      if (signal.signal.aborted) throw new Error('cancelled')
      for (const node of workflow.nodes) {
        const attempt=[...execution.tasks].reverse().find(task=>task.nodeId===node.id)!
        assertCurrentTerminal(attempt,reviewRequired)
        if (reviewRequired) { const taskArtifacts=artifacts.filter(a=>a.nodeId===node.id); const taskChecks=verifiedChecks.get(node.id)!; const snap=await verificationSnapshot(attempt.cwd,baseSha,taskArtifacts,taskChecks); if (snap.hash!==attempt.snapshotHash) throw new Error('DELIVERY_REVISION_CHANGED: 审过的产物在交付前改变') }
      }
      await auditReadyGroups()
      const captureCoordination=async()=>Promise.all(workflow.nodes.map(async node=>({taskId:node.id,...await verificationSnapshot(this.trees.find(runId,node.id)!.path,baseSha,artifacts.filter(a=>a.nodeId===node.id),verifiedChecks.get(node.id)??[])})))
      const communicationEvidence=(options.schedule?.organization?.communicationRounds??0)>0?await captureCoordination():[]
      if(JSON.stringify(communicationEvidence).length>2*1024*1024)throw new Error('COMMUNICATION_EVIDENCE_TOO_LARGE: 缩小责任组或由主会话复核')
      for(let round=1;round<=(options.schedule?.organization?.communicationRounds??0);round++) {
        const supervisors=options.schedule!.groups.filter(g=>g.supervisorId)
        const roundHash=contentDigest({evidence:communicationEvidence,reports:supervisionReports,audits:execution.audits,communications:communications.filter(m=>m.round<round)})
        for(const group of supervisors) {
          signal.signal.throwIfAborted()
          const attemptId=randomUUID(),targetTaskId=group.taskIds[0]!,release=await this.budget.acquire(signal.signal)
          const control=new AbortController(),abort=()=>control.abort(signal.signal.reason),timer=setTimeout(()=>control.abort(new Error('COMMUNICATION_TIMEOUT')),120000)
          signal.signal.addEventListener('abort',abort,{once:true})
          try {
            const reply=await dispatch({node:null,targetTaskId,cwd:this.trees.find(runId,targetTaskId)!.path,runId,baseSha,signal:control.signal,attemptId,phase:'coordination',snapshotHash:roundHash,memberId:group.supervisorId,
              prompt:'分管跨组协调，第 '+round+' 轮。只读核对各组接口与收件；证据缺失/接口不一致返回 fail，不能靠其他人说OK。最后一轮不得再发未解决问题；最多 '+options.schedule!.organization!.communicationRounds+' 轮，超出升级给会话总AI。\n职责：'+group.supervisorResponsibility+'\n实际文件证据：'+JSON.stringify(communicationEvidence)+'\n全部已验合同：'+JSON.stringify(workflow.nodes)+'\n分管汇总：'+JSON.stringify(supervisionReports)+'\n独立审计：'+JSON.stringify(execution.audits)+'\n收件：'+JSON.stringify(communications.filter(m=>m.to===group.supervisorId&&m.round<round))})
            control.signal.throwIfAborted()
            if(reply.attemptId!==attemptId||reply.snapshotHash!==roundHash||reply.verdict!=='pass'||!Array.isArray(reply.findings))throw new Error('COORDINATION_FAILED: '+(reply.findings??[]).join('; '))
            if(round===options.schedule!.organization!.communicationRounds&&reply.messages?.length)throw new Error('COMMUNICATION_UNRESOLVED: 达到轮数上限，请主会话处理')
            acceptMessages(reply,group.id,group.supervisorId!,attemptId,roundHash,round)
          }finally{clearTimeout(timer);signal.signal.removeEventListener('abort',abort);release()}
        }
      }
      if(communicationEvidence.length&&contentDigest(await captureCoordination())!==contentDigest(communicationEvidence))throw new Error('COORDINATION_REVISION_CHANGED: 跨组确认后文件证据变化')
      if(signal.signal.aborted)throw new Error('cancelled before delivery')
      const current=this.journal.read(runId)
      if(current?.state!=='running'||current.ownerToken!==execution.ownerToken)throw new Error('STALE_ATTEMPT: 执行身份已撤销，不能宣布交付')
      execution.state='validated'; this.journal.write(execution)
      record('validated')
      return { runId, state: 'validated' as const, completed: [...completed], artifacts, checks, audits: execution.audits ?? [],
        communications,supervisionReports,worktrees: this.trees.listLive(runId), integrated: false,
        ...(options.schedule ? { stepConcurrency: options.schedule.steps.map((s, i) => ({ id: s.id, agents: s.agents, peak: stepPeak.get(i) ?? 0 })) } : {}) }
    } catch (error) {
      // Parent cancellation owns the reason even if the child returned a partial result.
      if(options.signal?.aborted)error=options.signal.reason instanceof Error?options.signal.reason:new Error('RUN_CANCELLED')
      signal.abort(error); await Promise.all(jobs.values())
      const state = options.signal?.aborted || ['runtime disposed', 'run cancelled'].includes((signal.signal.reason as Error)?.message) ? 'cancelled' as const : 'failed' as const
      execution.state=state; execution.reason=(error as Error).message; for(const task of execution.tasks)task.active=false; this.journal.write(execution)
      record(state, (error as Error).message)
      return { runId, state, completed: [...completed], artifacts, checks, audits: execution.audits ?? [], error: (error as Error).message,
        communications:(execution as any).communications??[],supervisionReports:(execution as any).supervisionReports??[],worktrees: this.trees.listLive(runId), integrated: false }
    } finally {
      options.signal?.removeEventListener('abort', abort)
      this.activeOwnership.delete(`${repo}:${runId}`)
      this.activeRuns.delete(runId)
      try { await lease.release() } finally { finish() }
      // Worktrees are preserved for user inspection/integration; never forced away.
    }
  }

  private recoverWithLease(token:string): number {
    const recovered=this.journal.recover(token)
    for(const record of recovered)this.store.appendRun({workspaceId:record.workspaceId,sessionId:this.store.latestRuns(10000,record.workspaceId).find(r=>r.runId===record.runId)?.sessionId,runId:record.runId,workflowId:record.workflowId,revision:record.revision,planHash:record.planHash,attempt:1,state:'interrupted',startedAt:record.startedAt,endedAt:new Date().toISOString(),reason:record.reason})
    return recovered.length
  }
  async recoverInactiveRuns(): Promise<number> {
    const lease=await this.coordinator.acquire()
    try{return this.recoverWithLease(lease.token)}finally{await lease.release()}
  }

  async cancel(runId: string): Promise<boolean> {
    const run = this.activeRuns.get(runId)
    if (!run) return false
    run.controller.abort(new Error('run cancelled'))
    await run.settled
    return true
  }

  setConcurrency(limit: number): void { this.budget.setLimit(limit) }

  async cancelAll(): Promise<void> {
    const runs = [...this.activeRuns.values()]
    for (const run of runs) run.controller.abort(new Error('runtime disposed'))
    await Promise.all(runs.map((run) => run.settled))
  }
}

export function createHostDispatcher(subagents: any, parent: any): TaskDispatcher {
  return async (task) => {
    const text = { type: 'string' }
    const outputSchema = task.phase === 'implementation' ? {
      type: 'object', properties: {
        verdict: { type: 'string', enum: ['ready', 'blocked', 'failed'] },
        attemptId: { type: 'string', const: task.attemptId },
        artifactRefs: { type: 'array', items: { type: 'object', properties: { nodeId: text, port: text, ref: text, contentHash: text }, required: ['nodeId', 'port', 'ref', 'contentHash'], additionalProperties: false } },
      }, required: ['verdict', 'attemptId', 'artifactRefs'], additionalProperties: false,
    } : {
      type: 'object', properties: {
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        attemptId: { type: 'string', const: task.attemptId },
        snapshotHash: { type: 'string', const: task.snapshotHash },
        findings: { type: 'array', items: text },
        messages: { type: 'array', items: { type: 'object', properties: { to: text, body: text }, required: ['to', 'body'], additionalProperties: false } },
      }, required: ['verdict', 'attemptId', 'snapshotHash', 'findings'], additionalProperties: false,
    }
    // The official driver validates and captures this tool's authoritative result.
    // Plain-text summaries cannot accidentally become a delivery receipt.
    const run = await subagents.start('loom-worktree', { parent, label: dispatchLabel(task.runId, task.node?.id ?? task.targetTaskId ?? 'review'),
      ...(task.phase!=='implementation'?{toolFilter:{allow:['read','glob','grep']},persona:'Loom 独立只读审查'}:{}), outputSchema,
      prompt: [{ type: 'text', text: task.prompt + '\nLOOM_EXECUTION_CONTRACT '+JSON.stringify({phase:task.phase,attemptId:task.attemptId,snapshotHash:task.snapshotHash??null,memberId:task.memberId??null})+'\n最终交付必须调用 structured_output 工具，按其 schema 填写本次 attemptId；不要用 Markdown 或普通文字代替回执。'+(task.phase!=='implementation'?'审查使用本次 snapshotHash；没有跨组消息就用空数组。':'artifactRefs 中 ref 必须为本工作树内真实文件路径并填写 SHA-256；不得制造范围外文件。') }], signal: task.signal })
    try {
      const result = await run.result
      task.signal.throwIfAborted()
      if (result.stopReason !== 'completed') throw new Error(`CHILD_FAILED: 子代理未正常完成（${String(result.stopReason)}）`)
      const response = result.output.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n').trim()
      const value = result.structured ?? JSON.parse(response.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''))
      if (value?.attemptId !== task.attemptId || task.phase!=='implementation' && value?.snapshotHash !== task.snapshotHash) throw new Error('STALE_ATTEMPT: 子代理回执没有绑定本次执行身份')
      if (task.phase === 'implementation') {
        if (value?.verdict !== 'ready' || !Array.isArray(value.artifactRefs)) throw new Error('INVALID_TASK_RESULT: 子代理未返回结构化产物')
      } else if (!['pass','fail'].includes(value?.verdict) || !Array.isArray(value.findings) || value.findings.some((x:unknown)=>typeof x!=='string')) throw new Error('INVALID_REVIEW_RESULT: 审查回执不合法')
      return {...value, artifactRefs:value.artifactRefs ?? []}
    } finally { await run.dispose() }
  }
}

function assertCurrentTerminal(attempt: TaskAttempt | undefined, reviewRequired: boolean): void {
  if (!attempt || attempt.phase!=='validated' || attempt.active || reviewRequired && (attempt.review?.verdict!=='pass' || attempt.review.snapshotHash!==attempt.snapshotHash)) throw new Error('DELIVERY_NOT_REVIEWED')
}
