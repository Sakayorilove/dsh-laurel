/** Explicit complete-host acceptance. Run in WSL: node --expose-internals scripts/verify-planning-host.mjs. Uses existing installed official modules and Chromium, an isolated temporary profile, and an OFFLINE controlled model adapter. No real credentials, model charges, Electron claims or user-profile mutations. */
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdirSync, appendFileSync, existsSync } from 'node:fs'
import { format } from 'node:util'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { LoomStore } from '../lib/store.js'
import { PlanningController } from '../lib/planning.js'
import { normalizeWorkspaceId } from '../lib/core/index.js'
import { samplePlannerOutput } from '../tests/fixtures.mjs'
import { launchBrowser } from '../tests/cdp.mjs'
import { resolveHostAnchor, hostSkipReason } from './host-anchor.mjs'
const sourceRoot=fileURLToPath(new URL('..',import.meta.url))
const anchor=resolveHostAnchor()
if(anchor===null){console.error(hostSkipReason);process.exit(2)}
const host=createRequire(anchor)
const previousCwd=process.cwd(),previousEntry=process.argv[1]
const envKeys=['DSH_HOME','DSH_AGENTS_HOME','DSH_BUNDLED_SKILL_DIR'],previousEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]))
const packageVersion=JSON.parse(await readFile(join(sourceRoot,'package.json'),'utf8')).version
async function runtimeFiles(dir='lib'){const entries=await readdir(join(sourceRoot,dir),{withFileTypes:true});return (await Promise.all(entries.map(e=>e.isDirectory()?runtimeFiles(join(dir,e.name)):join(dir,e.name)))).flat()}
const runtimeHasher=createHash('sha256');for(const file of (await runtimeFiles()).sort())runtimeHasher.update(file+'\0').update(await readFile(join(sourceRoot,file)))
const runtimeFingerprint=runtimeHasher.digest('hex')

