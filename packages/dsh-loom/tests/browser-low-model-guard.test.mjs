/**
 * 低配模型护栏（P2-9）：连续两次「候选校验未通过」后，错误面板顶部出现
 * 「建议换更强模型」提示 + 「复制修复指令」按钮；只失败一次时不出现。
 *
 * 驱动点：mock 的 /planning/preview 在 window.__loomPreviewFail = N 时
 * 前 N 次返回 422 INVALID_CANDIDATE。
 *
 * 限制（与其它 browser-* 相同）：渲染器是 React fixture，不是 DSH 真实渲染器。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { launchBrowser, findChrome, sleep } from './cdp.mjs'
import { shellHtml, installShell, mountWorkbench, resetServerState } from './browser-harness.mjs'
import { samplePlanningReply } from './fixtures.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
mkdirSync(join(root, '.browser-evidence'), { recursive: true })
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
  writeFileSync('/tmp/loom-browser-page.html', '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>')
  browser = await launchBrowser({ executablePath: chromePath })
})
after(async () => { if (browser) await browser.close() })

const setTextarea = (page, label, text) => page.evaluate((label, text) => {
  const area = [...document.querySelectorAll('textarea')].find((t) => t.getAttribute('aria-label') === label)
  if (!area) throw new Error('找不到输入框：' + label)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(area, text)
  area.dispatchEvent(new Event('input', { bubbles: true }))
}, { args: [label, text] })

const clickButton = (page, label) => page.evaluate((label) => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label)
  if (!btn) return { found: false, disabled: null }
  const disabled = btn.disabled
  if (!disabled) btn.click()
  return { found: true, disabled }
}, { args: [label] })

/** 挂载工作台 → 切手动模式 → 填目标 → 导出提示词 → 粘贴回复。 */
async function prepare(page, failCount) {
  const { frameTree } = await page.send('Page.getFrameTree')
  await page.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' })
  await resetServerState(page)
  await installShell(page, shellHtml(), bundle)
  const mounted = await mountWorkbench(page)
  if (!mounted.ok) throw new Error('挂载失败：' + mounted.why)
  await page.waitForFunction(() => document.querySelectorAll('.loom-node').length > 0, { timeoutMs: 8000 })

  await page.evaluate((n) => { window.__loomPreviewFail = n }, { args: [failCount] })
  // 切手动模式：面板里的「粘贴回复 + 预览候选改动」才会常驻展开。
  await clickButton(page, '手动')
  await sleep(200)
  await setTextarea(page, '项目目标', '做一个待办网页')
  await clickButton(page, '生成规划提示词')
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some((t) => t.getAttribute('aria-label') === 'AI 架构 JSON 回复'), { timeoutMs: 8000 })
  await setTextarea(page, 'AI 架构 JSON 回复', JSON.stringify(samplePlanningReply({ architectureId: 'loom-architecture', workflowId: 'loom-default', constraints: [], expectedArchitectureRevision: null, expectedWorkflowRevision: null, maxConcurrency: 2 })))
}

/** 点一次「预览候选改动」，返回是否点到。 */
async function clickPreview(page) {
  const res = await clickButton(page, '预览候选改动')
  await sleep(700)
  return res
}

maybe('低配模型护栏：只失败一次不提示，连续两次才出现换模型建议与复制按钮', async () => {
  const page = await browser.newPage(PAGE_URL)
  await prepare(page, 2)

  // 第一次失败：显示错误、不显示护栏
  const first = await clickPreview(page)
  assert.equal(first.found, true, '应能找到「预览候选改动」，实际：' + JSON.stringify(first))
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('[data-loom-lownmodel-guard]'))), false, '只失败一次不该提示换模型')
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('.loom-error'))), true, '第一次失败应显示校验错误')

  // 第二次失败：护栏出现
  await clickPreview(page)
  await page.waitForFunction(() => Boolean(document.querySelector('[data-loom-lownmodel-guard]')), { timeoutMs: 5000 })
  const guard = await page.evaluate(() => {
    const node = document.querySelector('[data-loom-lownmodel-guard]')
    return { streak: node.getAttribute('data-loom-lownmodel-guard'), text: node.textContent, buttons: [...node.querySelectorAll('button')].map((b) => b.textContent.trim()) }
  })
  assert.equal(guard.streak, '2', '计数应为 2')
  assert.match(guard.text, /连续 2 次/)
  assert.match(guard.text, /更强的模型/)
  assert.ok(guard.buttons.some((t) => t.includes('复制修复指令')), '应有复制修复指令按钮：' + JSON.stringify(guard.buttons))

  assert.deepEqual(page.pageErrors, [], '页面不该有 JS 异常：' + page.pageErrors.join(' | '))
})

maybe('低配模型护栏：预览成功后计数清零，再单次失败也不提示', async () => {
  const page = await browser.newPage(PAGE_URL)
  await prepare(page, 1)

  // 失败一次 → 无护栏
  await clickPreview(page)
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('[data-loom-lownmodel-guard]'))), false)

  // 归零失败旋钮 → 预览成功 → 计数清零
  await page.evaluate(() => { window.__loomPreviewFail = 0 })
  await clickPreview(page)
  await sleep(400)
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('[data-loom-lownmodel-guard]'))), false, '成功时不该有护栏')

  // 再失败一次：因为计数已被成功清零，不该提示
  await page.evaluate(() => { window.__loomPreviewFail = 1 })
  await clickPreview(page)
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('[data-loom-lownmodel-guard]'))), false, '成功过一次后单次失败不该提示换模型')

  assert.deepEqual(page.pageErrors, [], '页面不该有 JS 异常：' + page.pageErrors.join(' | '))
})
