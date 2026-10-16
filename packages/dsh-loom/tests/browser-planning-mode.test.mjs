/**
 * 真实浏览器验证 · 规划模式与插槽注册（0.6.2/0.6.3 客户端半边）。
 *
 * 宿主插槽是官方扩展面：本用例断言客户端声明了做这件事所必需的插槽
 * （聊天框工具条、输入框着色层、欢迎页），以及工作台在规划模式下会隐藏
 * 执行类动作并显示横幅 —— 用的是与真实按钮同一份「loom:planning-mode」事件。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { launchBrowser, findChrome, sleep } from './cdp.mjs'
import { shellHtml, installShell, mountWorkbench, resetServerState } from './browser-harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const OUT = join(root, '.browser-evidence')
const PAGE_URL = 'file:///tmp/loom-browser-page.html'

let browser = null
let chromePath = null
try { chromePath = findChrome() } catch { chromePath = null }
const hasLibs = (() => {
  try { return existsSync(join(process.env.HOME || '', '.local/chromium-libs/usr/lib/x86_64-linux-gnu/libnspr4.so')) } catch { return false }
})()
const skipAll = !chromePath || !hasLibs
const maybe = (name, fn) => test(name, { skip: skipAll ? '环境缺 Chromium 运行库（先跑 scripts/setup-browser.sh）' : false }, fn)

before(async () => {
  if (skipAll) return
  mkdirSync(OUT, { recursive: true })
  writeFileSync('/tmp/loom-browser-page.html', '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>')
  browser = await launchBrowser({ executablePath: chromePath })
})
after(async () => { if (browser) await browser.close() })

maybe('active approval shows live task progress in the plan, preserves edits, and only stopped runs can recover',async()=>{
  const page=await browser.newPage(PAGE_URL)
  await resetServerState(page);await installShell(page,shellHtml(),bundle);assert.equal((await mountWorkbench(page)).ok,true)
  await page.waitForFunction(()=>document.querySelector('[data-loom-approval]'))
  await page.evaluate(()=>{
    window.__loomState.runs=[{runId:'run-live',sessionId:'another-session',workflowId:'loom-default',revision:2,state:'running',startedAt:new Date().toISOString()}]
    window.__loomState.execution={records:[]}
  })
  await sleep(3200)
  assert.equal(await page.evaluate(()=>Boolean(document.querySelector('[data-loom-active-run]'))),false,'another conversation must not block this one')
  await page.evaluate(()=>{
    const state=window.__loomState
    state.runs[0].sessionId='test-session'
    state.execution.records=[{runId:'run-live',state:'running',tasks:[{nodeId:'frontend',attemptId:'live-attempt',number:1,phase:'implementation',active:true}]}]
  })
  await page.waitForFunction(()=>document.querySelector('[data-loom-active-run]')?.textContent.includes('实现中'),{timeoutMs:6500})
  assert.equal(await page.evaluate(()=>document.querySelector('[data-loom-active-run] .loom-primary').disabled),true)
  const edit=await page.evaluate(()=>{
    const e=document.querySelector('textarea[aria-label$="完成条件"]')
    if(!e)return false
    e.value='保留用户尚未采纳的验收修改';e.dispatchEvent(new Event('blur'));return true
  })
  assert.equal(edit,true)
  await page.evaluate(()=>{window.__loomState.execution.records[0].tasks[0].phase='verification'})
  await page.waitForFunction(()=>document.querySelector('[data-loom-active-run]')?.textContent.includes('验证中'),{timeoutMs:6500})
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('textarea')].some(e=>e.value==='保留用户尚未采纳的验收修改')),true,'progress polling must not reload the unadopted plan')
  const point=await page.evaluate(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.textContent==='查看运行进度');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})
  await page.clickAt(point.x,point.y)
  await page.waitForFunction(()=>document.body.textContent.includes('项目运行记录'))
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='批准恢复运行')),false)
  await page.evaluate(()=>{window.__loomState.runs[0].state='cancelled';window.__loomState.runs[0].reason='USER_CANCELLED';window.__loomState.execution.records[0].state='cancelled';window.__loomState.execution.records[0].tasks[0].active=false})
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='批准恢复运行'),{timeoutMs:6500})
  assert.equal(await page.evaluate(()=>Boolean(document.querySelector('[data-loom-active-run]'))),false)
  assert.equal(await page.evaluate(()=>document.body.textContent.includes('已由用户取消，已有文件和工作树保留')),true)
  assert.deepEqual(page.pageErrors,[])
  await page.screenshot(join(OUT,'approval-active-progress.png'))
})

maybe('recovery approves the displayed revised plan, while a newer undisplayed revision blocks dispatch',async()=>{
  const page=await browser.newPage(PAGE_URL)
  await resetServerState(page);await installShell(page,shellHtml(),bundle)
  await page.evaluate(()=>{
    const original=window.fetch
    window.__snapshotRevision=3
    window.__loomState.workflow.revision=3
    window.__loomState.revisions.push({workflowId:'loom-default',revision:3,title:'revised acceptance'})
    window.__loomState.runs=[{runId:'old-failed',sessionId:'test-session',workflowId:'loom-default',revision:2,state:'failed',startedAt:new Date().toISOString()}]
    window.fetch=(url,init)=>{
      if(String(url).endsWith('/scm'))return Promise.resolve({ok:true,status:200,json:async()=>({ok:true,data:{head:'a'.repeat(40),dirty:false}})})
      if(String(url).includes('/plan/snapshot?'))return Promise.resolve({ok:true,status:200,json:async()=>({ok:true,data:{workflowId:'loom-default',revision:window.__snapshotRevision,hash:'approved-revised-hash'}})})
      return original(url,init)
    }
  })
  assert.equal((await mountWorkbench(page,{commandSpy:true})).ok,true)
  const click=async label=>{const p=await page.evaluate(label=>{const e=[...document.querySelectorAll('button')].find(b=>b.textContent===label&&!b.disabled);e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}}, {args:[label]});await page.clickAt(p.x,p.y)}
  await page.waitForFunction(()=>document.querySelector('[data-loom-approval]'))
  await click('运行');await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='批准恢复运行'))
  await click('批准恢复运行')
  await page.waitForFunction(()=>window.__loomCommands?.length===1)
  assert.deepEqual(await page.evaluate(()=>window.__loomCommands),['/loom approve-resume old-failed approved-revised-hash'])
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='批准恢复运行'&&!b.disabled))
  await page.evaluate(()=>{window.__snapshotRevision=4})
  await click('批准恢复运行')
  await page.waitForFunction(()=>document.body.textContent.includes('当前计划或编组已变化'))
  assert.equal(await page.evaluate(()=>window.__loomCommands.length),1,'unreviewed server version cannot dispatch')
  assert.deepEqual(page.pageErrors,[])
})

maybe('canvas: rectangle selection, direct grouping, drag membership and agents persist without the inspector',async()=>{
  const page=await browser.newPage(PAGE_URL)
  await resetServerState(page);await installShell(page,shellHtml(),bundle);assert.equal((await mountWorkbench(page)).ok,true)
  await page.waitForFunction(()=>document.querySelectorAll('.loom-node').length>=2)
  assert.equal(await page.evaluate(()=>document.querySelector('.loom-inspector').checkVisibility()),false)
  assert.equal(await page.evaluate(()=>document.querySelector('.loom-readable-plan').checkVisibility()),false)
  const clickLabel=async label=>{const p=await page.evaluate(label=>{const e=[...document.querySelectorAll('button')].find(b=>b.textContent===label&&!b.disabled&&b.checkVisibility());if(!e)throw Error('missing '+label);e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}}, {args:[label]});await page.clickAt(p.x,p.y)}
  const nodeIds=await page.evaluate(()=>[...document.querySelectorAll('.loom-node')].map(e=>e.dataset.nodeId))
  const rect=await page.evaluate(id=>{const e=document.querySelector('[data-node-id="'+id+'"]');const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}}, {args:[nodeIds[0]]})
  await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x-7,y:rect.y-7,button:'left',buttons:1,clickCount:1})
  await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x+rect.w/2,y:rect.y+rect.h/2,button:'left',buttons:1})
  await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x+rect.w/2,y:rect.y+rect.h/2,button:'left',buttons:0})
  await page.waitForFunction(()=>document.querySelector('[data-loom-canvas-tools]').textContent.includes('已选 1 个模块'))
  await clickLabel('编为一组')
  await page.waitForFunction(()=>document.querySelectorAll('[data-loom-team]').length===1)
  const nodePoint=async id=>page.evaluate(id=>{const e=document.querySelector('[data-node-id="'+id+'"]');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+20}}, {args:[id]})
  const second=await nodePoint(nodeIds[1]);await page.clickAt(second.x,second.y);await clickLabel('编为一组')
  await page.waitForFunction(()=>document.querySelectorAll('[data-loom-team]').length===2)
  const from=await nodePoint(nodeIds[0]),to=await nodePoint(nodeIds[1])
  await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',buttons:1,clickCount:1})
  await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1})
  await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',buttons:0})
  await page.waitForFunction(()=>document.querySelectorAll('[data-loom-team]').length===1)
  await clickLabel('增加子代理')
  await clickLabel('保存编排')
  await page.waitForFunction(()=>Boolean(window.__loomState.flowPlan?.organization))
  const saved=await page.evaluate(()=>window.__loomState.flowPlan.organization)
  assert.equal(saved.teams.length,1);assert.ok(saved.teams[0].taskIds.includes(nodeIds[0]));assert.ok(saved.teams[0].taskIds.includes(nodeIds[1]))
  assert.equal(saved.members.filter(m=>m.role==='executor'&&m.taskIds.includes(nodeIds[0])).length,1,'new responsible agent replaces the previous assignment')
  assert.ok(saved.members.some(m=>m.role==='supervisor'&&m.id===saved.teams[0].supervisorId));assert.ok(saved.members.some(m=>m.role==='reviewer'&&m.id===saved.teams[0].reviewerId))
  assert.equal(await page.evaluate(()=>document.querySelector('.loom-inspector').checkVisibility()),false)
  await page.screenshot(join(OUT,'canvas-direct-grouping-desktop.png'))
  await page.send('Emulation.setDeviceMetricsOverride',{width:430,height:900,deviceScaleFactor:1,mobile:false})
  await page.screenshot(join(OUT,'canvas-direct-grouping-narrow.png'))
  assert.deepEqual(page.pageErrors,[])
})

maybe('approval: adopted plan shows reasons, stays visible in focus, and never dispatches on disclosure', async () => {
  const page=await browser.newPage(PAGE_URL)
  await resetServerState(page)
  await installShell(page,shellHtml(),bundle)
  await page.evaluate(()=>{window.__loomState.workflow.openQuestions=['先确认任务的 Git 基线'];window.__loomState.architectures[0].openQuestions=['先确认插件启停接口']})
  const mounted=await mountWorkbench(page);assert.equal(mounted.ok,true)
  await page.waitForFunction(()=>document.querySelector('[data-loom-approval-blocks]')?.textContent.includes('先确认插件启停接口'))
  assert.equal(await page.evaluate(()=>document.querySelector('[data-loom-approval] .loom-primary').disabled),true)
  assert.equal(await page.evaluate(()=>document.querySelector('[data-loom-resolve]').disabled),false,'AI assistance remains usable while unanswered questions block implementation')
  const before=await page.evaluate(()=>window.__loomLog.requests.length)
  const point=await page.evaluate(()=>{const e=document.querySelector('[data-loom-approval-blocks] summary');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})
  await page.clickAt(point.x,point.y)
  assert.equal(await page.evaluate(()=>document.querySelector('[data-loom-approval-blocks]').open),true)
  assert.equal(await page.evaluate(()=>window.__loomLog.requests.slice().length),before,'viewing blockers does not issue approval or requests')
  const focus=await page.evaluate(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.textContent==='专注画布');e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})
  await page.clickAt(focus.x,focus.y)
  await page.waitForFunction(()=>document.querySelector('[data-loom-root]').getAttribute('data-loom-focus')==='true')
  assert.equal(await page.evaluate(()=>document.querySelector('[data-loom-approval] .loom-primary').checkVisibility()),true)
  assert.equal(await page.evaluate(()=>document.querySelector('[data-loom-approval] .loom-primary').disabled),true)
  await page.screenshot(join(OUT,'approval-blockers-focus.png'))
  assert.deepEqual(page.pageErrors,[])
})

maybe('planning mode: slots registered, explicit approval entry, banner shown', async () => {
  const page = await browser.newPage(PAGE_URL)
  const { frameTree } = await page.send('Page.getFrameTree')
  await page.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' })
  await resetServerState(page)
  await installShell(page, shellHtml(), bundle)
  const mounted = await mountWorkbench(page)
  if (!mounted.ok) throw new Error(`挂载失败：${mounted.why}`)
  await page.waitForFunction(() => document.querySelectorAll('.loom-node').length > 0, { timeoutMs: 8000 })

  const slots = await page.evaluate(() => window.__loomSlots || [])
  // composer.bar / hero.* 是 single 且被官方占用，注册即抛错；这里只允许 list 插槽。
  for (const name of ['settings.section', 'conversation.input.left', 'conversation.input.overlay']) {
    assert.ok(slots.includes(name), `应注册插槽 ${name}，实际：${JSON.stringify(slots)}`)
  }
  const clutter = await page.evaluate(() => [...document.querySelectorAll('button,span,a')].map((n) => (n.textContent || '').trim()).filter((text) => ['调色', '颜色在设置'].includes(text)))
  assert.deepEqual(clutter, [], `聊天框里不该出现调色控件（调色整体在设置里）：${JSON.stringify(clutter)}`)
  for (const forbidden of ['conversation.composer.bar', 'conversation.hero.workspace', 'conversation.hero.agentPreset', 'conversation.hero.brand.mark']) {
    assert.equal(slots.includes(forbidden), false, `不应抢占官方 single 插槽 ${forbidden}`)
  }

  // 题词：受控 DOM 注入 —— 有标题时插入、样式来自配置、禁用时移除
  const welcome = await page.evaluate(() => {
    const hero = document.createElement('div')
    hero.innerHTML = '<div class="hero-row"><span>fish</span><div class="title-group"><span>探索未至之境</span><span>预览版</span></div></div><div class="hero-rest">选择工作区 最近的会话列表足够长不会触发继续上爬的启发式判断</div>'
    document.body.appendChild(hero)
    const apply = window.__loomExports.applyWelcomeLine
    const applied = apply(document, { enabled: true, welcomeEnabled: true, welcomeFont: 'Georgia', welcomeFontSize: 20, welcomeColor: '#62d6a4', welcomeGlow: 2, welcomeStroke: 1, welcomeStrokeColor: '#101010' })
    const node = document.querySelector('[data-loom-welcome]')
    const result = {
      applied,
      text: node ? node.textContent : '',
      font: node ? node.style.fontFamily : '',
      size: node ? node.style.fontSize : '',
      color: node ? node.style.color : '',
      stroke: node ? node.style.webkitTextStroke : '',
      align: node ? node.style.textAlign : '',
      belowRow: node ? Boolean(node.previousElementSibling && node.previousElementSibling.className === 'hero-row') : false,
      removed: apply(document, { enabled: false, welcomeEnabled: true }),
      gone: !document.querySelector('[data-loom-welcome]'),
    }
    hero.remove()
    return result
  })
  assert.equal(welcome.applied, true, '有标题时应插入题词')
  assert.equal(welcome.text, '欢迎使用可视化规划模式')
  assert.equal(welcome.font, 'Georgia')
  assert.equal(welcome.size, '20px')
  assert.match(welcome.color, /62d6a4|rgb\(98, 214, 164\)/, '题词颜色应生效（浏览器会归一化成 rgb）')
  assert.match(welcome.stroke, /1px/)
  assert.equal(welcome.align, 'center', '题词应居中')
  assert.equal(welcome.belowRow, true, '题词应插在「标题整行」下方，而不是行内右侧（用户反馈的图二）')
  assert.equal(welcome.removed, false, 'Loom 停用时移除')
  assert.equal(welcome.gone, true)

  const before = await page.evaluate(() => ({
    start: [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '批准当前版本并开工'),
    runSeg: [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '运行'),
    banner: Boolean(document.querySelector('[data-loom-planning-banner]')),
  }))
  assert.equal(before.start, true, '未开启规划模式时应有「批准当前版本并开工」')
  assert.equal(before.runSeg, true, '未开启规划模式时应有「运行」视图')
  assert.equal(before.banner, false, '未开启规划模式时不应有横幅')

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('loom:planning-mode', { detail: { enabled: true, color: '#62d6a4' } })))
  await page.waitForFunction(() => Boolean(document.querySelector('[data-loom-planning-banner]')), { timeoutMs: 4000 })
  const after = await page.evaluate(() => ({
    start: [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '批准当前版本并开工'),
    runSeg: [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '运行'),
    banner: (document.querySelector('[data-loom-planning-banner]') || {}).textContent || '',
  }))
  assert.equal(after.start, true, '规划模式保留明确批准入口；实际派发由生产门禁阻断')
  assert.equal(after.runSeg, false, '规划模式下应隐藏「运行」视图')
  assert.match(after.banner, /批准当前版本并开工才会执行/)

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('loom:planning-mode', { detail: { enabled: false, color: '#6ea8fe' } })))
  await page.waitForFunction(() => !document.querySelector('[data-loom-planning-banner]'), { timeoutMs: 4000 })
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '批准当前版本并开工')), true, '关闭后应恢复')
  assert.deepEqual(page.pageErrors, [], `页面不该有 JS 异常：${page.pageErrors.join(' | ')}`)
  await page.screenshot(join(OUT, 'planning-mode.png'))
})

maybe("欢迎题词只在全新会话页注入，已有对话里不出现（用户要求）", async () => {
  const page = await browser.newPage(PAGE_URL)
  const { frameTree } = await page.send("Page.getFrameTree")
  await page.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html: "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body><div id=\"root\"></div></body></html>" })
  await resetServerState(page)
  await installShell(page, shellHtml(), bundle)
  const mounted = await mountWorkbench(page)
  if (!mounted.ok) throw new Error("挂载失败：" + mounted.why)
  await page.waitForFunction(() => document.querySelectorAll(".loom-node").length > 0, { timeoutMs: 8000 })
  // 造一块和宿主 hero 一样的标题区，看 effect 会不会往里塞题词。
  await page.evaluate(() => {
    const hero = document.createElement("div")
    hero.setAttribute("data-fake-hero", "")
    hero.innerHTML = "<div class=\"hero-row\"><span>fish</span><div class=\"title-group\"><span>探索未至之境</span><span>预览版</span></div></div>"
    document.body.appendChild(hero)
  })

  // 1) 已有对话（宿主选中了会话）→ 不注入
  await sleep(700)
  const inConversation = await page.evaluate(() => Boolean(document.querySelector("[data-loom-welcome]")))
  assert.equal(inConversation, false, "已有对话里不该出现欢迎题词（哪怕这个会话是空的）")

  // 2) 切到全新会话页（没有选中会话）→ 注入；effect 靠配置事件重跑同步
  await page.evaluate(async () => {
    window.__loomSessionKey = ""
    const res = await fetch("/loom/config", { headers: { "x-loom-session": "test-session" } })
    const body = await res.json()
    window.dispatchEvent(new CustomEvent("loom:config-changed", { detail: body.data }))
  })
  await page.waitForFunction(() => Boolean(document.querySelector("[data-loom-welcome]")), { timeoutMs: 5000 })
  const text = await page.evaluate(() => (document.querySelector("[data-loom-welcome]") || {}).textContent || "")
  assert.equal(text, "欢迎使用可视化规划模式")

  // 3) 再回到已有对话 → 撤掉
  await page.evaluate(async () => {
    window.__loomSessionKey = "test-session"
    const res = await fetch("/loom/config", { headers: { "x-loom-session": "test-session" } })
    const body = await res.json()
    window.dispatchEvent(new CustomEvent("loom:config-changed", { detail: body.data }))
  })
  await page.waitForFunction(() => !document.querySelector("[data-loom-welcome]"), { timeoutMs: 5000 })
  assert.deepEqual(page.pageErrors, [], `页面不该有 JS 异常：${page.pageErrors.join(' | ')}`)
})