const evidence=join(sourceRoot,'.verification');mkdirSync(evidence,{recursive:true});mkdirSync(join(sourceRoot,'.browser-evidence'),{recursive:true})
const logPath=join(evidence,'planning-host.log');await writeFile(logPath,'')
await writeFile(join(evidence,'planning-host.json'),JSON.stringify({passed:false,status:'running',packageVersion,startedAt:new Date().toISOString()},null,2)+'\n')
for(const level of ['log','warn','error']){const original=console[level].bind(console);console[level]=(...args)=>{appendFileSync(logPath,format(...args)+'\n');original(...args)}}
const home = await mkdtemp('/tmp/loom-complete-host-'), cwd = join(home,'planning-folder'), repo = join(home,'project')
await mkdir(cwd);process.chdir(cwd);process.env.DSH_HOME=home
process.env.DSH_AGENTS_HOME=join(home,'agents');process.env.DSH_BUNDLED_SKILL_DIR=join(home,'skills')
process.argv[1]=anchor
const app=host('@deepseek-ai/dsh-app-boot')
await mkdir(join(home,'node_modules'))
await symlink(sourceRoot,join(home,'node_modules','dsh-loom'))
app.initProfile(home,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-loom'])
const patches=[...app.loadOverlayPatches('loom-test',host.resolve('@deepseek-ai/dsh-base/cordis.patch.yml')),
...app.bundlePatchPaths(dirname(host.resolve('@deepseek-ai/dsh-web-app/package.json')),host('@deepseek-ai/dsh-web-app/package.json').dsh.bundle).flatMap(file=>app.loadOverlayPatches('loom-test',file)),
{id:'hmr',disabled:true},{id:'llm-deepseek',disabled:true},{id:'llm-pi-ai',disabled:true},{id:'session-title-llm',disabled:true},
{id:'session-log-deepseek',config:{enabled:false}}, {id:'session-telemetry-otel',disabled:true},
{id:'agent-instructions',disabled:true},{id:'open-in-app',disabled:true},{id:'ui-open-in-app',disabled:true},
{id:'agent-default-model',config:{provider:'loom-controlled',model:'controlled'}},
{id:'ui-settings-general',config:{welcomeNoticeVersion:'2026-09-28.1'}},
{id:'webserver',config:{host:'127.0.0.1',port:0,compression:'gzip',compressionLevel:1,compressionThresholdBytes:1024}},
{id:'web-runtime',config:{openBrowser:false,printUrl:false,surfaceContext:true}},
{id:'session-persistence-jsonl',config:{root:join(home,'sessions')}},
{id:'storage-json',config:{root:join(home,'storages')}},
{id:'session-query-sqlite',config:{path:':memory:',openAt:'never'}},
{id:'credentials',config:{dshHome:home}},
{id:'workspace-controller',config:{documentsDirectory:join(home,'Documents')}},
{id:'skill-filesystem',config:{dshHome:home,agentsHome:join(home,'agents'),bundledSkillDir:join(home,'skills'),watch:false}},
 {insert:[{id:'loom',name:pathToFileURL(join(sourceRoot,'lib/index.js')).href}]}]
const config=join(home,'cordis.yml');await writeFile(config,'[]\n')
let ctx
const windowsCaption=[]
let releaseFirstChild
const firstChildGate=new Promise(resolve=>{releaseFirstChild=resolve})
let captionGeometry
let inlineEvidence
try {
ctx=await app.boot('loom-complete-host',config,patches,async ctx=>{
 const profile={name:'loom-acceptance',dir:home,layers:[{packageName:'dsh-loom',packageDir:sourceRoot,patchPaths:[join(sourceRoot,'cordis.patch.yml')],patches:[]}],skippedBundles:[],patchPath:join(home,'cordis.patch.yml'),patches:[]}
 ctx.provide('profileContext',{name:profile.name,dir:home,patchPath:profile.patchPath,installAnchor:anchor,cwd,home,startedBundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-loom'],overlays:patches,telemetryDisabledEnv:undefined})
 ctx.provide('appReady',{onReady:listener=>{listener();return()=>{}}})
 const resolution=await app.createRuntimeResolution({installAnchor:anchor,home,profile})
 await ctx.plugin(app.PluginPackages,{resolution})
 host('@deepseek-ai/dsh-cmdline').provideCmdline(ctx,{args:[],exit:code=>{throw Error('unexpected exit '+code)}})
},pathToFileURL(anchor).href)
const services=['sessionController','typertGateway','agents','subagents','loomRemote','connection'].map(name=>[name,!!ctx.get(name)])
console.log(JSON.stringify({home,port:ctx.webServer?.port,services}))
console.log(JSON.stringify({loomModule:ctx.clientModules.graph().entries?.filter(e=>e.id==='dsh-loom')??ctx.clientModules.graph()}))
const modelCalls=[],children=new Map();let parentCalls=0,planningReply,bootstrap=true
console.log({nativePlanService:!!ctx.get('planMode'),nativeSet:typeof ctx.get('planMode')?.set, agentService:!!ctx.get('agents')})
const {createWorktreeManager}=await import('../lib/worktree.js')
const store=new LoomStore(home),trees=createWorktreeManager({paths:store.paths})
class ControlledAdapter extends host('@deepseek-ai/dsh-llm').LlmAdapter {
 async listModels(){return[{id:'controlled',name:'Controlled offline acceptance'}]}
 async resolveModel(provider,id){return{provider,id,name:id}}
 async *stream(options){
  const session=String(options.sessionId);modelCalls.push({session,tools:(options.tools??[]).map(t=>t.name)})
  let value,reason='stop',blockType='text',block
  if(session==='loom-planning-parent') {
    if(bootstrap){bootstrap=false;yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:'隔离会话准备完成。'};yield{type:'block-end',index:0,block:{type:'text',text:'隔离会话准备完成。'}};yield{type:'finish',reason:{kind:'stop'}};return}
    parentCalls++
    assert.ok(JSON.stringify(options).includes('You are in Loom planning mode'),'effective assembled policy selects Loom submission, not native exit review')
    if(parentCalls===1){reason='tool-calls';blockType='tool-call';block={type:'tool-call',id:'forbidden-parent-write',name:'write',arguments:JSON.stringify({file_path:'must-not-exist.txt',content:'blocked'})}}
    else if(parentCalls===2) {
      const request=store.latestPlanningRequest(normalizeWorkspaceId(cwd))
      assert.ok(request,'ordinary composer prompt creates a Loom request')
      const raw=samplePlannerOutput();raw.nodes=Array.from({length:6},(_,i)=>({...structuredClone(raw.nodes[2]),id:'task-'+(i+1),title:'模块 '+(i+1),inputs:[],ownership:{writes:['task-'+(i+1)+'.txt'],forbiddenWrites:[],sharedResources:[]},execution:{backend:'configured-agent',isolation:'worktree',timeoutSeconds:30,maxRepairAttempts:0},acceptance:{doneWhen:['交付实际文件'],commands:[{argv:['node','-e',`if(require('fs').readFileSync('task-${i+1}.txt','utf8')!=='task-${i+1}')process.exit(1)`],cwdRef:'node-worktree',expectedExitCode:0}],independentVerification:true}}));raw.edges=[];raw.workflowId=request.workflowId;raw.executionProposal.requiredBaseline='selected-frozen-commit';raw.executionProposal.requiredCapabilities=['worktree','wsl-execution','artifact-verification']
      raw.nodes[0].ownership.writes.push('package.json','scripts/**')
      for(let i=1;i<=2;i++){raw.nodes[i].inputs=[{name:'upstream',artifactType:'code-change',required:true}];raw.edges.push({id:'input-'+i,source:'task-'+i,sourcePort:'changes',target:'task-'+(i+1),targetPort:'upstream',artifactType:'code-change',require:'validated'})}
      raw.nodes[2].acceptance.commands.push({argv:['node','scripts/check.cjs'],cwdRef:'node-worktree',expectedExitCode:0})
      planningReply={requestId:request.payloadHash,architecture:{schemaVersion:1,architectureId:request.architectureId,revision:1,createdAt:new Date().toISOString(),nodes:raw.nodes.map(n=>({id:n.id,kind:'module',title:n.title,responsibility:n.goal})),edges:[],constraints:request.constraints},workflow:raw,mappings:raw.nodes.map(n=>({workflowNodeId:n.id,architectureNodeIds:[n.id],decisionIds:[]})),explanation:'六模块、三分管受控验收'}
      planningReply.workflow.openQuestions=['模块文件的验收方式需要确认','当前是否先只处理这一个项目']
      const rejected=structuredClone(planningReply);rejected.architecture.nodes[0].nodeKind='module';reason='tool-calls';blockType='tool-call';block={type:'tool-call',id:'submit-plan',name:'loom_submit_plan',arguments:JSON.stringify({document:JSON.stringify(rejected)})}
    }else if(parentCalls===3){assert.ok(store.paths.root);reason='tool-calls';blockType='tool-call';block={type:'tool-call',id:'retry-plan',name:'loom_submit_plan',arguments:JSON.stringify({document:JSON.stringify({retry:true,removeFields:['/architecture/nodes/0/nodeKind']})})}}
    else if(parentCalls===5){
      const resolution=new PlanningController(store,()=>({}),()=>null).read(session).resolution
      assert.ok(resolution,'real button created a request owned by the parent session')
      assert.ok(JSON.stringify(options).includes('loom_resolve_questions'))
      reason='tool-calls';blockType='tool-call';block={type:'tool-call',id:'resolve-questions',name:'loom_resolve_questions',arguments:JSON.stringify({document:JSON.stringify({requestId:resolution.id,answers:[{index:0,status:'deferred',decision:'验'.repeat(701),reason:'已有独立验收命令，无需用户决定技术方式',taskIds:['task-1'],verification:'task-1.txt 内容等于 task-1，使用已有命令验证'},{index:1,status:'default',decision:'只处理当前项目',reason:'范围保持最小，后续再扩展'}]})})}
    }else if(parentCalls===6){
      const state=new PlanningController(store,()=>({}),()=>null).read(session)
      assert.match(state.resolutionRejected.error,/answers\[0\]\.decision/)
      reason='tool-calls';blockType='tool-call';block={type:'tool-call',id:'repair-questions',name:'loom_resolve_questions',arguments:JSON.stringify({document:JSON.stringify({requestId:state.resolution.id,retry:true,answers:[{index:0,decision:'由模块一验证实际交付文件'}]})})}
    }else value=parentCalls>4?'建议已准备好，请查看并采纳，再批准开工。':'完整计划已提交。六个模块独立交付，按界面配置三组分管，等待用户修改并批准；尚未实施。'
  }else {
    let owned=children.get(session)
    if(!owned){
      const texts=[];const collect=v=>{if(typeof v==='string')texts.push(v);else if(Array.isArray(v))v.forEach(collect);else if(v&&typeof v==='object')Object.values(v).forEach(collect)};collect(options.messages)
      const serialized=texts.join('\n'),match=serialized.match(/LOOM_EXECUTION_CONTRACT (\{[^\n]+\})/);if(!match)throw Error('missing execution contract')
      const agent=ctx.agents.get(session),record=trees.listLive().find(r=>r.path===agent.session.header.cwd);assert.ok(record,'real child has its assigned worktree')
      owned={id:record.taskId,called:false,writeIndex:0,...JSON.parse(match[1])};children.set(session,owned)
      owned.files=owned.id==='task-1'?{'task-1.txt':'task-1','package.json':'{"scripts":{"check":"node scripts/check.cjs"}}','scripts/check.cjs':"if(require('fs').readFileSync('task-2.txt','utf8')!=='task-2'||require('fs').readFileSync('task-3.txt','utf8')!=='task-3')process.exit(1)"}:{[owned.id+'.txt']:owned.id}
      if(owned.phase==='implementation'&&owned.id==='task-1')await firstChildGate
    }
    if(owned.phase!=='implementation') {
      if(!owned.called){owned.called=true;reason='tool-calls';blockType='tool-call';block={type:'tool-call',id:'deny-'+session,name:'write',arguments:JSON.stringify({file_path:'denied-review.txt',content:'must never be written'})}}
      else value=JSON.stringify({verdict:'pass',attemptId:owned.attemptId,snapshotHash:owned.snapshotHash,findings:[],messages:owned.phase==='supervision'&&owned.memberId==='lead-1'?[{to:'lead-2',body:'检查跨组接口：使用已验代码与审计证据'}]:[]})
    }else if(owned.writeIndex<Object.keys(owned.files).length){
      const [file_path,content]=Object.entries(owned.files)[owned.writeIndex++]
      reason='tool-calls';blockType='tool-call';block={type:'tool-call',id:'owned-'+owned.id+'-'+owned.writeIndex,name:'write',arguments:JSON.stringify({file_path,content})}
    }else value=JSON.stringify({verdict:'ready',attemptId:owned.attemptId,artifactRefs:Object.entries(owned.files).map(([ref,content])=>({nodeId:owned.id,port:'changes',ref,contentHash:createHash('sha256').update(content).digest('hex')}))})
  }
  if(session!=='loom-planning-parent'&&value){assert.ok(options.tools.some(t=>t.name==='structured_output'),'official structured capture tool is visible');reason='tool-calls';blockType='tool-call';block={type:'tool-call',id:'capture-'+session,name:'structured_output',arguments:value};value=undefined}
  yield{type:'block-start',index:0,blockType}
  if(block){yield{type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};yield{type:'block-end',index:0,block}}
  else{yield{type:'text-delta',index:0,text:value};yield{type:'block-end',index:0,block:{type:'text',text:value}}}
  yield{type:'usage',usage:{inputTokens:10,outputTokens:20}}
  yield{type:'finish',reason:{kind:reason}}
 }
}
ctx.llm.registerAdapter(['loom-controlled'],new ControlledAdapter())
await mkdir(repo)
for(const args of [['init','-q','-b','main'],['config','user.email','acceptance@loom.local'],['config','user.name','Loom acceptance']])execFileSync('git',args,{cwd:repo})
await writeFile(join(repo,'baseline.txt'),'baseline');execFileSync('git',['add','.'],{cwd:repo});execFileSync('git',['commit','-qm','baseline'],{cwd:repo})
const baseSha=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim()
store.writeExecutionTarget('loom-planning-parent',normalizeWorkspaceId(cwd),repo)
const workspace=await ctx.workspaceRegistry.create(cwd,'Loom planning workspace')
const sessionId=(await ctx.sessionController.create({workspaceId:workspace.id,sessionId:'loom-planning-parent'})).sessionId
const resolved=await ctx.sessionController.resolveAgent(sessionId),parent=resolved.agent,ws=normalizeWorkspaceId(cwd)
await ctx.sessionController.prompt({sessionId,requestId:'acceptance-intro',mode:'queue',content:[{type:'text',text:'准备验收会话，不进行项目工作。'}]},new AbortController().signal);await parent.whenIdle()
console.log({agentPlan:!!parent.ctx.get('planMode'),agentPlanSet:typeof parent.ctx.get('planMode')?.set,agentSystem:!!parent.ctx.get('systemPrompt'),agentPreset:parent.session.header.agentPreset})
await ctx.sessionController.rename({sessionId,title:'Loom planning acceptance'},new AbortController().signal)
await ctx.commands.execute(parent,'/loom on',[],new AbortController().signal)
const invoke=async(method,path,body)=>{const result=await ctx.typertGateway.invoke({namespace:'loom',method:'request',args:{input:{sessionId,method,path,...body?{body}:{}}}});assert.equal(result.payload.ok,true,JSON.stringify(result));return result.payload.data}
let browser,run,frontendEvidence
try {
 browser=await launchBrowser();const page=await browser.newPage()
 await page.send('Page.navigate',{url:ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`)})
 await page.send('Emulation.setDeviceMetricsOverride',{width:1500,height:900,deviceScaleFactor:1,mobile:false})
 const pointFor=(label)=>{
  const buttons=[...document.querySelectorAll('button')];const e=buttons.find(b=>!b.disabled&&(b.textContent===label||b.getAttribute('aria-label')===label)&&b.checkVisibility())
  if(!e)return null;e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)
  return hit===e||e.contains(hit)?{x:r.x+r.width/2,y:r.y+r.height/2}:null
 }
 const click=async label=>{await page.waitForFunction(pointFor,{args:[label],timeout:20000}).catch(async error=>{console.log(JSON.stringify({label,buttons:await page.evaluate(()=>[...document.querySelectorAll('button')].map(b=>({text:b.textContent,disabled:b.disabled,visible:b.checkVisibility()}))),errors:page.pageErrors,console:page.consoleLogs}));await page.screenshot(join(sourceRoot,'.browser-evidence/planning-failure.png'));throw error});for(let i=0;i<12;i++){const point=await page.evaluate(pointFor,{args:[label]});if(!point)continue;await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,button:'none',buttons:0});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const settled=await page.evaluate(pointFor,{args:[label]});if(settled&&Math.abs(settled.x-point.x)<1&&Math.abs(settled.y-point.y)<1){await page.clickAt(settled.x,settled.y);return}}throw Error('control moves while hovering: '+label)}
 await page.waitForFunction(()=>document.querySelectorAll('button').length>0,{timeout:30000}).catch(error=>{console.log(JSON.stringify({console:page.consoleLogs,errors:page.pageErrors,failed:page.failedRequests}));throw error})
 if(await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Continue')))await click('Continue')
 console.log(JSON.stringify({initialBody:await page.evaluate(()=>document.body.textContent.slice(0,3500)),pageErrors:page.pageErrors}))
 const wp=await page.evaluate(()=>{const e=[...document.querySelectorAll('*')].find(e=>e.childElementCount===0&&e.textContent==='Loom planning workspace');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});await page.clickAt(wp.x,wp.y)
 await page.waitForFunction(()=>document.body?.textContent?.includes('Loom planning acceptance'),{timeout:30000}).catch(error=>{console.log(JSON.stringify({body:"session row unavailable",console:page.consoleLogs,errors:page.pageErrors,failed:page.failedRequests}));throw error})
 const sessionPoint=await page.evaluate(()=>{const e=[...document.querySelectorAll('*')].find(e=>e.childElementCount===0&&e.textContent==='Loom planning acceptance');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})
 await page.clickAt(sessionPoint.x,sessionPoint.y)
 await click('规划模式')
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='规划模式'&&b.getAttribute('aria-pressed')==='true'))
 const mode=await invoke('GET','/session/planning-mode');assert.equal(mode.guardReady,true);assert.equal(mode.planningMode,true)
 const composerPoint=()=>{const e=[...document.querySelectorAll('[contenteditable="true"]')].find(e=>e.checkVisibility());if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x+30,y:r.y+20}}
 await page.waitForFunction(composerPoint);const cp=await page.evaluate(composerPoint);await page.clickAt(cp.x,cp.y)
 await page.send('Input.insertText',{text:'做一个装载机项目，六个模块，先计划，等我修改分组再批准'})
 await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
 await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
 await page.waitForFunction(()=>document.body.textContent.includes('采纳候选并编辑'),{timeout:30000})
 await parent.whenIdle()
 await page.waitForFunction(()=>document.querySelectorAll('[data-loom-plan-task]').length===6&&document.querySelectorAll('.loom-node').length===6,{timeout:30000})
 const retryCall=parent.session.snapshotEvents().find(e=>e.type==='tool/call'&&e.data.callId==='retry-plan');assert.ok(retryCall,'real Agent fixes cached candidate');assert.ok(JSON.stringify(retryCall.data.arguments).length<200,'repair does not regenerate full candidate')
 assert.equal(existsSync(join(cwd,'must-not-exist.txt')),false);assert.equal(trees.listLive().length,0);assert.equal(store.latestRuns(10,ws).length,0)
 assert.ok(parent.session.snapshotEvents().some(e=>e.type==='plan/mode'&&e.data.active===true),'actual native plan transition is logged')
 assert.ok(parent.session.snapshotEvents().some(e=>e.type==='tool/result'&&JSON.stringify(e.data).includes('LOOM_WAITING_APPROVAL')),'actual main Agent write tool denied')
 assert.equal(await page.evaluate(()=>document.querySelectorAll('[data-loom-plan-task]').length),6)
 assert.equal(await page.evaluate(()=>document.querySelectorAll('.loom-node').length),6,'candidate graph appears before adoption')
 await page.screenshot(join(sourceRoot,'.browser-evidence/planning-candidate-desktop.png'))
 const replyPoint=await page.evaluate(()=>{const e=[...document.querySelectorAll('button')].filter(b=>b.textContent==='在此回复下打开 Loom 画布').at(-1);e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});await page.clickAt(replyPoint.x,replyPoint.y)
 await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-plan-history]')))
 assert.equal(await page.evaluate(()=>document.querySelectorAll('[data-loom-plan-history] svg rect').length),6,'reply pins its submitted version')
 await click('编辑当前项目计划')
 // Navigation may reflow the pane between pointer events; retry only this reversible
 // navigation, after observing that the real editor has not opened. Never retry adoption/run.
 try{await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-readable-plan]')),{timeoutMs:3000})}
 catch{console.log('Historical-plan navigation did not open the editor on the first pointer attempt; retrying real navigation once');await click('编辑当前项目计划')}
 await click('采纳候选并编辑')
 await page.waitForFunction(()=>document.querySelector('[data-loom-root]')?.getAttribute('aria-busy')==='false')
 assert.equal(await page.evaluate(()=>document.querySelector('.loom-inspector').checkVisibility()),false)
 // Six modules, arbitrary pairs, three leads: use real pointer controls in the complete host frontend.
 const pickNode=async(id,add=false)=>{
  const locate=()=>page.evaluate(id=>{const e=document.querySelector('.loom-node[data-node-id="'+id+'"]');e.scrollIntoView({block:'nearest',behavior:'instant'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+Math.min(8,r.height/10);return document.elementFromPoint(x,y)?.closest('.loom-node')===e?{x,y}:null},{args:[id]})
  let point=await locate()
  if(!point){await click('更多 ▾');await click('适配视图');point=await locate()}
  assert.ok(point,'real node pointer target is visible '+id)
  await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1,modifiers:add?8:0});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,modifiers:add?8:0})
  await page.waitForFunction(id=>document.querySelector('.loom-node[data-node-id="'+id+'"]')?.getAttribute('aria-selected')==='true',{args:[id]})
 }
 const firstStep=store.readFlowPlan(ws,planningReply.workflow.workflowId)?.order?.[0]||'step-1'
 const initialStepCount=await page.evaluate(()=>document.querySelectorAll('[aria-label^="勾选步骤 "]').length)
 await pickNode('task-1');await click('拆分所选步骤')
 await page.waitForFunction(()=>document.querySelectorAll('[aria-label^="勾选步骤 "]').length===6)
 await click('横排')
 await pickNode('task-4');await pickNode('task-5',true);await click('合并所选步骤')
 await page.waitForFunction(()=>document.querySelectorAll('[aria-label^="勾选步骤 "]').length===5)
 await click('撤销编排')
 await page.waitForFunction(()=>document.querySelectorAll('[aria-label^="勾选步骤 "]').length===6)
 await click('撤销编排')
 await page.waitForFunction(count=>document.querySelectorAll('[aria-label^="勾选步骤 "]').length===count,{args:[initialStepCount]})
 for(let group=0;group<3;group++){
  await pickNode('task-'+(group*2+1));await pickNode('task-'+(group*2+2),true);await click('编为一组')
 }
 assert.equal(await page.evaluate(()=>document.querySelectorAll('.loom-team-settings').length),3)
 const disabled=await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='批准当前版本并开工').disabled);assert.equal(disabled,true,'unsaved team edits cannot run')
 assert.ok(await page.evaluate(()=>document.querySelector('[data-loom-approval-blocks]')?.textContent.includes('保存流程')),'disabled approval explains how to save edits')
 await click('保存编排')
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='保存流程')?.disabled===true)
 const flow=store.readFlowPlan(ws,planningReply.workflow.workflowId);assert.equal(flow.organization.teams.length,3)
 assert.equal(await page.evaluate(()=>document.querySelectorAll('[data-loom-task-team]').length),6,'actual graph shows responsibility groups')
 await page.send('Emulation.setDeviceMetricsOverride',{width:760,height:850,deviceScaleFactor:1,mobile:false})
 await page.screenshot(join(sourceRoot,'.browser-evidence/planning-teams-narrow.png'))
 await page.send('Emulation.setDeviceMetricsOverride',{width:1500,height:900,deviceScaleFactor:1,mobile:false})
 await page.screenshot(join(sourceRoot,'.browser-evidence/planning-teams-desktop.png'))
 // Intelligent preflight is a second real chat turn, not a graph replacement or approval.
 assert.equal(await page.evaluate(()=>document.querySelector('[data-loom-approval] .loom-primary').disabled),true)
 const retainedBefore=structuredClone(store.latestRevision(planningReply.workflow.workflowId,ws))
 await click('让 AI 处理这些问题')
 await page.waitForFunction(()=>document.querySelector('[data-loom-resolution-report]')?.textContent.includes('只处理当前项目'),{timeout:30000})
 assert.equal(await page.evaluate(()=>Boolean(document.querySelector('[data-loom-question-help]'))),false,'candidate review does not show obsolete requests to process the previous plan')
 await parent.whenIdle()
 assert.equal(store.latestRevision(planningReply.workflow.workflowId,ws).revision,retainedBefore.revision)
 assert.equal(trees.listLive().length,0);assert.equal(store.latestRuns(10,ws).length,0)
 const resolvingCall=parent.session.snapshotEvents().find(e=>e.type==='tool/call'&&e.data.callId==='resolve-questions');assert.ok(resolvingCall)
 const repairCall=parent.session.snapshotEvents().find(e=>e.type==='tool/call'&&e.data.callId==='repair-questions');assert.ok(repairCall)
 assert.ok(JSON.stringify(repairCall.data.arguments).length<220,'repair resends only the failed field')
 await page.screenshot(join(sourceRoot,'.browser-evidence/planning-ai-resolution-candidate.png'))
 await click('采纳候选并编辑');await click('详细设置')
 await page.waitForFunction(()=>document.querySelectorAll('.loom-team-settings').length===3&&!document.querySelector('[data-loom-approval] .loom-primary')?.disabled)
 const resolvedWorkflow=store.latestRevision(planningReply.workflow.workflowId,ws)
 assert.equal(resolvedWorkflow.openQuestions.length,0)
 assert.deepEqual(store.readFlowPlan(ws,planningReply.workflow.workflowId),flow,'full groups and organization preserved byte-semantically')
 assert.deepEqual(resolvedWorkflow.edges,retainedBefore.edges)
 for(const before of retainedBefore.nodes){const after=resolvedWorkflow.nodes.find(n=>n.id===before.id);assert.deepEqual({...after,acceptance:before.acceptance},before)}
 assert.equal(store.latestRuns(10,ws).length,0,'adopting AI answers still grants no execution')
 assert.ok(await page.evaluate(()=>document.querySelector('[data-loom-execution-target]')?.textContent.includes('/project')),'selected actual execution directory is shown before approval')
 // An earlier reply has no historical candidate: open the actual current-project inline editor.
 const inlinePoint=await page.evaluate(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.textContent==='在此回复下打开 Loom 画布');e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});await page.clickAt(inlinePoint.x,inlinePoint.y)
 await page.waitForFunction(()=>document.querySelector('[data-loom-inline-body] [data-loom-root][data-loom-focus="true"] [data-loom-approval] .loom-primary')?.checkVisibility())
 await page.waitForFunction(()=>document.querySelector('[data-loom-inline-body] [data-loom-approval] .loom-primary')?.disabled===false).catch(async error=>{console.log(JSON.stringify({inlineApprovalReasons:await page.evaluate(()=>document.querySelector('[data-loom-inline-body] [data-loom-approval]')?.textContent)}));throw error})
 assert.equal(await page.evaluate(()=>document.querySelector('[data-loom-inline-body] [data-loom-approval] .loom-primary').disabled),false,'saved plan approval stays available in actual inline focus')
 await page.screenshot(join(sourceRoot,'.browser-evidence/planning-approval-inline-focus.png'))
 await click('全屏画布')
 await page.waitForFunction(()=>document.querySelector('[data-loom-window] [data-loom-approval] .loom-primary')?.checkVisibility())
 await page.screenshot(join(sourceRoot,'.browser-evidence/planning-approval-fullscreen-focus.png'))
 assert.equal(store.latestRuns(10,ws).length,0,'focus/fullscreen navigation grants no approval')
 await click('返回会话');await click('打开 Loom 工作台')
 await click('流程')
 await page.waitForFunction(()=>document.querySelectorAll('.loom-team-settings').length===3&&![...document.querySelectorAll('button')].find(b=>b.textContent==='批准当前版本并开工')?.disabled)
 // Turning the composer mode off must preserve pending approval and an escape action.
 await click('规划模式')
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='规划模式'&&b.getAttribute('aria-pressed')==='false'))
 await click('刷新')
 await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-planning-banner]'))&&[...document.querySelectorAll('button')].some(b=>b.textContent==='放弃本次规划'&&!b.disabled))
 assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='放弃本次规划'&&!b.disabled)),true)
 assert.equal(store.latestRuns(10,ws).length,0,'mode off never grants approval')
 await click('批准当前版本并开工')
 await page.waitForFunction(()=>document.querySelector('[data-loom-active-run] .loom-primary')?.disabled&&document.querySelector('[data-loom-active-run]')?.textContent.includes('模块 1 · 实现中'))
 assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='批准恢复运行')),false,'active run offers no recovery action')
 const active=store.latestRuns(10,ws)[0]
 assert.equal(active.state,'running');assert.equal(active.sessionId,sessionId)
 const command=parent.session.snapshotEvents().filter(e=>e.type==='command/run'&&e.data.name==='loom'&&e.data.args?.includes('approve-run')).at(-1)
 assert.ok(command,'native human approval command recorded')
 const repeat=await ctx.commands.execute(parent,'/loom '+command.data.args,[],new AbortController().signal)
 assert.equal(repeat.result.kind,'success');assert.match(repeat.result.text,/正在执行/)
 assert.equal(store.latestRuns(10,ws).length,1,'repeat approval does not queue another run')
 const approvedHash=command.data.args.trim().split(/\s+/).at(-1)
 const resume=await ctx.commands.execute(parent,`/loom approve-resume ${active.runId} ${approvedHash}`,[],new AbortController().signal)
 assert.equal(resume.result.kind,'success');assert.match(resume.result.text,/正在执行/)
 await page.screenshot(join(sourceRoot,'.browser-evidence/planning-active-progress.png'))
 releaseFirstChild()
 for(let i=0;i<300;i++){run=store.latestRuns(10,ws)[0];if(run&&['validated','failed','cancelled'].includes(run.state))break;await new Promise(r=>setTimeout(r,100))}
 assert.equal(run?.state,'validated',JSON.stringify(run))
 assert.equal(run.receipt.artifacts.length,8,'all files under one output port are retained')
 const finalTree=run.receipt.worktrees.find(t=>t.taskId==='task-3').path
 assert.equal(JSON.parse(await readFile(join(finalTree,'package.json'),'utf8')).scripts.check,'node scripts/check.cjs')
 assert.equal(await readFile(join(finalTree,'task-2.txt'),'utf8'),'task-2','transitive input reaches final worktree')
 assert.ok(run.receipt.checks.some(c=>c.argv.join(' ')==='node scripts/check.cjs'&&c.exitCode===0),'real downstream script executes in assigned tree')
 assert.equal(run.receipt.audits.length,3);assert.equal(run.receipt.execution.supervisionReports.length,3)
 assert.equal(run.receipt.execution.communications.length,1)
 assert.equal(children.size,21,'six implementation, six independent task review, three supervisors, three group audit, three peer coordination')
 assert.ok(run.receipt.worktrees.every(tree=>tree.repoPath===repo),'production children use selected repository, not non-Git planning folder')
 assert.ok(run.receipt.worktrees.every(tree=>!existsSync(join(tree.path,'denied-review.txt'))),'production read-only child cannot write')
 console.log(JSON.stringify({humanCommands:parent.session.snapshotEvents().filter(e=>e.type==='command/run').map(e=>e.data)}))
 assert.ok(parent.session.snapshotEvents().some(e=>e.type==='command/run'&&e.data.name==='loom'&&JSON.stringify(e.data).includes('approve-run')),'actual human command owns approval')
 await page.screenshot(join(sourceRoot,'.browser-evidence/planning-approved-run.png'))
 assert.deepEqual(page.pageErrors,[])
 frontendEvidence={structuredDeliveryCaptured:true,multipleArtifactsRetained:true,transitiveInputsAndRealBuild:true,activeProgressVisible:true,duplicateApprovalIdempotent:true,runningResumeDoesNotRestart:true,rawComposerMouseAndKeyboard:true,candidateTextAndGraph:true,historicalReplySnapshot:true,splitMergeUndoByRealMouse:true,threeTeamsByRealMouse:true,graphTeamBadges:true,unsavedChangesBlock:true,modeOffStillPending:true,cachedRejectedRepair:true,aiResolutionSecondRealTurn:true,compactAnswerTool:true,resolutionPreservesTasksAndGroups:true,resolutionAdoptionDoesNotApprove:true,inlineFocusApprovalVisible:true,fullscreenFocusApprovalVisible:true,approvalSaveReason:true,desktop:true,narrow:true,approvalButton:true,pageErrors:page.pageErrors}
}finally{if(browser)await browser.close()}
await writeFile(join(evidence,'planning-host.json'),JSON.stringify({passed:true,packageVersion,runtimeFingerprint,generatedAt:new Date().toISOString(),scope:'Unmodified official full WSL Web Host/frontend; production root/child Agents and tools; offline adapter; actual mouse/keyboard, real Git/worktrees. No paid model, production profile changes or Electron claim.',frontendEvidence,run,modelCalls,children:[...children]},null,2)+'\n')
}catch(error){await writeFile(join(evidence,'planning-host.json'),JSON.stringify({passed:false,status:'failed',packageVersion,runtimeFingerprint,generatedAt:new Date().toISOString(),error:String(error)},null,2)+'\n');console.error(error);process.exitCode=1}finally{releaseFirstChild?.();if(ctx)await ctx.fiber.dispose();process.chdir(previousCwd);process.argv[1]=previousEntry;for(const key of envKeys){if(previousEnv[key]===undefined)delete process.env[key];else process.env[key]=previousEnv[key]}await rm(home,{recursive:true,force:true})}
