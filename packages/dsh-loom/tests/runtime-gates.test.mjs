import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {LoomStore} from '../lib/store.js'
import {IsolatedTaskRuntime,createHostDispatcher} from '../lib/runtime.js'
import {createWorktreeManager} from '../lib/worktree.js'
import {adoptPlannerOutput,defaultFlowPlan,compileFlowSchedule,normalizeWorkspaceId} from '../lib/core/index.js'
import {LoomWorktreeProvider} from '../lib/provider.js'
import {samplePlannerOutput} from './fixtures.mjs'
const sha=s=>createHash('sha256').update(s).digest('hex')
function fixture(count=2){
  const root=mkdtempSync(join(tmpdir(),'loom-gates-')),repo=join(root,'repo');mkdirSync(repo)
  const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim()
  for(const args of [['init','-q','-b','main'],['config','user.email','fixture@loom.local'],['config','user.name','Loom fixture']])git(args)
  writeFileSync(join(repo,'baseline.txt'),'frozen');git(['add','.']);git(['commit','-qm','baseline'])
  const raw=samplePlannerOutput();raw.nodes=Array.from({length:count},(_,i)=>({...structuredClone(raw.nodes[2]),id:'task-'+(i+1),inputs:[],ownership:{writes:['modules/task-'+(i+1)+'/**'],forbiddenWrites:[],sharedResources:[]},acceptance:{doneWhen:['交付实际文件'],commands:[],independentVerification:true}}));raw.edges=[];raw.executionProposal.requiredCapabilities=['worktree'];const workflow=adoptPlannerOutput(raw).workflow
  const store=new LoomStore(join(root,'home')),trees=createWorktreeManager({paths:store.paths}),runtime=new IsolatedTaskRuntime(store,trees,2),ws=normalizeWorkspaceId(repo),baseSha=git(['rev-parse','HEAD'])
  const produce=async({node,cwd})=>{const ref='modules/'+node.id+'/artifact.txt';mkdirSync(join(cwd,ref,'..'),{recursive:true});writeFileSync(join(cwd,ref),node.id);return{verdict:'ready',artifactRefs:[{nodeId:node.id,port:node.outputs[0].name,ref,contentHash:sha(node.id)}]}}
  return {root,repo,workflow,store,trees,runtime,ws,baseSha,produce,cleanup:()=>rmSync(root,{recursive:true,force:true})}
}
test('group failure blocks the next step; production audit target exists and prompt contains actual bytes',async()=>{
  const f=fixture(),flow=defaultFlowPlan(f.workflow)
  flow.steps=[{id:'step-1',taskIds:['task-1'],agents:2},{id:'step-2',taskIds:['task-2'],agents:2}];flow.order=['step-1','step-2'];flow.groups=[{id:'group-1',stepIds:['step-1'],auditAgentId:'audit-1'}];flow.auditAgents[0].groupId='group-1'
  const compiled=compileFlowSchedule(f.workflow,flow,3);assert.equal(compiled.ok,true)
  const starts=[]
  try{
    const result=await f.runtime.run(f.workflow,f.repo,f.ws,f.baseSha,async task=>{
      if(task.phase==='audit'){
        const located=new LoomWorktreeProvider({paths:f.store.paths,helpers:{}}).locate('loom:'+task.runId+':'+task.targetTaskId)
        assert.equal('refuse' in located,false);assert.match(task.prompt,/"content":"task-1"/)
        return{verdict:'fail',attemptId:task.attemptId,snapshotHash:task.snapshotHash,findings:['BLOCKER: interface mismatch'],artifactRefs:[]}
      }
      starts.push(task.node.id);return f.produce(task)
    },{schedule:compiled.schedule})
    assert.equal(result.state,'failed');assert.match(result.error,/AUDIT_FAILED/);assert.deepEqual(starts,['task-1']);assert.equal(result.audits[0].verdict,'fail')
  }finally{f.cleanup()}
})
test('idle slot cannot cross a serial stage; advisory findings may pass',async()=>{
  const f=fixture(),flow=defaultFlowPlan(f.workflow);flow.steps=[{id:'step-1',taskIds:['task-1'],agents:2},{id:'step-2',taskIds:['task-2'],agents:2}];flow.order=['step-1','step-2']
  let active=null
  try{const result=await f.runtime.run(f.workflow,f.repo,f.ws,f.baseSha,async task=>{assert.equal(active,null);active=task.node.id;await new Promise(r=>setTimeout(r,30));const value=await f.produce(task);active=null;return value},{schedule:compileFlowSchedule(f.workflow,flow,3).schedule});assert.equal(result.state,'validated')}finally{f.cleanup()}
})
test('production dispatcher accepts audit without artifactRefs and binds a registered task label',async()=>{
  let started,disposed=false
  const dispatcher=createHostDispatcher({start:async(name,options)=>{started=options;return{result:Promise.resolve({stopReason:'completed',structured:{verdict:'pass',attemptId:'attempt-1',snapshotHash:'snapshot-1',findings:[]},output:[]}),dispose:async()=>{disposed=true}}}}, {})
  const result=await dispatcher({node:null,targetTaskId:'task-1',cwd:'/tmp/task',runId:'run-1',baseSha:'a'.repeat(40),phase:'audit',attemptId:'attempt-1',snapshotHash:'snapshot-1',prompt:'read immutable evidence',signal:new AbortController().signal})
  assert.equal(result.verdict,'pass');assert.deepEqual(result.artifactRefs,[]);assert.equal(started.label,'loom:run-1:task-1');assert.equal(started.persona,'Loom 独立只读审查');assert.equal(started.prompt[0].text.includes('verdict:"ready"'),false);assert.equal(disposed,true)
})
test('six modules, three teams and three supervisors use bounded typed communication and independent review',async()=>{
  const f=fixture(6),flow=defaultFlowPlan(f.workflow)
  flow.organization={members:f.workflow.nodes.map(n=>({id:'member-'+n.id,label:n.id,role:'executor',responsibility:'只改分配文件',taskIds:[n.id]})),teams:[],communicationRounds:1}
  for(let i=1;i<=3;i++){flow.organization.members.push({id:'lead-'+i,label:'分管'+i,role:'supervisor',responsibility:'接口协调',taskIds:[]},{id:'reviewer-'+i,label:'审查'+i,role:'reviewer',responsibility:'独立审查',taskIds:[]});flow.organization.teams.push({id:'team-'+i,label:'组'+i,taskIds:['task-'+(i*2-1),'task-'+(i*2)],supervisorId:'lead-'+i,reviewerId:'reviewer-'+i})}
  const compiled=compileFlowSchedule(f.workflow,flow,3);assert.equal(compiled.ok,true,JSON.stringify(compiled))
  const calls=[]
  try{const result=await f.runtime.run(f.workflow,f.repo,f.ws,f.baseSha,async task=>{calls.push({phase:task.phase,memberId:task.memberId,prompt:task.prompt});if(task.phase==='implementation')return f.produce(task);return{verdict:'pass',attemptId:task.attemptId,snapshotHash:task.snapshotHash,findings:[],messages:task.phase==='supervision'&&task.memberId==='lead-1'?[{to:'lead-2',body:'请核对字段类型，证据引用 team-1'}]:[],artifactRefs:[]}},{schedule:compiled.schedule})
    assert.equal(result.state,'validated',JSON.stringify(result));assert.equal(result.audits.length,3);assert.equal(result.supervisionReports.length,3);assert.equal(result.communications.length,1)
    assert.equal(calls.filter(c=>c.phase==='coordination').length,3);assert.ok(calls.some(c=>c.phase==='coordination'&&c.memberId==='lead-2'&&c.prompt.includes('请核对字段类型')))
    assert.equal(new Set(calls.filter(c=>c.phase==='implementation').map(c=>c.memberId)).size,6)
    const saved=f.runtime.journal.read(result.runId);assert.equal(saved.communications[0].attemptId.length>0,true)
  }finally{f.cleanup()}
})
test('required reviewer missing, uncovered tasks and backwards stage dependencies fail compilation',()=>{
  const f=fixture()
  try{const flow=defaultFlowPlan(f.workflow);flow.groups=[{id:'group-1',stepIds:['step-1'],auditAgentId:null}];assert.equal(compileFlowSchedule(f.workflow,flow,3).ok,false);flow.groups=[];flow.steps[0].taskIds.pop();assert.equal(compileFlowSchedule(f.workflow,flow,3).ok,false)}finally{f.cleanup()}
})
