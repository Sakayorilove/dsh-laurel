import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {LoomStore} from '../lib/store.js'
import {IsolatedTaskRuntime,compatibleRecoveryWorkflow} from '../lib/runtime.js'
import {createWorktreeManager} from '../lib/worktree.js'
import {adoptPlannerOutput,normalizeWorkspaceId} from '../lib/core/index.js'
import {materializeInputs} from '../lib/input-bundle.js'
import {samplePlannerOutput} from './fixtures.mjs'
const sha=s=>createHash('sha256').update(s).digest('hex')
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'loom-inputs-')),repo=join(root,'repo');mkdirSync(repo)
 const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim()
 for(const a of [['init','-q','-b','main'],['config','user.email','test@loom.local'],['config','user.name','Loom input test']])git(a)
 writeFileSync(join(repo,'baseline.txt'),'frozen');git(['add','.']);git(['commit','-qm','frozen'])
 const raw=samplePlannerOutput(),template=raw.nodes[2]
 raw.nodes=['skeleton','module','verify'].map((id,i)=>({...structuredClone(template),id,title:id,inputs:i?[{name:'input',artifactType:'code-change',required:true}]:[],outputs:[{name:'output',artifactType:'code-change',required:false}],ownership:{writes:i===0?['package.json','scripts/**']:i===1?['lib/core/**']:['tests/**'],forbiddenWrites:[],sharedResources:[]},execution:{backend:'configured-agent',isolation:'worktree',timeoutSeconds:30,maxRepairAttempts:0},acceptance:{doneWhen:['实际构建和测试'],commands:i===2?[{argv:['node','scripts/check.cjs'],cwdRef:'node-worktree',expectedExitCode:0}]:[],independentVerification:true}}))
 raw.edges=[{id:'a',source:'skeleton',sourcePort:'output',target:'module',targetPort:'input',artifactType:'code-change',require:'validated'},{id:'b',source:'module',sourcePort:'output',target:'verify',targetPort:'input',artifactType:'code-change',require:'validated'}]
 raw.executionProposal.requiredCapabilities=['worktree'];const adopted=adoptPlannerOutput(raw);assert.equal(adopted.accepted,true,JSON.stringify(adopted));const workflow=adopted.workflow
 const store=new LoomStore(join(root,'home')),trees=createWorktreeManager({paths:store.paths}),runtime=new IsolatedTaskRuntime(store,trees,1),ws=normalizeWorkspaceId(repo),baseSha=git(['rev-parse','HEAD'])
 const produce=async task=>{
  if(task.phase==='review')return {verdict:'pass',attemptId:task.attemptId,snapshotHash:task.snapshotHash,findings:[],artifactRefs:[]}
  const files=task.node.id==='skeleton'?{'package.json':'{"scripts":{"test":"node scripts/check.cjs"}}','scripts/check.cjs':"if(require('../lib/core/answer.cjs')!==42)process.exit(1);require('../tests/check.cjs')"}:task.node.id==='module'?{'lib/core/answer.cjs':'module.exports=42'}:{'tests/check.cjs':"require('node:assert/strict').equal(require('../lib/core/answer.cjs'),42)"}
  if(task.node.id!=='skeleton')assert.equal(JSON.parse(readFileSync(join(task.cwd,'package.json'))).scripts.test,'node scripts/check.cjs')
  if(task.node.id==='verify')assert.equal(readFileSync(join(task.cwd,'lib/core/answer.cjs'),'utf8'),'module.exports=42')
  for(const [path,content] of Object.entries(files)){mkdirSync(join(task.cwd,path,'..'),{recursive:true});writeFileSync(join(task.cwd,path),content)}
  return {verdict:'ready',attemptId:task.attemptId,artifactRefs:Object.entries(files).map(([ref,content])=>({nodeId:task.node.id,port:'output',ref,contentHash:sha(content)}))}
 }
 return{root,repo,git,workflow,store,runtime,ws,baseSha,produce,trees,cleanup:()=>rmSync(root,{recursive:true,force:true})}
}
test('reviewed skeleton, multiple files per port and transitive module reach final real build worktree',async()=>{
 const f=fixture();try{const result=await f.runtime.run(f.workflow,f.repo,f.ws,f.baseSha,f.produce,{maxRepairRounds:0});assert.equal(result.state,'validated',result.error);assert.equal(result.artifacts.length,4);assert.equal(result.checks[0].exitCode,0);assert.equal(f.git(['status','--porcelain']),'');assert.equal(f.git(['rev-parse','HEAD']),f.baseSha)}finally{f.cleanup()}
})
test('mutating inherited skeleton outside ownership blocks delivery and retains original bytes',async()=>{
 const f=fixture();try{const result=await f.runtime.run(f.workflow,f.repo,f.ws,f.baseSha,async task=>{const output=await f.produce(task);if(task.node.id==='module'&&task.phase==='implementation')writeFileSync(join(task.cwd,'package.json'),'{}');return output});assert.equal(result.state,'failed');assert.match(result.error,/OWNERSHIP_VIOLATION/);assert.equal(JSON.parse(readFileSync(join(result.worktrees.find(t=>t.taskId==='skeleton').path,'package.json'))).scripts.test,'node scripts/check.cjs')}finally{f.cleanup()}
})
test('unknown extra artifact ports cannot be silently discarded',async()=>{
 const f=fixture();try{const result=await f.runtime.run(f.workflow,f.repo,f.ws,f.baseSha,async task=>{const output=await f.produce(task);output.artifactRefs.push({...output.artifactRefs[0],port:'unexpected'});return output});assert.equal(result.state,'failed');assert.match(result.error,/INVALID_ARTIFACT/)}finally{f.cleanup()}
})
test('explicit recovery preserves stopped task drafts but re-runs every acceptance and review',async()=>{
 const f=fixture();try{
  const failed=await f.runtime.run(f.workflow,f.repo,f.ws,f.baseSha,async task=>task.phase==='review'?{verdict:'fail',attemptId:task.attemptId,snapshotHash:task.snapshotHash,findings:['correct the contract'],artifactRefs:[]}:f.produce(task),{maxRepairRounds:0})
  assert.equal(failed.state,'failed');const oldTree=failed.worktrees.find(t=>t.taskId==='skeleton').path;const before=readFileSync(join(oldTree,'scripts/check.cjs'),'utf8');let sawDraft=false,reviewCount=0
  const resumed=await f.runtime.run(f.workflow,f.repo,f.ws,f.baseSha,async task=>{
   if(task.node.id==='skeleton'&&task.phase==='implementation'){assert.notEqual(task.cwd,oldTree);assert.equal(readFileSync(join(task.cwd,'scripts/check.cjs'),'utf8'),before);assert.match(task.prompt,/未验收草稿/);assert.match(task.prompt,/correct the contract/);sawDraft=true}
   if(task.phase==='review')reviewCount++;return f.produce(task)
  },{recoveryOf:failed.runId,maxRepairRounds:0})
  assert.equal(resumed.state,'validated',resumed.error);assert.equal(sawDraft,true);assert.equal(reviewCount,3);assert.equal(readFileSync(join(oldTree,'scripts/check.cjs'),'utf8'),before)
 }finally{f.cleanup()}
})
test('ambiguous inputs and baseline symlink cannot redirect projection outside worktree',()=>{
 const root=mkdtempSync(join(tmpdir(),'loom-input-security-')),tree=join(root,'tree'),outside=join(root,'outside');mkdirSync(tree);mkdirSync(outside);writeFileSync(join(outside,'keep.txt'),'keep');symlinkSync(outside,join(tree,'lib'))
 const file={path:'lib/keep.txt',kind:'file',mode:0o100644,content:'new',sha256:sha('new')},snapshot=files=>({data:{files}})
 try{assert.throws(()=>materializeInputs(tree,[snapshot([file])]),/INPUT_PATH_SYMLINK/);assert.equal(readFileSync(join(outside,'keep.txt'),'utf8'),'keep');assert.throws(()=>materializeInputs(tree,[snapshot([{...file,path:'a'}]),snapshot([{...file,path:'a',content:'other',sha256:sha('other')}])]),/INPUT_CONFLICT/);assert.throws(()=>materializeInputs(tree,[snapshot([{...file,path:'../outside/keep.txt'}])]),/INPUT_PATH_ESCAPE/)}finally{rmSync(root,{recursive:true,force:true})}
})
test('changed acceptance needs fresh approval; changed ownership, task graph or execution cannot reuse drafts',async()=>{
 const f=fixture();try{
  f.store.appendRevision(f.workflow,f.ws)
  const revised=structuredClone(f.workflow);revised.revision++;revised.nodes[0].acceptance.doneWhen.push('骨架负责冻结接口，具体实现由下游验收')
  assert.equal(compatibleRecoveryWorkflow(f.workflow,revised),true)
  for(const mutate of [w=>w.nodes[0].ownership.writes.push('elsewhere/**'),w=>w.nodes[0].execution.timeoutSeconds++,w=>w.edges.pop(),w=>w.nodes[0].goal+='changed']){const unsafe=structuredClone(revised);mutate(unsafe);assert.equal(compatibleRecoveryWorkflow(f.workflow,unsafe),false)}
  const failed=await f.runtime.run(f.workflow,f.repo,f.ws,f.baseSha,async task=>task.phase==='review'?{verdict:'fail',attemptId:task.attemptId,snapshotHash:task.snapshotHash,findings:['contract correction'],artifactRefs:[]}:f.produce(task),{maxRepairRounds:0})
  await assert.rejects(f.runtime.run(revised,f.repo,f.ws,f.baseSha,f.produce,{recoveryOf:failed.runId,maxRepairRounds:0}),/RECOVERY_REFUSED/)
  const resumed=await f.runtime.run(revised,f.repo,f.ws,f.baseSha,f.produce,{recoveryOf:failed.runId,maxRepairRounds:0,approvedPlan:{hash:'fresh-approved',flowHash:'fresh-flow',markdown:'revised acceptance',flow:{},baseSha:f.baseSha,workflowId:revised.workflowId,revision:revised.revision}})
  assert.equal(resumed.state,'validated',resumed.error)
 }finally{f.cleanup()}
})
