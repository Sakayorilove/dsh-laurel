/**
 * dsh-loom · 宿主半边：HTTP 数据面。
 *
 * 客户端半边（画布 / 设置页）只通过这些端点读写。
 * 响应统一 `{ ok, data }` / `{ ok, error }`，与 Laurel / Strata 同一套约定。
 *
 * 路由前缀 `/loom` 要三处一致：本文件、`src/index.ts`、客户端 bundle。
 */
import { ExecutionJournal } from './execution.js'
import {
  CAPABILITY_KEYS,
  adoptPlannerOutput,
  buildTaskPackage,
  compileCoordinatorPrompt,
  compileWorkflow,
  compileArchitecturePrompt,
  contentDigest,
  dependencyLayers,
  describeDegradations,
  knownCapabilities,
  missingCapabilities,
  validateArchitecture,
  validateAdoptedRevision,
  validateWorkflow,
  capabilityGaps,
  checkOwnership,
  confirmDestructiveOp,
  isRunInFlight,
  isUsable,
  issueDestructiveOp,
  normalizeWorkspaceId,
  stageLabel,
  computeStale,
  validateSourceMap,
  type LoomCapabilities,
  type PendingDestructiveOp,
  type Presentation,
  applyFlowOrder,
  defaultFlowPlan,
  validateFlowPlan,
  FLOW_MAX_AGENTS, flowPlanDigest,
} from './core/index.js'
import { exportInitialPlanning, previewInitialPlanning } from './core/initial-planner.js'
import { validateConfigPatch } from './config.js'
import { previewRefinement } from './refinement.js'
import { existsSync, promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LoomConfig } from './config.js'
import type { LoomStore } from './store.js'
import type { IWorktreeManager } from './worktree.js'

export interface HandlerDeps {
  readonly planning?: import('./planning.js').PlanningController
  readonly diagnostics?: () => unknown
  readonly store: LoomStore
  readonly getConfig: () => LoomConfig
  readonly setConfig: (patch: unknown) => LoomConfig
  readonly capabilities: () => LoomCapabilities
  /** 工作树管理器。懒建。**只有 HTTP 破坏性路由**用它。 */
  readonly getWorktrees?: () => IWorktreeManager
  /**
   * 解析请求归属的工作区。
   *
   * 归属必须来自**可信来源**（会话 cwd），不是请求参数。
   * 宿主半边由 `src/index.ts` 注入；解析不出时返回 `null`，
   * 调用方必须拒绝写入 —— **不许回落全局**。
   */
  readonly resolveWorkspace?: (req: unknown) => string | null | Promise<string | null>
  readonly resolveSessionId?: (req: unknown) => string | null | Promise<string | null>
  readonly resolveSessionCwd?: (req: unknown) => string | null | Promise<string | null>
  readonly scmFacts?: (cwd: string, sessionId?: string) => Promise<{ repo: string; head: string; dirty: boolean }>
  readonly authorizeDestructiveRequest?: (req: unknown) => boolean | Promise<boolean>
  readonly log: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void }
}

/**
 * 一次性破坏性操作 token 的本进程表。
 *
 * 刻意**不落盘**：token 是「这一次点击的有效期」，重启后必须重新发起。
 * 落盘反而会让一个旧 token 在用户早就不看这个页面时仍然有效。
 */
const pendingDestructive = new Map<string, PendingDestructiveOp>()

/** token 由归属 + 目标 + 时间派生，不可预测且天然唯一。 */

const MAX_BODY = 512 * 1024

function readJsonBody(req: any, limit = MAX_BODY): Promise<unknown | null> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        resolve(null)
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function send(res: any, status: number, payload: unknown, method = 'GET'): void {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(method === 'HEAD' ? undefined : JSON.stringify(payload))
}

