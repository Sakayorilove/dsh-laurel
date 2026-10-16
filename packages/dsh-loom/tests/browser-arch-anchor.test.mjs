/**
 * 真实浏览器验证 · 架构图连线锚点垂直居中（0.5.13）。
 *
 * 用户图一的缺陷：同一目标卡片的多条入边全挤在卡片顶部一小段，
 * 既没对齐卡片中心、边一多也看不清。修复后锚点按**卡片真实高度**
 * 垂直居中、按边数摊开。这里种一份「一个汇合节点 + 5 条入边」的架构，
 * 切到架构视图后直接量 SVG 路径终点，断言它们围绕卡片中心分布。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { launchBrowser, findChrome, sleep } from './cdp.mjs'
import { shellHtml, installShell, mountWorkbench } from './browser-harness.mjs'

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

const architecture = {
  schemaVersion: 1,
  architectureId: 'loom-architecture',
  revision: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  constraints: [],
  openQuestions: [],
  nodes: [
    { id: 'hub', kind: 'service', title: '汇合模块', responsibility: '汇总上游结果。', sourceRefs: [], locked: false },
    ...[1, 2, 3, 4, 5].map((i) => ({ id: 'src' + i, kind: 'module', title: '上游 ' + i, responsibility: '产出第 ' + i + ' 份结果。', sourceRefs: [], locked: false })),
  ],
  edges: [1, 2, 3, 4, 5].map((i) => ({ id: 'e' + i, from: 'src' + i, to: 'hub', kind: 'call', bidirectional: false })),
}

maybe('architecture anchors centre on the card and spread with edge count', async () => {
  const page = await browser.newPage(PAGE_URL)
  const { frameTree } = await page.send('Page.getFrameTree')
  await page.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' })
  // 种下架构，让架构视图有 5 条入边汇到同一张卡片。
  await page.evaluate((arch) => {
    sessionStorage.setItem('__loomServerDUMP__', JSON.stringify({ architectures: [arch] }))
  }, { args: [architecture] })
  await installShell(page, shellHtml(), bundle)
  const mounted = await mountWorkbench(page)
  if (!mounted.ok) throw new Error(`挂载失败：${mounted.why}`)
  await page.waitForFunction(() => document.querySelectorAll('.loom-node').length > 0, { timeoutMs: 8000 })

  // 点「架构」切视图（真实鼠标点击按钮中心）。
  const at = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '架构')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })
  assert.ok(at, '工具条上应该有「架构」按钮')
  await page.clickAt(at.x, at.y)
  await page.waitForFunction(() => document.querySelectorAll('.loom-node').length === 6, { timeoutMs: 8000 })
  await sleep(250)

  const metrics = await page.evaluate(() => {
    const card = document.querySelector('.loom-node[data-node-id="hub"]')
    const top = parseFloat(card.style.top)
    const left = parseFloat(card.style.left)
    const height = card.offsetHeight
    const seen = new Set()
    const ends = []
    for (const p of document.querySelectorAll('.loom-edges path')) {
      const d = p.getAttribute('d') || ''
      if (seen.has(d) || !d.includes('C')) continue
      seen.add(d)
      const nums = d.match(/-?\d+(?:\.\d+)?/g).map(Number)
      ends.push({ x: nums[nums.length - 2], y: nums[nums.length - 1] })
    }
    const incoming = ends.filter((e) => Math.abs(e.x - left) < 2)
    const ys = incoming.map((e) => e.y)
    return { top, left, height, incoming: ys.length, min: Math.min.apply(null, ys), max: Math.max.apply(null, ys),
      centre: (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2, cardCentre: top + height / 2 }
  })
  assert.ok(metrics.incoming >= 5, `应有 5 条入边落在卡片左缘，实际 ${metrics.incoming}`)
  assert.ok(metrics.max - metrics.min >= 30, `入边锚点应随边数摊开（实际跨度 ${(metrics.max - metrics.min).toFixed(1)}px）`)
  assert.ok(Math.abs(metrics.centre - metrics.cardCentre) <= 8, `锚点应围绕卡片垂直中心（锚点中心 ${metrics.centre.toFixed(1)} vs 卡片中心 ${metrics.cardCentre.toFixed(1)}）`)
  assert.ok(metrics.min >= metrics.top + 2 && metrics.max <= metrics.top + metrics.height - 2, '锚点不应超出卡片上下缘')
  await page.screenshot(join(OUT, 'arch-anchors.png'))
})
