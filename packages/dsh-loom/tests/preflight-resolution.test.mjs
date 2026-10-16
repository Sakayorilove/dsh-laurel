import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {mkdirSync,writeFileSync} from 'node:fs'
import {readScmFacts} from '../lib/scm.js'
import {LoomStore} from '../lib/store.js'
import {PlanningController} from '../lib/planning.js'
import {DEFAULT_CONFIG} from '../lib/config.js'
import {defaultFlowPlan,flowPlanDigest,knownCapabilities,normalizeWorkspaceId} from '../lib/core/index.js'
import {createTools} from '../lib/tools.js'
import {createRemoteRequest} from '../lib/remote.js'
import {samplePlannerOutput} from './fixtures.mjs'
// 宿主锚点可配置、可校验：只有「real ToolRuntime」那一个用例要真宿主。
import {hostRequire as host,hostTest} from '../scripts/host-anchor.mjs'
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'loom-resolution-')),store=new LoomStore(home),ws=normalizeWorkspaceId(home)
 const agent={session:{id:'owner',header:{id:'owner',cwd:home},snapshotEvents:()=>[]}}
 const planning=new PlanningController(store,()=>DEFAULT_CONFIG,()=>null);planning.guardReady=true;store.writeSessionPlanningMode('owner',true)
 planning.beforeStep(agent,[{id:'goal',role:'user',source:{kind:'user'},content:[{type:'text',text:'实现当前项目'}]}],1)
 const request=store.latestPlanningRequest(ws),workflow=samplePlannerOutput();workflow.nodes=workflow.nodes.slice(2,4);workflow.nodes.forEach(n=>{n.inputs=[]});workflow.edges=[];workflow.workflowId=request.workflowId
 workflow.openQuestions=['兼容性检测怎么实现？','先支持几个项目？','真实部署什么时候进行？']
 const architecture={schemaVersion:1,architectureId:request.architectureId,revision:1,createdAt:new Date().toISOString(),nodes:[{id:'module',kind:'module',title:'模块',responsibility:'实现',locked:true}],edges:[],constraints:['只在 WSL 开发；真实部署另行授权'],openQuestions:['兼容性检测怎么实现？']}
 const result=planning.submit(agent,{requestId:request.payloadHash,architecture,workflow,mappings:workflow.nodes.map(n=>({workflowNodeId:n.id,architectureNodeIds:['module'],decisionIds:[]}))})
 planning.adopt('owner',ws,result.candidateId)
 const current=store.latestRevision(workflow.workflowId,ws),flow=defaultFlowPlan(current);flow.steps[0].agents=2;store.writeFlowPlan(ws,workflow.workflowId,flow)
 const input={workflowId:workflow.workflowId,revision:1,architectureRevision:1,flowHash:flowPlanDigest(flow)}
 const prepare=(scm={available:true,repo:home,head:'a'.repeat(40),dirty:false})=>planning.prepareResolution('owner',ws,input,{cwd:home,scm})
 const answers=()=>({requestId:planning.read('owner').resolution.id,answers:[
  {index:0,status:'deferred',decision:'实现兼容性探测并验证缺失 API 的退路',reason:'隔离开发时可以实测，不需要用户猜 API',taskIds:['backend'],verification:'只读探测缺失 API，验证显示不可用并保留手动入口'},
  {index:1,status:'default',decision:'先支持当前项目',reason:'保持范围最小，用户以后可以扩展'},
  {index:2,status:'ask',decision:'真实部署需单独授权',reason:'会影响用户当前运行环境',question:'完成开发后，要马上更新你正在用的软件吗？',options:['先保留当前版本','完成后再决定'],recommended:'完成后再决定'},
 ]})
 return{home,store,ws,agent,planning,current,flow,input,prepare,answers,close:()=>rmSync(home,{recursive:true,force:true})}
}
test('multiple task verification is scoped per owner and cached repair can replace ambiguous shared conditions',()=>{
 const f=fixture();try{
  f.prepare();const input=f.answers();input.answers[0].taskIds=['frontend','backend']
  assert.throws(()=>f.planning.resolveQuestions(f.agent,input),/多个任务必须使用 verifications/)
  const result=f.planning.resolveQuestions(f.agent,{requestId:input.requestId,retry:true,answers:[{index:0,verifications:[{taskId:'frontend',criterion:'只检查自己的 UI 显示'},{taskId:'backend',criterion:'只检查自己的 API 探测'}]}]})
  const nodes=f.planning.read('owner').candidate.preview.workflow.nodes
  assert.ok(nodes.find(n=>n.id==='frontend').acceptance.doneWhen.some(x=>x.includes('UI 显示')))
  assert.equal(nodes.find(n=>n.id==='frontend').acceptance.doneWhen.some(x=>x.includes('API 探测')),false)
  assert.ok(nodes.find(n=>n.id==='backend').acceptance.doneWhen.some(x=>x.includes('API 探测')))
  assert.equal(result.waitingApproval,true)
 }finally{f.close()}
})
test('prepared repository belongs only to its conversation and changing it invalidates approval',async()=>{
 const f=fixture()
 try{
  await assert.rejects(()=>readScmFacts(f.store,f.home,'owner'),/SCM_UNAVAILABLE/)
  const repo=join(f.home,'prepared');mkdirSync(repo)
  const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim()
  git(['init','-q']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@loom.local']);writeFileSync(join(repo,'README.md'),'baseline');git(['add','README.md']);git(['commit','-qm','baseline'])
  f.store.writeExecutionTarget('owner',f.ws,repo)
  const facts=await readScmFacts(f.store,f.home,'owner');assert.equal(facts.repo,repo);assert.equal(facts.dirty,false)
  await assert.rejects(()=>readScmFacts(f.store,f.home,'other'),/SCM_UNAVAILABLE/)
  assert.throws(()=>f.store.readExecutionTarget('owner',normalizeWorkspaceId('/other')),/EXECUTION_TARGET_INVALID/)
  const snapshot=f.planning.snapshot('owner',f.ws,f.current,facts.head)
  f.planning.approve('owner',f.ws,f.current,facts.head,snapshot.hash,'human-command')
  f.store.writeExecutionTarget('owner',f.ws,join(f.home,'different'))
  assert.throws(()=>f.planning.consume(f.agent,f.ws,f.current,facts.head),/APPROVAL_REQUIRED/)
  assert.equal(f.planning.read('owner').approval.consumed,false)
 }finally{f.close()}
})
hostTest('real ToolRuntime resolves compact answers; preview/adoption retain tasks, locked modules, groups and human gates',async()=>{
 const f=fixture(),ctx=new (host('@deepseek-ai/cordis').Context)()
 try{
  await ctx.plugin(host('@deepseek-ai/dsh-system-prompt').default);await ctx.plugin(host('@deepseek-ai/dsh-tools').default)
  f.agent.ctx=ctx;ctx.tools.guard(exec=>f.planning.guard(exec))
  for(const tool of createTools({store:f.store,planning:f.planning,getConfig:()=>DEFAULT_CONFIG,log:{info(){},warn(){},error(){}}}))ctx.tools.register(tool)
  const exported=f.prepare();assert.match(exported.text,/请由 AI/);assert.doesNotMatch(exported.text,/LOOM_RESOLVE|[a-f0-9]{64}/)
  const prompt=f.planning.beforeStep(f.agent,[{id:'resolution',role:'user',source:{kind:'user'},content:[{type:'text',text:exported.text}]}],1)
  assert.match(prompt,/loom_resolve_questions/);assert.match(prompt,/先支持几个项目/)
  const result=await ctx.tools.execute({agent:f.agent,name:'loom_resolve_questions',callId:'answers',arguments:{document:JSON.stringify(f.answers())},signal:new AbortController().signal})
  assert.equal(result.isError,false,JSON.stringify(result));assert.match(JSON.stringify(result),/建议已准备好/)
  const candidate=new PlanningController(f.store,()=>DEFAULT_CONFIG,()=>null).read('owner').candidate
  assert.equal(f.store.latestRevision(f.current.workflowId,f.ws).revision,1,'answers do not adopt or run')
  assert.deepEqual(candidate.preview.workflow.edges,f.current.edges)
  assert.deepEqual(candidate.preview.architecture.nodes,f.planning.read('owner').resolution.architecture.nodes)
  assert.equal(candidate.preview.workflow.openQuestions.length,1)
  for(const original of f.current.nodes){const after=candidate.preview.workflow.nodes.find(n=>n.id===original.id);assert.deepEqual({...after,acceptance:original.acceptance},original)}
  assert.ok(candidate.preview.workflow.nodes.find(n=>n.id==='backend').acceptance.doneWhen.some(v=>v.includes('缺失 API')))
  assert.ok(candidate.preview.workflow.nodes.every(n=>n.acceptance.doneWhen.some(v=>v.includes('先支持当前项目'))),'adopted defaults reach every affected implementation contract')
  assert.deepEqual(f.store.readFlowPlan(f.ws,f.current.workflowId),f.flow)
  f.planning.adopt('owner',f.ws,candidate.id)
  assert.deepEqual(f.store.readFlowPlan(f.ws,f.current.workflowId),f.flow)
  assert.equal(f.planning.read('owner').approval,undefined);assert.equal(f.planning.held('owner',f.agent),true)
  assert.match(f.planning.guard({agent:f.agent,name:'bash'}),/WAITING_APPROVAL/)
  assert.equal(f.store.listRuns(100,f.ws).length,0)
 }finally{await ctx.fiber.dispose();f.close()}
})
test('field-specific errors retain all answers; tiny retries repair only the failed answer',()=>{
 const f=fixture()
 try{
  f.prepare();const input=f.answers();input.answers[0].decision='查证'.repeat(400)
  assert.throws(()=>f.planning.resolveQuestions(f.agent,input),/answers\[0\]\.decision: 最多 700 字符，当前 800/)
  const saved=f.planning.read('owner').resolutionRejected;assert.deepEqual(saved.document,input)
  const repair={requestId:input.requestId,retry:true,answers:[{index:0,decision:'由已有任务验证兼容性'}]}
  assert.ok(JSON.stringify(repair).length<200)
  f.planning.resolveQuestions(f.agent,repair)
  const state=f.planning.read('owner');assert.equal(state.resolutionRejected,undefined)
  assert.ok(state.candidate.preview.workflow.evidence.some(e=>e.observation.includes(input.answers[1].decision)))
  assert.deepEqual(f.store.readFlowPlan(f.ws,f.current.workflowId),f.flow)
  assert.equal(state.approval,undefined);assert.equal(f.store.latestRevision(f.current.workflowId,f.ws).revision,1)
  assert.throws(()=>f.planning.resolveQuestions(f.agent,{...repair,requestId:'foreign'}),/REPAIR_INVALID/)
 }finally{f.close()}
})
test('recommendation decorations are ignored; different or ambiguous options still reject',()=>{
 const f=fixture()
 try{
  f.prepare();const input=f.answers();input.answers[2].options=['先保留当前版本','完成后再决定（推荐）']
  assert.ok(f.planning.resolveQuestions(f.agent,input).candidateId)
  assert.ok(f.planning.read('owner').candidate.preview.workflow.openQuestions.some(q=>q.includes('完成后再决定（推荐）')))
  input.answers[2].options=['完成后再决定','完成后再决定（推荐）'];assert.throws(()=>f.planning.resolveQuestions(f.agent,input),/options: 选项内容不能重复/)
  input.answers[2].options=['先保留当前版本','立刻发布'];assert.throws(()=>f.planning.resolveQuestions(f.agent,input),/recommended: 必须对应/)
 }finally{f.close()}
})
test('typed RPC prepares resolution with trusted cwd facts; malformed, foreign and disabled requests fail',async()=>{
 const f=fixture(),observed=[]
 try{
  const rpc=createRemoteRequest({store:f.store,planning:f.planning,getConfig:()=>DEFAULT_CONFIG,setConfig:()=>DEFAULT_CONFIG,capabilities:knownCapabilities,resolveWorkspace:req=>req.headers['x-loom-session']==='owner'?f.ws:null,resolveSessionId:req=>req.headers['x-loom-session']==='owner'?'owner':null,resolveSessionCwd:()=>f.home,scmFacts:async cwd=>{observed.push(cwd);return{repo:cwd,head:'a'.repeat(40),dirty:false}},log:{warn(){},error(){}}})
  const result=await rpc({sessionId:'owner',method:'POST',path:'/plan/resolve',body:f.input})
  assert.equal(result.payload.ok,true,JSON.stringify(result));assert.deepEqual(observed,[f.home])
  assert.equal((await rpc({sessionId:'owner',method:'POST',path:'/plan/resolve',body:{...f.input,cwd:'/forged'}})).payload.ok,false)
  assert.throws(()=>f.planning.resolveQuestions({session:{id:'foreign',header:{cwd:f.home}}},f.answers()),/RESOLUTION_REQUEST_REQUIRED/)
  f.store.writeSessionActivation('owner',false)
  assert.equal((await rpc({sessionId:'owner',method:'POST',path:'/plan/resolve',body:f.input})).payload.code,'LOOM_DISABLED')
 }finally{f.close()}
})
test('AI cannot drop questions without reasons/evidence/assigned verification or rewrite a resolution graph',()=>{
 const f=fixture()
 try{
  f.prepare();assert.throws(()=>f.planning.submit(f.agent,{}),/RESOLUTION_TOOL_REQUIRED/)
  for(const mutate of [a=>a.pop(),a=>{a[1].index=0},a=>{a[0].reason=''},a=>{a[0].taskIds=['imaginary']},a=>{a[0].verification=''},a=>{a[1].status='researched'},a=>{a[1].skip=true},a=>{a[2].recommended='不存在的选项'}]){
   const input=f.answers();mutate(input.answers);assert.throws(()=>f.planning.resolveQuestions(f.agent,input),/RESOLUTION_INVALID/)
  }
  assert.equal(f.planning.read('owner').candidate,undefined)
  const input=f.answers();input.answers[1]={index:1,status:'researched',decision:'只处理当前项目',reason:'用户约束限制范围',sources:[{locator:'当前需求',observation:'当前目标没有授权其他项目'}]}
  input.answers[1].taskIds=['backend'];input.answers[1].verification='查证项目清单，只读核对'
  assert.ok(f.planning.resolveQuestions(f.agent,input).candidateId)
  assert.ok(f.planning.read('owner').candidate.preview.workflow.nodes.find(n=>n.id==='backend').acceptance.doneWhen.some(v=>v.includes('只读核对')))
 }finally{f.close()}
})
test('Git failure remains blocking; flow/draft changes and replacement requests invalidate answers and adoption',()=>{
 const f=fixture()
 try{
  f.prepare({available:false});const result=f.planning.resolveQuestions(f.agent,f.answers())
  assert.ok(f.planning.read('owner').candidate.preview.workflow.openQuestions.some(q=>q.includes('Git 仓库')))
  const flow=structuredClone(f.flow);flow.steps[0].agents=3;f.store.writeFlowPlan(f.ws,f.current.workflowId,flow)
  assert.throws(()=>f.planning.adopt('owner',f.ws,result.candidateId),/RESOLUTION_STALE/)
  assert.throws(()=>f.planning.resolveQuestions(f.agent,f.answers()),/RESOLUTION_STALE/)
  f.store.writeFlowPlan(f.ws,f.current.workflowId,f.flow)
  const draft=f.store.readDraft(f.ws);f.store.writeDraft({...draft,draftRevision:draft.draftRevision+1},{expectedRevision:draft.draftRevision})
  assert.throws(()=>f.planning.resolveQuestions(f.agent,f.answers()),/STALE_REPLY/)
  const oldAnswers=f.answers()
  f.planning.beforeStep(f.agent,[{id:'replacement',role:'user',source:{kind:'user'},content:[{type:'text',text:'改成另外一个需求'}]}],1)
  assert.throws(()=>f.planning.resolveQuestions(f.agent,oldAnswers),/RESOLUTION_REQUEST_REQUIRED/)
  assert.equal(f.store.latestRevision(f.current.workflowId,f.ws).revision,1)
 }finally{f.close()}
})
