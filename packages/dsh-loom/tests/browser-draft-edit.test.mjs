/**
 * 真实浏览器验证 · 步骤 3。
 *
 * ── 与 draft-edit.test.mjs 的分工 ───────────────────────────────────────
 * `draft-edit.test.mjs` 用 DOM 替身在 Node 里跑组件，验的是**逻辑**：
 * 请求发没发对、草案 revision 闸门在不在、冲突会不会回读。
 * 本文件用真实 Chromium，验的是**用户在浏览器里真能操作出来**：
 * 真实点击、真实拖拽端口、真实键盘输入、真实 SVG 命中测试、真实重载页面。
 * 两者都要有 —— 只有替身会漏掉命中测试和 CSS 布局问题，
 * 只有浏览器则跑得太慢、断言太脆。
 *
 * ── 页面怎么搭的 ───────────────────────────────────────────────────────
 * 不起 dev server。用 CDP 的 `Page.setDocumentContent` 注入壳页面，
 * 壳来自 tests/browser-harness.mjs（测试和探针共用同一份，避免两边漂移）。
 * 壳里：
 *   - 用 fetch 拦截（覆盖 window.fetch）接走 /loom/* 请求，答一份内存数据面；
 *   - 按真实模块系统形状注册 `window.__ModuleLoader__`；
 *   - 用页面里自带的极简 React 实现（createElement + hooks + 最小 reconciler）
 *     跑组件。这个替身的关键语义（effect 时机、SVG 命名空间、按 key 复用节点）
 *     在 harness 的注释里逐条写了 —— 那里踩过的坑都真的把测试跑红过。
 * 这样 bundle 的代码路径与宿主里完全一致（同一个文件、同一套 API 调用），
 * 变的只是「谁来回 HTTP」——那正是我们要替换的部分。
 *
 * ⚠ 这仍然不是「DSH 宿主里真实加载」。宿主加载需要 dsh 桌面版与真实 profile，
 * 归步骤 4/6。本文件证明的是**浏览器内行为**，报告里必须这样写。
 *
 * 运行：
 *   bash scripts/setup-browser.sh
 *   LD_LIBRARY_PATH=~/.local/chromium-libs/usr/lib/x86_64-linux-gnu \
 *     node --test tests/browser-draft-edit.test.mjs
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

/**
 * 页面必须跑在一个**真实源**（file://）上，不能停在 about:blank。
 *
 * 为什么：替身数据面把「服务端盘上状态」放进 sessionStorage，靠它跨
 * Page.reload 存活 —— 这正是「刷新后还在」要验的东西。但 about:blank 是
 * 不透明源（opaque origin），Chromium 对它的 sessionStorage **读写都抛
 * SecurityError**（实测：setItem/getItem 均 "Access is denied"）。
 * 于是 persist() 静默失败、SAVED 永远 null，reload 后「服务端」自己失忆，
 * 用例必然红 —— 而那是环境的错，不是实现的错。
 *
 * 换成 file:// 后 sessionStorage 正常工作且跨 reload 存活（已实测）。
 * 每个用例仍靠 resetServerState 清 key 来隔离（同源不同 key）。
 */
const PAGE_URL = 'file:///tmp/loom-browser-page.html'

let browser = null
let chromePath = null

// 允许在没装运行库的机器上「跳过」而不是「失败」——
// 环境缺库不该被误读成实现有问题。
try {
  chromePath = findChrome()
} catch {
  chromePath = null
}

const hasLibs = (() => {
  try {
    const p = join(process.env.HOME || '', '.local/chromium-libs/usr/lib/x86_64-linux-gnu')
    return existsSync(join(p, 'libnspr4.so'))
  } catch {
    return false
  }
})()

before(async () => {
  if (!chromePath || !hasLibs) return
  mkdirSync(OUT, { recursive: true })
  // 造一个 file:// 静态页，给页面一个真实源（见 PAGE_URL 注释）。
  // 内容不重要：每个用例都会用 Page.setDocumentContent 把它替换成工作台壳，
  // 关键是**源**必须是 file://，sessionStorage 才可用。
  writeFileSync(
    '/tmp/loom-browser-page.html',
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>',
  )
  browser = await launchBrowser({ executablePath: chromePath })
})

