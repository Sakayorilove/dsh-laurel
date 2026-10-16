import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PlanningController} from '../lib/planning.js'
import {LoomStore} from '../lib/store.js'
import {DEFAULT_CONFIG} from '../lib/config.js'
import {adoptPlannerOutput,defaultFlowPlan,normalizeWorkspaceId} from '../lib/core/index.js'
import {createTools} from '../lib/tools.js'
import {registerCommands} from '../lib/commands.js'
import {samplePlannerOutput} from './fixtures.mjs'
// 宿主锚点可配置、可校验。本文件四个用例：一、二、四要真宿主，第三个只用内存 store。
import {hostRequire as host,hostTest} from '../scripts/host-anchor.mjs'

hostTest('real ToolRuntime guard blocks writes, shell, delegation and exit; readonly calls still execute',async()=>{
  const root=mkdtempSync(join(tmpdir(),'loom-planning-')),ctx=new (host('@deepseek-ai/cordis').Context)()
  try {
    await ctx.plugin(host('@deepseek-ai/dsh-system-prompt').default)
    await ctx.plugin(host('@deepseek-ai/dsh-tools').default)
    const store=new LoomStore(root),agent={ctx,session:{id:'a',header:{id:'a',cwd:root}}}
    const planning=new PlanningController(store,()=>DEFAULT_CONFIG,name=>name==='agents'?{get:()=>agent}:name==='planMode'?{get:()=>({active:true}),set:()=>{}}:null)
    planning.guardReady=true;ctx.tools.guard(exec=>planning.guard(exec));planning.select('a',true)
    let writes=0,reads=0
    for(const name of ['write','edit','bash','subagent','workflow','exit_plan_mode','read'])ctx.tools.register({name,description:'probe '+name,parameters:{type:'object',properties:{}},output:{schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok']},render:()=>[]},execute:async()=>{if(name==='read')reads++;else writes++;return{ok:true}}})
    for(const name of ['write','edit','bash','subagent','workflow','exit_plan_mode']) {
      const result=await ctx.tools.execute({name,arguments:{},callId:name,agent,signal:new AbortController().signal})
      assert.equal(result.isError,true,JSON.stringify(result));assert.match(JSON.stringify(result),/LOOM_WAITING_APPROVAL/)
    }
    assert.equal((await ctx.tools.execute({name:'read',arguments:{},callId:'read',agent,signal:new AbortController().signal})).isError,false)
    assert.equal(writes,0);assert.equal(reads,1)
    planning.select('a',false)
    assert.match(planning.guard({name:'write',agent}),/WAITING_APPROVAL/,'mode off does not approve')
    const other={ctx,session:{id:'b',header:{id:'b',cwd:join(root,'other')}}}
    assert.equal(planning.guard({name:'write',agent:other}),undefined,'no foreign session restrictions')
  } finally {await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}
})

hostTest('human CommandRuntime approves exact semantics; consumed approval cannot replay and flow changes revoke it',async()=>{
  const root=mkdtempSync(join(tmpdir(),'loom-approval-')),ctx=new (host('@deepseek-ai/cordis').Context)()
  try {
    const {Session}=host('@deepseek-ai/dsh-session'),store=new LoomStore(root),cwd=join(root,'project'),ws=normalizeWorkspaceId(cwd)
    const agent={ctx,session:Session.create('human',undefined,{version:4,id:'human',cwd,createdAt:Date.now(),isSeeded:false})}
    const planning=new PlanningController(store,()=>DEFAULT_CONFIG,name=>name==='planMode'?{set:()=>{}}:null)
    planning.guardReady=true
    const workflow=adoptPlannerOutput(samplePlannerOutput()).workflow;store.appendRevision(workflow,ws)
    const sha='a'.repeat(40),hash=planning.snapshot('human',ws,workflow,sha).hash
    store.writeSessionPlanningMode('human',true)
    let dispatched=0
    await ctx.plugin(host('@deepseek-ai/dsh-commands').default)
    await ctx.plugin({inject:['commands'],apply(child){registerCommands(child,{store,planning,getConfig:()=>DEFAULT_CONFIG,scmFacts:async()=>({repo:cwd,head:sha,dirty:false}),cancelRun:async()=>false,log:{warn(){}},runWorkflow:async(wf,exec,args)=>{planning.consume(exec.agent,ws,wf,args.baseSha);dispatched++;return{state:'validated'}}})}})
    const command=line=>ctx.commands.execute(agent,line,[],new AbortController().signal)
    assert.equal((await command(`/loom run ${workflow.workflowId} 1 ${sha}`)).result.kind,'error')
    assert.equal(dispatched,0)
    const admitted=await command(`/loom approve-run ${workflow.workflowId} 1 ${sha} ${hash}`)
    assert.equal(admitted.result.kind,'success');await new Promise(r=>setTimeout(r,10));assert.equal(dispatched,1)
    assert.throws(()=>planning.consume(agent,ws,workflow,sha),/APPROVAL_REQUIRED/)
    planning.approve('human',ws,workflow,sha,hash,'human-command-2')
    const flow=defaultFlowPlan(workflow);flow.steps[0].agents=3;store.writeFlowPlan(ws,workflow.workflowId,flow)
    assert.throws(()=>planning.consume(agent,ws,workflow,sha),/APPROVAL_REQUIRED/)
    assert.throws(()=>planning.approve('human',ws,workflow,sha,hash,'human-command-3'),/PLAN_VERSION_CHANGED/)
    assert.equal(agent.session.snapshotEvents().filter(e=>e.type==='command/run'&&e.data.source.kind==='user').length,2)
    planning.select('human',true);assert.equal(planning.held('human',agent),true)
    assert.equal((await command('/loom cancel-plan')).result.kind,'success');assert.equal(planning.held('human',agent),false)
    assert.equal(planning.read('human').approval,undefined)
  }finally{await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}
})

test('ordinary user prompt owns a request, controlled submit persists full plan, adoption still waits for human',async()=>{
  const root=mkdtempSync(join(tmpdir(),'loom-candidate-'))
  try{
    const store=new LoomStore(root),agent={session:{id:'raw',header:{id:'raw',cwd:root},snapshotEvents:()=>[{type:'step/start',data:{turn:1}}]}},ws=normalizeWorkspaceId(root)
    const selected=[],planning=new PlanningController(store,()=>DEFAULT_CONFIG,name=>name==='planMode'?{set:(agent,active)=>selected.push(active)}:null)
    planning.guardReady=true;store.writeSessionPlanningMode('raw',true)
    const prompt=planning.beforeStep(agent,[{id:'message-1',role:'user',source:{kind:'user'},content:[{type:'text',text:'做装载机模块'}]}],1)
    assert.match(prompt,/loom_submit_plan/);assert.match(prompt,/做装载机/);assert.deepEqual(selected,[true])
    const request=store.latestPlanningRequest(ws),workflow=samplePlannerOutput();workflow.nodes=workflow.nodes.slice(2,4);workflow.edges=[];workflow.workflowId=request.workflowId;workflow.executionProposal.requiredCapabilities=['worktree'];workflow.nodes.forEach(n=>{n.inputs=[]})
    const document={requestId:request.payloadHash,architecture:{schemaVersion:1,architectureId:request.architectureId,revision:1,createdAt:new Date().toISOString(),nodes:[{id:'loader',kind:'module',title:'装载机',responsibility:'装载模块'}],edges:[],constraints:[]},workflow,mappings:workflow.nodes.map(n=>({workflowNodeId:n.id,architectureNodeIds:['loader'],decisionIds:[]})),explanation:'模块计划'}
    const result=planning.submit(agent,document,'call-1')
    assert.match(result.markdown,/修改范围/);assert.match(result.markdown,/完成条件/)
    assert.equal(store.listRevisions(ws).length,0);assert.equal(planning.read('raw').candidate.turn,1)
    planning.adopt('raw',ws,result.candidateId)
    assert.equal(store.listRevisions(ws).length,1);assert.equal(planning.held('raw',agent),true)
    assert.equal(planning.read('raw').history[0].callId,'call-1')
    assert.match(new PlanningController(store,()=>DEFAULT_CONFIG,()=>null).guard({agent,name:'bash'}),/WAITING_APPROVAL/,'restart must preserve wait')
    const tools=createTools({store,getConfig:()=>DEFAULT_CONFIG,log:{info(){},warn(){},error(){}},runWorkflow:()=>{throw Error('must not dispatch')}})
    await assert.rejects(tools.find(t=>t.name==='loom_run').execute({workflowId:workflow.workflowId,revision:1},{agent}),/WAITING_APPROVAL/)
  }finally{rmSync(root,{recursive:true,force:true})}
})

hostTest('real ToolRuntime retries persisted rejected plan with tiny corrections; preserves constraints and blocks stale/unsafe repair',async()=>{
 const root=mkdtempSync(join(tmpdir(),'loom-plan-retry-')),ctx=new (host('@deepseek-ai/cordis').Context)()
 try{
  await ctx.plugin(host('@deepseek-ai/dsh-system-prompt').default);await ctx.plugin(host('@deepseek-ai/dsh-tools').default)
  const store=new LoomStore(root),ws=normalizeWorkspaceId(root),agent={ctx,session:{id:'retry',header:{id:'retry',cwd:root},snapshotEvents:()=>[{type:'step/start',data:{turn:1}}]}}
  store.appendArchitecture({schemaVersion:1,architectureId:'loom-project-architecture',revision:1,createdAt:new Date().toISOString(),nodes:[{id:'loader',kind:'module',title:'装载机',responsibility:'装载模块'}],edges:[],constraints:['必须在 WSL 执行']},ws)
  const planning=new PlanningController(store,()=>DEFAULT_CONFIG,()=>null);planning.guardReady=true;store.writeSessionPlanningMode('retry',true)
  planning.beforeStep(agent,[{id:'m1',role:'user',source:{kind:'user'},content:[{type:'text',text:'规划装载机'}]}],1)
  const request=store.latestPlanningRequest(ws),workflow=samplePlannerOutput();workflow.nodes=workflow.nodes.slice(2,4);workflow.edges=[];workflow.workflowId=request.workflowId;workflow.executionProposal.requiredCapabilities=['worktree'];workflow.nodes.forEach(n=>{n.inputs=[]})
  const document={requestId:request.payloadHash,architecture:{schemaVersion:1,architectureId:request.architectureId,revision:2,createdAt:new Date().toISOString(),nodes:[{id:'loader',kind:'module',nodeKind:'module',title:'装载机',responsibility:'装载模块'}],edges:[],constraints:['新增的验收约束']},workflow,mappings:workflow.nodes.map(n=>({workflowNodeId:n.id,architectureNodeIds:['loader'],decisionIds:[]})),explanation:'测试局部修复'}
  const tools=createTools({store,planning,getConfig:()=>DEFAULT_CONFIG,log:{info(){},warn(){},error(){}}});for(const tool of tools)ctx.tools.register(tool)
  ctx.tools.guard(exec=>planning.guard(exec))
  const submit=doc=>ctx.tools.execute({agent,name:'loom_submit_plan',callId:'retry-call',arguments:{document:JSON.stringify(doc)},signal:new AbortController().signal})
  const first=await submit(document);assert.equal(first.isError,true);assert.match(JSON.stringify(first),/nodeKind/)
  assert.equal(planning.read('retry').candidate,undefined);assert.equal(planning.read('retry').rejected.document.workflow.nodes.length,2)
  assert.ok(new PlanningController(store,()=>DEFAULT_CONFIG,()=>null).read('retry').rejected,'rejected candidate survives restart')
  const repair={retry:true,removeFields:['/architecture/nodes/0/nodeKind']};assert.ok(JSON.stringify(repair).length<100)
  const second=await submit(repair);assert.equal(second.isError,true);assert.match(JSON.stringify(second),/constraints\[0\]/)
  assert.throws(()=>planning.submit(agent,{retry:true,removeFields:['/architecture/__proto__/polluted']}),/PLAN_REPAIR_PATH_INVALID/)
  assert.equal(Object.prototype.polluted,undefined)
  const third=await submit({retry:true,restoreConstraints:true});assert.equal(third.isError,false,JSON.stringify(third))
  const final=planning.read('retry');assert.equal(final.rejected,undefined);assert.deepEqual(final.candidate.document.workflow,document.workflow)
  assert.deepEqual(final.candidate.document.architecture.constraints,['必须在 WSL 执行','新增的验收约束'])
  assert.equal(final.waitingApproval,true);assert.equal(final.approval,undefined);assert.equal(store.listRevisions(ws).length,0)
  planning.beforeStep(agent,[{id:'m2',role:'user',source:{kind:'user'},content:[{type:'text',text:'另一份需求'}]}],1)
  assert.throws(()=>planning.submit(agent,{retry:true,restoreConstraints:true}),/PLAN_REPAIR_STALE/)
 }finally{await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}
})
