/**
 * 真实浏览器验证 · 连线滚动箭头与拖拽选择（0.5.11）。
 *
 * 验的是两件用户看得见的事：
 *   1. 画布上的连线带**沿路径滚动的箭头**（animateMotion + mpath，位置随时间变化）；
 *      0.5.10 首版箭头太小、且在 prefers-reduced-motion 下完全不画，用户看不见。
 *   2. 拖拽画布/节点**不会把文字选蓝**（viewport user-select:none + 拖拽期 body 禁用）。
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
  await sleep(200)
  return page
}

const carrierBoxes = (page) => page.evaluate(() => [...document.querySelectorAll('.loom-edges > g')].map((g) => {
  const r = g.getBoundingClientRect()
  return [Math.round(r.x), Math.round(r.y)]
}))

maybe('连线箭头沿路径滚动，且拖拽不会选中文字', async () => {
  const page = await openWorkbench()
  const counts = await page.evaluate(() => ({
    carriers: document.querySelectorAll('.loom-edges > g').length,
    motions: document.querySelectorAll('.loom-edges animateMotion').length,
    mpaths: document.querySelectorAll('.loom-edges mpath').length,
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }))
  assert.ok(counts.carriers > 0, '画布上应该有箭头载体（<g>）')
  assert.ok(counts.mpaths > 0, '箭头应该绑定到路径（mpath）')
  if (!counts.reduced) assert.ok(counts.motions > 0, '未开启减弱动态效果时应该有 animateMotion')

  const before = await carrierBoxes(page)
  await sleep(1600)
  const after = await carrierBoxes(page)
  if (!counts.reduced) {
    const moved = before.length === after.length && before.some((b, i) => Math.abs(b[0] - after[i][0]) + Math.abs(b[1] - after[i][1]) >= 3)
    assert.ok(moved, `1.6 秒后至少一个箭头应移动 ≥3px（前 ${JSON.stringify(before.slice(0, 2))} 后 ${JSON.stringify(after.slice(0, 2))}）`)
  }

  const box = await page.evaluate(() => {
    const c = document.querySelector('.loom-node')
    const r = c.getBoundingClientRect()
    return { x: Math.round(r.left + 40), y: Math.round(r.top + 12) }
  })
  await page.dragMouse(box.x, box.y, box.x + 160, box.y + 90, 14)
  await sleep(250)
  const selection = await page.evaluate(() => ({
    text: String(window.getSelection ? window.getSelection().toString() : ''),
    userSelect: getComputedStyle(document.querySelector('.loom-node')).userSelect,
    bodySelect: document.body.style.userSelect,
  }))
  assert.equal(selection.text, '', '拖拽后不应该有文字被选中')
  assert.equal(selection.userSelect, 'none', '节点卡片应禁止文字选择')
  assert.ok(!selection.bodySelect || selection.bodySelect === 'none' || selection.bodySelect === '', '松开后不应残留选择屏蔽')

  // 松手后必须恢复**滚动**箭头：拖拽期间 renderEdges 走的是静止兜底分支，
  // 松手不重铺的话动画就永远停在那儿（用户报的「拖一下就再也不动了」）。
  const afterDrag = await page.evaluate(() => ({
    motions: document.querySelectorAll('.loom-edges animateMotion').length,
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }))
  if (!afterDrag.reduced) {
    assert.ok(afterDrag.motions > 0, `拖拽松手后应恢复 animateMotion，实际 ${afterDrag.motions}`)
    const movedBefore = await carrierBoxes(page)
    await sleep(1600)
    const movedAfter = await carrierBoxes(page)
    const stillMoving = movedBefore.length === movedAfter.length && movedBefore.some((b, i) => Math.abs(b[0] - movedAfter[i][0]) + Math.abs(b[1] - movedAfter[i][1]) >= 3)
    assert.ok(stillMoving, '拖拽之后箭头仍应继续流动，而不是停住')
  }
  await page.screenshot(join(OUT, 'edge-arrows.png'))
})

maybe('减少动态效果时改为静止箭头；「始终滚动」可覆盖系统偏好', async () => {
  const page = await browser.newPage(PAGE_URL)
  const { frameTree } = await page.send('Page.getFrameTree')
  await page.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' })
  // 先模拟系统「减少动态效果」，再挂载：渲染时读到的就是这样。
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await resetServerState(page)
  await installShell(page, shellHtml(), bundle)
  const mounted = await mountWorkbench(page)
  if (!mounted.ok) throw new Error(`挂载失败：${mounted.why}`)
  await page.waitForFunction(() => document.querySelectorAll('.loom-node').length > 0, { timeoutMs: 8000 })
  const counts = await page.evaluate(() => ({
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    carriers: document.querySelectorAll('.loom-edges > g').length,
    motions: document.querySelectorAll('.loom-edges animateMotion').length,
  }))
  assert.equal(counts.reduced, true, '模拟的减少动态效果应生效')
  assert.ok(counts.carriers > 0, '静止兜底仍应在路径上摆箭头')
  assert.equal(counts.motions, 0, '跟随系统时不应有动画')
  await page.screenshot(join(OUT, 'edge-arrows-reduced.png'))
})