after(async () => {
  if (browser) await browser.close()
})

/** 打开一个页面并挂载组件，等到 /workflow 回来、画布铺好。 */
async function openWorkbench() {
  const page = await browser.newPage(PAGE_URL)
  const { frameTree } = await page.send('Page.getFrameTree')
  await page.send('Page.setDocumentContent', {
    frameId: frameTree.frame.id,
    html: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>',
  })
  // 先清掉上一个用例留在页面里的「服务端盘上状态」（sessionStorage）。
  // 这条必须在 installShell 之前 —— 壳初始化时就会读它。
  // 不清的话，用例之间会通过 sessionStorage 互相污染：单跑过、整套挂。
  await resetServerState(page)
  await installShell(page, shellHtml(), bundle)
  const mounted = await mountWorkbench(page)
  if (!mounted.ok) throw new Error(`挂载失败：${mounted.why}`)

  // 等 /workflow 回来 + 画布真的铺出节点。
  // 等 DOM 而不是等「加载中」消失 —— 后者会在还没铺画布时就为真。
  await page.waitForFunction(() => window.__loomLog.requests.some((r) => r.path.startsWith('/workflow')), { timeoutMs: 8000 })
  await page.waitForFunction(() => document.querySelectorAll('.loom-node').length > 0, { timeoutMs: 8000 })
  await sleep(120)
  return page
}

/** 在页面里按可见文案找按钮，返回它的几何中心（用于真实点击）。 */
const FIND_BTN = (label) => `
  (function () {
    const bs = [...document.querySelectorAll('button')]
    const b = bs.find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)})
      || bs.find((x) => (x.textContent || '').includes(${JSON.stringify(label)}))
    if (!b) return null
    b.scrollIntoView({block:'center',inline:'nearest'})
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), disabled: b.disabled, visible: b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)), w: Math.round(r.width), h: Math.round(r.height) }
  })()
`

async function clickLabel(page, label) {
  let box = await page.evaluate(FIND_BTN(label))
  assert.ok(box, `页面上找不到按钮「${label}」`)
  // 0.5.15：进阶按钮收进「更多 ▾」菜单（收起时 display:none）。
  // 找不到可见目标时先展开菜单再点，脚本本身不需要知道菜单结构。
  if (box && !box.visible && label !== '更多') {
    const more = await page.evaluate(FIND_BTN('更多'))
    if (more && more.visible) {
      await page.clickAt(more.x, more.y)
      await sleep(220)
      box = await page.evaluate(FIND_BTN(label))
    }
  }
  assert.equal(box.disabled, false, `按钮「${label}」处于禁用态，不该点`)
  assert.equal(box.visible, true, `按钮「${label}」必须在可见范围内且未被遮挡`)
  await page.clickAt(box.x, box.y)
  await sleep(160)
  return box
}

/** 真实键盘输入：聚焦 + 逐字敲，触发 input 事件。 */
async function typeInto(page, placeholder, value) {
  if(!await page.evaluate(ph=>[...document.querySelectorAll('input')].some(i=>(i.placeholder||'').includes(ph)),{args:[placeholder]}))await clickLabel(page,'详细设置')
  const box = await page.evaluate(
    (ph) => {
      const el = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes(ph))
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    },
    { args: [placeholder] },
  )
  assert.ok(box, `找不到 placeholder 含「${placeholder}」的输入框`)
  await page.clickAt(box.x, box.y)
  await sleep(40)
  for (const ch of value) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp' })
    await sleep(12)
  }
  await sleep(60)
}