export function createHandler(deps: HandlerDeps) {
  const { store, getConfig, setConfig, capabilities, resolveWorkspace, log } = deps

  /**
   * 解析这次请求属于哪个工作区。
   *
   * 优先级：宿主注入的可信解析器 → 请求头 `x-loom-workspace`（客户端同页面同源，
   * 仅在没有宿主上下文时用，例如独立调试）。两者都拿不到就返回 null。
   *
   * 注意**不看 URL 查询参数** —— 查询参数完全由调用方控制，拿它当归属
   * 等于把归属性交回给可能写错的模型。
   */
  const resolveWs = async (req: any): Promise<string | null> => {
    // Only a host-backed resolver can establish identity. Headers and query strings
    // identify a requested session, never the workspace itself.
    if (!resolveWorkspace) return null
    try { return await resolveWorkspace(req) } catch { return null }
  }

  const stateSnapshot = (ws: string | null, sessionId: string | null) => {
    const c = capabilities()
    const legacy = store.legacyFilesPresent()
    const draft = ws ? store.readDraft(ws) : null
    const revisions = (ws ? store.listRevisions(ws) : []).map((r) => ({
      workflowId: r.workflowId,
      revision: r.revision,
      title: r.title,
      adoptedAt: r.adoptedAt,
      planInput: r.inputDigest,
      nodes: r.nodes.length,
      edges: r.edges.length,
      openQuestions: r.openQuestions.length,
    }))
    const architectures = (ws ? store.listArchitectures(ws) : []).map((a) => ({
      architectureId: a.architectureId,
      revision: a.revision,
      nodes: a.nodes.length,
      edges: a.edges.length,
      createdAt: a.createdAt,
    }))
    // 能力逐档呈现。**任一档为真都不蕴含其余为真**。
    const capabilityStages = CAPABILITY_KEYS.map((key) => {
      const fact = c[key]
      return { key, backend: fact.backend, declaredByHost: fact.declaredByHost,
        implementedByLoom: fact.implementedByLoom, availableInEnv: fact.availableInEnv,
        verifiedInRun: fact.verifiedInRun, lastVerifiedAt: fact.lastVerifiedAt,
        stage: stageLabel(fact), usable: isUsable(fact), gaps: capabilityGaps(fact), limits: fact.limits }
    })
    const sourceMap = ws ? store.readSourceMap(ws) : null
    const sourceArch = sourceMap && ws ? store.latestArchitecture(sourceMap.architectureId, ws) : null
    const stale = sourceMap && sourceArch ? computeStale(sourceMap, sourceArch.revision, sourceArch.nodes.map((n) => n.id)) : null
    return {
      config: getConfig(),
      planning:sessionId&&deps.planning?{...deps.planning.read(sessionId),request:deps.planning.read(sessionId).request?{id:deps.planning.read(sessionId).request!.id}:undefined}:null,
      sessionEnabled: sessionId ? store.readSessionActivation(sessionId) : false,
      capabilities: c,
      capabilityStages,
      degradations: describeDegradations(c),
      workspaceId: ws,
      executionTarget: sessionId&&ws?store.readExecutionTarget(sessionId,ws):null,
      workspaceResolved: ws !== null,
      workspaceUnresolvedReason: ws === null ? '无法从会话上下文确定工作区，已拒绝读写分区数据（不回落全局）' : null,
      draft,
      revisions,
      architectures,
      presentation: ws ? store.readPresentation(ws) : null,
      sourceMap,
      stale,
      runs: ws ? store.latestRuns(100, ws) : [],
      execution: ws ? (() => { try {return {records:new ExecutionJournal(store.paths.root).summary(ws),error:null}}catch(error){return {records:[],error:String((error as Error).message)}} })() : {records:[],error:null},
      legacyFiles: legacy,
      legacyWarning: legacy.drafts || legacy.presentation || legacy.sourcemap
        ? '存在旧版全局文件（drafts/presentation/sourcemap）。它们不再被读取，需用 loom_worktree migrate 预览迁移。'
        : null,
      stats: ws ? store.stats(ws) : { revisions: 0, architectures: 0, runs: 0, events: 0 },

    }
  }

  return async function handler(req: any, res: any): Promise<void> {
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.replace(/^\/loom/, '').replace(/\/+$/, '') || '/'

    try {
      const globalSettings = route === '/config' || route === '/diagnostics'
      const ws = globalSettings ? null : await resolveWs(req)
      // sessionId 与 workspace 是两件事：前者是「哪个会话」（会话态开关要用），
      // 后者是「哪个项目目录」（项目数据要用）。没接 resolveSessionId 的调用方
      // （测试/内嵌壳）回落到 header —— 也**不能**再拿 ws 当前提，否则又变成
      // 「没有工作区就认不出会话」，正是用户在新对话里撞到的那堵墙。
      const sessionId = globalSettings ? null : deps.resolveSessionId ? await deps.resolveSessionId(req) : (typeof req.headers?.['x-loom-session'] === 'string' ? req.headers['x-loom-session'] : null)
      req.signal?.throwIfAborted()
      const projectRoutes = new Set(['/planning/export', '/planning/preview', '/planning/accept', '/planning/collect', '/planning/stage', '/flow', '/flow/apply', '/scm', '/session/activation', '/workflow', '/architecture', '/architecture/adopt', '/architecture/preview', '/architecture/accept', '/sourcemap', '/adopt', '/draft', '/presentation', '/prompt', '/batch', '/runs', '/events', '/worktree/force-remove', '/worktree/force-remove/confirm'])
      // `/session/planning-mode` 不在上面：它是**会话态开关**，只按 sessionId
      // 读写，不碰工作区。放进来会让「新对话还没选工作区就点规划模式」被
      // 409 拦掉 —— 而规划模式恰恰是「还没有项目时最该能用」的那类开关。
      // 它自己的两个分支都已有 `!sessionId` 检查兜底，不会漏。
      if (projectRoutes.has(route) && !ws) return send(res, 409, { ok: false, code: 'WORKSPACE_UNRESOLVED', error: '无法从宿主会话确定工作区，请选择项目会话' }, method)
      // 只接受 JSON 写入，并做同源检查：避免别的网页顺手改草案。
      if (method === 'POST') {
        const contentType = req.headers?.['content-type'] ?? ''
        if (!/^application\/json(?:;|$)/i.test(contentType)) {
          return send(res, 415, { ok: false, error: '写入必须使用 application/json' })
        }
        const origin = req.headers?.origin
        if (origin) {
          let originHost: string
          try {
            originHost = new URL(origin).host
          } catch {
            return send(res, 403, { ok: false, error: '不支持此来源' })
          }
          if (originHost !== req.headers?.host) return send(res, 403, { ok: false, error: '跨来源写入已拒绝' })
        }
      }

      /* ---------------- 读 ---------------- */
      if (method === 'GET' || method === 'HEAD') {
        if (route === '/state' || route === '/') return send(res, 200, { ok: true, data: stateSnapshot(ws, sessionId) }, method)
        if (route === '/config') return send(res, 200, { ok: true, data: getConfig() }, method)
        if (route === '/session/activation') {
          if (!sessionId) return send(res, 409, { ok: false, code: 'SESSION_UNRESOLVED', error: '请选择真实项目会话' }, method)
          return send(res, 200, { ok: true, data: { sessionId, enabled: store.readSessionActivation(sessionId) } }, method)
        }
        if (route === '/session/planning-mode') {
          if (!sessionId) return send(res, 409, { ok: false, code: 'SESSION_UNRESOLVED', error: '请选择真实项目会话' }, method)
          // 会话没记过就用全局默认（planningModeDefault）；一旦这个会话手动改过，
          // 以会话记录为准 —— 否则用户关不掉默认开启的规划模式。
          if(deps.planning) return send(res,200,{ok:true,data:deps.planning.status(sessionId)},method)
          const explicit = store.readSessionPlanningModeExplicit(sessionId)
          const planningMode = explicit === null ? getConfig().planningModeDefault === true : explicit
          return send(res, 200, { ok: true, data: { sessionId, planningMode, source: explicit === null ? 'default' : 'session' } }, method)
        }
        if(route === '/plan/snapshot') {
          if(!ws||!sessionId||!deps.planning)throw new Error('PLAN_UNAVAILABLE')
          const wf=store.latestRevision(url.searchParams.get('workflowId')??'',ws)
          if(!wf)throw new Error('WORKFLOW_NOT_FOUND')
          return send(res,200,{ok:true,data:deps.planning.snapshot(sessionId,ws,wf,url.searchParams.get('baseSha')??'')},method)
        }
        if (route === '/flow') {
          const workflowId = url.searchParams.get('workflowId') ?? ''
          const wf = workflowId ? store.latestRevision(workflowId, ws!) : null
          if (!wf) return send(res, 404, { ok: false, error: '找不到任务图；先在规划里采纳一份任务图' }, method)
          const saved = store.readFlowPlan(ws!, workflowId)
          // maxAgents 一并返回：下拉上限必须与宿主侧调度上限同源，别让客户端自己写死。
          if (!saved) return send(res, 200, { ok: true, data: { plan: defaultFlowPlan(wf), digest:flowPlanDigest(defaultFlowPlan(wf)), saved: false, warnings: [], maxAgents: FLOW_MAX_AGENTS } }, method)
          const check = validateFlowPlan(saved, wf)
          return send(res, 200, { ok: true, data: check.ok
            ? { plan: check.plan, digest:flowPlanDigest(check.plan!), saved: true, warnings: check.warnings, maxAgents: FLOW_MAX_AGENTS }
            : { plan: defaultFlowPlan(wf), digest:flowPlanDigest(saved), saved: false, warnings: [{ path: 'saved', message: '已保存流程不一致；下方为待审核修复草案，保存并批准前禁止运行：' + check.errors.map((e) => e.message).join('；') }], maxAgents: FLOW_MAX_AGENTS } }, method)
        }
        if (route === '/planning/collect') {
          const cwd = deps.resolveSessionCwd ? await deps.resolveSessionCwd(req) : null
          if (!cwd) return send(res, 409, { ok: false, code: 'WORKSPACE_UNRESOLVED', error: '宿主未提供真实会话目录' }, method)
          const file = join(cwd, '.loom', 'plan.json')
          let text: string | null = null
          let mtimeMs = 0
          try {
            const stat = await fsp.stat(file)
            if (stat.isFile() && stat.size > 0 && stat.size <= 2 * 1024 * 1024) { text = await fsp.readFile(file, 'utf8'); mtimeMs = stat.mtimeMs }
          } catch { /* 模型还没有写文件时按未产处理 */ }
          // requestId 一并返回：客户端窗口重开后没有内存里的导出记录，
          // 只能靠它判断这份文件是不是为最近一次规划请求写的。
          const latest = store.latestPlanningRequest(ws!)
          return send(res, 200, { ok: true, data: { text, mtimeMs, path: '.loom/plan.json', requestId: latest?.payloadHash ?? null } }, method)
        }
        if (route === '/scm') {
          const cwd = deps.resolveSessionCwd ? await deps.resolveSessionCwd(req) : null
          if (!cwd) return send(res, 409, { ok: false, code: 'WORKSPACE_UNRESOLVED', error: '宿主未提供真实会话目录' }, method)
          if (!deps.scmFacts) return send(res, 409, { ok: false, code: 'SCM_UNAVAILABLE', error: '当前宿主没有可用 Git 读取能力' }, method)
          req.signal?.throwIfAborted()
          const facts = await deps.scmFacts(cwd,sessionId??undefined)
          req.signal?.throwIfAborted()
          return send(res, 200, { ok: true, data: facts }, method)
        }
        if (route === '/diagnostics') return send(res,200,{ok:true,data:deps.diagnostics?.() ?? {loadedVersion:null,installedVersion:null,services:{},execution:{healthy:true},recommendations:[]}},method)
        if (route === '/capabilities') {
          const c = capabilities()
          return send(res, 200, { ok: true, data: { capabilities: c, degradations: describeDegradations(c) } }, method)
        }
        if (route === '/events') {
          return send(res, 200, { ok: true, data: store.readEvents(200, ws!) }, method)
        }
        if (route === '/runs') {
          return send(res, 200, { ok: true, data: store.latestRuns(200, ws!) }, method)
        }
        if (route === '/batch') {
          const workflowId = url.searchParams.get('workflowId') ?? ''
          const revision = Number(url.searchParams.get('revision') ?? '0')
          const index = Number(url.searchParams.get('index') ?? '0')
          const wf = store.revisionAt(workflowId, revision, ws!)
          if (!wf) return send(res, 404, { ok: false, error: `找不到 revision：${workflowId}@${revision}` }, method)
          const c = capabilities()
          const missing = missingCapabilities(c, wf)
          try {
            const plan = compileWorkflow(wf, c, {
              resolveCwd: (n) => `<cwd>/${n.id}`,
              baseSha: url.searchParams.get('baseSha') ?? '<unset-baseSha>',
            })
            const batch = plan.batches[index]
            if (!batch) return send(res, 404, { ok: false, error: `批次 ${index} 不存在` }, method)
            return send(
              res,
              200,
              {
                ok: true,
                data: {
                  workflowId,
                  revision,
                  index,
                  planHash: plan.planHash,
                  scriptHash: batch.scriptHash,
                  script: batch.script,
                  expectations: batch.expectations,
                  concurrency: plan.concurrency[index],
                  missingCapabilities: missing,
                  dispatchable: false,
                  dispatchReason: "编译预览不持有真实 Agent；运行必须通过 loom_run 的执行闸门",
                },
              },
              method,
            )
          } catch (error) {
            return send(res, 400, { ok: false, error: (error as Error).message }, method)
          }
        }
        if (route === '/workflow') {
          const workflowId = url.searchParams.get('workflowId') ?? ''
          const revision = url.searchParams.get('revision')
          const wf = revision === null ? store.latestRevision(workflowId, ws!) : store.revisionAt(workflowId, Number(revision), ws!)
          if (!wf) return send(res, 404, { ok: false, error: `找不到工作流：${workflowId}` }, method)
          return send(res, 200, { ok: true, data: wf }, method)
        }
        if (route === '/architecture') {
          const architectureId = url.searchParams.get('architectureId') ?? ''
          const arch = store.latestArchitecture(architectureId, ws!)
          if (!arch) return send(res, 404, { ok: false, error: `找不到架构：${architectureId}` }, method)
          return send(res, 200, { ok: true, data: arch }, method)
        }
        return send(res, 404, { ok: false, error: `未知端点：${route}` }, method)
      }

      if (method !== 'POST') return send(res, 405, { ok: false, error: `不支持的方法：${method}` })

      const body = (await readJsonBody(req)) as Record<string, unknown> | null
      req.signal?.throwIfAborted()
      if (body === null) return send(res, 400, { ok: false, error: '请求体不是合法 JSON 或超过上限' })

      /* ---------------- 写 ---------------- */
      if (route === '/config') {
        try { validateConfigPatch(body) } catch (error) { return send(res, 400, { ok: false, code: 'CONFIG_INVALID', error: (error as Error).message }) }
        const persisted = store.writeConfig(body, getConfig())
        const next = setConfig(persisted)
        store.event({ kind: 'config', detail: JSON.stringify(next) })
        return send(res, 200, { ok: true, data: next })
      }

      if (route === '/session/activation') {
        if (!sessionId) return send(res, 409, { ok: false, code: 'SESSION_UNRESOLVED', error: '请选择真实项目会话' })
        if (Object.keys(body).some((key) => key !== 'enabled') || typeof body.enabled !== 'boolean') return send(res, 400, { ok: false, code: 'SESSION_INVALID', error: '只允许布尔值 enabled' })
        return send(res, 200, { ok: true, data: store.writeSessionActivation(sessionId, body.enabled) })
      }

      if (route === '/session/planning-mode') {
        if (!sessionId) return send(res, 409, { ok: false, code: 'SESSION_UNRESOLVED', error: '请选择真实项目会话' })
        if (Object.keys(body).some((key) => key !== 'planningMode') || typeof body['planningMode'] !== 'boolean') return send(res, 400, { ok: false, code: 'SESSION_INVALID', error: '只允许布尔值 planningMode' })
        if(deps.planning) return send(res,200,{ok:true,data:deps.planning.select(sessionId,body['planningMode'])})
        const written = store.writeSessionPlanningMode(sessionId, body['planningMode'])
        store.event({ kind: 'planning-mode', detail: `session=${sessionId} planningMode=${written}` })
        return send(res, 200, { ok: true, data: { sessionId, planningMode: written } })
      }

      if (!getConfig().enabled || (sessionId && !store.readSessionActivation(sessionId))) return send(res, 409, { ok: false, code: 'LOOM_DISABLED', error: '请先启用 Loom 总开关和当前会话开关' })

      if (route === '/plan/adopt') {
        if(!sessionId||!ws||!deps.planning)throw new Error('PLAN_UNAVAILABLE')
        return send(res,200,{ok:true,data:deps.planning.adopt(sessionId,ws,String(body.candidateId??''))})
      }
      if (route === '/plan/resolve') {
        if(!sessionId||!ws||!deps.planning)throw new Error('PLAN_UNAVAILABLE')
        const cwd=await deps.resolveSessionCwd?.(req)
        let scm:unknown={available:false,reason:'宿主没有 Git 读取能力'}
        if(cwd&&deps.scmFacts)try{scm={available:true,...await deps.scmFacts(cwd,sessionId)}}catch{scm={available:false,reason:'本次未能读取当前会话的 Git 仓库与基线；不能编造或忽略'}}
        return send(res,200,{ok:true,data:deps.planning.prepareResolution(sessionId,ws,body,{observedAt:new Date().toISOString(),cwd,scm,capabilities:deps.capabilities()})})
      }
      if (route === '/flow') {
        const workflowId = typeof body['workflowId'] === 'string' ? body['workflowId'] : ''
        const wf = workflowId ? store.latestRevision(workflowId, ws!) : null
        if (!wf) return send(res, 404, { ok: false, error: '找不到任务图；先在规划里采纳一份任务图' })
        const original=store.readFlowPlan(ws!,workflowId)??defaultFlowPlan(wf)
        if(deps.planning&&body.expectedDigest!==flowPlanDigest(original))return send(res,409,{ok:false,code:'PLAN_VERSION_CHANGED',error:'流程已被另一窗口修改，请重新读取后编辑'})
        const check = validateFlowPlan(body['plan'], wf)
        if (!check.ok) return send(res, 400, { ok: false, code: 'FLOW_INVALID', error: check.errors.map((e) => `${e.path}: ${e.message}`).join('；') })
        const saved = store.writeFlowPlan(ws!, workflowId, { ...check.plan!, updatedAt: new Date().toISOString() })
        store.event({ workspaceId: ws!, kind: 'flow-plan', workflowId, detail: `steps=${saved.steps.length} groups=${saved.groups.length}` })
        return send(res, 200, { ok: true, data: { plan: saved, digest:flowPlanDigest(saved), warnings: check.warnings } })
      }

      if (route === '/flow/apply') {
        const workflowId = typeof body['workflowId'] === 'string' ? body['workflowId'] : ''
        const wf = workflowId ? store.latestRevision(workflowId, ws!) : null
        if (!wf) return send(res, 404, { ok: false, error: '找不到任务图；先在规划里采纳一份任务图' })
        const original=store.readFlowPlan(ws!,workflowId)??defaultFlowPlan(wf)
        if(deps.planning&&body.expectedDigest!==flowPlanDigest(original))return send(res,409,{ok:false,code:'PLAN_VERSION_CHANGED',error:'流程已被另一窗口修改，请重新读取后编辑'})
        const current = store.readDraft(ws!)
        if (current && current.candidate) return send(res, 409, { ok: false, code: 'DRAFT_DIRTY', error: '还有未采纳的草案；先「采纳为新 revision」，再应用流程顺序' })
        const check = validateFlowPlan(body['plan'], wf)
        if (!check.ok) return send(res, 400, { ok: false, code: 'FLOW_INVALID', error: check.errors.map((e) => `${e.path}: ${e.message}`).join('；') })
        const applied = applyFlowOrder(wf, check.plan!)
        if (!applied.ok) return send(res, 400, { ok: false, code: 'FLOW_APPLY_REFUSED', error: applied.errors.map((e) => `${e.path}: ${e.message}`).join('；') })
        const candidate = { ...wf, edges: [...wf.edges, ...applied.addedEdges] }
        const nextRevision = (current?.draftRevision ?? 0) + 1
        const draft = {
          candidate,
          mode: current?.mode ?? 'manual',
          workflowId,
          draftRevision: nextRevision,
          workspaceId: ws!,
          lockedConstraints: current?.lockedConstraints ?? [],
          architectureId: current?.architectureId,
          architectureRevision: current?.architectureRevision,
          updatedAt: new Date().toISOString(),
        }
        const written = store.writeDraft(draft, { expectedRevision: current?.draftRevision ?? null })
        if (!written.ok) return send(res, 409, { ok: false, code: 'REVISION_CONFLICT', error: written.conflict.detail, data: { conflict: written.conflict, current } })
        store.writeFlowPlan(ws!, workflowId, { ...check.plan!, updatedAt: new Date().toISOString() })
        store.event({ workspaceId: ws!, kind: 'flow-apply', workflowId, detail: `added=${applied.addedEdges.length}` })
        return send(res, 200, { ok: true, data: { addedEdges: applied.addedEdges, draft: written.draft } })
      }


      if (route.startsWith('/planning/')) {
        try {
          if (route === '/planning/stage') {
            const text = (body as { text?: unknown }).text
            if (typeof text !== 'string' || !text.trim() || text.length > 200000) return send(res, 400, { ok: false, code: 'PLANNING_SCHEMA', error: '请求文档需要 1..200000 字符的 text' })
            const cwd = deps.resolveSessionCwd ? await deps.resolveSessionCwd(req) : null
            if (!cwd) return send(res, 409, { ok: false, code: 'WORKSPACE_UNRESOLVED', error: '宿主未提供真实会话目录' })
            await fsp.mkdir(join(cwd, '.loom'), { recursive: true })
            await fsp.writeFile(join(cwd, '.loom', 'plan-request.md'), text, 'utf8')
            return send(res, 200, { ok: true, data: { path: '.loom/plan-request.md' } })
          }
          if (route === '/planning/export') return send(res, 200, { ok: true, data: exportInitialPlanning(store, ws!, body, getConfig().defaultMaxConcurrency) })
          const preview = previewInitialPlanning(store, ws!, String(body.payloadHash ?? ''), body.reply)
          if (route === '/planning/accept') {
            if (body.candidateHash !== preview.candidateHash) throw new Error('PREVIEW_CHANGED: 候选与预览不一致，请重新预览')
            if (body.expectedArchitectureRevision !== preview.expectedArchitectureRevision || body.expectedWorkflowRevision !== preview.expectedWorkflowRevision) throw new Error('REVISION_CONFLICT: 采纳基线与预览不一致')
            const draft = store.adoptPlanningBundle(ws!, preview, { architecture: preview.expectedArchitectureRevision, workflow: preview.expectedWorkflowRevision, draft: preview.expectedDraftRevision }, getConfig().defaultMode)
            store.event({ kind: 'initial-plan-adopted', workspaceId: ws!, workflowId: preview.workflow.workflowId, revision: preview.workflow.revision, detail: `architecture=${preview.architecture.architectureId}@${preview.architecture.revision}` })
            return send(res, 200, { ok: true, data: { ...preview, draft } })
          }
          if (route === '/planning/preview') return send(res, 200, { ok: true, data: preview })
          return send(res, 404, { ok: false, error: '未知规划端点' })
        } catch (error) {
          const message = (error as Error).message
          return send(res, /SCHEMA|INVALID|MISMATCH|UNSUPPORTED/.test(message.split(':')[0]!) ? 400 : 409, { ok: false, code: message.split(':')[0], error: message })
        }
      }

      if (route === '/validate') {
        const kind = body['kind'] === 'architecture' ? 'architecture' : 'workflow'
        const result = kind === 'architecture' ? validateArchitecture(body['document']) : validateWorkflow(body['document'])
        return send(res, 200, { ok: true, data: result })
      }

      if (route === '/draft') {
            if (!ws) {
          return send(res, 409, {
            ok: false,
            error: '无法确定请求归属的工作区，已拒绝写入（不回落全局）',
            code: 'WORKSPACE_UNRESOLVED',
          })
        }
        const current = store.readDraft(ws)
        // 草案若已存在且带别的工作区 id，说明归属对不上 —— 拒绝并保留现稿。
        if (current?.workspaceId && current.workspaceId !== ws) {
          return send(res, 409, {
            ok: false,
            error: `草案归属为 ${current.workspaceId}，与本次请求 ${ws} 不一致，已拒绝覆盖`,
            code: 'WORKSPACE_MISMATCH',
          })
        }
        const own = checkOwnership(current?.workspaceId ?? ws, ws)
        if (!own.ok) return send(res, 409, { ok: false, error: own.reason, code: 'WORKSPACE_MISMATCH' })

        const mode = body['mode'] === 'auto' || body['mode'] === 'manual' ? body['mode'] : (current?.mode ?? 'manual')
        const workflowId = typeof body['workflowId'] === 'string' ? body['workflowId'] : (current?.workflowId ?? 'loom-default')
        const nextRevision = (current?.draftRevision ?? 0) + 1
        const candidate = body['candidate'] === undefined ? current?.candidate : body['candidate']
        if (candidate !== undefined && (!candidate || typeof candidate !== 'object' || !Array.isArray((candidate as any).nodes) || !Array.isArray((candidate as any).edges) || (candidate as any).workflowId !== workflowId)) {
          return send(res, 400, { ok: false, error: '草案必须包含相同 workflowId 的 nodes 与 edges' })
        }
        const draft = {
          candidate: candidate as any,
          mode,
          workflowId,
          draftRevision: nextRevision,
          workspaceId: ws,
          lockedConstraints: Array.isArray(body['lockedConstraints'])
            ? (body['lockedConstraints'] as string[])
            : (current?.lockedConstraints ?? []),
          architectureId:
            typeof body['architectureId'] === 'string' ? body['architectureId'] : current?.architectureId,
          architectureRevision:
            typeof body['architectureRevision'] === 'number' ? body['architectureRevision'] : current?.architectureRevision,
          updatedAt: new Date().toISOString(),
        }
        // 乐观并发闸门：客户端声明的 expectedRevision 必须与磁盘现稿**恰好相等**。
        if (body['expectedRevision'] !== null && !Number.isInteger(body['expectedRevision'])) {
          return send(res, 400, { ok: false, error: '必须携带 expectedRevision（首次写入为 null）' })
        }
        const expectedRevision = body['expectedRevision'] as number | null
        const result = store.writeDraft(draft, { expectedRevision })
        if (!result.ok) {
          // 冲突是预期内结果 —— 返回 409 + 现稿 revision，调用方据此重读再改。
          return send(res, 409, {
            ok: false,
            error: result.conflict.detail,
            code: 'REVISION_CONFLICT',
            data: { conflict: result.conflict, current },
          })
        }
        store.event({ workspaceId: ws!, kind: 'draft', workflowId, detail: `ws=${ws} mode=${mode} rev=${draft.draftRevision}` })
        return send(res, 200, { ok: true, data: result.draft })
      }

      if (route === '/adopt') {
        const workflowId = String(body['workflowId'] ?? '')
        const candidate = body['candidate']
        const latest = store.latestRevision(workflowId, ws!)
        if ((body['expectedRevision'] ?? null) !== (latest?.revision ?? null)) return send(res, 409, { ok: false, code: 'REVISION_CONFLICT', error: '采纳所基于的任务版本已变更，请重读' })
        const revision =
          (latest?.revision ?? 0) + 1
        const result = adoptPlannerOutput(candidate, {
          inputDigest: typeof body['inputDigest'] === 'string' ? body['inputDigest'] : undefined,
          adoptedAt: new Date().toISOString(),
        })
        if (!result.accepted || !result.workflow) {
          return send(res, 400, { ok: false, error: '候选图未通过校验，未产生 revision', data: result })
        }
        const next = { ...result.workflow, workflowId, revision }
        store.appendRevision(next, ws!)
        store.event({ workspaceId: ws!, kind: 'adopt', workflowId, revision, detail: `nodes=${next.nodes.length}` })
        return send(res, 200, { ok: true, data: { workflow: next, blocked: result.blocked, warnings: result.warnings } })
      }

      if (route === '/architecture' || route === '/architecture/adopt') {
        const arch = body['architecture'] as { architectureId?: string; revision?: number } | undefined
        if (!arch || typeof arch.architectureId !== 'string') {
          return send(res, 400, { ok: false, error: '缺少 architecture.architectureId' })
        }
        const result = validateArchitecture(arch)
        if (!result.ok) return send(res, 400, { ok: false, error: '架构未通过校验', data: result })
        const latest = store.latestArchitecture(arch.architectureId, ws!)
        if ((body['expectedRevision'] ?? null) !== (latest?.revision ?? null)) return send(res, 409, { ok: false, code: 'REVISION_CONFLICT', error: '架构版本已变更，请重读再提交' })
        try { store.appendArchitecture(arch as never, ws!, route === '/architecture/adopt') }
        catch (error) { return send(res, 409, { ok: false, code: String((error as Error).message).split(':')[0], error: (error as Error).message }) }
        store.event({ workspaceId: ws!, kind: 'architecture', detail: `${arch.architectureId}@${String(arch.revision)}` })
        return send(res, 200, { ok: true, data: { warnings: result.warnings } })
      }

      if (route === '/architecture/preview' || route === '/architecture/accept') {
        try {
          const preview = previewRefinement(store, ws!, String(body['payloadHash'] ?? ''), body['reply'])
          if (route === '/architecture/accept') {
            if (body['candidateHash'] !== preview.candidateHash) return send(res, 409, { ok: false, code: 'PREVIEW_CHANGED', error: '候选与预览不一致，请重新预览' })
            if (body['expectedRevision'] !== preview.expectedRevision) return send(res, 409, { ok: false, code: 'REVISION_CONFLICT', error: '预览后版本变化，请重新预览' })
            store.appendArchitecture(preview.candidate, ws!, true)
            store.event({ kind: 'refinement-adopted', workspaceId: ws!, detail: `${preview.candidate.architectureId}@${preview.candidate.revision}` })
          }
          return send(res, 200, { ok: true, data: preview })
        } catch (error) {
          const message = (error as Error).message
          return send(res, 409, { ok: false, code: message.split(':')[0], error: message })
        }
      }

      if (route === '/sourcemap') {
        const map = body['sourceMap'] as any
        const wf = store.latestRevision(String(map?.workflowId ?? ''), ws!)
        const arch = store.latestArchitecture(String(map?.architectureId ?? ''), ws!)
        if (!wf || !arch) return send(res, 404, { ok: false, error: '请先采纳任务图并保存架构' })
        if (body['expectedWorkflowRevision'] !== wf.revision || body['expectedArchitectureRevision'] !== arch.revision) return send(res, 409, { ok: false, code: 'REVISION_CONFLICT', error: '映射所基于的版本已变' })
        const problems = validateSourceMap(map, wf.nodes.map((n) => n.id))
        if (problems.length) return send(res, 400, { ok: false, error: problems.join('; ') })
        for (const entry of map.entries) {
          if (!Array.isArray(entry.architectureNodeIds) || entry.architectureNodeIds.some((id: any) => !arch.nodes.some((n) => n.id === id))) problems.push('映射指向不存在的架构模块')
          if (!Array.isArray(entry.decisionIds) || entry.decisionIds.some((id: any) => !arch.nodes.some((n) => n.id === id && n.kind === 'decision'))) problems.push('decisionIds 指向不存在的决策')
        }
        if (problems.length) return send(res, 400, { ok: false, error: problems.join('; ') })
        const confirmed = body['confirmedNodeIds']
        if (!Array.isArray(confirmed) || !confirmed.length || confirmed.some((id) => typeof id !== 'string' || !wf.nodes.some((n) => n.id === id))) return send(res, 400, { ok: false, error: '需显式列出 confirmedNodeIds' })
        const previous = store.readSourceMap(ws!)
        const boundEntries = []
        for (const entry of map.entries) {
          const old = previous?.workflowId === wf.workflowId && previous.architectureId === arch.architectureId ? previous.entries.find((e) => e.workflowNodeId === entry.workflowNodeId) : null
          if (!confirmed.includes(entry.workflowNodeId)) {
            if (!old || contentDigest([old.architectureNodeIds, old.decisionIds]) !== contentDigest([entry.architectureNodeIds, entry.decisionIds])) return send(res, 400, { ok: false, error: '不得改动未确认任务的映射' })
            boundEntries.push(old)
          } else boundEntries.push({ ...entry, basedOnArchitectureRevision: arch.revision, workflowFingerprint: contentDigest(wf.nodes.find((n) => n.id === entry.workflowNodeId)) })
        }
        if (previous?.workflowId === wf.workflowId && previous.architectureId === arch.architectureId && previous.entries.some((old) => !confirmed.includes(old.workflowNodeId) && !map.entries.some((e: any) => e.workflowNodeId === old.workflowNodeId))) return send(res, 400, { ok: false, error: '不得删除未确认任务的映射' })
        const bound = { ...map, entries: boundEntries }
        store.writeSourceMap(ws!, bound)
        return send(res, 200, { ok: true, data: bound })
      }

      if (route === '/presentation') {
            if (!ws) {
          return send(res, 409, {
            ok: false,
            error: '无法确定请求归属的工作区，已拒绝写入（不回落全局）',
            code: 'WORKSPACE_UNRESOLVED',
          })
        }
        const p = body['presentation'] as Presentation | undefined
        if (!p || p.schemaVersion !== 1 || typeof p.workflowId !== 'string') {
          return send(res, 400, { ok: false, error: 'presentation 形状不合法' })
        }
        store.writePresentation(ws, p)
        return send(res, 200, { ok: true, data: { workspaceId: ws, layoutDigest: contentDigest(p.nodes) } })
      }

      if (route === '/prompt') {
        // 确定性导出。「生成提示词」与「发给 AI 优化」「开始执行」是三个分开的动作。
        //
        // 修正：三种 kind 是**三条独立路线**，各有各自的素材来源，
        // 不是「先查工作流，查不到再想别的」。其中：
        //   coordinator → 需要 workflow
        //   task        → 需要 workflow + nodeId
        //   architecture→ 需要 architecture（**不查工作流**）
        const rawKind = body['kind']
        const kind = rawKind === 'architecture' ? 'architecture' : rawKind === 'task' ? 'task' : 'coordinator'

        if (kind === 'architecture') {
          const architectureId = String(body['architectureId'] ?? '')
          const arch = store.latestArchitecture(architectureId, ws!)
          if (!arch) {
            return send(res, 404, {
              ok: false,
              error: `找不到架构：${architectureId}（architecture 分支不需要工作流；请先提交 architecture）`,
              code: 'ARCHITECTURE_NOT_FOUND',
            })
          }
          const nodeId = typeof body['nodeId'] === 'string' ? body['nodeId'] : undefined
          if (nodeId && !arch.nodes.some((n) => n.id === nodeId)) {
            return send(res, 404, { ok: false, error: `架构中找不到节点：${nodeId}`, code: 'NODE_NOT_FOUND' })
          }
                const draftState = ws ? store.readDraft(ws) : null
          // 基线 revision 必须来自**真实记录**，不硬造 `revision - 1`。
          const context = store.architectureContext(architectureId, ws!)!
          const baseRevision = context.baseRevision
          const baseArch = store.architectureAt(architectureId, baseRevision, ws!) ?? undefined
          const pkg = compileArchitecturePrompt({
            projectId: String(body['projectId'] ?? ws ?? 'loom-project'),
            proposalId: String(body['proposalId'] ?? `${arch.architectureId}@${arch.revision}`),
            baseRevision,
            draftRevision: arch.revision,
            inputDigest: contentDigest(arch),
            scope: nodeId ? { nodeIds: [nodeId] } : 'all',
            base: baseArch,
            draft: arch,
            changes: context.changes,
            lockedConstraints: [...new Set([...(arch.constraints ?? []), ...(draftState?.lockedConstraints ?? [])])],
            sources: [],
          })
          store.saveRefinementRequest(ws!, { payloadHash: pkg.payloadHash, architectureId, baseRevision, draftRevision: arch.revision, scope: nodeId ? [nodeId] : 'all' })
          return send(res, 200, {
            ok: true,
            data: {
              kind: 'architecture',
              architectureId: arch.architectureId,
              revision: arch.revision,
              baseRevision,
              nodeId: nodeId ?? null,
              payloadHash: pkg.payloadHash,
              text: pkg.text,
            },
          })
        }

        const workflowId = String(body['workflowId'] ?? '')
        const wf = body['revision'] === undefined ? store.latestRevision(workflowId, ws!) : store.revisionAt(workflowId, Number(body['revision']), ws!)
        if (!wf) return send(res, 404, { ok: false, error: `找不到工作流：${workflowId}` })

        if (kind === 'coordinator') {
          const { layers } = dependencyLayers(wf.nodes, wf.edges)
          return send(res, 200, { ok: true, data: { kind, text: compileCoordinatorPrompt(wf, layers) } })
        }

        const node = wf.nodes.find((n) => n.id === body['nodeId'])
        if (!node) return send(res, 404, { ok: false, error: `找不到节点：${String(body['nodeId'])}` })
        const text = buildTaskPackage({
          workflow: { workflowId: wf.workflowId, revision: wf.revision, inputDigest: wf.inputDigest },
          node,
          upstream: wf.edges
            .filter((e) => e.target === node.id)
            .map((e) => ({ nodeId: e.source, port: e.sourcePort, type: e.artifactType, ref: `artifact://${e.source}/${e.sourcePort}` })),
          cwd: typeof body['cwd'] === 'string' ? (body['cwd'] as string) : `<cwd>/${node.id}`,
          baseSha: typeof body['baseSha'] === 'string' ? (body['baseSha'] as string) : '<unset-baseSha>',
          allowedChecks: node.acceptance.commands.map((c) => c.argv.join(' ')),
        })
        return send(res, 200, { ok: true, data: { kind: 'task', nodeId: node.id, text } })
      }

      /* ---------- 破坏性操作：强制移除工作树 ----------
         模型工具里**没有**这个动作。只有用户从画布/设置页点按钮才能走到这里，
         而且必须两步：先 /worktree/force-remove（拿 token），再
         /worktree/force-remove/confirm（带回 token + 目标路径）。          */

      if (route.startsWith('/worktree/force-remove') && !(await deps.authorizeDestructiveRequest?.(req))) {
        return send(res, 403, { ok: false, code: 'USER_APPROVAL_REQUIRED', error: '缺少宿主可信的用户审批，强制删除已停用' })
      }
      if (route === '/worktree/force-remove') {
            if (!ws) {
          return send(res, 409, { ok: false, error: '无法确定请求归属的工作区，已拒绝', code: 'WORKSPACE_UNRESOLVED' })
        }
        const runId = String(body['runId'] ?? '')
        const taskId = String(body['taskId'] ?? '')
        if (!runId || !taskId) return send(res, 400, { ok: false, error: '缺少 runId 或 taskId' })

        const mgr = deps.getWorktrees?.()
        if (!mgr) return send(res, 503, { ok: false, error: '工作树管理器不可用（能力未挂载）' })

        const targetPath = mgr.pathFor(runId, taskId)
        const record = mgr.find(runId, taskId)
        if (!record) {
          return send(res, 404, {
            ok: false,
            error: `没有 ${runId}/${taskId} 的工作树记录 —— 无记录一律不删`,
            code: 'NO_WORKTREE_RECORD',
          })
        }
        const inFlight = store.latestRuns(10000).some((r) => r.runId === runId && isRunInFlight(r.state))
        if (inFlight) {
          return send(res, 409, {
            ok: false,
            error: `run ${runId} 仍在途，拒绝删除。请先停止派发并等它收敛。`,
            code: 'IN_FLIGHT',
          })
        }
        const willDiscard = await mgr.describeChanges(runId, taskId)
        const now = new Date().toISOString()
        const token = randomUUID()
        const op = issueDestructiveOp({ token, workspaceId: ws, runId, taskId, targetPath, willDiscard, now })
        pendingDestructive.set(token, op)
        store.event({ kind: 'worktree-force-remove-requested', workspaceId: ws, runId, detail: `task=${taskId} path=${targetPath}` })
        return send(res, 200, {
          ok: true,
          data: {
            // 用户要先看到这些，再决定确不确认。
            token: op.token,
            workspaceId: op.workspaceId,
            runId: op.runId,
            taskId: op.taskId,
            targetPath: op.targetPath,
            willDiscard: op.willDiscard,
            issuedAt: op.issuedAt,
            expiresAt: op.expiresAt,
            confirmPath: '/loom/worktree/force-remove/confirm',
          },
        })
      }

      if (route === '/worktree/force-remove/confirm') {
            if (!ws) {
          return send(res, 409, { ok: false, error: '无法确定请求归属的工作区，已拒绝', code: 'WORKSPACE_UNRESOLVED' })
        }
        const token = String(body['token'] ?? '')
        const runId = String(body['runId'] ?? '')
        const taskId = String(body['taskId'] ?? '')
        const targetPath = String(body['targetPath'] ?? '')

        const mgr = deps.getWorktrees?.()
        if (!mgr) return send(res, 503, { ok: false, error: '工作树管理器不可用（能力未挂载）' })

        const verdict = confirmDestructiveOp([...pendingDestructive.values()], {
          token,
          workspaceId: ws,
          runId,
          taskId,
          targetPath,
          now: new Date().toISOString(),
          inFlight: store.latestRuns(10000).some((r) => r.runId === runId && isRunInFlight(r.state)),
          targetExists: existsSync(targetPath),
        })
        if (!verdict.ok) {
          return send(res, 409, { ok: false, error: verdict.detail, code: verdict.code })
        }
        // 核销成功 → token 立即作废（一次性）。
        pendingDestructive.delete(token)
        const removed = await mgr.forceRemove(runId, taskId)
        if (!removed.ok) {
          return send(res, 500, { ok: false, error: `确认通过但底层移除失败：${removed.detail}`, code: 'REMOVE_FAILED' })
        }
        store.event({ kind: 'worktree-force-removed', workspaceId: ws, runId, detail: `task=${taskId} path=${targetPath}` })
        return send(res, 200, { ok: true, data: { removed: targetPath, runId, taskId, detail: removed.detail } })
      }

      if (route === '/worktree/force-remove/pending') {
            return send(res, 200, {
          ok: true,
          data: {
            workspaceId: ws,
            pending: [...pendingDestructive.values()].filter((p) => !ws || p.workspaceId === ws),
          },
        })
      }

      if (route === '/compile') {
        const workflowId = String(body['workflowId'] ?? '')
        const revision = typeof body['revision'] === 'number' ? body['revision'] : undefined
        const wf = revision === undefined ? store.latestRevision(workflowId, ws!) : store.revisionAt(workflowId, revision, ws!)
        if (!wf) return send(res, 404, { ok: false, error: `找不到 revision：${workflowId}` })
        const adopted = validateAdoptedRevision(wf)
        if (!adopted.ok) return send(res, 400, { ok: false, error: 'revision 未通过校验', data: adopted })
        const c = capabilities()
        try {
          const plan = compileWorkflow(wf, c, {
            resolveCwd: (n) => `<cwd>/${n.id}`,
            baseSha: typeof body['baseSha'] === 'string' ? (body['baseSha'] as string) : '<unset-baseSha>',
          })
          return send(res, 200, {
            ok: true,
            data: {
              planHash: plan.planHash,
              batches: plan.batches.map((b) => ({
                index: b.index,
                nodeIds: b.nodeIds,
                agentCalls: b.agentCalls,
                scriptHash: b.scriptHash,
                expectations: b.expectations,
              })),
              concurrency: plan.concurrency,
              warnings: plan.warnings,
              capabilityNotes: plan.capabilityNotes,
              missingCapabilities: missingCapabilities(c, wf),
            },
          })
        } catch (error) {
          return send(res, 400, { ok: false, error: (error as Error).message })
        }
      }

      return send(res, 404, { ok: false, error: `未知端点：${route}` })
    } catch (error) {
      // 关键写入失败必须可见 —— 不吞。
      log.error(`/loom${route} 处理失败：${(error as Error)?.message ?? error}`)
      return send(res, 500, { ok: false, error: String((error as Error)?.message ?? error) })
    }
  }
}
