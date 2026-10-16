import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {registerCommands} from '../lib/commands.js'
import {DEFAULT_CONFIG} from '../lib/config.js'
import {createHostDispatcher} from '../lib/runtime.js'
import {fixture,graph,produce} from './execution-fixture.mjs'
// 宿主锚点可配置、可校验：前两个用例要用真宿主，后三个不需要。
import {hostRequire as host,hostTest} from '../scripts/host-anchor.mjs'
const deferred=()=>{let resolve;return{promise:new Promise(r=>{resolve=r}),resolve:(v)=>resolve(v)}}

hostTest('human approval admission and duplicate commands start exactly one run while preserving session isolation',async()=>{
  const root=mkdtempSync(join(tmpdir(),'loom-approval-progress-')),f=fixture(root),w=graph(),{Context}=host('@deepseek-ai/cordis'),{Session}=host('@deepseek-ai/dsh-session'),ctx=new Context()
  f.store.appendRevision(w,f.ws)
  const agent=id=>({ctx,session:Session.create(id,undefined,{version:4,id,cwd:f.repo,createdAt:Date.now(),isSeeded:false})})
  const receiver=agent('progress-human'),other=agent('progress-other'),scm=deferred(),off=deferred(),started=deferred(),done=deferred()
  let approvals=0,starts=0,facts=0
  try {
    await ctx.plugin(host('@deepseek-ai/dsh-commands').default)
    await ctx.plugin({inject:['commands'],apply(child){
      child.commands.register({name:'plan',description:'Controlled native plan-off barrier',async handler(){off.resolve();await started.promise;return{kind:'success',text:'off'}}})
      registerCommands(child,{store:f.store,getConfig:()=>DEFAULT_CONFIG,planning:{held:()=>false,approve(){approvals++}},
        scmFacts:async()=>{facts++;await scm.promise;return{repo:f.repo,head:f.base,dirty:false}},
        async runWorkflow(_wf,exec){starts++;await done.promise;return undefined},cancelRun:async()=>false,log:{warn(){}}})
    }})
    const command=(a,line)=>ctx.commands.execute(a,line,[],new AbortController().signal)
    const line=`/loom approve-run ${w.workflowId} ${w.revision} ${f.base} ${'a'.repeat(64)}`
    const first=command(receiver,line)
    const preparing=await command(receiver,line)
    assert.equal(preparing.result.kind,'success');assert.match(preparing.result.text,/正在提交/);assert.equal(facts,1)
    scm.resolve();await off.promise
    assert.match((await command(receiver,line)).result.text,/正在提交/,'native plan-off await is protected too')
    started.resolve();const admitted=await first
    assert.equal(admitted.result.kind,'success')
    const duplicate=await command(receiver,line)
    assert.equal(duplicate.result.kind,'success');assert.match(duplicate.result.text,/正在执行/)
    assert.equal((await command(receiver,line.replace('a'.repeat(64),'b'.repeat(64)))).result.kind,'error','different approval is not accepted as a duplicate')
    assert.equal(approvals,1);assert.equal(starts,1);assert.equal(f.store.latestRuns(100,f.ws).length,1)
    assert.equal(f.store.latestRuns(100,f.ws)[0].sessionId,'progress-human')
    assert.equal((await command(other,line)).result.kind,'success','another conversation is not blocked by this session admission')
    assert.equal(starts,2);assert.equal(approvals,2)
    assert.ok(receiver.session.snapshotEvents().some(e=>e.type==='command/run'&&e.data.source.kind==='user'))
  }finally{scm.resolve();started.resolve();done.resolve();await ctx.fiber.dispose();await f.runtime.cancelAll();rmSync(root,{recursive:true,force:true})}
})