const draftWriteCount = (page) => page.evaluate(() => window.__loomLog.draftWrites.length)
const lastDraftWrite = (page) => page.evaluate(() => window.__loomLog.draftWrites[window.__loomLog.draftWrites.length - 1] || null)
const snapshot = (page) => page.evaluate(() => ({
  nodes: [...document.querySelectorAll('.loom-node')].map((c) => c.dataset.nodeId),
  nodeCards: document.querySelectorAll('.loom-node').length,
  ports: document.querySelectorAll('.loom-port').length,
  edges: [...document.querySelectorAll('.loom-edges path')].map((p) => p.getAttribute('d')),
  hint: (document.querySelector('.loom-hint') || {}).textContent || '',
  okText: [...document.querySelectorAll('.loom-ok')].map((p) => p.textContent).join(' | '),
  errText: [...document.querySelectorAll('.loom-error')].map((p) => p.textContent).join(' | '),
  text: document.body.innerText,
}))

/* ====================================================================== *
 * 用例
 * ====================================================================== */

const skipAll = !chromePath || !hasLibs
const maybe = (name, fn) => test(name, { skip: skipAll ? '环境缺 Chromium 运行库（先跑 scripts/setup-browser.sh）' : false }, fn)

maybe('真实 Chromium 里能加载 bundle 并挂载工作台', async () => {
  const page = await openWorkbench()
  const info = await page.evaluate(() => ({
    title: document.title,
    hasCanvas: !!document.querySelector('[data-loom-root]'),
    hasStage: !!document.querySelector('.loom-stage'),
    hasSvg: !!document.querySelector('.loom-edges'),
    nodeCards: document.querySelectorAll('.loom-node').length,
    ports: document.querySelectorAll('.loom-port').length,
    buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()),
  }))
  assert.equal(info.hasCanvas, true, '应该渲染出 [data-loom-root]')
  assert.equal(info.hasStage, true, '应该有画布舞台')
  assert.equal(info.hasSvg, true, '连线层应该是 SVG')
  assert.equal(info.nodeCards, 4, `画布上应有 4 个节点卡片，实际 ${info.nodeCards}`)
  assert.ok(info.ports >= 4, `端口小圆点应该渲染出来，实际 ${info.ports}`)
  for (const b of ['撤销', '重做', '连线模式', '详细设置', '采纳为新 revision', '导出架构提示词']) {
    assert.ok(info.buttons.includes(b), `工具栏应该有「${b}」`)
  }
  await clickLabel(page,'详细设置')
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='添加节点')),true,'advanced node creation remains available on demand')
  assert.deepEqual(page.pageErrors, [], `页面不该有 JS 异常：${page.pageErrors.join(' | ')}`)
  await page.screenshot(join(OUT, '01-mounted.png'))
})

maybe('真实鼠标点击「添加节点」把新节点写进草案', async () => {
  const page = await openWorkbench()
  const before = await draftWriteCount(page)

  await typeInto(page, 'id（', 'delivery-node')
  await typeInto(page, '目标（', '产出交付报告')
  await clickLabel(page, '添加节点')

  await page.waitForFunction((n) => window.__loomLog.draftWrites.length > n, { args: [before], timeoutMs: 8000 })
  const after = await draftWriteCount(page)
  assert.equal(after, before + 1, '点一次「添加节点」应当写一次草案')

  const last = await lastDraftWrite(page)
  assert.equal(last.workspaceId, 'proj-alpha', '草案必须带工作区归属')
  assert.equal(typeof last.expectedRevision, 'number', 'expectedRevision 必须是数字')

  const snap = await snapshot(page)
  assert.equal(snap.nodeCards, 5, `画布上应变成 5 个节点卡片，实际 ${snap.nodeCards}`)
  assert.ok(snap.nodes.includes('delivery-node'), `新节点应该出现在画布上，实际 ${snap.nodes.join('、')}`)
  assert.ok(snap.okText.includes('已新增节点'), `应提示已新增，实际「${snap.okText}」`)

  await page.screenshot(join(OUT, '02-added-node.png'))
})

