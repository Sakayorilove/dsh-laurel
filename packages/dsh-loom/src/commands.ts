/** Human-owned session commands. Dispatch uses the actual receiving Agent. */
import { ExecutionJournal } from './execution.js'
import { randomUUID } from 'node:crypto'
import type { LoomStore } from './store.js'
import type { LoomConfig } from './config.js'
import { toolWorkspace } from './workspace.js'

export interface CommandDeps {
  planning?: import('./planning.js').PlanningController
  store: LoomStore
  getConfig: () => LoomConfig
  scmFacts: (cwd: string, sessionId?: string) => Promise<{ repo: string; head: string; dirty: boolean }>
  runWorkflow: (workflow: any, exec: any, args: any) => Promise<any>
  cancelRun: (runId: string) => Promise<boolean>
  log: { warn: (...args: unknown[]) => void }
}

export function registerCommands(ctx: any, deps: CommandDeps): void {
  const jobs = new Map<string, { workspaceId: string; sessionId: string; workflowId: string; revision: number; baseSha: string; approvedHash?: string; controller: AbortController; promise: Promise<void> }>()
  // Admission spans SCM and native /plan off awaits, before a job exists.
  const admissions = new Map<string, string>()
  const result = (text: string, kind: 'success' | 'error' = 'success') => ({ kind, text })
  ctx.get('commands').register({
    name: 'loom', description: 'Loom 项目工作台：规划审核、版本批准、会话开关与运行管理',
    input: { hint: 'on | off | status | cancel-plan | unlock <architectureId> <nodeId> <revision> | approve-run <workflowId> <revision> <baseSha> <planHash> | cancel <runId> | approve-resume <runId> <planHash>' },
    async handler(invocation: any) {
      const agent = invocation.agent
      const sessionId = agent?.session?.id ?? agent?.session?.header?.id
      const workspaceId = toolWorkspace({ agent })
      if (!workspaceId || typeof sessionId !== 'string') return result('无法识别实际会话工作区。', 'error')
      const args = String(invocation.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
      let action = args[0] ?? 'status'
      if (action === 'on' || action === 'off') {
        if (args.length !== 1) return result('用法：/loom on 或 /loom off', 'error')
        deps.store.writeSessionActivation(sessionId, action === 'on')
        return result(`Loom 在本会话已${action === 'on' ? '启用' : '停用'}。${!deps.getConfig().enabled ? '全局总开关目前关闭，请在 Loom 设置页打开。' : ''}`)
      }
      if (action === 'status' && args.length <= 1) {
        return result(`Loom 总开关：${deps.getConfig().enabled ? '开' : '关'}；本会话：${deps.store.readSessionActivation(sessionId) ? '启用' : '停用'}。\n/loom unlock <架构ID> <模块ID> <当前架构版本>\n/loom approve-run <工作流ID> <版本> <冻结SHA> <计划hash>\n/loom cancel <运行ID>\n/loom approve-resume <运行ID> <计划hash>（保留旧树，新建执行）\n/loom cancel-plan（放弃待批准规划）`)
      }
      if(action==='cancel-plan'&&args.length===1){deps.planning?.cancel(sessionId,invocation.commandId);if(deps.planning)await ctx.get('commands').execute(agent,'/plan off',[],invocation.signal);return result('已放弃本次待批准规划，历史计划保留；没有批准或执行任何任务。')}
      if (action === 'unlock') {
        if (args.length !== 4 || !/^[1-9][0-9]*$/.test(args[3]!)) return result('用法：/loom unlock <architectureId> <nodeId> <当前架构版本>', 'error')
        if (!deps.getConfig().enabled || !deps.store.readSessionActivation(sessionId)) return result('Loom 已停用。请打开总开关并启用本会话。', 'error')
        invocation.signal?.throwIfAborted()
        try {
          // CommandRuntime appends command/run with source.kind=user before calling
          // this registered handler and command/done after it settles. No tool or
          // HTTP endpoint exposes the unlocking capability.
          const next = deps.store.unlockArchitectureNode(workspaceId, args[1]!, args[2]!, Number(args[3]), {
            sessionId, commandId: invocation.commandId, cwd: agent.session.header.cwd,
            command: `/loom unlock ${args[1]} ${args[2]} ${args[3]}`,
          })
          return result(`已解除模块 ${args[2]} 的设计冻结，架构 ${next.architectureId}@${next.revision}。旧任务映射需要重新规划或确认。`)
        } catch (error) { return result(String((error as Error)?.message ?? error), 'error') }
      }
      if (action === 'cancel' && args.length === 2) {
        const runId = args[1]!
        const job = jobs.get(runId)
        const recorded = deps.store.latestRuns(10000, workspaceId).find(r => r.runId === runId)
        if (job && job.workspaceId !== workspaceId || !job && !recorded) return result('找不到本工作区的运行。', 'error')
        if (job) job.controller.abort(new Error('USER_CANCELLED'))
        const cancelled = await deps.cancelRun(runId)
        if (job) await job.promise
        return result(job || cancelled ? `已取消 ${runId}；工作树保留。` : '运行已结束或不在当前实例中。')
      }
      let approvedHash:string|undefined
      if(action==='approve-run') {
        if(args.length!==5)return result('用法：/loom approve-run <workflowId> <revision> <baseSha> <当前计划hash>','error')
        approvedHash=args.pop();action='run';args[0]='run'
      }
      if(action==='run'&&deps.planning?.held(sessionId,agent)&&!approvedHash)return result('当前计划尚未批准；请在工作台审核并点「批准当前版本并开工」。','error')
      let recoveryOf: string | undefined
      if(action==='approve-resume'){if(args.length!==3)return result('用法：/loom approve-resume <运行ID> <当前计划hash>','error');approvedHash=args.pop();action='resume';args[0]='resume'}
      if (action === 'resume') {
        if(deps.planning&&!approvedHash)return result('恢复也需要重新批准，请在运行页点击「批准恢复运行」。','error')
        if(args.length!==2)return result('用法：/loom resume <运行ID>','error')
        let record
        try {record=new ExecutionJournal(deps.store.paths.root).read(args[1]!)}catch(error){return result(String((error as Error).message),'error')}
        if(!record||record.workspaceId!==workspaceId)return result('找不到本项目的可恢复运行。','error')
        const owner = deps.store.latestRuns(10000, workspaceId).find(r => r.runId === record.runId)?.sessionId
        if(owner && owner !== sessionId)return result('请回到批准此运行的会话恢复。','error')
        if(record.state==='validated')return result('该运行已通过验收；无需恢复。','error')
        if(!['failed','cancelled','interrupted'].includes(record.state)) {
          const job=jobs.get(record.runId)
          if(job?.sessionId===sessionId && job.approvedHash===approvedHash)return result(`计划正在执行：${record.runId}。请查看运行进度，无需再次批准或恢复。`)
          return result('该运行尚未结束，请查看进度；停止后才能批准恢复。','error')
        }
        const latest = deps.store.latestRevision(record.workflowId,workspaceId)
        if(!latest)return result('找不到当前已采纳的任务版本。','error')
        recoveryOf=record.runId;args.splice(0,args.length,'run',record.workflowId,String(latest.revision),record.baseSha);action='run'
      }
      if (action !== 'run' || args.length < 3 || args.length > 4 || !/^[1-9][0-9]*$/.test(args[2]!)) return result('用法：/loom run <workflowId> <revision> [40位baseSha]，或 /loom on|off|status|cancel <runId>', 'error')
      if (!deps.getConfig().enabled || !deps.store.readSessionActivation(sessionId)) return result('Loom 已停用。请打开总开关并启用本会话。', 'error')
      invocation.signal?.throwIfAborted()
      const workflow = deps.store.revisionAt(args[1]!, Number(args[2]), workspaceId)
      if (!workflow) return result('找不到本工作区已采纳的任务版本。', 'error')
      const active = [...jobs.entries()].find(([, j]) => j.workspaceId === workspaceId && j.sessionId === sessionId)
      if(active) {
        const [id,job]=active
        if(!recoveryOf && job.workflowId===workflow.workflowId && job.revision===workflow.revision && (!args[3]||job.baseSha===args[3]) && job.approvedHash===approvedHash)return result(`计划正在执行：${id}。请查看运行进度，无需再次批准。`)
        return result('本会话正在执行另一份计划，请查看进度，完成或取消后再批准新计划。','error')
      }
      const key=JSON.stringify([workspaceId,sessionId]),request=JSON.stringify([workflow.workflowId,workflow.revision,args[3],approvedHash,recoveryOf])
      if(admissions.has(key))return result(admissions.get(key)===request?'开工请求正在提交，请稍候，无需重复批准。':'本会话正在提交另一份开工请求，请稍候。',admissions.get(key)===request?'success':'error')
      admissions.set(key,request)
      try {
      const facts = await deps.scmFacts(agent.session.header.cwd,sessionId)
      const baseSha = args[3] ?? facts.head
      if (!/^[a-f0-9]{40}$/.test(baseSha) || baseSha !== facts.head) return result('冻结基线已变化，请刷新仓库状态再开工。', 'error')
      if (facts.dirty) return result('仓库有未提交改动，请先提交本次基线；隔离任务只会读取冻结 commit。', 'error')
      invocation.signal?.throwIfAborted()
      if (!deps.getConfig().enabled || !deps.store.readSessionActivation(sessionId)) return result('Loom 已停用。', 'error')
      try {
        if(approvedHash){deps.planning?.approve(sessionId,workspaceId,workflow,baseSha,approvedHash,invocation.commandId);if(deps.planning)await ctx.get('commands').execute(agent,'/plan off',[],invocation.signal)}
        else if(deps.planning) return result('执行需要当前版本的明确批准，请使用工作台批准按钮。','error')
      } catch(error){return result(String((error as Error).message),'error')}
      const runId = `run-${randomUUID()}`, controller = new AbortController(), startedAt = new Date().toISOString()
      deps.store.appendRun({ workspaceId, sessionId, runId, workflowId: workflow.workflowId, revision: workflow.revision, planHash: '<pending-validation>', attempt: 1, state: 'queued', startedAt })
      // Yield to register the admitted job before asynchronous validation or cancellation.
      const promise = Promise.resolve().then(async () => {
        try {
          controller.signal.throwIfAborted()
          const delivery=await deps.runWorkflow(workflow, { agent, signal: controller.signal }, { baseSha, runId, recoveryOf })
          if(delivery&&typeof agent.inject==='function')agent.inject({id:randomUUID(),role:'user',source:{kind:'loom-delivery',form:'snapshot'},content:[{type:'text',text:'Loom 执行结果回传当前会话总AI。仅汇总实际结果，不自动集成或新增实施。状态：'+delivery.state+'；运行：'+runId+'；分管汇总：'+JSON.stringify(delivery.supervisionReports??[])+'；独立审计：'+JSON.stringify(delivery.audits??[])+'；跨组消息：'+JSON.stringify(delivery.communications??[])+'；错误：'+(delivery.error??'无')+'；工作树保留，尚未集成。'}]})
        } catch (error) {
          const text = String((error as Error)?.message ?? error)
          deps.store.appendRun({ workspaceId, sessionId, runId, workflowId: workflow.workflowId, revision: workflow.revision, planHash: '<validation-failed>', attempt: 1,
            state: controller.signal.aborted ? 'cancelled' : 'failed', startedAt, endedAt: new Date().toISOString(), reason: text })
          deps.log.warn(`运行 ${runId} 未完成：${text}`)
        } finally { jobs.delete(runId) }
      })
      jobs.set(runId, { workspaceId, sessionId, workflowId:workflow.workflowId, revision:workflow.revision, baseSha, approvedHash, controller, promise })
      return result(`已提交 ${runId}，请在 Loom 运行页查看进度。取消：/loom cancel ${runId}`)
      } finally { admissions.delete(key) }
    },
  })
  ctx.effect(() => async () => {
    const active = [...jobs.values()]
    for (const job of active) job.controller.abort(new Error('plugin disposed'))
    await Promise.all(active.map(job => job.promise))
  }, 'loom.commands-jobs')
}
