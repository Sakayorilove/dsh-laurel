/** Installed Harness platform React/Cordis + real Host Gateway. Session feed is
 * deterministic; this does not claim Electron or real model acceptance. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import * as loom from '../lib/index.js'
import { LoomStore } from '../lib/store.js'
import { normalizeWorkspaceId } from '../lib/core/index.js'
import { launchBrowser } from './cdp.mjs'
import { samplePlannerOutput } from './fixtures.mjs'
// 宿主锚点可配置、可校验：本用例要真宿主 + 真浏览器。
import { hostRequire as host, hostTest, hostAnchor } from '../scripts/host-anchor.mjs'

hostTest('Harness platform React/Cordis and Gateway: RPC, initial planning, settings, session entry, adoption, teardown', async () => {
  const { Context } = host('@deepseek-ai/cordis'), { Session } = host('@deepseek-ai/dsh-session')
  const root = mkdtempSync(join(tmpdir(), 'loom-platform-')), previous = process.env.DSH_HOME, entry = process.argv[1]
  process.env.DSH_HOME = root; process.argv[1] = hostAnchor
  const ctx = new Context(), store = new LoomStore(root), project = join(root, '项目甲'), projectB = join(root, '项目乙')
  mkdirSync(project);mkdirSync(projectB)
  ctx.provide('sessionQuery', { readTitleSnapshot: async id => ({ session: { cwd: id === 'a' ? project : id === 'b' ? projectB : undefined } }) })
  const receiver = { ctx, session: Session.create('a', undefined, { version: 4, id: 'a', cwd: project, createdAt: Date.now(), isSeeded: false }) }
  await ctx.plugin(host('@deepseek-ai/dsh-commands').default)
  await ctx.plugin(host('@deepseek-ai/dsh-typert-registry').default)
  await ctx.plugin(host('@deepseek-ai/dsh-api-gateway').default, {})
  const fiber = await ctx.plugin(loom)
  const assets = join(dirname(host.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist/assets')
  const front = readdirSync(assets).find(f => /^index-.*\.js$/.test(f))
  const frontCode = readFileSync(join(assets, front), 'utf8')
  const bootIndex = frontCode.indexOf('const fo=globalThis.dshDesktopBoot')
  assert.ok(bootIndex > 0, 'pinned installed frontend platform seam; changed build needs reinspection')
  const platform = frontCode.slice(0, bootIndex) + '\nwindow.__loomNativeModules = rM();'
  const clientCode = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let rpcCount = 0, httpLoom = 0, browser
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{margin:0;padding:16px;font-family:system-ui;background:#1b1e23;color:#eee}</style></head><body><div id="root"></div>
  <script>window.__loomExposeEdit=true;window.__loomAllowTestHooks=true;window.__loomLoaded=[];window.__ModuleLoader__={load:x=>window.__loomLoaded.push(x)}</script>
  <script src="/client.js"></script><script type="module">
  import '/platform.js';
  window.blockConfig=true;
  const nativeSetTimeout=window.setTimeout.bind(window);
  window.setTimeout=(fn,ms,...args)=>nativeSetTimeout(fn,window.blockConfig&&ms===10000?100:ms,...args);
  const modules=window.__loomNativeModules, {Context}=modules['@deepseek-ai/cordis'];
  let component, overlay, header, inline, refs=0;const listeners=new Set(),selection=new Set();let entries=[],revision=0,sequence=0,turn=0;
  const eventSource={getSnapshot:()=>({entries,revision,hasMore:false}),subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)}};
  window.feedReply=(requestId,text,reason='completed',interrupted=false)=>{
    turn++;entries.push({type:'event',event:{seq:++sequence,type:'turn/start',data:{turn}}},
    {type:'event',event:{seq:++sequence,type:'user/message',data:{source:{kind:'user',rpcId:requestId},content:[{type:'text',text:window.sent.text}]}}},
    {type:'event',event:{seq:++sequence,type:'assistant/message',data:{turn,interrupted,message:{content:[{type:'text',text}]}}}},
    {type:'event',event:{seq:++sequence,type:'turn/end',data:{turn,reason:{kind:reason}}}});revision++;for(const f of [...listeners])f();
  };
  const session={command:async line=>{if(window.commandMode==='admission-only')return {ok:true,value:{matched:true}};const response=await fetch('/command',{method:'POST',body:line});return response.json()},beginSubmission:()=>({requestId:'native-request',abandon(){}}),prompt:async content=>{window.sent={text:content[0].text};return {ok:true}}};
  const binding={session,eventSource};const reference=()=>{refs++;let released=false;return {ready:Promise.resolve(binding),release(){if(!released){released=true;refs--}}}};
  const sessions={retain:reference,using:async(_id,_opts,fn)=>{const ref=reference();try{return await fn(ref)}finally{ref.release()}}};
  const rootCtx=new Context();
  rootCtx.provide('slots',{inject:(key,fn)=>key==='laurel-center.module'?()=>{}:fn(),register:(_spec,c)=>{if(_spec.name==='settings.section')component=c;if(_spec.name==='shell.overlay')overlay=c;if(_spec.name==='conversation.session.header.utilities')header=c;if(_spec.name==='conversation.chat.turnTail')inline=c;return()=>{if(_spec.name==='settings.section')component=null}}});
  let sessionKey='a';window.switchSession=key=>{sessionKey=key;for(const f of [...selection])f()};
  rootCtx.provide('uiSession',{adapter:{current:{getSnapshot:()=>({key:sessionKey}),subscribe:f=>{selection.add(f);return()=>selection.delete(f)}}}});
  sessions.list={getSnapshot:()=>({byId:{a:{blank:false},b:{blank:true}}}),subscribe:f=>{selection.add(f);return()=>selection.delete(f)}};
  rootCtx.provide('workspaces',{list:{getSnapshot:()=>({items:[{workspaceId:'project-b',title:'项目乙',path:'fixture-project-b'}]}),subscribe:()=>()=>{}},create:async()=>{window.preparationRegistryCalls=(window.preparationRegistryCalls||0)+1;return {workspaceId:'project-b'}}});
  rootCtx.provide('uiWorkspace',{pickDirectory:async()=>null,openWorkspace:async(_workspace,beforeOpen)=>{
    if(window.preparationNavigationMode==='refuse')throw Error('Host refused workspace creation');
    if(window.preparationNavigationMode==='supersede'){window.switchSession('a');return;}
    beforeOpen('b');window.switchSession('b');
  }});
  rootCtx.provide('sessions',sessions);
  rootCtx.provide('connection',{rpc:{call:async(channel,endpoint,payload,signal)=>{
    if(channel!='/api'||endpoint!=='loom/request')throw Error('wrong carrier');
    if(payload.args.input.path==='/config'){if(payload.args.input.sessionId)throw Error('global settings carried selected session');if(window.blockConfig)return new Promise(()=>{});}
    const response=await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal});return response.json();
  }}});
  const exported=window.__loomLoaded[0].factory(name=>modules[name]);window.readSubmittedReply=exported.readSubmittedReply;
  const fiber=await rootCtx.plugin(exported);
  const reactRoot=modules['react-dom/client'].createRoot(document.getElementById('root'));
  reactRoot.render(modules.react.createElement(component));
  window.showSessionEntry=()=>reactRoot.render(modules.react.createElement(modules.react.Fragment,null,modules.react.createElement(header),modules.react.createElement(overlay)));
  window.showInline=()=>reactRoot.render(modules.react.createElement(modules.react.Fragment,null,modules.react.createElement(inline,{key:sessionKey+'-1',sessionId:sessionKey,turn:1}),modules.react.createElement(inline,{key:sessionKey+'-2',sessionId:sessionKey,turn:2}),modules.react.createElement(overlay)));
  window.showSettings=()=>reactRoot.render(modules.react.createElement(component));
  window.teardown=async()=>{reactRoot.unmount();await fiber.dispose();return {refs,listeners:listeners.size,selection:selection.size}};
  window.countRefs=()=>refs;
  </script></body></html>`
  const server = createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/loom')) { httpLoom++; res.statusCode = 500; return res.end('HTTP Loom forbidden in this test') }
      if (req.url === '/command') {
        const chunks=[];for await(const chunk of req)chunks.push(chunk);const line=Buffer.concat(chunks).toString();
        const execution=await ctx.get('commands').execute(receiver,line,[],new AbortController().signal);
        res.setHeader('content-type','application/json');return res.end(JSON.stringify({ok:true,value:{matched:Boolean(execution)}}))
      }
      if (req.url === '/rpc') {
        const chunks=[];for await(const chunk of req) chunks.push(chunk)
        const payload=JSON.parse(Buffer.concat(chunks));rpcCount++
        const value=await ctx.typertGateway.invoke({ namespace:'loom', method:'request', args:payload.args })
        res.setHeader('content-type','application/json');return res.end(JSON.stringify({ok:true,value}))
      }
      res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8')
      if (req.url === '/platform.js') return res.end(platform)
      if (req.url === '/client.js') return res.end(clientCode)
      if (/^\/vendor-[\w-]+\.js$/.test(req.url)) return res.end(readFileSync(join(assets, req.url.slice(1))))
      res.end(html)
    } catch(error) {res.statusCode=500;res.end(error.message)}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try {
    browser=await launchBrowser();const page=await browser.newPage()
    await page.send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`})
    const click=async text=>{
      try {await page.waitForFunction(text=>[...document.querySelectorAll('button')].some(b=>(b.textContent===text||b.getAttribute('aria-label')===text)&&!b.disabled),{args:[text]})}
      catch(error){throw Error(text+': '+error.message+' '+JSON.stringify({errors:page.pageErrors,console:page.consoleLogs})+' '+JSON.stringify(await page.evaluate(()=>({inlineElements:[...document.querySelectorAll('[data-loom-inline]')].map(e=>e.outerHTML.slice(0,300)),text:document.body.textContent.slice(-2500),busy:window.__loomEdit.getState().busy,problem:window.__loomEdit.getState().problem}))))}
      await page.evaluate(text=>[...document.querySelectorAll('button')].find(b=>(b.textContent===text||b.getAttribute('aria-label')===text)&&!b.disabled).click(),{args:[text]})
    }
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='重新读取设置'))
    assert.match(await page.evaluate(()=>document.body.textContent),/响应超时/)
    assert.equal(await page.evaluate(()=>document.body.textContent.includes('读取插件设置中')),false,'timeout exits the loading state even when RPC ignores cancellation')
    await page.evaluate(()=>{window.blockConfig=false;window.switchSession('b')})
    await click('重新读取设置')
    await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-surface="settings"] input')))
    await page.evaluate(()=>window.switchSession('a'))
    assert.equal(await page.evaluate(()=>Boolean(document.querySelector('.loom-viewport'))),false,'settings does not mount the graph')
    assert.equal(await page.evaluate(()=>Boolean(document.querySelector('[aria-label="项目目标"]'))),false,'settings has no planning UI')
    assert.equal(await page.evaluate(()=>window.countRefs()),0,'settings never retains an Agent session')
    const openSessionWorkbench=async()=>{
      await page.evaluate(()=>window.showSessionEntry())
      await page.waitForFunction(()=>Boolean(document.querySelector('[aria-label="打开可视化规划模式"]:not(:disabled), [aria-label="在本会话启用可视化规划模式"]:not(:disabled)')))
      await page.evaluate(()=>document.querySelector('[aria-label="打开可视化规划模式"], [aria-label="在本会话启用可视化规划模式"]').click())
      await page.waitForFunction(()=>document.querySelector('[data-loom-surface="workbench"]')&&window.__loomEdit?.getState().ready)
    }
    await openSessionWorkbench()
    await page.waitForFunction(()=>window.__loomEdit.getState().sessionEnabled)
    // Empty graphs need the same usable canvas as loaded graphs.
    const emptyGeometry=await page.evaluate(()=>{
      const c=document.querySelector('.loom-stage').getBoundingClientRect(),m=document.querySelector('.loom-main').getBoundingClientRect()
      return {width:c.width,height:c.height,mainWidth:m.width}
    })
    assert.ok(emptyGeometry.height>=320)
    assert.ok(Math.abs(emptyGeometry.width-emptyGeometry.mainWidth)<2,'hidden inspector reserves no empty column')
    await click('全屏画布')
    const emptyFullscreen=await page.evaluate(()=>{const c=document.querySelector('.loom-stage').getBoundingClientRect();return {width:c.width,height:c.height,viewportWidth:innerWidth,viewportHeight:innerHeight}})
    assert.ok(emptyFullscreen.width>emptyFullscreen.viewportWidth*.9)
    assert.ok(emptyFullscreen.height>emptyFullscreen.viewportHeight*.65,'empty canvas fills fullscreen too')
    await page.screenshot(new URL('../.browser-evidence/empty-fullscreen-canvas.png',import.meta.url).pathname)
    await click('显示规划面板');await click('还原窗口')
    await click('自动')
    await page.waitForFunction(()=>/已(切到|处于)自动模式/.test(document.body.textContent))
    await click('填入示例需求')
    assert.match(await page.evaluate(()=>document.querySelector('[aria-label="项目目标"]').value), /个人待办网页/)
    assert.equal(await page.evaluate(()=>Boolean(window.sent)),false,'filling an example does not submit a model request')
    // 这里原先断言的是「开始并行开工」——那个按钮名早在 0.7.0 就改成了
    // 「批准当前版本并开工」，于是这条断言永远成立（假通过）。改成当前真实按钮名。
    assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='批准当前版本并开工')),false,'first use shows planning before execution controls')
    assert.equal(store.latestRevision('loom-default',normalizeWorkspaceId(project)),null,'example does not create executable tasks')
    mkdirSync(new URL('../.browser-evidence/',import.meta.url),{recursive:true})
    await page.screenshot(new URL('../.browser-evidence/first-use-example.png',import.meta.url).pathname)

    await page.evaluate(()=>{
      const box=document.querySelector('[aria-label="项目目标"]'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      setter.call(box,'实现前端和后端两个独立模块，使用明确接口约定');box.dispatchEvent(new Event('input',{bubbles:true}));
    })
    await click('规划并发送给 AI')
    await page.waitForFunction(()=>window.sent&&window.countRefs()===1)
    const request=await page.evaluate(()=>window.__loomEdit.getState().promptText.request)
    const planned=samplePlannerOutput();planned.workflowId=request.workflowId;planned.revision=1;planned.nodes=planned.nodes.slice(2,4);planned.edges=[];planned.openQuestions=[]
    planned.executionProposal.requiredBaseline='selected-frozen-commit'
    for(const node of planned.nodes){node.inputs=[];node.acceptance.commands=[]}
    const architecture={schemaVersion:1,architectureId:request.architectureId,revision:1,createdAt:new Date().toISOString(),nodes:[
      {id:'web_module',kind:'module',title:'前端模块',responsibility:'实现前端任务界面与错误状态'},
      {id:'api_module',kind:'module',title:'后端模块',responsibility:'实现模块 API 与输入验证'}],edges:[{id:'web_api',from:'web_module',to:'api_module',kind:'call'}],constraints:request.constraints}
    const planningReply={requestId:request.payloadHash,architecture,workflow:planned,mappings:[
      {workflowNodeId:'frontend',architectureNodeIds:['web_module'],decisionIds:[]},
      {workflowNodeId:'backend',architectureNodeIds:['api_module'],decisionIds:[]}],explanation:'明确接口后两个模块独立分工'}
    await page.evaluate(text=>window.feedReply('native-request',text),{args:[JSON.stringify(planningReply)]})
    await page.waitForFunction(()=>Boolean(document.querySelector('[aria-label="AI 规划架构流程图"]')))
    assert.equal(await page.evaluate(()=>document.querySelector('[aria-label="AI 规划架构流程图"]').compareDocumentPosition(document.querySelector('.loom-main')) & Node.DOCUMENT_POSITION_FOLLOWING),4,'candidate is presented before the editing canvas')
    assert.equal(await page.evaluate(()=>document.querySelector('[aria-label="AI 架构 JSON 回复"]').closest('details').open),false,'automatic preview does not require reading raw JSON')
    await page.screenshot(new URL('../.browser-evidence/first-use-candidate.png',import.meta.url).pathname)

    const ws=normalizeWorkspaceId(project)
    assert.equal(store.latestRevision(request.workflowId,ws),null,'initial planning preview cannot adopt a task graph')
    assert.equal(store.latestArchitecture(request.architectureId,ws),null,'initial planning preview cannot adopt architecture')
    await click('采纳 AI 候选方案')
    await page.waitForFunction(()=>document.body.textContent.includes('已采纳 AI 优化方案'))
    assert.equal(store.latestRevision(request.workflowId,ws).nodes.length,2)
    assert.equal(store.readSourceMap(ws).entries.length,2)
    const beforeFullscreen=await page.evaluate(()=>JSON.stringify(window.__loomEdit.getState().architecture))
    await click('全屏工作台');await click('专注画布')
    await page.waitForFunction(()=>document.querySelector('[data-loom-focus="true"]')&&document.querySelector('.loom-stage').getBoundingClientRect().height>300)
    const fullGeometry=await page.evaluate(()=>({window:document.querySelector('[role="dialog"]').getBoundingClientRect().toJSON(),canvas:document.querySelector('.loom-stage').getBoundingClientRect().toJSON(),viewport:{width:innerWidth,height:innerHeight},plannerHidden:getComputedStyle(document.querySelector('.loom-planner')).display==='none'}))
    assert.equal(fullGeometry.window.width,fullGeometry.viewport.width)
    assert.equal(fullGeometry.window.height,fullGeometry.viewport.height)
    assert.equal(fullGeometry.plannerHidden,true)
    assert.ok(fullGeometry.canvas.height>fullGeometry.viewport.height*0.4,'focus canvas uses available height')
    assert.equal(await page.evaluate(()=>JSON.stringify(window.__loomEdit.getState().architecture)),beforeFullscreen,'view changes do not edit the architecture')
    const dragPoint=await page.evaluate(()=>{const r=document.querySelector('.loom-node-head').getBoundingClientRect();return {x:r.x+40,y:r.y+10}})
    await page.dragMouse(dragPoint.x,dragPoint.y,dragPoint.x+65,dragPoint.y+45)
    const movedPoint=await page.evaluate(()=>{const r=document.querySelector('.loom-node-head').getBoundingClientRect();return {x:r.x+40,y:r.y+10}})
    assert.ok(Math.abs(movedPoint.x-dragPoint.x-65)<3,'real pointer drag stays aligned in fullscreen')
    assert.equal(await page.evaluate(()=>JSON.stringify(window.__loomEdit.getState().architecture)),beforeFullscreen,'moving modules edits only presentation')
    const transformBefore=await page.evaluate(()=>document.querySelector('.loom-world').style.transform)
    await page.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:fullGeometry.canvas.x+400,y:fullGeometry.canvas.y+150,deltaY:-100,deltaX:0})
    await page.waitForFunction(before=>document.querySelector('.loom-world').style.transform!==before,{args:[transformBefore]})
    await page.screenshot(new URL('../.browser-evidence/native-fullscreen-canvas.png',import.meta.url).pathname)
    await click('显示规划面板');await click('还原窗口')
    await page.evaluate(()=>[...document.querySelectorAll('label')].find(l=>l.textContent.includes('在当前会话启用')).querySelector('input').click())
    await page.waitForFunction(()=>!window.__loomEdit.getState().sessionEnabled&&!window.__loomEdit.getState().busy)
    assert.equal(store.readSessionActivation('a'),false)
    await page.evaluate(()=>window.showSessionEntry())
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='启用可视化规划模式'))
    await click('启用可视化规划模式')
    await page.waitForFunction(()=>Boolean(document.querySelector('[role="dialog"][aria-label="可视化规划模式"]')))
    assert.equal(store.readSessionActivation('a'),true,'native header activates exactly its session')
    await page.waitForFunction(()=>Boolean(document.querySelector('[aria-label="打开可视化规划模式"]:not(:disabled)')))
    await click('返回会话')
    try { await page.waitForFunction(()=>!document.querySelector('[role="dialog"]')) }
    catch(error) { throw Error(error.message+' '+JSON.stringify(await page.evaluate(()=>({text:document.body.textContent.slice(0,800),buttons:[...document.querySelectorAll('button')].map(b=>b.textContent).slice(0,12),errors:window.__loomEdit?.getState().problem})))) }
    await page.evaluate(()=>window.showSettings())
    await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-surface="settings"] input:not(:disabled)')))
    await page.evaluate(()=>[...document.querySelectorAll('label')].find(l=>l.textContent.includes('启用 Loom（总开关）')).querySelector('input').click())
    await page.waitForFunction(()=>{const input=[...document.querySelectorAll('label')].find(l=>l.textContent.includes('启用 Loom（总开关）')).querySelector('input');return !input.checked&&!input.disabled})
    assert.equal(store.readConfig().enabled,false,'Settings uses persisted Host config')
    assert.equal(await page.evaluate(()=>Boolean(document.querySelector('.loom-viewport'))),false,'settings remains configuration-only after a toggle')
    await page.evaluate(()=>[...document.querySelectorAll('label')].find(l=>l.textContent.includes('启用 Loom（总开关）')).querySelector('input').click())
    await page.waitForFunction(()=>{const input=[...document.querySelectorAll('label')].find(l=>l.textContent.includes('启用 Loom（总开关）')).querySelector('input');return input.checked&&!input.disabled})
    assert.equal(store.readConfig().enabled,true)
    await openSessionWorkbench()
    await click('架构');await click('添加模块')
    await page.waitForFunction(()=>document.body.textContent.includes('已新增架构模块'))
    await page.evaluate(()=>{window.__loomEdit.getState().selectedNodeId=null})
    await click('导出架构提示词');await click('发送给当前 AI 会话')
    await page.waitForFunction(()=>window.sent&&window.countRefs()===1)
    const baseline=store.latestArchitecture('loom-architecture',ws)
    const reply={baseRevision:await page.evaluate(()=>window.__loomEdit.getState().promptText.baseRevision),candidate:structuredClone(baseline),explanation:'来自本次会话的候选'}
    reply.candidate.nodes[0].responsibility='由本次 AI 回答更新'
    await page.evaluate(text=>window.feedReply('old-request',text),{args:[JSON.stringify(reply)]})
    assert.equal(await page.evaluate(()=>document.querySelector('[aria-label="AI 架构 JSON 回复"]').value),'')
    await page.evaluate(text=>window.feedReply('native-request',text),{args:[JSON.stringify(reply)]})
    await page.waitForFunction(()=>document.body.textContent.includes('来自本次会话的候选'))
    assert.equal(store.latestArchitecture('loom-architecture',ws).nodes[0].responsibility,baseline.nodes[0].responsibility,'preview is read-only')
    assert.equal(await page.evaluate(()=>window.countRefs()),0,'completed reply releases retained session')
    await click('采纳 AI 候选方案')
    await page.waitForFunction(()=>document.body.textContent.includes('已采纳 AI 优化方案'))
    assert.equal(store.latestArchitecture('loom-architecture',ws).nodes[0].responsibility,'由本次 AI 回答更新')
    assert.ok(rpcCount>8);assert.equal(httpLoom,0)
    assert.deepEqual(page.pageErrors,[])
    mkdirSync(new URL('../.browser-evidence/',import.meta.url),{recursive:true})
    await page.screenshot(new URL('../.browser-evidence/host-platform-rpc.png',import.meta.url).pathname)
    const rememberedGoal=await page.evaluate(()=>window.__loomEdit.getState().goal)
    await click('专注画布')
    await page.evaluate(()=>window.switchSession('b'))
    await page.waitForFunction(()=>Boolean(window.__loomEdit.getState().ready&&!window.__loomEdit.getState().architecture&&!window.__loomEdit.getState().workflow&&document.querySelector('[data-loom-focus="false"]')))
    assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.loom-planner')).display!=='none'),true,'switching to an empty project restores the planning panel')
    assert.equal(await page.evaluate(()=>window.__loomEdit.getState().goal),'','new project does not inherit previous input')
    assert.equal(await page.evaluate(()=>window.countRefs()),0,'switching projects retains no previous Agent reference')
    await page.evaluate(()=>window.switchSession('a'))
    await page.waitForFunction(()=>window.__loomEdit.getState().ready&&Boolean(window.__loomEdit.getState().architecture))
    assert.equal(await page.evaluate(()=>window.__loomEdit.getState().goal),rememberedGoal,'returning restores only the selected session input')
    assert.equal(store.latestArchitecture('loom-architecture',ws).nodes[0].responsibility,'由本次 AI 回答更新','switching projects preserves the previous graph')
    await click('开工任务');await click('详细设置');await click('添加节点')
    await page.waitForFunction(()=>document.body.textContent.includes('已新增节点'))
    await click('编译预览')
    await page.waitForFunction(()=>document.querySelector('.loom-error')?.textContent.includes('请先采纳任务草案'))
    // Manual agent nodes can supply actual write boundaries and argv acceptance.
    const manualId = await page.evaluate(()=>window.__loomEdit.getState().selectedNodeId)
    const field = async (selector, value) => {
      await page.evaluate(({selector,value})=>{
        const el=document.querySelector(selector);el.focus();
        Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,value);
        el.dispatchEvent(new Event('input',{bubbles:true}));el.blur();
      },{args:[{selector,value}]})
      await page.waitForFunction(()=>!window.__loomEdit.getState().busy)
    }
    await field('[aria-label="可写文件范围（每行一个相对路径或 glob）"]','manual/**')
    await page.waitForFunction(id=>window.__loomEdit.getState().workflow.nodes.find(n=>n.id===id).ownership.writes[0]==='manual/**',{args:[manualId]})
    await field('[aria-label="禁止写入范围（每行一个）"]','pnpm-lock.yaml')
    await field('[aria-label="完成条件（每行一条）"]','生成 manual/result.txt 并验证内容为完成结果')
    await field('[aria-label="验收命令（argv JSON 数组）"]',JSON.stringify([{argv:['node','-e','process.exit(0)'],cwdRef:'node-worktree',expectedExitCode:0}]))
    await field('input[type="number"][max="86400"]','600')
    await click('刷新')
    await page.waitForFunction(()=>window.__loomEdit.getState().ready&&!window.__loomEdit.getState().busy)
    const manual = store.readDraft(ws).candidate.nodes.find(n=>n.id===manualId)
    assert.deepEqual(manual.ownership.writes,['manual/**']);assert.deepEqual(manual.ownership.forbiddenWrites,['pnpm-lock.yaml'])
    assert.deepEqual(manual.acceptance.doneWhen,['生成 manual/result.txt 并验证内容为完成结果'])
    assert.deepEqual(manual.acceptance.commands,[{argv:['node','-e','process.exit(0)'],cwdRef:'node-worktree',expectedExitCode:0}])
    assert.equal(manual.execution.timeoutSeconds,600,'timeout persists through actual Host RPC and disk refresh')
    // Admission alone cannot pretend a locked module became editable.
    const frozen = structuredClone(store.latestArchitecture('loom-architecture', ws))
    frozen.revision += 1; frozen.nodes[0].locked = true; store.appendArchitecture(frozen, ws)
    await click('架构'); await click('刷新')
    await page.waitForFunction(()=>window.__loomEdit.getState().architecture.nodes[0].locked&&!window.__loomEdit.getState().busy)
    const frozenBox=await page.evaluate(id=>{const node=[...document.querySelectorAll('.loom-node')].find(el=>el.dataset.nodeId===id);const box=node.getBoundingClientRect();return {x:box.left+box.width/2,y:box.top+box.height/2}},{args:[frozen.nodes[0].id]})
    await page.clickAt(frozenBox.x,frozenBox.y)
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='解除冻结'))
    await page.evaluate(()=>{window.commandMode='admission-only'})
    await click('解除冻结')
    await page.waitForFunction(()=>document.querySelector('.loom-error')?.textContent.includes('尚未确认解除冻结完成'),{timeoutMs:15000})
    assert.equal(store.latestArchitecture('loom-architecture',ws).revision,frozen.revision)
    assert.equal(store.latestArchitecture('loom-architecture',ws).nodes[0].locked,true)
    assert.equal(await page.evaluate(()=>{const panel=[...document.querySelectorAll('.loom-panel')].find(p=>p.querySelector('h4')?.textContent==='选中模块');return [...panel.querySelectorAll('input,textarea,select')].every(el=>el.disabled)}),true)
    await page.evaluate(()=>{window.commandMode='real'})
    await click('解除冻结')
    await page.waitForFunction(()=>document.body.textContent.includes('已解除模块')&&!window.__loomEdit.getState().busy)
    assert.equal(store.latestArchitecture('loom-architecture',ws).revision,frozen.revision+1)
    assert.equal(store.latestArchitecture('loom-architecture',ws).nodes[0].locked,false)
    assert.equal(await page.evaluate(()=>{const panel=[...document.querySelectorAll('.loom-panel')].find(p=>p.querySelector('h4')?.textContent==='选中模块');return [...panel.querySelectorAll('input,textarea,select')].every(el=>!el.disabled)}),true)
    assert.ok(receiver.session.snapshotEvents().some(event=>event.type==='command/done'&&event.data.kind==='success'))
    // New Session must be usable before an identity exists; no project RPC writes
    // or model calls are admitted until an explicit native navigation succeeds.
    const architectureBeforePreparation=structuredClone(store.latestArchitecture('loom-architecture',ws))
    await click('返回会话')
    await page.evaluate(()=>window.switchSession(''))
    await click('打开可视化规划模式')
    await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-preparation]'))&&!window.__loomEdit.getState().busy)
    await field('[aria-label="项目目标"]','新会话预先整理的需求')
    await field('[aria-label="规划约束"]','需求不能因选择项目丢失')
    assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='规划并发送给 AI').disabled),true)
    assert.equal(await page.evaluate(()=>window.countRefs()),0)
    await click('全屏工作台');await click('返回会话');await click('打开可视化规划模式')
    await page.waitForFunction(()=>window.__loomEdit.getState().goal==='新会话预先整理的需求'&&!window.__loomEdit.getState().busy)
    await click('选择项目文件夹')
    await page.waitForFunction(()=>!window.__loomEdit.getState().preparing)
    assert.equal(await page.evaluate(()=>window.preparationRegistryCalls||0),0,'cancelled picker creates nothing')
    const choosePreparationWorkspace=()=>page.evaluate(()=>{const e=document.querySelector('[aria-label="规划所在项目"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'project-b');e.dispatchEvent(new Event('change',{bubbles:true}))})
    await choosePreparationWorkspace()
    await page.evaluate(()=>{window.preparationNavigationMode='refuse'})
    await click('进入项目会话')
    await page.waitForFunction(()=>document.body.textContent.includes('Host refused workspace creation'))
    assert.equal(await page.evaluate(()=>window.__loomEdit.getState().goal),'新会话预先整理的需求')
    await page.evaluate(()=>{window.preparationNavigationMode='supersede'})
    await click('进入项目会话')
    await page.waitForFunction(()=>window.__loomEdit.getState().ready&&Boolean(window.__loomEdit.getState().architecture))
    assert.notEqual(await page.evaluate(()=>window.__loomEdit.getState().goal),'新会话预先整理的需求','superseded navigation cannot inject a draft into another session')
    await page.evaluate(()=>window.switchSession(''))
    await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-preparation]'))&&!window.__loomEdit.getState().busy)
    assert.equal(await page.evaluate(()=>window.__loomEdit.getState().goal),'新会话预先整理的需求')
    await choosePreparationWorkspace()
    await page.evaluate(()=>{window.preparationNavigationMode='success'})
    await click('进入项目会话')
    await page.waitForFunction(()=>window.__loomEdit.getState().ready&&window.__loomEdit.getState().sessionEnabled&&!window.__loomEdit.getState().busy&&!document.querySelector('[data-loom-preparation]'))
    assert.equal(await page.evaluate(()=>window.__loomEdit.getState().goal),'新会话预先整理的需求')
    assert.equal(await page.evaluate(()=>window.__loomEdit.getState().planningConstraints),'需求不能因选择项目丢失')
    assert.equal(store.readSessionActivation('b'),true)
    assert.deepEqual(store.latestArchitecture('loom-architecture',ws),architectureBeforePreparation,'preparation never rewrites another project graph')
    await click('返回会话')
    await click('打开可视化规划模式')
    await page.waitForFunction(()=>Boolean(document.querySelector('[aria-label="项目目标"]')))
    assert.equal(await page.evaluate(()=>window.__loomEdit.getState().goal),'新会话预先整理的需求','blank native session exposes the pre-workbench entry')
    // Selection/turn lifecycle fixture complements the real official stream test.
    await click('返回会话')
    await page.evaluate(()=>{window.switchSession('a');window.showInline()})
    await click('在此回复下打开规划画布')
    await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-inline-open="true"] [aria-busy="false"]')))
    assert.equal(await page.evaluate(()=>document.querySelectorAll('.loom-viewport').length),1)
    await click('在此回复下打开规划画布')
    await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-inline-open="true"] [aria-busy="false"]')))
    assert.equal(await page.evaluate(()=>document.querySelectorAll('[data-loom-inline-open="true"]').length),1,'only the explicitly selected reply owns an editor')
    await click('显示规划面板')
    await field('[data-loom-inline-open="true"] [aria-label="项目目标"]','回复中操作的项目甲需求')
    await page.evaluate(()=>{window.switchSession('b');window.showInline()})
    await click('在此回复下打开规划画布')
    await page.waitForFunction(()=>Boolean(document.querySelector('[data-loom-inline-open="true"] [aria-busy="false"]')))
    await click('显示规划面板')
    assert.equal(await page.evaluate(()=>document.querySelector('[data-loom-inline-open="true"] [aria-label="项目目标"]').value),'新会话预先整理的需求','inline switching preserves session isolation')
    await page.evaluate(()=>{window.switchSession('a');window.showInline()})
    await page.waitForFunction(()=>document.querySelector('[data-loom-inline-open="true"] [aria-label="项目目标"]')?.value==='回复中操作的项目甲需求')
    await click('收起对话画布')
    assert.equal(await page.evaluate(()=>document.querySelectorAll('.loom-viewport').length),0)
    assert.deepEqual(page.pageErrors,[])
    await page.screenshot(new URL('../.browser-evidence/native-new-session-preparation.png',import.meta.url).pathname)
    assert.deepEqual(await page.evaluate(()=>window.teardown()),{refs:0,listeners:0,selection:0})
  } finally {
    if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));await fiber.dispose();await ctx.fiber.dispose()
    if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous
    process.argv[1]=entry;rmSync(root,{recursive:true,force:true})
  }
})