maybe('真实键盘输入非法 id 被拒绝，且不写草案', async () => {
  const page = await openWorkbench()
  const before = await draftWriteCount(page)
  await typeInto(page, 'id（', 'Bad-ID')
  await typeInto(page, '目标（', '非法 id')
  await clickLabel(page, '添加节点')
  await sleep(300)
  const after = await draftWriteCount(page)
  assert.equal(after, before, '非法 id 不该写草案')
  const snap = await snapshot(page)
  assert.match(snap.text, /不合规/, `应当显示 id 不合规的错误，实际错误区「${snap.errText}」`)
  await page.screenshot(join(OUT, '03-invalid-id.png'))
})

maybe('真实鼠标拖拽端口把连线写进草案（评审 C 的核心缺陷）', async () => {
  const page = await openWorkbench()
  const before = await draftWriteCount(page)

  // 先像用户一样滚动到画布。设置区新增后，report 的端口可能在当前屏幕下方，
  // CDP 不会自动为坐标拖拽滚动；屏幕外的坐标不是有效的鼠标目标。
  await page.evaluate(() => document.querySelector('.loom-stage').scrollIntoView({ block: 'center' }))
  // 找 frontend.change（输出, code-change）与 report.change（输入, code-change）的端口坐标。
  // 这一步完全靠真实 DOM 几何 —— 拖拽能不能连上，取决于端口是否真的画在卡片边上。
  const geom = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.loom-node')]
    const pick = (id) => cards.find((c) => c.dataset.nodeId === id)
    const portPos = (card, kind, name) => {
      if (!card) return null
      const el = [...card.querySelectorAll('.loom-port')].find((p) => {
        const d = p.dataset.port || ''
        return d.startsWith(kind + ':') && d.slice(kind.length + 1) === name
      })
      if (!el) return null
      const r = el.getBoundingClientRect()
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
      return { x, y, port: el.dataset.port, hit: document.elementFromPoint(x, y)?.closest('.loom-port')?.dataset.port, w: Math.round(r.width) }
    }
    const f = pick('frontend')
    const rp = pick('report')
    return {
      changeOut: portPos(f, 'out', 'change'),
      changeIn: portPos(rp, 'in', 'change'),
      viewport: { width: innerWidth, height: innerHeight },
      portsOnFrontend: f ? [...f.querySelectorAll('.loom-port')].map((p) => p.dataset.port) : [],
      portsOnReport: rp ? [...rp.querySelectorAll('.loom-port')].map((p) => p.dataset.port) : [],
    }
  })

  assert.ok(geom.changeOut, `frontend 应该有 change 输出端口；实际 ${JSON.stringify(geom.portsOnFrontend)}`)
  assert.ok(geom.changeIn, `report 应该有 change 输入端口；实际 ${JSON.stringify(geom.portsOnReport)}`)

  assert.equal(geom.changeOut.hit, 'out:change', `输出端口必须在当前屏幕可命中：${JSON.stringify(geom)}`)
  assert.equal(geom.changeIn.hit, 'in:change', `输入端口必须在当前屏幕可命中：${JSON.stringify(geom)}`)
  await page.dragMouse(geom.changeOut.x, geom.changeOut.y, geom.changeIn.x, geom.changeIn.y, 18)
  await sleep(400)

  const after = await draftWriteCount(page)
  assert.equal(after, before + 1, '合法连线必须写进草案 —— 这正是评审 C 的原缺陷')

  const snap = await snapshot(page)
  assert.match(snap.okText, /已连线/, `提示应说明已经连上草案，实际「${snap.okText}」`)
  assert.equal(snap.text.includes('没有写进草案'), false, '不该再出现「没有写进草案」')
  assert.ok(snap.edges.length >= 3, `画布上应该多出一条边（原 2 条），实际 ${snap.edges.length}`)

  await page.screenshot(join(OUT, '04-connected-edge.png'))
})

