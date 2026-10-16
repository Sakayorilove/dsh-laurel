/** One session owns its pending request; only human commands issue run approval. */
import { readFileSync, existsSync, openSync, closeSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWrite, type LoomStore } from './store.js'
import { contentDigest, normalizeWorkspaceId, compileFlowSchedule, defaultFlowPlan, flowPlanDigest, FLOW_MAX_AGENTS, type WorkflowRevision } from './core/index.js'
import { exportInitialPlanning, previewInitialPlanning } from './core/initial-planner.js'
import type { LoomConfig } from './config.js'
import { resolutionDocument, type ResolutionBaseline } from './preflight.js'

export function agentSessionId(agent:any):string|null { return agent?.session?.id ?? agent?.session?.header?.id ?? null }
export const PLANNING_READ_TOOLS = new Set(['read','glob','grep','web_search','web_fetch','loom_status','loom_capabilities','loom_validate','loom_submit_plan','loom_resolve_questions'])
interface SessionPlan {
  resolution?: ResolutionBaseline
  resolutionRejected?: {resolutionId:string;document:any;error:string;at:string}
  request?: {id:string;messageId:string;workspaceId:string;prompt:string}
  candidate?: {turn?:number;callId?:string;id:string;workspaceId:string;document:any;preview:any;markdown:string;at:string}
  history: {turn?:number;callId?:string;id:string;workspaceId:string;document:any;markdown:string;at:string}[]
  rejected?: {requestId:string;document:any;error:string;at:string}
  waitingApproval?: boolean
  approval?: {id:string;hash:string;baseSha:string;workflowId:string;revision:number;workspaceId:string;commandId:string;consumed:boolean;at:string;snapshot?:unknown}
}
export function readablePlan(workflow:WorkflowRevision, flow:any=defaultFlowPlan(workflow)):string {
  const lines=['# '+workflow.title,'','计划版本：'+workflow.workflowId+'@'+workflow.revision,'']
  for(const [i,id] of flow.order.entries()) {
    const step=flow.steps.find((s:any)=>s.id===id)
    lines.push('## '+(i+1)+'. '+id+'（最多 '+step.agents+' 个并发调用）','')
    for(const taskId of step.taskIds) {
      const task=workflow.nodes.find(n=>n.id===taskId)
      if(!task)continue
      lines.push('### '+task.title+' ['+task.id+']',task.goal,'职责：'+task.role,
        '修改范围：'+task.ownership.writes.join('、'),
        '完成条件：'+task.acceptance.doneWhen.join('；'),
        '前置任务：'+(workflow.edges.filter(e=>e.target===task.id).map(e=>e.source).join('、')||'无'), '')
    }
  }
  if(flow.organization){lines.push('## 团队分工',...flow.organization.members.map((m:any)=>'- '+m.label+'：'+m.role+'；'+m.responsibility+'；任务 '+m.taskIds.join('、')),...flow.organization.teams.map((t:any)=>'- '+t.label+'：'+t.taskIds.join('、')+'；分管 '+t.supervisorId+'；独立审查 '+t.reviewerId),'')}
  if(workflow.openQuestions.length)lines.push('## 待解决问题',...workflow.openQuestions.map(q=>'- '+q))
  return lines.join('\n')
}

