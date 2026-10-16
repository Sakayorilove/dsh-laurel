/**
 * 真实浏览器验证 · 流程视图 v2（0.7.3）：真画布 + 泳道。
 *
 * 验的是用户视角的四件事：
 *   1. 进入「流程」后画布上出现泳道，节点被铺进泳道里（横向＝顺序、纵向＝并行）；
 *   2. 把卡片拖到另一条泳道 → 「保存流程」写回的顺序按摆位反推；
 *   3. 「两两结组」在右侧生成审计组 + 两个审计代理浮标；
 *   4. 「应用为新依赖」发出请求并给出提示。
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

async function openWorkbench() {
  const page = await browser.newPage(PAGE_URL)
  const { frameTree } = await page.send('Page.getFrameTree')
  await page.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' })
  await resetServerState(page)
  await installShell(page, shellHtml(), bundle)
  const mounted = await mountWorkbench(page)
  if (!mounted.ok) throw new Error(`挂载失败：${mounted.why}`)
  await page.waitForFunction(() => document.querySelectorAll('.loom-node').length > 0, { timeoutMs: 8000 })
  await sleep(150)
  return page
}

const FIND = (label) => `
  (function () {
    const bs = [...document.querySelectorAll('button')]
    const b = bs.find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)})
      || bs.find((x) => (x.textContent || '').includes(${JSON.stringify(label)}))
    if (!b) return null
    b.scrollIntoView({ block: 'center', inline: 'nearest' })
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), disabled: b.disabled, visible: b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) }
  })()
`
async function clickText(page, label) {
  let box = await page.evaluate(FIND(label))
  if(box&&!box.visible&&['两两结组','结为审计组'].some(t=>label.includes(t))){await clickText(page,'详细设置');box=await page.evaluate(FIND(label))}
  assert.ok(box, `页面上找不到按钮「${label}」`)
  assert.equal(box.disabled, false, `按钮「${label}」不应被禁用`)
  assert.equal(box.visible, true, `按钮「${label}」必须在可见范围内（若在「更多」菜单里请先展开）`)
  await page.clickAt(box.x, box.y)
  await sleep(200)
  return box
}

maybe('流程泳道：铺位、拖动改序、保存/应用与审计分组', async () => {
  const page = await openWorkbench()
  await clickText(page, '流程')
  await page.waitForFunction(() => document.querySelectorAll('.loom-lane').length >= 2, { timeoutMs: 8000 })

  const geometry = await page.evaluate(() => {
    const bands = [...document.querySelectorAll('.loom-lane')].map((el) => ({ id: el.dataset.lane, top: parseFloat(el.style.top), height: parseFloat(el.style.height) }))
    const cards = [...document.querySelectorAll('.loom-node')].map((el) => ({ id: el.dataset.nodeId, top: parseFloat(el.style.top) }))
    const laneAt = (top) => (bands.find((b) => top >= b.top - 20 && top <= b.top + b.height + 20) || {}).id || null
    return { bands, cards: cards.map((c) => ({ ...c, lane: laneAt(c.top) })) }
  })
  assert.ok(geometry.bands.length >= 2, `应有至少两条泳道，实际 ${geometry.bands.length}`)
  assert.ok(geometry.cards.every((c) => c.lane), `每张卡片都应在泳道带内：${JSON.stringify(geometry.cards)}`)

  // 把第一张卡拖到第二条泳道（屏幕坐标拖拽，缩放无关）
  const cardId = geometry.cards[0].id
  const cardLane = geometry.cards[0].lane
  const secondLane = geometry.bands.find((b) => b.id !== cardLane).id
  const from = await page.evaluate((id) => {
    const card = document.querySelector(`.loom-node[data-node-id="${id}"]`)
    const r = card.getBoundingClientRect()
    return { x: Math.round(r.left + 40), y: Math.round(r.top + 12) }
  }, { args: [cardId] })
  const to = await page.evaluate((lane) => {
    const band = document.querySelector(`.loom-lane[data-lane="${lane}"]`)
    const r = band.getBoundingClientRect()
    return { x: Math.round(r.left + 120), y: Math.round(r.top + r.height / 2) }
  }, { args: [secondLane] })
  await page.dragMouse(from.x, from.y, to.x, to.y, 14)
  await sleep(300)

  await clickText(page, '保存流程')
  await page.waitForFunction(() => (window.__loomLog.flow && window.__loomLog.flow.saves.length) === 1, { timeoutMs: 8000 })
  const saved = await page.evaluate(() => window.__loomLog.flow.saves[0])
  const step = saved.steps.find((s) => s.taskIds.includes(cardId))
  assert.ok(step, `拖动后的任务 ${cardId} 应仍在某个步骤里：${JSON.stringify(saved.steps)}`)
  assert.notEqual(step.id, cardLane, `拖动后 ${cardId} 应换到别的泳道（原来在 ${cardLane}，现在在 ${step.id}）`)

  await clickText(page, '两两结组')
  await sleep(220)
  const groups = await page.evaluate(() => document.querySelectorAll('.loom-flow-groupbox').length)
  const audits = await page.evaluate(() => [...document.querySelectorAll('.loom-flow-audit')].map((el) => el.textContent))
  assert.ok(groups >= 1, `应生成审计组，实际 ${groups}`)
  assert.equal(audits.length, 2, '应有两个审计代理浮标')

  await clickText(page,'收起详细设置')
  await clickText(page, '应用为新依赖')
  await page.waitForFunction(() => (window.__loomLog.flow && window.__loomLog.flow.applies.length) === 1, { timeoutMs: 8000 })
  const notice = await page.evaluate(() => [...document.querySelectorAll('.loom-ok')].map((p) => p.textContent).join(' | '))
  assert.ok(/新依赖/.test(notice), `应用后应给出草案提示，实际：${notice}`)
  assert.deepEqual(page.pageErrors, [], `页面不该有 JS 异常：${page.pageErrors.join(' | ')}`)
  await page.screenshot(join(OUT, 'flow-lanes.png'))
})

maybe('步骤先后可调 + 任意两步结组（S3）', async () => {
  const page = await openWorkbench()
  await clickText(page, '流程')
  await page.waitForFunction(() => document.querySelectorAll('.loom-lane').length >= 3, { timeoutMs: 8000 })

  // 竖排：每条泳道标签上出现方向按钮；首条没有「往前」、末条没有「往后」。
  const laneButtons = () => page.evaluate(() => [...document.querySelectorAll('.loom-lane')].map((lane) => ({
    id: lane.dataset.lane,
    moves: [...lane.querySelectorAll('.loom-lane-move')].map((b) => ({ dir: b.dataset.laneMove, glyph: b.textContent })),
  })))
  const vertical = await laneButtons()
  assert.deepEqual(vertical[0].moves.map((m) => m.glyph), ['▼'], '竖排首条只有「往后」')
  assert.deepEqual(vertical.at(-1).moves.map((m) => m.glyph), ['▲'], '竖排末条只有「往前」')
  assert.deepEqual(vertical[1].moves.map((m) => m.glyph), ['▲', '▼'], '中间步骤两个方向都能调')

  // 把第 2 条步骤往前挪一位 → 保存 → 服务端收到的 order 与界面一致。
  const orderBefore = await page.evaluate(() => [...document.querySelectorAll('.loom-lane')].map((l) => l.dataset.lane))
  const moved = await page.evaluate(() => {
    const lane = document.querySelectorAll('.loom-lane')[1]
    const b = lane.querySelector('.loom-lane-move[data-lane-move="back"]')
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })
  await page.clickAt(moved.x, moved.y)
  await sleep(250)
  const orderAfter = await page.evaluate(() => [...document.querySelectorAll('.loom-lane')].map((l) => l.dataset.lane))
  assert.deepEqual(orderAfter.slice(0, 2), [orderBefore[1], orderBefore[0]], `挪一位后前两步应互换：${orderBefore} → ${orderAfter}`)

  await clickText(page, '保存流程')
  await page.waitForFunction(() => (window.__loomLog.flow && window.__loomLog.flow.saves.length) === 1, { timeoutMs: 8000 })
  const savedOrder = await page.evaluate(() => window.__loomLog.flow.saves[0].order)
  assert.deepEqual(savedOrder, orderAfter, 'POST /flow 的 order 必须与界面上的步骤顺序一致')

  // 横排：方向按钮跟着换成 ◀ ▶。
  await clickText(page, '横排')
  await sleep(250)
  const horizontal = await laneButtons()
  assert.deepEqual(horizontal[1].moves.map((m) => m.glyph), ['◀', '▶'], '横排用左右箭头')

  // 勾任意两步（跨栏、不相邻）→ 结为审计组 → 保存后 groups 与勾选一致。
  await clickText(page,'详细设置')
  const picked = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('[aria-label^="勾选步骤 "]')]
    return { first: boxes[0].getAttribute('aria-label'), third: boxes[2].getAttribute('aria-label') }
  })
  for (const label of [picked.first, picked.third]) {
    const at = await page.evaluate((l) => {
      const box = document.querySelector(`[aria-label="${l}"]`)
      box.scrollIntoView({ block: 'center' })
      const r = box.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    }, { args: [label] })
    await page.clickAt(at.x, at.y)
    await sleep(120)
  }
  await clickText(page, '结为审计组')
  await sleep(200)
  const groupCount = await page.evaluate(() => document.querySelectorAll('.loom-flow-groupbox').length)
  assert.equal(groupCount, 1, '应生成一个审计组')
  const groupText = await page.evaluate(() => document.querySelector('.loom-flow-groupbox').textContent)
  const stepA = picked.first.replace('勾选步骤 ', '')
  const stepB = picked.third.replace('勾选步骤 ', '')
  assert.ok(groupText.includes(stepA) && groupText.includes(stepB), `审计组应包含勾选的两步：${groupText}`)

  // 子代理数量下拉必须用**服务端返回的上限**（夹具故意给 2），不是写死的 4。
  const agentOptions = await page.evaluate(() => {
    const select = document.querySelector('.loom-flow-row select')
    return select ? [...select.options].map((o) => o.value) : []
  })
  assert.deepEqual(agentOptions, ['1', '2'], `下拉上限应来自 /flow 的 maxAgents：${JSON.stringify(agentOptions)}`)
  await clickText(page,'收起详细设置')

  await clickText(page, '保存流程')
  await page.waitForFunction(() => window.__loomLog.flow.saves.length === 2, { timeoutMs: 8000 })
  const savedPlan = await page.evaluate(() => window.__loomLog.flow.saves[1])
  const group = savedPlan.groups.find((g) => g.stepIds.includes(stepA) && g.stepIds.includes(stepB))
  assert.ok(group, `保存的 groups 应包含勾选的两步：${JSON.stringify(savedPlan.groups)}`)
  // 顺序必须与界面一致（不相邻也合法，只是给告警）。
  assert.deepEqual(group.stepIds.slice().sort(), [stepA, stepB].sort())
  assert.deepEqual(page.pageErrors, [], `页面不该有 JS 异常：${page.pageErrors.join(' | ')}`)
  await page.screenshot(join(OUT, 'flow-step-order.png'))
})

maybe('流程方向切换与吸附：竖排/横排成行成列，卡片永远在步骤栏内', async () => {
  const page = await openWorkbench()
  await clickText(page, '流程')
  await page.waitForFunction(() => document.querySelectorAll('.loom-lane').length >= 2, { timeoutMs: 8000 })

  const laneShape = () => page.evaluate(() => [...document.querySelectorAll('.loom-lane')].map((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) })))
  const cardsInLanes = () => page.evaluate(() => {
    const bands = [...document.querySelectorAll('.loom-lane')].map((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }))
    return [...document.querySelectorAll('.loom-node')].map((el) => ({ id: el.dataset.nodeId, x: parseFloat(el.style.left), y: parseFloat(el.style.top) }))
      .map((card) => bands.some((b) => card.x >= b.x - 30 && card.x <= b.x + b.w && card.y >= b.y - 30 && card.y <= b.y + b.h + 30))
      .every(Boolean)
  })

  const vertical = await laneShape()
  assert.equal(new Set(vertical.map((l) => l.x)).size, 1, '竖排：所有步骤栏同一起始 x')
  assert.ok(new Set(vertical.map((l) => l.y)).size >= 2, '竖排：步骤栏自上而下排开')
  assert.equal(await cardsInLanes(), true, '竖排：卡片都在步骤栏内')

  await clickText(page, '横排')
  await page.waitForFunction(() => [...document.querySelectorAll('.loom-lane')].map((el) => el.style.top).filter((v) => v === [...document.querySelectorAll('.loom-lane')][0].style.top).length >= 2, { timeoutMs: 4000 })
  const horizontal = await laneShape()
  assert.equal(new Set(horizontal.map((l) => l.y)).size, 1, '横排：所有步骤栏同一行')
  assert.ok(new Set(horizontal.map((l) => l.x)).size >= 2, '横排：步骤栏自左而右排开')
  assert.equal(await cardsInLanes(), true, '横排：卡片都在步骤栏内')

  // 把一张卡拖到栏外（上方很远），松手后必须被吸回某条步骤栏
  const card = await page.evaluate(() => {
    const el = document.querySelector('.loom-node')
    const r = el.getBoundingClientRect()
    return { id: el.dataset.nodeId, x: Math.round(r.left + 40), y: Math.round(r.top + 12) }
  })
  await page.dragMouse(card.x, card.y, card.x + 30, card.y - 420, 16)
  await sleep(300)
  const snapped = await page.evaluate(() => {
    const bands = [...document.querySelectorAll('.loom-lane')].map((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }))
    return [...document.querySelectorAll('.loom-node')].map((el) => ({ id: el.dataset.nodeId, x: parseFloat(el.style.left), y: parseFloat(el.style.top) }))
      .map((c) => ({ id: c.id, ok: bands.some((b) => c.x >= b.x - 30 && c.x <= b.x + b.w && c.y >= b.y - 30 && c.y <= b.y + b.h + 30) }))
  })
  assert.ok(snapped.every((c) => c.ok), `拖动后所有卡片都应吸附在步骤栏里：${JSON.stringify(snapped)}`)
  assert.deepEqual(page.pageErrors, [], `页面不该有 JS 异常：${page.pageErrors.join(' | ')}`)
  await page.screenshot(join(OUT, 'flow-orientation.png'))
})