maybe('撤销能回退刚才的连线，并再次写草案', async () => {
  const page = await openWorkbench()
  await typeInto(page, 'id（', 'temp-node')
  await typeInto(page, '目标（', '临时节点')
  await clickLabel(page, '添加节点')
  await page.waitForFunction(() => window.__loomLog.draftWrites.length >= 1, { timeoutMs: 8000 })
  const afterAdd = await draftWriteCount(page)
  const cardsAfterAdd = (await snapshot(page)).nodeCards
  assert.equal(cardsAfterAdd, 5, `加了节点后应有 5 个卡片，实际 ${cardsAfterAdd}`)

  await clickLabel(page, '撤销')
  await page.waitForFunction((n) => window.__loomLog.draftWrites.length > n, { args: [afterAdd], timeoutMs: 8000 })
  const cardsAfterUndo = (await snapshot(page)).nodeCards
  assert.equal(cardsAfterUndo, cardsAfterAdd - 1, '撤销后画布上应少一个节点')

  // 重做把节点放回来
  await clickLabel(page, '重做')
  await page.waitForFunction((n) => window.__loomLog.draftWrites.length > n, { args: [afterAdd + 1], timeoutMs: 8000 })
  const cardsAfterRedo = (await snapshot(page)).nodeCards
  assert.equal(cardsAfterRedo, cardsAfterAdd, '重做后应恢复该节点')

  await page.screenshot(join(OUT, '05-undo-redo.png'))
})

maybe('保存布局只写 presentation，不产生草案 revision', async () => {
  const page = await openWorkbench()
  const beforeWrites = await draftWriteCount(page)
  const beforeEdges = (await snapshot(page)).edges.length
  await clickLabel(page, '保存布局')
  await sleep(500)
  const afterWrites = await draftWriteCount(page)
  assert.equal(afterWrites, beforeWrites, '保存布局不该写草案（布局不是语义）')

  const pres = await page.evaluate(() => window.__loomLog.requests.filter((r) => r.path === '/presentation'))
  assert.ok(pres.length >= 1, '应该发过 /presentation')
  assert.ok(pres.every((r) => r.ws === 'proj-alpha'), '/presentation 必须带工作区头')

  const afterEdges = (await snapshot(page)).edges.length
  assert.equal(afterEdges, beforeEdges, '保存布局不该改变语义图（边数不变）')
})

maybe('仅移动位置不产生语义变化（画布节点真的能拖动）', async () => {
  const page = await openWorkbench()
  const before = await draftWriteCount(page)

  const box = await page.evaluate(() => {
    const c = document.querySelector('.loom-node')
    const r = c.getBoundingClientRect()
    return { x: Math.round(r.left + 40), y: Math.round(r.top + 12), id: c.dataset.nodeId }
  })
  const left0 = await page.evaluate((id) => document.querySelector(`.loom-node[data-node-id="${id}"]`).style.left, { args: [box.id] })

  await page.dragMouse(box.x, box.y, box.x + 150, box.y + 90, 14)
  await sleep(300)

  const left1 = await page.evaluate((id) => document.querySelector(`.loom-node[data-node-id="${id}"]`).style.left, { args: [box.id] })
  assert.notEqual(left1, left0, '拖动后节点的 left 应该变了（画布确实响应拖拽）')

  const after = await draftWriteCount(page)
  assert.equal(after, before, '只移动位置不该写草案 —— 布局不是语义')

  const snap = await snapshot(page)
  assert.match(snap.hint, /布局已改/, `应提示布局已改但语义未变，实际「${snap.hint}」`)

  await page.screenshot(join(OUT, '07-moved-only.png'))
})

