/** Explicit complete-host acceptance. Run in WSL: node --expose-internals scripts/verify-live-host.mjs. Uses existing installed official modules and Chromium, an isolated temporary profile, and an OFFLINE controlled model adapter. No real credentials, model charges, Electron claims or user-profile mutations. */
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdirSync, appendFileSync, existsSync } from 'node:fs'
import { format } from 'node:util'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { LoomStore } from '../lib/store.js'
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
const evidence=join(sourceRoot,'.verification');mkdirSync(evidence,{recursive:true});mkdirSync(join(sourceRoot,'.browser-evidence'),{recursive:true})
const logPath=join(evidence,'live-host-session-agent.log');await writeFile(logPath,'')
await writeFile(join(evidence,'live-host-session-agent.json'),JSON.stringify({passed:false,status:'running',packageVersion,startedAt:new Date().toISOString()},null,2)+'\n')
for(const level of ['log','warn','error']){const original=console[level].bind(console);console[level]=(...args)=>{appendFileSync(logPath,format(...args)+'\n');original(...args)}}
const home = await mkdtemp('/tmp/loom-complete-host-'), cwd = join(home,'project')
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
const modelCalls=[],children=new Map();let planningReply
class ControlledAdapter extends host('@deepseek-ai/dsh-llm').LlmAdapter {
 async listModels(){return[{id:'controlled',name:'Controlled offline acceptance'}]}
 async resolveModel(provider,id){return{provider,id,name:id}}
 async *stream(options){
  const session=String(options.sessionId);modelCalls.push({session,tools:(options.tools??[]).map(t=>t.name)})
  let value,reason='stop',blockType='text',block
  if(session==='loom-live-parent'){value=JSON.stringify(planningReply)}
  else {
   let owned=children.get(session)
   if(!owned){
    const texts=[];const collect=v=>{if(typeof v==='string')texts.push(v);else if(Array.isArray(v))v.forEach(collect);else if(v&&typeof v==='object')Object.values(v).forEach(collect)};collect(options.messages)
    const serialized=texts.join('\n'),match=serialized.match(/LOOM_EXECUTION_CONTRACT (\{[^\n]+\})/);if(!match)throw Error('missing execution contract');const contract=JSON.parse(match[1])
    const id=serialized.includes('frontend-developer')?'frontend':'backend'
    owned={id,called:false,...contract};children.set(session,owned)
   }
   if(owned.phase==='review'&&!owned.called){owned.called=true;reason='tool-calls';blockType='tool-call';block={type:'tool-call',id:'deny-'+owned.id,name:'write',arguments:JSON.stringify({file_path:'denied-review.txt',content:'must never be written'})}}
   else if(owned.phase==='review'){assert.match(JSON.stringify(options.messages),/LOOM_REVIEW_READ_ONLY|not available|denied|not allowed|not found/i);value=JSON.stringify({verdict:'pass',attemptId:owned.attemptId,snapshotHash:owned.snapshotHash,findings:[],artifactRefs:[]})}
   else if(!owned.called){owned.called=true;reason='tool-calls';blockType='tool-call';block={type:'tool-call',id:'owned-'+owned.id,name:'write',arguments:JSON.stringify({file_path:owned.id+'.txt',content:owned.id})}}
   else{value=JSON.stringify({verdict:'ready',attemptId:owned.attemptId,artifactRefs:[{nodeId:owned.id,port:'changes',ref:owned.id+'.txt',contentHash:createHash('sha256').update(owned.id).digest('hex')}]})}
  }
  yield{type:'block-start',index:0,blockType}
  if(block){yield{type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};yield{type:'block-end',index:0,block}}
  else{yield{type:'text-delta',index:0,text:value};yield{type:'block-end',index:0,block:{type:'text',text:value}}}
  yield{type:'usage',usage:{inputTokens:10,outputTokens:20}}
  yield{type:'finish',reason:{kind:reason}}
 }
}
ctx.llm.registerAdapter(['loom-controlled'],new ControlledAdapter())
for(const args of [['init','-q','-b','main'],['config','user.email','acceptance@loom.local'],['config','user.name','Loom acceptance']])execFileSync('git',args,{cwd})
await writeFile(join(cwd,'baseline.txt'),'baseline');execFileSync('git',['add','.'],{cwd});execFileSync('git',['commit','-qm','baseline'],{cwd})
const baseSha=execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim()
const workspace=await ctx.workspaceRegistry.create(cwd,'Loom acceptance workspace')
const sessionId=(await ctx.sessionController.create({workspaceId:workspace.id,sessionId:'loom-live-parent'})).sessionId
const ws=normalizeWorkspaceId(cwd),store=new LoomStore(home)
const invoke=async(method,path,body)=>{const result=await ctx.typertGateway.invoke({namespace:'loom',method:'request',args:{input:{sessionId,method,path,...body?{body}:{}}}});assert.equal(result.payload.ok,true,JSON.stringify(result));return result.payload.data}
const exported=await invoke('POST','/planning/export',{goal:'实现前端和后端两个隔离模块',constraints:['WSL'],expectedArchitectureRevision:null,expectedWorkflowRevision:null})
const request=exported.request
const wf=samplePlannerOutput();wf.nodes=wf.nodes.slice(2,4);wf.edges=[];wf.workflowId=request.workflowId;wf.executionProposal.requiredBaseline='selected-frozen-commit';wf.executionProposal.requiredCapabilities=['real-parent-agent','parallel-agents','worktree','cancel-cleanup','artifact-verification','wsl-execution']
wf.nodes.forEach(n=>{n.inputs=[];n.ownership.writes=[n.id+'.txt'];n.ownership.forbiddenWrites=[];n.acceptance.commands=[{argv:['node','-e',`if(require('fs').readFileSync('${n.id}.txt','utf8')!=='${n.id}')process.exit(1)`],cwdRef:'node-worktree',expectedExitCode:0}];n.execution.timeoutSeconds=30})
planningReply={requestId:request.payloadHash,architecture:{schemaVersion:1,architectureId:request.architectureId,revision:1,createdAt:new Date().toISOString(),nodes:[{id:'front',kind:'module',title:'前端',responsibility:'前端实现'},{id:'back',kind:'module',title:'后端',responsibility:'后端实现'}],edges:[],constraints:request.constraints},workflow:wf,mappings:[{workflowNodeId:'frontend',architectureNodeIds:['front'],decisionIds:[]},{workflowNodeId:'backend',architectureNodeIds:['back'],decisionIds:[]}],explanation:'隔离并行模块'}
await ctx.sessionController.prompt({sessionId,requestId:'loom-owned-planning',mode:'queue',content:[{type:'text',text:exported.text??exported.prompt??JSON.stringify(request)}]},new AbortController().signal)
const resolved=await ctx.sessionController.resolveAgent(sessionId),parent=resolved.agent
assert.ok(parent&&parent.ctx&&parent.session&&parent.followup,'production SessionController created a real parent Agent')
await parent.whenIdle()
await ctx.sessionController.rename({sessionId,title:'Loom acceptance session'},new AbortController().signal)
const events=parent.session.snapshotEvents()
console.log(JSON.stringify({parentType:parent.constructor.name,eventTypes:events.map(e=>e.type)}))
const preview=await invoke('POST','/planning/preview',{payloadHash:request.payloadHash,reply:planningReply})
await invoke('POST','/planning/accept',{payloadHash:request.payloadHash,reply:planningReply,candidateHash:preview.candidateHash,expectedArchitectureRevision:null,expectedWorkflowRevision:null})
await ctx.commands.execute(parent,'/loom on',[],new AbortController().signal)
const admitted=await ctx.commands.execute(parent,`/loom run ${wf.workflowId} 1 ${baseSha}`,[],new AbortController().signal)
console.log(JSON.stringify({admitted}))
let run
for(let i=0;i<250;i++){run=store.latestRuns(10,ws)[0];if(run&&['validated','failed','cancelled'].includes(run.state))break;await new Promise(r=>setTimeout(r,100))}
assert.equal(run?.state,'validated',JSON.stringify(run))
assert.equal(children.size,4)
assert.equal([...children.values()].filter(c=>c.phase==='review').length,2)
assert.ok(run.receipt.execution.tasks.every(t=>t.review?.verdict==='pass'))
assert.ok(run.receipt.worktrees.every(t=>!existsSync(join(t.path,'denied-review.txt'))),'real review tool call cannot mutate a worktree')
console.log(JSON.stringify({runtimePassed:true,runId:run.runId,state:run.state,adapterRequests:modelCalls.length}))
// Add deterministic carrier latency to the real service, retaining its exact
// authenticated handler. A cached pane must not race a late entry activation.
const nativeLoomRequest=ctx.loomRemote.request.bind(ctx.loomRemote)
ctx.loomRemote.request=async(input,signal)=>{
 if(input.path==='/session/activation')await new Promise(resolve=>setTimeout(resolve,500))
 return nativeLoomRequest(input,signal)
}
let browser
try{
 browser=await launchBrowser();const page=await browser.newPage()
 await page.send('Page.navigate',{url:ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`)})
 await page.waitForFunction(()=>(document.body?.textContent?.length??0)>300,{timeout:30000})
 await new Promise(r=>setTimeout(r,1500))
 const controlPoint=text=>{const b=[...document.querySelectorAll('button')].find(b=>{
   if(b.disabled||!(b.textContent===text||b.getAttribute('aria-label')===text))return false
   const r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)
   return r.width>0&&r.height>0&&(hit===b||b.contains(hit))
 });if(!b)return null;const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}}
 const click=async text=>{
   await page.waitForFunction(controlPoint,{args:[text]})
   for(let attempt=0;attempt<3;attempt++){
     const point=await page.evaluate(controlPoint,{args:[text]})
     if(!point){await page.waitForFunction(controlPoint,{args:[text]});continue}
     await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,button:'none',buttons:0})
     await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
     const settled=await page.evaluate(controlPoint,{args:[text]})
     if(settled&&Math.abs(settled.x-point.x)<1&&Math.abs(settled.y-point.y)<1){await page.clickAt(settled.x,settled.y);return}
     await page.waitForFunction(controlPoint,{args:[text]})
   }
   throw Error('Control moved during hover: '+text)
 }
 if(await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Continue')))await click('Continue')
 console.log(JSON.stringify({browserBody:await page.evaluate(()=>document.body.textContent.slice(0,2500)),pageErrors:page.pageErrors}))
 console.log(JSON.stringify({buttons:await page.evaluate(()=>[...document.querySelectorAll('button')].map(b=>({text:b.textContent,title:b.title,aria:b.getAttribute('aria-label')})))}))
 // The initial complete official frontend is a New Session (title utilities
 // are hidden). Exercise its resident Loom entry without sending any prompt.
 // Exercise the installed official CSS contract for Windows caption clearance.
 // This is browser geometry/hit testing, not an Electron/native-caption test.

 for(const [width,height,caption] of [[1400,800,40],[760,720,56]]){
   await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
   await page.evaluate(caption=>{
     document.documentElement.setAttribute('data-windows-titlebar','')
     document.documentElement.style.setProperty('--dsh-windows-titlebar-height',caption+'px')
   },{args:[caption]})
   await page.waitForFunction(caption=>{
     const b=document.querySelector('[data-loom-new-session-entry] button')
     return b&&b.getBoundingClientRect().top>=caption
   },{args:[caption]})
   const entry=await page.evaluate(()=>{
     const b=document.querySelector('[data-loom-new-session-entry] button'),r=b.getBoundingClientRect()
     const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)
     return {top:r.top,right:r.right,width:r.width,viewport:innerWidth,hittable:hit===b||b.contains(hit),chrome:getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-chrome-top').trim()}
   })
   assert.equal(entry.chrome,caption+'px','installed Host publishes the caption safe area')
   assert.equal(entry.top,caption+14);assert.ok(entry.right<=width);assert.ok(entry.hittable)
   await page.screenshot(join(sourceRoot,`.browser-evidence/windows-caption-entry-${width}.png`))
   windowsCaption.push({width,height,caption,entry})
 }
 await page.send('Emulation.setDeviceMetricsOverride',{width:1400,height:800,deviceScaleFactor:1,mobile:false})
 await page.evaluate(()=>document.documentElement.style.setProperty('--dsh-windows-titlebar-height','40px'))
 await page.screenshot(join(sourceRoot,'.browser-evidence/complete-host-new-session-entry.png'))
 const preparationCallCount=modelCalls.length
 await click('打开 Loom 预工作台')
 await page.waitForFunction(()=>Boolean(document.querySelector('[aria-label="项目目标"]')))
 assert.equal(await page.evaluate(()=>document.querySelector('[aria-label="项目目标"]').checkVisibility()),true,'New Session keeps goal entry expanded even when the project already has a graph')
 const goalPoint=await page.evaluate(()=>{const r=document.querySelector('[aria-label="项目目标"]').getBoundingClientRect();return{x:r.x+30,y:r.y+20}})
 await page.clickAt(goalPoint.x,goalPoint.y)
 await page.send('Input.insertText',{text:'新会话先整理需求'})
 await click('全屏工作台')
 await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-fullscreen="true"]')))
 captionGeometry=await page.evaluate(()=>{
   const r=document.querySelector('[data-loom-window]').getBoundingClientRect()
   const b=[...document.querySelectorAll('[data-loom-window] button')].find(b=>b.textContent==='返回会话'),br=b.getBoundingClientRect()
   const hit=document.elementFromPoint(br.x+br.width/2,br.y+br.height/2)
   return {top:r.top,height:r.height,viewport:innerHeight,returnTop:br.top,hittable:hit===b||b.contains(hit)}
 })
 assert.equal(captionGeometry.top,40);assert.equal(captionGeometry.height,captionGeometry.viewport-40)
 assert.ok(captionGeometry.returnTop>=40&&captionGeometry.hittable)
 await page.screenshot(join(sourceRoot,'.browser-evidence/windows-caption-workbench.png'))
 // Host fullscreen events remove the native caption; CSS must update directly.
 await page.evaluate(()=>document.documentElement.setAttribute('data-fullscreen',''))
 await page.waitForFunction(()=>document.querySelector('[data-loom-window]').getBoundingClientRect().top===0)
 assert.equal(await page.evaluate(()=>document.querySelector('[data-loom-window]').getBoundingClientRect().height),800)
 await page.evaluate(()=>document.documentElement.removeAttribute('data-fullscreen'))
 await page.waitForFunction(()=>document.querySelector('[data-loom-window]').getBoundingClientRect().top===40)
 await page.evaluate(()=>{
   document.documentElement.removeAttribute('data-windows-titlebar')
   document.documentElement.style.removeProperty('--dsh-windows-titlebar-height')
 })
 await page.waitForFunction(()=>document.querySelector('[data-loom-window]').getBoundingClientRect().top===0)
 await page.screenshot(join(sourceRoot,'.browser-evidence/complete-host-new-session.png'))
 await click('返回会话')
 await click('打开 Loom 预工作台')
 await page.waitForFunction(()=>document.querySelector('[aria-label="项目目标"]')?.value==='新会话先整理需求')
 assert.equal(modelCalls.length,preparationCallCount,'opening New Session preparation never invokes a model')
 await click('全屏工作台')
 await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-window]')))
 await click('返回会话')
 await click('Collapse right sidebar')
 await page.waitForFunction(()=>!document.querySelector('.loom-viewport'))
 await click('Settings')
 await new Promise(r=>setTimeout(r,500))
 console.log(JSON.stringify({settingsBody:await page.evaluate(()=>document.body.textContent.slice(-5000)),pageErrors:page.pageErrors}))
 await click('可视化开发（Loom）')
 await page.waitForFunction(()=>document.body.textContent.includes('启用 Loom（总开关）'))
 assert.equal(await page.evaluate(()=>Boolean(document.querySelector('[data-loom-surface="settings"]'))),true)
 assert.equal(await page.evaluate(()=>Boolean(document.querySelector('.loom-viewport'))),false,'official Settings has no canvas')
 await page.evaluate(()=>[...document.querySelectorAll('label')].find(l=>l.textContent.includes('启用 Loom（总开关）')).querySelector('input').click())
 await page.waitForFunction(()=>{const input=[...document.querySelectorAll('label')].find(l=>l.textContent.includes('启用 Loom（总开关）')).querySelector('input');return !input.checked&&!input.disabled})
 assert.equal(store.readConfig().enabled,false)
 await page.evaluate(()=>[...document.querySelectorAll('label')].find(l=>l.textContent.includes('启用 Loom（总开关）')).querySelector('input').click())
 await page.waitForFunction(()=>{const input=[...document.querySelectorAll('label')].find(l=>l.textContent.includes('启用 Loom（总开关）')).querySelector('input');return input.checked&&!input.disabled})
 assert.equal(store.readConfig().enabled,true)
 await page.screenshot(join(sourceRoot,'.browser-evidence/complete-host-settings.png'))
 console.log(JSON.stringify({closeControls:await page.evaluate(()=>[...document.querySelectorAll('button')].filter(b=>b.textContent==='Close'||b.getAttribute('aria-label')==='Close').map(b=>({text:b.textContent,aria:b.getAttribute('aria-label'),rect:b.getBoundingClientRect().toJSON(),parent:b.parentElement?.outerHTML.slice(0,500)})))}))
 await click('Close')
 await page.waitForFunction(()=>![...document.querySelectorAll('[data-loom-surface="settings"]')].some(e=>e.checkVisibility()))
 const sessionTarget=await page.evaluate(()=>{const e=[...document.querySelectorAll('*')].find(e=>e.childElementCount===0&&e.textContent==='Loom acceptance session');if(!e)throw Error('session row unavailable');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})
 await page.clickAt(sessionTarget.x,sessionTarget.y)
 try {await page.waitForFunction(()=>Boolean(document.querySelector('[aria-label="打开 Loom 工作台"]:not(:disabled), [aria-label="在本会话启用 Loom"]:not(:disabled)')))} catch(error) {
   console.log(JSON.stringify({sessionEntryDiagnostic:await page.evaluate(()=>({body:document.body.textContent.slice(-5000),buttons:[...document.querySelectorAll('button')].map(b=>({text:b.textContent,aria:b.getAttribute('aria-label'),disabled:b.disabled}))})),pageErrors:page.pageErrors}));throw error
 }
 const loomTarget=await page.evaluate(()=>{const e=document.querySelector('[aria-label="打开 Loom 工作台"], [aria-label="在本会话启用 Loom"]');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})
 await page.clickAt(loomTarget.x,loomTarget.y)
 await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-native-pane] [data-loom-root][aria-busy="false"]')))
 await page.waitForFunction(()=>Boolean(document.querySelector('[aria-label="项目目标"]')))
 const plannerPoint=await page.evaluate(()=>{const d=document.querySelector('.loom-planner');if(d.open)return null;const r=d.querySelector('summary').getBoundingClientRect();return{x:r.x+30,y:r.y+r.height/2}})
 if(plannerPoint)await page.clickAt(plannerPoint.x,plannerPoint.y)
 await page.waitForFunction(()=>document.querySelector('[aria-label="项目目标"]').checkVisibility())
 const inputPoint=()=>{for(const e of document.querySelectorAll('[data-loom-native-pane] [aria-label="项目目标"]')){const r=e.getBoundingClientRect(),x=r.x+30,y=r.y+20;if(r.width>0&&r.height>0&&document.elementFromPoint(x,y)===e)return{x,y}}return null}
 await page.waitForFunction(inputPoint)
 const existingGoalPoint=await page.evaluate(inputPoint)
 await page.clickAt(existingGoalPoint.x,existingGoalPoint.y)
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'项目目标','real pointer reaches the current goal field')
 await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2})
 await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2})
 await page.send('Input.insertText',{text:'原生面板切换保留的需求'})
 await page.waitForFunction(()=>[...document.querySelectorAll('[data-loom-native-pane] [aria-label="项目目标"]')].some(e=>e.value==='原生面板切换保留的需求'))
 assert.equal(await page.evaluate(()=>Boolean(document.querySelector('[data-loom-window]'))),false,'native pane appears beside chat')
 await page.screenshot(join(sourceRoot,'.browser-evidence/complete-host-native-pane.png'))
 await click('全屏工作台')
 await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-window] [aria-label="项目目标"]')))
 assert.equal(await page.evaluate(()=>document.querySelector('[data-loom-window] [aria-label="项目目标"]').value),'原生面板切换保留的需求')
 await click('专注画布')
 try {await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-fullscreen="true"] [data-loom-focus="true"]')))} catch(error){console.log(JSON.stringify({focusDiagnostic:await page.evaluate(()=>({windows:[...document.querySelectorAll('[data-loom-window]')].map(e=>e.outerHTML.slice(0,400)),roots:[...document.querySelectorAll('[data-loom-root]')].map(e=>({surface:e.dataset.loomSurface,focus:e.dataset.loomFocus})),buttons:[...document.querySelectorAll('button')].map(e=>e.textContent).filter(t=>/画布|面板|窗口|全屏/.test(t))}))}));throw error}
 const geometry=await page.evaluate(()=>{const w=document.querySelector('[role="dialog"]').getBoundingClientRect(),c=document.querySelector('.loom-stage').getBoundingClientRect();return {width:w.width,height:w.height,canvasHeight:c.height,viewportWidth:innerWidth,viewportHeight:innerHeight}})
 assert.equal(geometry.width,geometry.viewportWidth);assert.equal(geometry.height,geometry.viewportHeight)
 assert.ok(geometry.canvasHeight>geometry.viewportHeight*0.4)
 await page.screenshot(join(sourceRoot,'.browser-evidence/complete-host-fullscreen.png'))
 await click('返回会话')
 await page.waitForFunction(()=>!document.querySelector('[data-loom-window]'))
 await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-native-pane]')))
 await click('显示规划面板')
 assert.equal(await page.evaluate(()=>document.querySelector('[aria-label="项目目标"]').value),'原生面板切换保留的需求')
 console.log(JSON.stringify({actualFullHostSessionEntryClicked:true,actualFullHostFullscreenOpenedAndClosed:true,geometry}))
 console.log(JSON.stringify({sessionButtons:await page.evaluate(()=>[...document.querySelectorAll('button')].map(b=>({text:b.textContent,aria:b.getAttribute('aria-label')})))}))
 // Open a real completed-turn extension in the official Chat stream.
 const inlineButton=()=>{
   const b=document.querySelector('[data-loom-inline] button')
   if(!b)return false
   b.scrollIntoView({block:'center'});return !b.disabled
 }
 await page.waitForFunction(inlineButton)
 await click('在此回复下打开 Loom 画布')
 try { await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-inline-open="true"] [data-loom-root][aria-busy="false"]'))) }
 catch(error){console.log(JSON.stringify({inlineDiagnostic:await page.evaluate(()=>({roots:[...document.querySelectorAll('[data-loom-root]')].map(e=>({busy:e.getAttribute('aria-busy'),rect:e.getBoundingClientRect().toJSON(),text:e.textContent.slice(0,3000)})),inline:[...document.querySelectorAll('[data-loom-inline]')].map(e=>e.outerHTML.slice(0,2000)),body:document.body.textContent.slice(-4000)}))}));throw error}
 assert.equal(await page.evaluate(()=>document.querySelectorAll('.loom-viewport').length),1,'inline and sidebar share one active editor')
 const inlineState=()=>{
   const e=document.querySelector('[data-loom-inline-open="true"]'),c=e.querySelector('.loom-stage'),r=c.getBoundingClientRect()
   const tail=e.closest('[data-turn-tail]')
   return {width:r.width,height:r.height,editorWidth:e.getBoundingClientRect().width,inTurnTail:Boolean(tail),turn:tail?.dataset.turnTail,nodes:e.querySelectorAll('.loom-node').length,viewportWidth:innerWidth}
 }
 const normalInline=await page.evaluate(inlineState)
 assert.ok(normalInline.inTurnTail&&normalInline.nodes>0,'actual reply contains the live graph')
 assert.ok(normalInline.width>normalInline.editorWidth*.9,'canvas spans the reply width')
 console.log(JSON.stringify({inlineGeometry:normalInline,layout:await page.evaluate(()=>{const e=document.querySelector('[data-loom-inline-open="true"]');return [...e.querySelectorAll('[data-loom-inline-body],[data-loom-root],.loom-viewbar,.loom-editbar,.loom-main,.loom-stage')].map(n=>({tag:n.className||n.tagName,rect:n.getBoundingClientRect().toJSON(),display:getComputedStyle(n).display,focus:n.getAttribute('data-loom-focus')}))})}))
 assert.ok(normalInline.height>300)
 await page.evaluate(()=>document.querySelector('[data-loom-inline-open="true"] .loom-stage').scrollIntoView({block:'center'}))
 const dragStart=await page.evaluate(()=>{const r=document.querySelector('[data-loom-inline-open="true"] .loom-node-head').getBoundingClientRect();return{x:r.x+40,y:r.y+10}})
 await page.dragMouse(dragStart.x,dragStart.y,dragStart.x+55,dragStart.y+35)
 const dragEnd=await page.evaluate(()=>{const r=document.querySelector('[data-loom-inline-open="true"] .loom-node-head').getBoundingClientRect();return{x:r.x+40,y:r.y+10}})
 assert.ok(Math.abs(dragEnd.x-dragStart.x-55)<3&&Math.abs(dragEnd.y-dragStart.y-35)<3,'real pointer operates the reply canvas')
 const movedLayout=await page.evaluate(()=>[...document.querySelectorAll('[data-loom-inline-open="true"] .loom-node')].map(n=>({left:n.style.left,top:n.style.top})))
 await page.screenshot(join(sourceRoot,'.browser-evidence/complete-host-inline-canvas.png'))
 await page.evaluate(()=>document.querySelector('[data-loom-inline-open="true"]').scrollIntoView({block:'start'}))
 await click('全屏画布')
 await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-window] [data-loom-root][aria-busy="false"]')))
 assert.equal(await page.evaluate(()=>document.querySelectorAll('.loom-viewport').length),1,'fullscreen moves rather than duplicates the editor')
 await click('返回会话')
 await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-inline-open="true"] [data-loom-root][aria-busy="false"]')))
 assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('[data-loom-inline-open="true"] .loom-node')].map(n=>({left:n.style.left,top:n.style.top}))),movedLayout,'dragged positions survive fullscreen return')
 await page.evaluate(()=>document.querySelector('[data-loom-inline-open="true"]').scrollIntoView({block:'start'}))
 await click('显示规划面板')
 await page.waitForFunction(()=>document.querySelector('[data-loom-inline-open="true"] [aria-label="项目目标"]')?.value==='原生面板切换保留的需求')
 await click('专注画布')
 await page.send('Emulation.setDeviceMetricsOverride',{width:760,height:800,deviceScaleFactor:1,mobile:false})
 await page.evaluate(()=>document.querySelector('[data-loom-inline-open="true"]').scrollIntoView({block:'center'}))
 const narrowInline=await page.evaluate(inlineState)
 assert.ok(narrowInline.width>narrowInline.editorWidth*.9&&narrowInline.height>200)
 await page.screenshot(join(sourceRoot,'.browser-evidence/complete-host-inline-narrow.png'))
 await page.send('Emulation.setDeviceMetricsOverride',{width:1400,height:800,deviceScaleFactor:1,mobile:false})
 await page.evaluate(()=>document.querySelector('[data-loom-inline-open="true"]').scrollIntoView({block:'start'}))
 await page.waitForFunction(()=>!document.querySelector('[data-animating]')&&Boolean(document.querySelector('[data-loom-inline-open="true"] [aria-busy="false"]')))
 // Native Chat tail following can move the row after resize. Use a real
 // reader scroll before addressing a historical reply control.
 for(let attempt=0;attempt<40;attempt++){
   const scrollTarget=await page.evaluate(()=>{
     const b=[...document.querySelectorAll('[data-loom-inline] button')].find(b=>b.textContent==='收起对话画布')
     if(!b)return {hittable:false,x:innerWidth/2,y:innerHeight/2,delta:0}
     const r=b.getBoundingClientRect(),center=r.y+r.height/2
     const hit=document.elementFromPoint(r.x+r.width/2,center)
     if(hit===b||b.contains(hit))return {hittable:true,x:0,y:0,delta:0}
     let el=document.querySelector('[data-chat-flow]').parentElement,scroller=null
     while(el){const s=getComputedStyle(el);if(el.scrollHeight>el.clientHeight+4&&/(auto|scroll|overlay)/.test(s.overflowY)){scroller=el;break}el=el.parentElement}
     const port=(scroller||document.querySelector('[data-chat-flow]').parentElement).getBoundingClientRect()
     const px=Math.min(innerWidth-10,Math.max(10,port.x+port.width/2)),py=Math.min(innerHeight-10,Math.max(10,port.y+port.height/2))
     return {x:px,y:py,delta:Math.max(-600,Math.min(600,center-(port.y+port.height/2))),hittable:false}
   })
   if(scrollTarget.hittable)break
   await page.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:scrollTarget.x,y:scrollTarget.y,deltaX:0,deltaY:scrollTarget.delta})
   await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,80)))
 }
 await page.waitForFunction(controlPoint,{args:['收起对话画布']})
 await page.screenshot(join(sourceRoot,'.browser-evidence/complete-host-inline-reply-controls.png'))
 await click('收起对话画布')
 try {await page.waitForFunction(()=>!document.querySelector('[data-loom-inline-open="true"]'))} catch(error){console.log(JSON.stringify({closeDiagnostic:await page.evaluate(()=>({inline:document.querySelector('[data-loom-inline]')?.outerHTML.slice(0,1000),focus:document.activeElement?.outerHTML.slice(0,400),busy:document.querySelector('[data-loom-inline] [data-loom-root]')?.getAttribute('aria-busy')}))}));throw error}
 inlineEvidence={normal:normalInline,narrow:narrowInline,realMouseDrag:true,singleEditor:true,fullscreenReturn:true,goalPreserved:true,scope:'Live current-project editor inside official completed-turn extension; not a historical graph snapshot'}
 assert.deepEqual(page.pageErrors,[])
 await page.screenshot(join(sourceRoot,'.browser-evidence/complete-host-shell.png'))
}finally{if(browser)await browser.close()}
await writeFile(join(evidence,'live-host-session-agent.json'),JSON.stringify({passed:true,packageVersion,generatedAt:new Date().toISOString(),scope:'Only official base + Web App + Loom; real installed full Web Host and unmodified complete official frontend; production SessionController parent/child Agents; offline controlled LLM adapter, real Git worktrees and native write tool; Settings controls only, session entry, fullscreen canvas and return. No external model or Electron acceptance',hostAnchor:anchor,frontend:{inlineCanvas:inlineEvidence,windowsCaption:{scope:'Installed official CSS with simulated Windows root attributes; actual browser geometry and mouse hit tests, not Electron controls',states:windowsCaption,workbench:captionGeometry,nativeFullscreenTransition:true},moduleScanned:true,nativeSessionPane:true,newSessionEntry:true,newSessionDraftPreserved:true,newSessionOpeningCallsModel:false,entryActivationLatencyMs:500,independentReview:true,settingsNavigation:true,settingsConfigurationOnly:true,totalSwitchPersisted:true,sessionEntry:true,fullscreenCanvas:true,returnToSession:true},cleanup:'Temporary profile and test worktrees removed after evidence capture',home,services,parentType:parent.constructor.name,eventTypes:events.map(e=>e.type),admitted,run,modelCalls},null,2)+'\n')
await ctx.fiber.dispose()
}catch(error){console.error(error);process.exitCode=1}finally{if(ctx)await ctx.fiber.dispose();process.chdir(previousCwd);process.argv[1]=previousEntry;for(const key of envKeys){if(previousEnv[key]===undefined)delete process.env[key];else process.env[key]=previousEnv[key]}await rm(home,{recursive:true,force:true})}
