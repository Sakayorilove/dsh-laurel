/**
 * 真实浏览器验证 · 任务节点端口栈垂直居中（0.5.14）。
 *
 * 用户图：`lc_verification`（契约守卫与端到端验收记录）有 8 个输入端口、8 条入边。
 * 端口行从卡片顶部 46px 起、每行 22px，排到 200px，而卡片按内容只有 ~170px：
 * 端口和箭头溢到卡片外，看着就是"没对齐、偏了"。
 * 修复后：卡片至少和端口栈同高，端口栈在卡片可用区里垂直居中，锚点跟端口一致。
 * 这里直接种**用户的真实任务图**来量。
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

const workflow = {
  schemaVersion: '0.1', workflowId: 'loom-default', revision: 1, title: '端口居中回归图', detectedStage: 'implementation',
  evidence: [], assumptions: [], openQuestions: [], executionProposal: null,
  nodes: [
    ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'].map((id, i) => ({
      id: 'src_' + id, kind: 'agent', title: '上游 ' + (i + 1), phase: 'implementation', goal: '产出第 ' + (i + 1) + ' 份产物', role: 'module-developer',
      sourceRefs: [], inputs: [], outputs: [{ name: 'out_' + id, artifactType: 'code-change', required: false }],
      ownership: { writes: ['src/m' + (i + 1) + '/**'], forbiddenWrites: [], sharedResources: [] },
      execution: { backend: 'configured-agent', isolation: 'worktree', timeoutSeconds: 1800, maxRepairAttempts: 1 },
      acceptance: { doneWhen: ['产物可检查'], commands: [], independentVerification: true },
    })),
    {
      id: 'lc_verification', kind: 'agent', title: '契约守卫与端到端验收记录', phase: 'implementation', goal: '汇总验收', role: 'module-developer',
      sourceRefs: [],
      inputs: ['frozen_contract', 'host_core', 'loader_api', 'health_api', 'compat_api', 'update_api', 'repair_api', 'client_bundle'].map((name) => ({ name, artifactType: 'code-change', required: true })),
      outputs: [{ name: 'verification_report', artifactType: 'verification-report', required: false }],
      ownership: { writes: ['tests/smoke.mjs', 'tests/contract/host.mjs', 'tests/contract/kit.mjs', 'tests/installed.mjs', 'docs/验收记录.md'], forbiddenWrites: [], sharedResources: [] },
      execution: { backend: 'configured-agent', isolation: 'worktree', timeoutSeconds: 1800, maxRepairAttempts: 1 },
      acceptance: { doneWhen: ['全部验收脚本通过'], commands: [], independentVerification: true },
    },
  ],
  edges: ['frozen_contract', 'host_core', 'loader_api', 'health_api', 'compat_api', 'update_api', 'repair_api', 'client_bundle'].map((port, i) => ({
    id: 'e' + i, source: 'src_c' + (i + 1), sourcePort: 'out_c' + (i + 1), target: 'lc_verification', targetPort: port, artifactType: 'code-change', require: 'validated',
  })),
}
before(async () => {
  if (skipAll) return
  mkdirSync(OUT, { recursive: true })
  writeFileSync('/tmp/loom-browser-page.html', '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>')
  browser = await launchBrowser({ executablePath: chromePath })
})
after(async () => { if (browser) await browser.close() })

maybe('task port stack fits the card, is centred, and edges land on the dots', async () => {
  const page = await browser.newPage(PAGE_URL)
  const { frameTree } = await page.send('Page.getFrameTree')
  await page.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' })
  await page.evaluate((wf) => {
    sessionStorage.setItem('__loomServerDUMP__', JSON.stringify({ workflow: wf, revisions: [wf] }))
  }, { args: [workflow] })
  await installShell(page, shellHtml(), bundle)
  const mounted = await mountWorkbench(page)
  if (!mounted.ok) throw new Error(`挂载失败：${mounted.why}`)
  await page.waitForFunction(() => document.querySelectorAll('.loom-node').length >= 9, { timeoutMs: 8000 })
  await sleep(250)

  const metrics = await page.evaluate(() => {
    const card = document.querySelector('.loom-node[data-node-id="lc_verification"]')
    const top = parseFloat(card.style.top)
    const left = parseFloat(card.style.left)
    const height = card.offsetHeight
    const dots = [...card.querySelectorAll('.loom-port-in')].map((d) => parseFloat(d.style.top) + 11)
    const seen = new Set()
    const ends = []
    for (const p of document.querySelectorAll('.loom-edges path')) {
      const d = p.getAttribute('d') || ''
      if (seen.has(d) || !d.includes('C')) continue
      seen.add(d)
      const nums = d.match(/-?\d+(?:\.\d+)?/g).map(Number)
      ends.push({ x: nums[nums.length - 2], y: nums[nums.length - 1] })
    }
    const incoming = ends.filter((e) => Math.abs(e.x - left) < 2).map((e) => e.y - top)
    return { top, left, height, dots, incoming }
  })
  assert.equal(metrics.dots.length, 8, `应有 8 个输入端口，实际 ${metrics.dots.length}`)
  assert.equal(metrics.incoming.length, 8, `应有 8 条入边落在卡片左缘，实际 ${metrics.incoming.length}`)
  const minDot = Math.min.apply(null, metrics.dots)
  const maxDot = Math.max.apply(null, metrics.dots)
  assert.ok(minDot >= 44 && maxDot <= metrics.height - 2, `端口栈必须落在卡片内（栈 ${minDot.toFixed(1)}..${maxDot.toFixed(1)}，卡片高 ${metrics.height}）`)
  const stackCentre = (minDot + maxDot) / 2
  const regionCentre = (46 + (metrics.height - 8)) / 2
  assert.ok(Math.abs(stackCentre - regionCentre) <= 8, `端口栈应垂直居中（栈中心 ${stackCentre.toFixed(1)} vs 可用区中心 ${regionCentre.toFixed(1)}）`)
  for (const y of metrics.incoming) {
    const hit = metrics.dots.some((dot) => Math.abs(dot - y) <= 1.5)
    assert.ok(hit, `每条入边都应落在端口上（端点 ${y.toFixed(1)} 不在任何端口中心上）`)
  }
  await page.screenshot(join(OUT, 'task-ports.png'))
})