maybe('采纳为新 revision 后刷新，改动仍在（真的落盘了，不是内存幻觉）', async () => {
  const page = await openWorkbench()
  await typeInto(page, 'id（', 'persist-node')
  await typeInto(page, '目标（', '重载后仍应存在')
  await clickLabel(page, '添加节点')
  await page.waitForFunction(() => window.__loomLog.draftWrites.length >= 1, { timeoutMs: 8000 })
  const nodesBefore = (await snapshot(page)).nodes
  assert.ok(nodesBefore.includes('persist-node'), `保存前画布上就该有它，实际 ${nodesBefore.join('、')}`)

  // Both draft persistence and immutable adoption are supported. This case specifically verifies adoption; browser-real-backend tests cover an unadopted draft against disk.
  await clickLabel(page, '采纳为新 revision')
  await page.waitForFunction(() => window.__loomLog.requests.some((r) => r.path === '/adopt'), { timeoutMs: 8000 })
  await sleep(400)
  const afterAdopt = await snapshot(page)
  assert.match(afterAdopt.okText, /已采纳为新 revision/, `应提示已采纳，实际「${afterAdopt.okText}」`)

  // 重载 = 真的走一遍 Page.reload，把页面里的 React 状态、hook、
  // 画布 DOM 全部丢掉，只剩「服务端」那一份。然后再挂一次。
  // 这才是「刷新后还在」的诚实检验 —— 只 restore 状态不算。
  await page.send('Page.reload', { ignoreCache: true })
  await sleep(700)
  // reload 回到的是 file:// 那份静态页（没有 #root、没有壳），要重铺一遍。
  // 注意源仍是 file://，所以 sessionStorage 里的「服务端」还在。
  const { frameTree } = await page.send('Page.getFrameTree')
  await page.send('Page.setDocumentContent', {
    frameId: frameTree.frame.id,
    html: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>',
  })
  await installShell(page, shellHtml(), bundle)
  const mounted = await mountWorkbench(page)
  assert.equal(mounted.ok, true, `重载后应能重新挂载：${mounted.why}`)
  await page.waitForFunction(() => document.querySelectorAll('.loom-node').length > 0, { timeoutMs: 8000 })

  const snap = await snapshot(page)
  assert.ok(snap.nodes.includes('persist-node'), `重载后节点仍应出现在画布上，实际 ${snap.nodes.join('、')}`)
  assert.equal(
    await page.evaluate(() => window.__loomLog.draftWrites.length),
    0,
    '重载后不该偷偷写草案 —— 内容应该来自服务端已采纳的 revision',
  )
  const rev = await page.evaluate(() => window.__loomState.workflow.revision)
  assert.equal(rev, 3, `重载后读到的应是采纳后的 revision 3，实际 ${rev}`)
  await page.screenshot(join(OUT, '06-after-reload.png'))
})

maybe('旧 revision 不受新草案影响（保护在途任务靠 immutable revision）', async () => {
  const page = await openWorkbench()
  const revBefore = await page.evaluate(() => window.__loomState.workflow.revision)
  const nodesBefore = await page.evaluate(() => window.__loomState.workflow.nodes.length)

  // 改草案：加节点 + 删节点，但**不采纳**。
  await typeInto(page, 'id（', 'inflight-node')
  await typeInto(page, '目标（', '不该影响旧版')
  await clickLabel(page, '添加节点')
  await page.waitForFunction(() => window.__loomLog.draftWrites.length >= 1, { timeoutMs: 8000 })
  await sleep(300)

  const revAfter = await page.evaluate(() => window.__loomState.workflow.revision)
  const nodesAfter = await page.evaluate(() => window.__loomState.workflow.nodes.length)

  assert.equal(revAfter, revBefore, `只写草案不该改变已采纳 revision，${revBefore} → ${revAfter}`)
  assert.equal(nodesAfter, nodesBefore, `只写草案不该改变服务端现稿的节点数（旧版必须原样不动），${nodesBefore} → ${nodesAfter}`)

  // 画布上能看到新节点（草案态），并明确标出「与已采纳 revision 有差异」。
  const snap = await snapshot(page)
  assert.ok(snap.nodes.includes('inflight-node'), '画布上应能看到草案里的新节点')
  // 提示语要同时说清楚两件事：①当前图与已采纳稿有差异；②草案不影响运行中的旧版。
  // 只查一个关键词是不够的 —— 「有差异」而没说明「不影响旧版」，
  // 用户会以为一改就把在途任务弄坏了。
  assert.match(snap.text, /草案与已采纳 revision/, '应明确标出草案与已采纳 revision 有差异')
  assert.match(snap.text, /草案改动不影响正在运行的旧版/, '应明确说明草案不影响运行中的旧版')

  await page.screenshot(join(OUT, '10-inflight-unchanged.png'))
})

