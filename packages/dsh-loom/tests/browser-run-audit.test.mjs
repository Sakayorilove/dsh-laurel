/**
 * 真实浏览器验证 · 运行视图的审计报告（S4 / P1-5）。
 *
 * 验的是用户视角的三件事：
 *   1. 每条审计可以展开，看到**完整** findings（不再是拼接成一行）；
 *   2. 展开后有可选中复制的纯文本报告；
 *   3. 点「复制审计报告」走剪贴板，成功后给出提示（失败也有降级提示，不静默）。
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
const PAGE_URL = 'file:///tmp/loom-run-audit-page.html'

let browser = null
let chromePath = null
try { chromePath = findChrome() } catch { chromePath = null }
const hasLibs = (() => {
  try { return existsSync(join(process.env.HOME || '', '.local/chromium-libs/usr/lib/x86_64-linux-gnu/libnspr4.so')) } catch { return false }
})()
const skipAll = !chromePath || !hasLibs
const maybe = (name, fn) => test(name, { skip: skipAll ? '环境缺 Chromium 运行库' : false }, fn)

before(async () => {
  if (skipAll) return
  mkdirSync(OUT, { recursive: true })
  writeFileSync('/tmp/loom-run-audit-page.html', '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>')
  browser = await launchBrowser({ executablePath: chromePath })
})
after(async () => { if (browser) await browser.close() })

maybe('运行视图：审计可展开、报告可复制', async () => {
  const page = await browser.newPage(PAGE_URL)
  const { frameTree } = await page.send('Page.getFrameTree')
  await page.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' })
  await resetServerState(page)
  await installShell(page, shellHtml(), bundle)
  const mounted = await mountWorkbench(page)
  assert.equal(mounted.ok, true, `挂载失败：${mounted.why}`)
  await page.waitForFunction(() => document.querySelectorAll('.loom-node').length > 0, { timeoutMs: 8000 })

  // 切到「运行」视图
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '运行').click() })
  await page.waitForFunction(() => document.querySelector('[data-loom-execution]') || document.querySelector('.loom-panel'), { timeoutMs: 8000 })
  await sleep(200)

  // 展开运行记录的「运行产物与工作树」
  const opened = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('details')]
    const target = boxes.find((d) => (d.querySelector('summary') || {}).textContent && /运行产物与工作树/.test(d.querySelector('summary').textContent))
    if (!target) return false
    target.open = true
    return true
  })
  assert.equal(opened, true, '应有「运行产物与工作树」小节')
  await sleep(200)

  const audits = await page.evaluate(() => [...document.querySelectorAll('details[data-loom-audit]')].map((d) => ({
    id: d.dataset.loomAudit,
    summary: (d.querySelector('summary') || {}).textContent || '',
    findings: [...d.querySelectorAll('li')].map((li) => li.textContent),
    report: (d.querySelector('[data-loom-audit-text]') || {}).textContent || '',
    copyButton: [...d.querySelectorAll('button')].some((b) => b.textContent.trim() === '复制审计报告'),
    open: d.open,
  })))
  assert.equal(audits.length, 2, `应有两条审计，实际 ${audits.length}`)
  const pass = audits.find((a) => /group-1/.test(a.id))
  assert.match(pass.summary, /主审 审计 1 · 通过（覆盖 2 个任务）/)
  assert.ok(pass.findings.includes('接口契约与实现一致') && pass.findings.includes('缺一条边界用例'), `完整 findings 应逐条列出：${JSON.stringify(pass.findings)}`)
  assert.match(pass.report, /审计组 group-1 · 主审 审计 1 · 通过/)
  assert.match(pass.report, /- 缺一条边界用例/)
  assert.equal(pass.copyButton, true, '每条审计都应有复制按钮')
  const fail = audits.find((a) => /group-2/.test(a.id))
  assert.match(fail.report, /- 无额外结论/, '没有 findings 时报告要写「无额外结论」而不是空着')

  // 点复制：必须给出结果提示（成功「已复制」，失败也明确说手动复制）
  await page.evaluate(() => {
    const d = document.querySelector('details[data-loom-audit="group-1"]')
    d.open = true
    const b = [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === '复制审计报告')
    b.click()
  })
  await page.waitForFunction(() => [...document.querySelectorAll('.loom-ok, .loom-note')].some((p) => /已复制审计报告|复制失败/.test(p.textContent)), { timeoutMs: 4000 })
  const notice = await page.evaluate(() => [...document.querySelectorAll('.loom-ok, .loom-note')].map((p) => p.textContent).filter((t) => /审计报告/.test(t))[0] || '')
  assert.match(notice, /已复制审计报告|复制失败/)
  assert.deepEqual(page.pageErrors, [], `页面不该有 JS 异常：${page.pageErrors.join(' | ')}`)
  await page.screenshot(join(OUT, 'run-audit-report.png'))
})