hostTest('native recovery command approves the latest adopted acceptance and revalidates old drafts',async()=>{
  const root=mkdtempSync(join(tmpdir(),'loom-revised-command-')),f=fixture(root),original=graph(),{Context}=host('@deepseek-ai/cordis'),{Session}=host('@deepseek-ai/dsh-session'),ctx=new Context(),done=deferred()
  const receiver={ctx,session:Session.create('revised-human',undefined,{version:4,id:'revised-human',cwd:f.repo,createdAt:Date.now(),isSeeded:false})}
  try {
    f.store.appendRevision(original,f.ws)
    const failed=await f.runtime.run(original,f.repo,f.ws,f.base,async()=>({verdict:'failed',artifactRefs:[]}),{sessionId:'revised-human',maxRepairRounds:0})
    assert.equal(failed.state,'failed')
    const revised=structuredClone(original);revised.revision++;revised.nodes[0].acceptance.doneWhen.push('修正完成条件归属')
    f.store.appendRevision(revised,f.ws)
    let approved=0
    await ctx.plugin(host('@deepseek-ai/dsh-commands').default)
    await ctx.plugin({inject:['commands'],apply(child){
      child.commands.register({name:'plan',description:'Controlled test plan-off command',handler(){return{kind:'success',text:'off'}}})
      registerCommands(child,{store:f.store,getConfig:()=>DEFAULT_CONFIG,planning:{held:()=>false,approve(_session,_ws,w,base,hash){assert.equal(w.revision,revised.revision);assert.equal(base,f.base);assert.equal(hash,'f'.repeat(64));approved++}},scmFacts:async()=>({repo:f.repo,head:f.base,dirty:false}),cancelRun:async()=>false,log:{warn(){}},
        async runWorkflow(w,exec,options){try{const result=await f.runtime.run(w,f.repo,f.ws,f.base,produce,{...options,signal:exec.signal,sessionId:'revised-human',maxRepairRounds:0,approvedPlan:{hash:'f'.repeat(64),flowHash:'test-flow',markdown:'test current plan',flow:{},baseSha:f.base,workflowId:w.workflowId,revision:w.revision}});done.resolve(result);return result}catch(error){done.resolve(error);throw error}}})
    }})
    const response=await ctx.commands.execute(receiver,`/loom approve-resume ${failed.runId} ${'f'.repeat(64)}`,[],new AbortController().signal)
    assert.equal(response.result.kind,'success',response.result.text)
    const resumed=await done.promise
    assert.equal(resumed.state,'validated',resumed.error||resumed.message);assert.equal(approved,1)
    assert.equal(f.runtime.journal.read(resumed.runId).revision,revised.revision)
    assert.ok(receiver.session.snapshotEvents().some(e=>e.type==='command/run'&&e.data.source.kind==='user'))
    assert.ok(failed.worktrees.every(t=>existsSync(t.path)))
  }finally{await ctx.fiber.dispose();await f.runtime.cancelAll();rmSync(root,{recursive:true,force:true})}
})

test('parent cancellation preserves its reason and partial files instead of reporting a child failure',async()=>{
  const root=mkdtempSync(join(tmpdir(),'loom-cancel-progress-')),f=fixture(root),abort=new AbortController(),started=deferred()
  try {
    const subagents={async start(_provider,request){return{result:(async()=>{writeFileSync(join(request.parent.cwd,'partial.txt'),'keep');started.resolve();await new Promise(r=>{if(request.signal.aborted)r();else request.signal.addEventListener('abort',r,{once:true})});return{output:[],stopReason:'aborted'}})(),async dispose(){}}}}
    const pending=f.runtime.run(graph(),f.repo,f.ws,f.base,t=>createHostDispatcher(subagents,{cwd:t.cwd})(t),{signal:abort.signal,sessionId:'cancel-human'})
    await started.promise;abort.abort(new Error('USER_CANCELLED'));const result=await pending
    assert.equal(result.state,'cancelled');assert.equal(result.error,'USER_CANCELLED')
    const saved=f.store.latestRuns(100,f.ws).find(r=>r.runId===result.runId)
    assert.equal(saved.sessionId,'cancel-human');assert.equal(saved.reason,'USER_CANCELLED')
    assert.ok(result.worktrees.some(t=>existsSync(join(t.path,'partial.txt'))))
    assert.ok(result.worktrees.every(t=>existsSync(t.path)))
  }finally{abort.abort();await f.runtime.cancelAll();rmSync(root,{recursive:true,force:true})}
})

test('cold status reconciliation requires the real execution lease and preserves session ownership',async()=>{
  const root=mkdtempSync(join(tmpdir(),'loom-cold-progress-')),f=fixture(root)
  try {
    const stopped=await f.runtime.run(graph(),f.repo,f.ws,f.base,async()=>({verdict:'failed',artifactRefs:[]}),{sessionId:'cold-human'})
    const record=f.runtime.journal.read(stopped.runId);record.state='running';record.ownerToken='previous-process';f.runtime.journal.write(record)
    assert.equal(await f.runtime.recoverInactiveRuns(),1)
    assert.equal(f.runtime.journal.read(stopped.runId).state,'interrupted')
    const saved=f.store.latestRuns(100,f.ws).find(r=>r.runId===stopped.runId)
    assert.equal(saved.state,'interrupted');assert.equal(saved.sessionId,'cold-human')
    assert.ok(stopped.worktrees.every(t=>existsSync(t.path)))
    assert.equal(await f.runtime.recoverInactiveRuns(),0)
  }finally{await f.runtime.cancelAll();rmSync(root,{recursive:true,force:true})}
})

test('dispatcher exposes terminal stop reason and retains abort/timeout identity',async()=>{
  for(const reason of ['refusal','max-tokens','error']) {
    const dispatch=createHostDispatcher({async start(){return{result:Promise.resolve({output:[],stopReason:reason}),async dispose(){}}}},{})
    await assert.rejects(dispatch({phase:'implementation',runId:'test',attemptId:'attempt',prompt:'test',signal:new AbortController().signal}),new RegExp(reason))
  }
  const abort=new AbortController();abort.abort(new Error('TASK_TIMEOUT'))
  const dispatch=createHostDispatcher({async start(){return{result:Promise.resolve({output:[],stopReason:'aborted'}),async dispose(){}}}},{})
  await assert.rejects(dispatch({phase:'implementation',runId:'test',attemptId:'attempt',prompt:'test',signal:abort.signal}),/TASK_TIMEOUT/)
})