maybe('三条提示词导出路线在真实点击下各自发出正确的 kind', async () => {
  const page = await openWorkbench()
  for (const label of ['导出架构提示词', '导出任务包', '导出协调提示词']) {
    await clickLabel(page, label)
    await sleep(300)
  }
  const calls = await page.evaluate(() => window.__loomState.promptCalls.map((c) => ({ kind: c.kind, scope: c.scope, hasWorkflowId: !!c.workflowId })))
  assert.deepEqual(calls.map((c) => c.kind), ['architecture', 'task', 'coordinator'], `实际发出：${JSON.stringify(calls)}`)
  // 架构路线即使没有任务图也能导出，所以它不该被 workflowId 短路。
  assert.equal(calls[0].kind, 'architecture')
  assert.equal(calls[1].hasWorkflowId, true, '任务包必须带 workflowId')
})

maybe('非法边不能采用执行（服务端拒绝时不留假象）', async () => {
  const page = await openWorkbench()
  // 让 /draft 拒绝一次，模拟「服务端判定非法」。
  await page.evaluate(() => {
    const orig = window.fetch
    window.fetch = function (url, init) {
      if (String(url).includes('/loom/draft')) {
        return Promise.resolve({
          ok: false, status: 409,
          json: async () => ({ ok: false, error: '边不合法：类型不匹配', code: 'DRAFT_REJECTED' }),
        })
      }
      return orig(url, init)
    }
  })
  await typeInto(page, 'id（', 'rejected-node')
  await typeInto(page, '目标（', '服务端会拒绝')
  await clickLabel(page, '添加节点')
  await sleep(500)

  const snap = await snapshot(page)
  assert.match(snap.errText, /类型不匹配/, `应显示服务端拒绝原因，实际「${snap.errText}」`)
  assert.match(snap.okText, /草案保存失败/, `应明确说明本地编辑未生效，实际「${snap.okText}」`)
  // 画布必须回滚成服务端现稿 —— 不能留下「看起来加上了」的假象。
  assert.equal(snap.nodes.includes('rejected-node'), false, `被拒绝的改动不该留在画布上，实际 ${snap.nodes.join('、')}`)

  await page.screenshot(join(OUT, '08-rejected-edge.png'))
})

maybe('整个流程结束后页面无 JS 异常', async () => {
  const page = await openWorkbench()
  await clickLabel(page, '校验')
  await sleep(400)
  await clickLabel(page, '编译预览')
  await sleep(400)
  await clickLabel(page, '连线模式')
  await sleep(200)
  await clickLabel(page, '选择模式')
  await sleep(200)
  assert.deepEqual(page.pageErrors, [], `页面不该有异常，实际：${page.pageErrors.join(' | ')}`)
  const bad = page.consoleLogs.filter((c) => c.type === 'error')
  assert.deepEqual(bad.map((b) => b.text), [], `不该有 console.error：${bad.map((b) => b.text).join(' | ')}`)
  await page.screenshot(join(OUT, '09-final.png'))
})

maybe('进阶按钮收进「更多」菜单：收起时保留在 DOM 但不可点，展开后可达', async () => {
  const page = await openWorkbench()
  const collapsed = await page.evaluate(FIND_BTN('校验'))
  assert.ok(collapsed, '菜单收起时进阶按钮仍应保留在 DOM（避免布局与测试漂移）')
  assert.equal(collapsed.visible, false, '菜单收起时「校验」不应可点')
  const saveCollapsed = await page.evaluate(FIND_BTN('保存布局'))
  assert.ok(saveCollapsed && saveCollapsed.visible === false, '菜单收起时「保存布局」不应可点')
  await clickLabel(page, '校验')
  const expanded = await page.evaluate(FIND_BTN('保存布局'))
  assert.equal(expanded.visible, true, '展开菜单后「保存布局」应可达')
  assert.equal((await page.evaluate(FIND_BTN('导出架构提示词'))).visible, true, '展开菜单后三种导出也应可达')
  await page.screenshot(join(OUT, '09-more-menu.png'))
})
