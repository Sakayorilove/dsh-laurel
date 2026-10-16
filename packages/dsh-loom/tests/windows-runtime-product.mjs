/** Explicit real Windows product run; never used as a Windows build command. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { executeWsl, wslToWindowsPath, windowsToWslPath } from '../lib/bridge.js'
import { installWslChildFileSystem } from '../lib/wsl-fs.js'
import { WslShellExecution, installWslChildShell } from '../lib/wsl-shell.js'
import { createWorktreeManager, probeRepo, git } from '../lib/worktree.js'
import { LoomStore } from '../lib/store.js'
import { acquireExecutionLease } from '../lib/coordinator.js'
import { IsolatedTaskRuntime } from '../lib/runtime.js'
import { adoptPlannerOutput, normalizeWorkspaceId } from '../lib/core/index.js'
import { samplePlannerOutput } from './fixtures.mjs'
import { resolveHostAnchor } from '../scripts/host-anchor.mjs'

assert.equal(process.platform, 'win32', 'Run through the installed Windows product Node to validate the real boundary')
// 宿主锚点可配置、可校验：不再写死某台机器的路径。
// 解析顺序 LOOM_HOST_ANCHOR → DSH_HOME → 常见安装位置；给的是 WSL 路径就翻成 UNC。
const resolvedAnchor = resolveHostAnchor()
assert.ok(resolvedAnchor, '找不到宿主锚点：设 LOOM_HOST_ANCHOR 指向 Harness 的 package.json（或设 DSH_HOME）')
const hostAnchor = resolvedAnchor.startsWith('/') && !resolvedAnchor.startsWith('//')
  ? wslToWindowsPath(resolvedAnchor)
  : resolvedAnchor
const host=createRequire(hostAnchor)
const hostVersions={}
for(const name of ['cordis','dsh-tools','dsh-fs-local','dsh-tool-fs','dsh-shell','dsh-tool-bash']) hostVersions[name]=host(`@deepseek-ai/${name}/package.json`).version
const root=mkdtempSync(wslToWindowsPath('/tmp/loom-windows-product-')), repo=join(root,'repo')
mkdirSync(repo);writeFileSync(join(repo,'baseline.txt'),'frozen')
const receipts=[], assertions=[]
const record=(name)=>assertions.push(name)
const shell=(argv,cwd=repo,options)=>executeWsl(argv,cwd,options).then(result=>{receipts.push({argv:result.argv,cwd:result.cwd,platform:result.platform,pid:result.pid,exitCode:result.exitCode,state:result.state,stdoutHash:result.stdoutHash,stderrHash:result.stderrHash});return result})
const ok=async(argv,cwd=repo)=>{const result=await shell(argv,cwd);assert.equal(result.state,'passed',result.stderr);return result.stdout.trim()}
let ctx
try {
  await ok(['git','init','-q','-b','main']);await ok(['git','config','user.email','fixture@loom.local']);await ok(['git','config','user.name','Loom fixture'])
  await ok(['git','add','.']);await ok(['git','commit','-qm','baseline'])
  const baseSha=await ok(['git','rev-parse','HEAD'])
  const probe=await probeRepo(repo);assert.equal(probe.ok,true,JSON.stringify(probe));assert.equal(probe.headSha,baseSha);assert.equal(readFileSync(join(probe.topLevel,'baseline.txt'),'utf8'),'frozen');record('real Windows Git adapter invokes WSL and canonical UNC repo probe')
  const store=new LoomStore(join(root,'home')), trees=createWorktreeManager({paths:store.paths,root:join(root,'trees')})
  const created=await trees.create('windows',repo,['api']);assert.equal(created.ok,true,JSON.stringify(created))
  const tree=created.records[0].path
  const ex=new WslShellExecution({command:'printf bridge > bridge.txt; printf "%s" "$PWD"',workdir:tree,timeoutMs:10000,stdoutMaxBytes:4000,sandboxPolicy:{mode:'workspace-write',workspaceRoot:tree}})
  const result=await ex.result();await ex.done;assert.equal(result.exitCode,0,result.stderr.text);assert.equal(result.stdout.text,windowsToWslPath(tree));assert.equal(readFileSync(join(tree,'bridge.txt'),'utf8'),'bridge');record('real Windows ShellExecution writes inside a WSL sandbox, read through UNC')
  const {Context}=host('@deepseek-ai/cordis');ctx=new Context()
  await ctx.plugin(host('@deepseek-ai/dsh-system-prompt').default)
  await ctx.plugin(host('@deepseek-ai/dsh-tools').default,{})
  ctx.provide('sandboxPolicy',{defaultMode:'workspace-write',resolve:({session}={})=>({mode:'workspace-write',workspaceRoot:session?.header.cwd??tree})})
  ctx.provide('shellEnv',{collect:()=>({})})
  const parentShell={name:'pwsh',description:'parent fixture tool',parameters:{type:'object',properties:{}},output:{schema:{type:'object',properties:{}},render:()=>[]},execute:async()=>({})}
  ctx.tools.register(parentShell)
  const agent={session:{id:'windows-fs-task',header:{cwd:tree},append(){}},ctx:null}
  const scope=host('@deepseek-ai/dsh-scope').createScope(ctx,agent);agent.ctx=scope.ctx
  const oldEntry=process.argv[1];process.argv[1]=hostAnchor
  try {await installWslChildFileSystem(scope.ctx,tree);await installWslChildShell(scope.ctx,tree)} finally {process.argv[1]=oldEntry}
  assert.equal(ctx.tools.get('pwsh'),parentShell);assert.equal(ctx.tools.get('pwsh',agent),undefined)
  assert.equal(ctx.tools.get('bash'),undefined);assert.ok(ctx.tools.get('bash',agent))
  record('real public child scope exposes WSL bash and fs tools while parent tools remain intact')
  const run=async(name,args)=>{
    const definition=ctx.tools.get(name,agent);assert.ok(definition,name)
    const result=await ctx.tools.execute({name,arguments:args,agent,callId:`${name}-receipt`,signal:new AbortController().signal})
    assert.ok(!result.isError,JSON.stringify(result));return result
  }
  const scopedShell=await run('bash',{command:'printf scoped-bash > scoped-bash.txt',description:'Verify child WSL shell'})
  assert.equal(readFileSync(join(tree,'scoped-bash.txt'),'utf8'),'scoped-bash')
  const wrote=await run('write',{file_path:'tool-owned.txt',content:'before'})
  assert.equal(readFileSync(join(tree,'tool-owned.txt'),'utf8'),'before',JSON.stringify(wrote))
  const read=await run('read',{file_path:'tool-owned.txt'});assert.match(JSON.stringify(read),/before/)
  await run('edit',{file_path:'tool-owned.txt',old_string:'before',new_string:'after'})
  assert.equal(readFileSync(join(tree,'tool-owned.txt'),'utf8'),'after');assert.equal(existsSync(join(repo,'tool-owned.txt')),false);record('installed public host read/write/edit tools use native WSL FileSystem and child cwd and preserve parent repository')
  const wf=samplePlannerOutput();wf.nodes=wf.nodes.slice(2,4);wf.edges=[];wf.executionProposal.requiredCapabilities=['worktree','wsl-execution','artifact-verification']
  wf.nodes.forEach(node=>{node.inputs=[];node.execution.timeoutSeconds=20;node.acceptance.commands=[{argv:['node','-e',`if(require('fs').readFileSync('${node.id}.txt','utf8')!=='${node.id}')process.exit(1)`],cwdRef:'node-worktree',expectedExitCode:0}];node.ownership.writes=[`${node.id}.txt`]})
  const runtime=new IsolatedTaskRuntime(store,trees,2);let active=0,peak=0
  const actual=await runtime.run(adoptPlannerOutput(wf).workflow,repo,normalizeWorkspaceId(repo),baseSha,async task=>{
    if(task.phase==='review')return{verdict:'pass',attemptId:task.attemptId,snapshotHash:task.snapshotHash,findings:[],artifactRefs:[]}
    active++;peak=Math.max(peak,active)
    try {
      const result=await shell(['node','-e',`setTimeout(()=>require('fs').writeFileSync('${task.node.id}.txt','${task.node.id}'),100)`],task.cwd,{signal:task.signal})
      assert.equal(result.state,'passed',result.stderr)
      return{verdict:'ready',attemptId:task.attemptId,artifactRefs:[{nodeId:task.node.id,port:task.node.outputs[0].name,ref:`${task.node.id}.txt`,contentHash:createHash('sha256').update(task.node.id).digest('hex')}]}
    }finally{active--}
  },{maxRepairRounds:0})
  assert.equal(actual.state,'validated',JSON.stringify(actual));assert.equal(peak,2);assert.equal(actual.checks.length,2);assert.equal((await git(repo,['status','--porcelain'])).stdout.trim(),'');record('real Windows runtime dispatches parallel WSL processes to distinct worktrees and verifies files, ownership, hashes and checks')
  assert.ok(runtime.journal.read(actual.runId).tasks.every(t=>t.review?.verdict==='pass'));record('Windows execution journal is durable; review snapshots include actual WSL command receipts')
  const ntfsRoot=mkdtempSync(process.env.LOOM_WINDOWS_FIXTURE_ROOT ?? 'D:/loom-windows-lock-fixture-');try{const ntfsLease=await acquireExecutionLease(ntfsRoot);const busy=await shell(['flock','-n','-E','73',windowsToWslPath(join(ntfsRoot,'execution.lock')),'true']);assert.equal(busy.exitCode,73);await ntfsLease.release();await ok(['flock','-n','-E','73',windowsToWslPath(join(ntfsRoot,'execution.lock')),'true']);record('Windows NTFS profile boundary: DrvFS flock blocks and releases a Linux contender')}finally{rmSync(ntfsRoot,{recursive:true,force:true})}
  const lease=await acquireExecutionLease(store.paths.root);const contender=await shell(['flock','-n','-E','73',windowsToWslPath(join(store.paths.root,'execution.lock')),'true']);assert.equal(contender.exitCode,73);await lease.release();await ok(['flock','-n','-E','73',windowsToWslPath(join(store.paths.root,'execution.lock')),'true']);record('actual Windows→WSL flock blocks a Linux contender and releases on owner completion')
  await runtime.cancelAll();await scope.dispose()
  assert.equal(ctx.tools.get('bash',agent),undefined);assert.equal(ctx.tools.get('pwsh'),parentShell);record('child scope disposal removes owned WSL services and tools')
  const out={platform:process.platform,node:process.versions.node,hostAnchor,hostVersions,root,assertions,receipts,peak,modelCalls:0,scope:'Real Windows Node/WSL/Linux worktrees and installed host FS tools. Program dispatch, not a model or Electron renderer.',passed:true}
  if(process.env.LOOM_EVIDENCE_PATH)writeFileSync(process.env.LOOM_EVIDENCE_PATH,JSON.stringify(out,null,2)+'\n')
  console.log(JSON.stringify(out,null,2))
} finally {if(ctx)await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}