export class PlanningController {
  guardReady=false
  constructor(readonly store:LoomStore, readonly config:()=>LoomConfig, readonly service:(name:string)=>any) {}
  private file(id:string) {return join(this.store.paths.root,'session-plans',contentDigest(id)+'.json')}
  read(id:string):SessionPlan {const file=this.file(id); if(!existsSync(file))return {history:[]}; try{return JSON.parse(readFileSync(file,'utf8'))}catch{throw new Error('PLANNING_STORAGE_CORRUPT')}}
  private update<T>(id:string, fn:(state:SessionPlan)=>T):T {
    const file=this.file(id);mkdirSync(join(this.store.paths.root,'session-plans'),{recursive:true})
    let fd:number
    try {fd=openSync(file+'.lock','wx',0o600)}catch{throw new Error('PLAN_BUSY: 另一窗口正在修改计划，请重读后重试')}
    try {const state=this.read(id);const result=fn(state);atomicWrite(file,JSON.stringify(state));return result}
    finally {closeSync(fd);unlinkSync(file+'.lock')}
  }
  private native(agent?:any) {try{return this.service('planMode')??agent?.ctx?.get?.('planMode')??null}catch{return null}}
  selected(id:string, agent?:any):boolean {
    const explicit=this.store.readSessionPlanningModeExplicit(id)
    return explicit ?? (!agent?.parentAgent && this.config().planningModeDefault===true)
  }
  held(id:string, agent?:any):boolean {return this.selected(id,agent)||this.read(id).waitingApproval===true}
  status(id:string) {
    const agent=this.service('agents')?.get?.(id), native=this.native(agent)
    const state=agent&&native?.get?native.get(agent):null
    return {sessionId:id,planningMode:this.selected(id),waitingApproval:this.read(id).waitingApproval===true,
      guardReady:this.guardReady,nativeAvailable:!!native?.set,nativeState:state,
      pending:!agent||state?.pending===true,source:this.store.readSessionPlanningModeExplicit(id)===null?'default':'session'}
  }
  select(id:string,active:boolean) {
    if(active&&!this.guardReady)throw new Error('PLANNING_GUARD_UNAVAILABLE: 执行防线尚未就绪，不能开启规划')
    const agent=this.service('agents')?.get?.(id),native=this.native(agent)
    if(agent&&native?.set)native.set(agent,active)
    this.store.writeSessionPlanningMode(id,active)
    if(active)this.update(id,state=>{state.waitingApproval=true;state.approval=undefined})
    return this.status(id)
  }
  guard(exec:any):string|undefined {
    const id=agentSessionId(exec.agent)
    if(!id||!this.held(id,exec.agent))return
    if(PLANNING_READ_TOOLS.has(exec.name))return
    return 'LOOM_WAITING_APPROVAL: 当前只允许读取资料和 loom_submit_plan 提交候选；请在 Loom 中审核、编辑并批准当前版本后开工。关闭规划开关不构成批准。'
  }
  beforeStep(agent:any,messages:any[],step:number) {
    const id=agentSessionId(agent)
    if(!id||!this.held(id,agent))return null
    if(!this.guardReady)throw new Error('PLANNING_GUARD_UNAVAILABLE')
    const native=this.native(agent)
    native?.set?.(agent,true)
    if(step!==1)return this.read(id).resolution?'Loom：用 loom_resolve_questions 提交处理建议；校验失败只用 retry 修正指出的字段，不重写全部答案。成功后只简短提示查看并采纳，然后停止；不实施或批准。':'Loom：仍在待批准规划阶段。只读检查、提交完整候选后停止；不可 exit_plan_mode、实现或派发。'
    const message=[...messages].reverse().find(m=>m.role==='user'&&m.source?.kind==='user')
    const goal=message?.content?.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join('\n')?.trim()
    const ws=normalizeWorkspaceId(agent.session.header.cwd)
    if(!goal||!ws)return 'Loom：先在聊天中输出完整文字计划与待选工作区说明，只规划；没有项目目录不得实施或委托。'
    const previous=this.read(id)
    const marker=goal.match(/^LOOM_RESOLVE ([a-f0-9]{64})(?:\n|$)/)
    if(marker || previous.resolution?.outgoingText===goal) {
      const resolution=previous.resolution
      if(!resolution||(marker&&resolution.id!==marker[1])||resolution.workspaceId!==ws||previous.request?.id!==resolution.requestId)throw new Error('RESOLUTION_STALE: 请在当前计划重新点击让 AI 处理')
      this.checkResolution(ws,resolution)
      this.update(id,state=>{state.request!.messageId=message.id})
      return resolution.prompt
    }
    if(previous.request && previous.request.messageId===message.id)return previous.request.prompt
    const draft=this.store.readDraft(ws), architectureId=draft?.architectureId??'loom-project-architecture',workflowId=draft?.workflowId??'loom-project-workflow'
    const supplied=this.store.latestPlanningRequest(ws)
    const requestGoal=supplied&&goal.includes(supplied.payloadHash)?supplied.goal:goal
    const exported=exportInitialPlanning(this.store,ws,{goal:requestGoal.slice(0,30000),architectureId,workflowId,
      expectedArchitectureRevision:this.store.latestArchitecture(architectureId,ws)?.revision??null,
      expectedWorkflowRevision:this.store.latestRevision(workflowId,ws)?.revision??null},this.config().defaultMaxConcurrency)
    this.update(id,state=>{state.request={id:exported.payloadHash,messageId:message.id,workspaceId:ws,prompt:exported.text};state.resolution=undefined;state.resolutionRejected=undefined;state.candidate=undefined;state.rejected=undefined;state.waitingApproval=true;state.approval=undefined})
    return exported.text
  }
  private checkResolution(ws:string,base:ResolutionBaseline) {
    const flow=this.store.readFlowPlan(ws,base.workflow.workflowId)??defaultFlowPlan(base.workflow)
    if(flowPlanDigest(flow)!==base.flowHash || contentDigest(this.store.latestRevision(base.workflow.workflowId,ws))!==contentDigest(base.workflow) || contentDigest(this.store.latestArchitecture(base.architecture.architectureId,ws))!==contentDigest(base.architecture))throw new Error('RESOLUTION_STALE: 计划或编组已改变，请重新处理')
  }
  prepareResolution(id:string,ws:string,input:any,facts:unknown) {
    if(!this.guardReady)throw new Error('PLANNING_GUARD_UNAVAILABLE')
    if(!input||Object.keys(input).some(k=>!['workflowId','revision','architectureRevision','flowHash'].includes(k)))throw new Error('RESOLUTION_INVALID')
    const draft=this.store.readDraft(ws),workflow=this.store.latestRevision(input.workflowId,ws)
    const architecture=draft?.architectureId?this.store.latestArchitecture(draft.architectureId,ws):null
    if(!workflow||!architecture||workflow.revision!==input.revision||architecture.revision!==input.architectureRevision)throw new Error('PLAN_VERSION_CHANGED')
    if(draft?.candidate&&contentDigest({nodes:draft.candidate.nodes,edges:draft.candidate.edges})!==contentDigest({nodes:workflow.nodes,edges:workflow.edges}))throw new Error('DRAFT_DIRTY: 先采纳你的任务修改')
    const flow=this.store.readFlowPlan(ws,workflow.workflowId)??defaultFlowPlan(workflow),flowHash=flowPlanDigest(flow)
    if(input.flowHash!==flowHash)throw new Error('PLAN_VERSION_CHANGED: 编组已变化')
    const map=this.store.readSourceMap(ws)
    if(!map||map.workflowId!==workflow.workflowId||map.architectureId!==architecture.architectureId||workflow.nodes.some(n=>!map.entries.some(e=>e.workflowNodeId===n.id&&e.basedOnArchitectureRevision===architecture.revision&&e.workflowFingerprint===contentDigest(n))))throw new Error('MAPPING_INVALID: 先确认当前任务与架构的映射，不能让 AI 自动确认旧映射')
    const questions=[...new Set([...(architecture.openQuestions??[]),...workflow.openQuestions])]
    if(!questions.length)throw new Error('RESOLUTION_EMPTY: 当前没有待处理的问题')
    return this.update(id,state=>{
      if(state.candidate)throw new Error('PLAN_CANDIDATE_PENDING: 先查看当前候选')
      const exported=exportInitialPlanning(this.store,ws,{goal:workflow.title,architectureId:architecture.architectureId,workflowId:workflow.workflowId,expectedArchitectureRevision:architecture.revision,expectedWorkflowRevision:workflow.revision},this.config().defaultMaxConcurrency)
      const resolutionId=contentDigest({requestId:exported.payloadHash,flowHash,nonce:randomUUID()})
      const prompt=[
        '你负责智能处理当前计划的开工前问题。只读调查、给处理建议；不能实施、建仓库、改真实 profile、重启、派发或批准。不要让用户替你回答技术细节。',
        '技术问题先用 read/glob/grep/web_search/web_fetch/loom_capabilities 查证，最多 3 步、6 次只读调用；不运行 shell。宿主事实只代表下方本次观测；源码存在不代表能力已启用。没有证据不得说已经验证或已经完成。',
        '逐项选择：researched=有来源支持的解决建议，必须 sources；default=可逆稳妥的默认方案，记录明确取舍；deferred=实现阶段再验证，指派现有任务；一个任务可用 taskIds:[id],verification，多任务必须 verifications:[{taskId,criterion}] 分别写各自验收。骨架任务只冻结接口，具体模块测试给模块作者或最终验收，不能把所有后续测试压到第一步；ask=确实影响目标/范围/授权的人类选择，用日常语言问一个短问题，给 2..3 个 options 和推荐 recommended；blocked=缺少执行必需事实且无法安全绕过。',
        '未知 API/兼容性/检测触发等通常应先查源码，或给现有相关任务增加验证条件；真实 profile 启用、发布和重启安排到后续单独授权，不阻止独立的隔离开发。范围不明确时建议仅当前项目；不能擅自扩大范围。不存在的仓库/Git 基线必须保留 blocked；不得编造路径、commit 或把真实启动条件降级成假设。不可通过改问题分类扩大原约束或授权。',
        '不用重写任务图。调用 loom_resolve_questions，document 为 JSON 字符串：{requestId,answers:[{index,status,decision,reason,sources:[{locator,observation}],taskIds,verification,verifications:[{taskId,criterion}],question,options,recommended}]}。index 是问题下标，每项恰好回答一次；仅填写适用字段，verification 与 verifications 二选一，criterion 最多 1000 字符。服务器保留原任务/边/模块/分组，添加解释和必要验证条件，生成待采纳候选。未知字段、缺少依据、旧版本或重复问题会拒绝。',
        '字段长度上限：decision/reason 各 700 字符，sources 最多 6 条，locator 300、observation/verification 1000、question 500、每个 option/recommended 200 字符。recommended 对应现有选项，装饰性推荐标签可省略。校验错误指出具体字段且保留原答案：用 {requestId,retry:true,answers:[{index,decision:"修正内容"}]} 只补改该项，其余答案服务器保留；不重新发送全部答案，不漏答，不用一条答案冒充完整九条。',
        '建议将显示在计划面板。提交成功后只告诉用户“建议已准备好，请查看并采纳，再批准开工”，需要用户决定时最多解释一个短问题，然后停止；不得输出整份 JSON 或长篇错误回顾，不调用 loom_submit_plan 重做完整计划。',
        JSON.stringify({requestId:resolutionId,questions:questions.map((question,index)=>({index,question})),facts,currentArchitecture:architecture,currentWorkflow:workflow,flow}),
      ].join('\n\n')
      const outgoingText='请由 AI 查证并处理「'+workflow.title+'」第 '+workflow.revision+' 版计划的开工前问题，给我处理建议。保留我的任务和编组，只规划，等待我采纳和批准。'
      state.resolution={id:resolutionId,requestId:exported.payloadHash,workspaceId:ws,flowHash,prompt,outgoingText,architecture,workflow,questions,gitAvailable:typeof (facts as any)?.scm?.available==='boolean'?(facts as any).scm.available:null,mappings:map.entries.filter(e=>workflow.nodes.some(n=>n.id===e.workflowNodeId)).map(e=>({workflowNodeId:e.workflowNodeId,architectureNodeIds:e.architectureNodeIds,decisionIds:e.decisionIds}))}
      state.request={id:exported.payloadHash,messageId:'pending-resolution',workspaceId:ws,prompt};state.candidate=undefined;state.rejected=undefined;state.resolutionRejected=undefined;state.approval=undefined;state.waitingApproval=true
      return {kind:'resolution',payloadHash:exported.payloadHash,text:outgoingText}
    })
  }
  resolveQuestions(agent:any,input:unknown,callId?:string) {
    const id=agentSessionId(agent),ws=normalizeWorkspaceId(agent?.session?.header?.cwd)
    const state=id?this.read(id):null,base=state?.resolution
    if(!id||!ws||!base||base.workspaceId!==ws||!this.held(id,agent))throw new Error('RESOLUTION_REQUEST_REQUIRED')
    this.checkResolution(ws,base)
    let document:any=input
    if(document?.retry===true){
      if(Object.keys(document).some(k=>!['requestId','retry','answers'].includes(k))||document.requestId!==base.id)throw new Error('RESOLUTION_REPAIR_INVALID: 需要当前 requestId、retry:true 和答案补丁')
      if(!state?.resolutionRejected||state.resolutionRejected.resolutionId!==base.id)throw new Error('RESOLUTION_REPAIR_STALE: 当前请求没有保留的失败答案')
      const patches=document.answers
      if(!Array.isArray(patches)||!patches.length||patches.length>base.questions.length)throw new Error('RESOLUTION_REPAIR_INVALID: 答案补丁需要 1..问题数量 项')
      document=structuredClone(state.resolutionRejected.document)
      if(!Array.isArray(document.answers))throw new Error('RESOLUTION_REPAIR_INVALID: 原答案数组不存在，请提交完整答案')
      const indices=new Set<number>()
      for(const patch of patches){
        if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Number.isInteger(patch.index)||indices.has(patch.index)||Object.keys(patch).some(k=>!['index','status','decision','reason','sources','taskIds','verification','verifications','question','options','recommended'].includes(k)))throw new Error('RESOLUTION_REPAIR_INVALID: 只允许按 index 修改答案字段')
        indices.add(patch.index)
        const matches=document.answers.filter((a:any)=>a?.index===patch.index)
        if(matches.length!==1)throw new Error('RESOLUTION_REPAIR_INVALID: 原答案下标缺失或重复，请提交完整答案')
        if(Object.hasOwn(patch,'verifications')&&!Object.hasOwn(patch,'verification'))delete matches[0].verification
        if(Object.hasOwn(patch,'verification')&&!Object.hasOwn(patch,'verifications'))delete matches[0].verifications
        Object.assign(matches[0],patch)
      }
    }
    let resolved
    try{resolved=resolutionDocument(base,document)}catch(error){
      const message=String((error as Error).message)
      if(message.startsWith('RESOLUTION_INVALID:')&&document?.requestId===base.id&&JSON.stringify(document).length<=128*1024){
        this.update(id,s=>{if(s.resolution?.id!==base.id)throw new Error('RESOLUTION_STALE');s.resolutionRejected={resolutionId:base.id,document,error:message,at:new Date().toISOString()};s.candidate=undefined;s.approval=undefined})
        throw new Error(message+'\n答案已保留。仅用 loom_resolve_questions 的 {requestId,retry:true,answers:[{index,需修正字段}]} 修正；不要重写全套或输出 JSON 给用户。')
      }
      throw error
    }
    const result=this.submit(agent,resolved,callId,true)
    this.update(id,s=>{s.resolutionRejected=undefined})
    return result
  }
  submit(agent:any,document:unknown,callId?:string,fromResolution=false) {
    const id=agentSessionId(agent),ws=normalizeWorkspaceId(agent?.session?.header?.cwd)
    if(!id||!ws||!this.held(id,agent))throw new Error('PLAN_SESSION_REQUIRED')
    const current=this.read(id),request=current.request
    if(current.resolution&&!fromResolution)throw new Error('RESOLUTION_TOOL_REQUIRED: 用 loom_resolve_questions 回答问题，不重写任务图')
    if(!request||request.workspaceId!==ws)throw new Error('PLAN_REQUEST_REQUIRED: 先以本会话发送规划需求')
    if(document && typeof document==='object' && (document as any).retry===true) {
      const repair=document as any
      if(Object.keys(repair).some(k=>!['retry','removeFields','restoreConstraints'].includes(k)) || (repair.restoreConstraints!==undefined && typeof repair.restoreConstraints!=='boolean'))throw new Error('PLAN_REPAIR_INVALID')
      const rejected=current.rejected
      if(!rejected || rejected.requestId!==request.id)throw new Error('PLAN_REPAIR_STALE: 本次请求没有可重试候选')
      document=JSON.parse(JSON.stringify(rejected.document))
      const fields=repair.removeFields??[]
      if(!Array.isArray(fields)||fields.length>32)throw new Error('PLAN_REPAIR_INVALID')
      for(const path of fields){
        if(typeof path!=='string'||path.length>500||!/^\/(architecture|workflow|mappings)\//.test(path))throw new Error('PLAN_REPAIR_PATH_INVALID')
        const parts=path.slice(1).split('/').map(k=>k.replace(/~1/g,'/').replace(/~0/g,'~'))
        if(parts.length>16||parts.some(k=>['__proto__','prototype','constructor'].includes(k)))throw new Error('PLAN_REPAIR_PATH_INVALID')
        let parent:any=document
        for(const key of parts.slice(0,-1)){if(!parent||typeof parent!=='object'||!Object.hasOwn(parent,key))throw new Error('PLAN_REPAIR_PATH_MISSING');parent=parent[key]}
        const key=parts.at(-1)!
        if(!parent||typeof parent!=='object'||Array.isArray(parent)||!Object.hasOwn(parent,key))throw new Error('PLAN_REPAIR_PATH_MISSING')
        delete parent[key]
      }
      if(repair.restoreConstraints){
        const saved=this.store.readPlanningRequest(ws,request.id)
        const arch=(document as any)?.architecture
        if(!saved||!arch||!Array.isArray(arch.constraints)||arch.constraints.some((c:any)=>typeof c!=='string'))throw new Error('PLAN_REPAIR_CONSTRAINTS_INVALID')
        arch.constraints=[...new Set([...saved.constraints,...arch.constraints])]
      }
    }
    let preview:ReturnType<typeof previewInitialPlanning>
    try{preview=previewInitialPlanning(this.store,ws,request.id,document)}
    catch(error){
      const message=String((error as Error).message)
      if(document && typeof document==='object' && (document as any).requestId===request.id && JSON.stringify(document).length<=1024*1024){
        this.update(id,state=>{if(state.request?.id!==request.id)throw new Error('STALE_REPLY');state.rejected={requestId:request.id,document,error:message,at:new Date().toISOString()};state.candidate=undefined;state.approval=undefined;state.waitingApproval=true})
        const schemaRoot=message.startsWith('INVALID_ARCHITECTURE')?'architecture':message.startsWith('INVALID_WORKFLOW')?'workflow':null
        const fields=schemaRoot?[...message.matchAll(/nodes\[(\d+)\]\.([^:\s]+): 未知(?:节点)?字段/g)].map(m=>'/'+schemaRoot+'/nodes/'+m[1]+'/'+m[2]):[]
        const retry=message.startsWith('LOCKED_CONFLICT')&&message.includes('constraints[')?{retry:true,restoreConstraints:true}:fields.length?{retry:true,removeFields:[...new Set(fields)].slice(0,32)}:null
        throw new Error(message+'\n候选已保留，不要重写整份。'+(retry?'调用 loom_submit_plan，document='+JSON.stringify(retry)+' 可按本次报错局部修正，不改任务合同。':'语义错误需修正后重新提交完整候选，不能通过删除必需字段绕过校验。'))
      }
      throw error
    }
    const turn=agent.session.snapshotEvents?.().filter((e:any)=>e.type==='step/start').at(-1)?.data?.turn
    const candidate={turn,callId,id:preview.candidateHash,workspaceId:ws,document,preview,markdown:readablePlan(preview.workflow)+(fromResolution?'\n\n'+preview.explanation:''),at:new Date().toISOString()}
    this.update(id,state=>{
      if(state.request?.id!==request.id)throw new Error('STALE_REPLY')
      state.candidate=candidate;state.rejected=undefined;state.waitingApproval=true;state.approval=undefined
      if(!state.history.some(h=>h.id===candidate.id))state.history.push(candidate)
    })
    return {candidateId:candidate.id,markdown:candidate.markdown,waitingApproval:true}
  }
  adopt(id:string,ws:string,candidateId:string) {
    return this.update(id,state=>{
      const candidate=state.candidate
      if(!candidate||candidate.id!==candidateId||candidate.workspaceId!==ws)throw new Error('PLAN_VERSION_CHANGED')
      if(state.resolution)this.checkResolution(ws,state.resolution)
      const preview=previewInitialPlanning(this.store,ws,state.request!.id,candidate.document)
      const draft=this.store.adoptPlanningBundle(ws,preview,{architecture:preview.expectedArchitectureRevision,workflow:preview.expectedWorkflowRevision,draft:preview.expectedDraftRevision},this.config().defaultMode)
      state.candidate=undefined;state.rejected=undefined;state.resolution=undefined;state.resolutionRejected=undefined;state.approval=undefined;state.waitingApproval=true
      return {draft,workflow:preview.workflow}
    })
  }
  snapshot(id:string,ws:string,workflow:WorkflowRevision,baseSha:string) {
    const latest=this.store.latestRevision(workflow.workflowId,ws)
    if(!latest||contentDigest(latest)!==contentDigest(workflow))throw new Error('PLAN_VERSION_CHANGED: 必须批准最新任务版本')
    const draft=this.store.readDraft(ws)
    if(draft?.candidate&&contentDigest({nodes:draft.candidate.nodes,edges:draft.candidate.edges})!==contentDigest({nodes:workflow.nodes,edges:workflow.edges}))throw new Error('DRAFT_DIRTY')
    const flow=this.store.readFlowPlan(ws,workflow.workflowId)??defaultFlowPlan(workflow)
    const check=compileFlowSchedule(workflow,flow,FLOW_MAX_AGENTS)
    if(!check.ok)throw new Error('FLOW_INVALID: '+check.errors.map(e=>e.message).join('; '))
    const payload={sessionId:id,workspaceId:ws,executionTarget:this.store.readExecutionTarget(id,ws),workflow,flowHash:flowPlanDigest(flow),architectures:this.store.listArchitectures(ws).filter(a=>a.architectureId===draft?.architectureId).slice(-1),sourceMap:this.store.readSourceMap(ws),baseSha,
      concurrency:this.config().defaultMaxConcurrency,repairRounds:this.config().maxRepairRounds}
    return {hash:contentDigest(payload),flowHash:flowPlanDigest(flow),workflowId:workflow.workflowId,revision:workflow.revision,executionTarget:payload.executionTarget,flow,markdown:readablePlan(workflow,flow),baseSha}
  }
  approve(id:string,ws:string,workflow:WorkflowRevision,baseSha:string,hash:string,commandId:string) {
    if(!commandId)throw new Error('HUMAN_COMMAND_REQUIRED')
    const snap=this.snapshot(id,ws,workflow,baseSha)
    if(snap.hash!==hash)throw new Error('PLAN_VERSION_CHANGED: 图文计划或执行基线变化，请重读再批准')
    this.update(id,state=>{state.approval={id:randomUUID(),hash,baseSha,workflowId:workflow.workflowId,revision:workflow.revision,workspaceId:ws,commandId,consumed:false,at:new Date().toISOString(),snapshot:snap}})
  }
  cancel(id:string,commandId:string) {if(!commandId)throw new Error('HUMAN_COMMAND_REQUIRED');this.update(id,state=>{state.waitingApproval=false;state.approval=undefined;state.request=undefined;state.resolution=undefined;state.resolutionRejected=undefined;state.candidate=undefined;state.rejected=undefined});this.store.writeSessionPlanningMode(id,false)}
  consume(agent:any,ws:string,workflow:WorkflowRevision,baseSha:string) {
    const id=agentSessionId(agent)
    if(!id)throw new Error('APPROVAL_REQUIRED')
    const snap=this.snapshot(id,ws,workflow,baseSha)
    this.update(id,state=>{
      const a=state.approval
      if(!a||a.consumed||a.hash!==snap.hash||a.workspaceId!==ws)throw new Error('APPROVAL_REQUIRED: 请由用户批准当前版本后开工')
      a.consumed=true;state.waitingApproval=false
    })
    this.store.writeSessionPlanningMode(id,false)
    this.native(agent)?.set?.(agent,false)
    return snap
  }
}
