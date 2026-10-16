/**
 * 真实浏览器验证 · 步骤 3 / 评审 C —— **锁定模块是真闸门，不是装饰**。
 *
 * ── 这份文件回答什么问题 ────────────────────────────────────────────────
 * 评审最初只要求 C：「架构视图要能删改模块/关系」。实现里给节点加了
 * `locked` 字段，界面上画了「[锁定]」标签、按钮在「锁定/解锁」间切换 ——
 * 看起来锁定生效了。但**实测点「删除此模块」照样把 locked 节点删掉**，
 * 并且发出了 POST /architecture。
 *
 * 这违反了两条既有语义：
 *   1. src/core/graphchange.ts 的 detectConflicts：锁定对象被
 *      remove/modify/unlock 必须被拒（`LOCKED_OBJECT_MODIFIED`）。
 *   2. 用户直觉：锁 = 冻结。看得见锁、却锁不住，比没有锁更危险 ——
 *      用户会以为冻结了，于是放心让模型接手。
 *
 * 本文件在**真实 Chromium** 里把这两层都测了：
 *   - UI 层：锁定节点的字段输入框与「删除此模块」按钮 `disabled === true`；
 *            本版没有可信解锁入口，按钮禁用。
 *   - 逻辑层（关键）：绕过 UI 直接调 `editRemoveArchNode('core')`，
 *            节点必须仍在、POST /architecture 不得发出。
 *   - 恢复：缺少可信解锁入口时拒绝解除冻结，不能伪装恢复可用。
 *
 * ⚠ 仍然是浏览器内行为，不是 DSH 宿主真实加载（宿主挂载归步骤 4/6）。
 *
 * 运行：
 *   bash scripts/setup-browser.sh
 *   LD_LIBRARY_PATH=~/.local/chromium-libs/usr/lib/x86_64-linux-gnu \
 *     node --test tests/browser-lock-enforce.test.mjs
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

/** 见 browser-draft-edit.test.mjs 的 PAGE_URL 注释：必须真实源，否则 sessionStorage 抛错。 */
const PAGE_URL = 'file:///tmp/loom-browser-page.html'

let browser = null
let chromePath = null
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
  writeFileSync(
    '/tmp/loom-browser-page.html',
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>',
  )
  browser = await launchBrowser({ executablePath: chromePath })
})

after(async () => {
  if (browser) await browser.close()
})

/** 打开页面、挂壳、进**架构视图**、选中一个模块。 */
async function openArchView(selectId) {
  const page = await browser.newPage(PAGE_URL)
  const { frameTree } = await page.send('Page.getFrameTree')
  await page.send('Page.setDocumentContent', {
    frameId: frameTree.frame.id,
    html: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>',
  })
  await resetServerState(page)
  await installShell(page, shellHtml(), bundle, { exposeEdit: true })
  const mounted = await mountWorkbench(page)
  if (!mounted.ok) throw new Error(`挂载失败：${mounted.why}`)

  // 切到架构视图。
  const seg = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '架构')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })
  assert.ok(seg, '工具栏应该有「架构」标签')
  await page.clickAt(seg.x, seg.y)
  await sleep(200)

  // 等架构读回来。
  await page.waitForFunction(
    () => window.__loomLog.requests.some((r) => r.path.startsWith('/architecture')),
    { timeoutMs: 8000 },
  )

  if (selectId) {
    await selectArchNode(page, selectId)
  }
  await sleep(120)
  return page
}

/** 在画布上点一个架构模块卡片，让它成为「选中模块」。 */
async function selectArchNode(page, nodeId) {
  const box = await page.evaluate((id) => {
    // 架构视图的卡片也带 data-node-id（画布是同一套渲染，只换图源）。
    const el = [...document.querySelectorAll('.loom-node')].find((c) => c.dataset.nodeId === id)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }, { args: [nodeId] })
  assert.ok(box, `画布上找不到架构模块 ${nodeId}`)
  await page.clickAt(box.x, box.y)
  await sleep(140)
  return box
}

/** 读右侧「选中模块」面板里各控件与按钮的禁用态。 */
const probePanel = (page) => page.evaluate(() => {
  const panel = [...document.querySelectorAll('.loom-panel')].find((p) =>
    (p.querySelector('h4') || {}).textContent === '选中模块')
  if (!panel) return null
  const btn = (label) => {
    const b = [...panel.querySelectorAll('button')].find((x) => (x.textContent || '').includes(label))
    return b ? b.disabled : null
  }
  const inputs = [...panel.querySelectorAll('input, textarea, select')]
  return {
    lockNotice: (panel.querySelector('.loom-lock') || {}).textContent || '',
    anyInputEnabled: inputs.some((i) => !i.disabled),
    inputCount: inputs.length,
    allInputsDisabled: inputs.length > 0 && inputs.every((i) => i.disabled),
    deleteDisabled: btn('删除此模块'),
    lockBtnDisabled: btn('模块已锁定'),
    lockBtnLabel: (() => {
      const b = [...panel.querySelectorAll('button')].find((x) => /锁定模块|模块已锁定/.test(x.textContent || ''))
      return b ? (b.textContent || '').trim() : null
    })(),
  }
})

const archWrites = (page) => page.evaluate(() =>
  window.__loomLog.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/architecture')).length)

const archNodeIds = (page) => page.evaluate(() => {
  const seen = new Set()
  return [...document.querySelectorAll('.loom-node')].map((c) => c.dataset.nodeId)
})

/* ====================================================================== *
 * 用例
 * ====================================================================== */

const skipAll = !chromePath || !hasLibs
const maybe = (name, fn) =>
  test(name, { skip: skipAll ? '环境缺 Chromium 运行库（先跑 scripts/setup-browser.sh）' : false }, fn)

maybe('架构视图能加载并渲染出预置的 3 个模块', async () => {
  const page = await openArchView(null)
  const ids = await archNodeIds(page)
  for (const id of ['web', 'core', 'store']) {
    assert.ok(ids.includes(id), `架构视图应渲染模块 ${id}，实际 ${ids.join('、')}`)
  }
  await page.screenshot(join(OUT, '11-arch-view.png'))
})

maybe('点锁定模块 core：字段与「删除此模块」都被禁用，只有「解锁」可用', async () => {
  const page = await openArchView('core')
  const p = await probePanel(page)
  assert.ok(p, '应该渲染出「选中模块」面板')
  assert.match(p.lockNotice, /锁定/, `应显示锁定说明，实际「${p.lockNotice}」`)
  assert.equal(p.allInputsDisabled, true, `锁定模块的所有字段输入框都应禁用，实际 inputCount=${p.inputCount} anyEnabled=${p.anyInputEnabled}`)
  assert.equal(p.deleteDisabled, true, '锁定模块的「删除此模块」按钮应禁用')
  assert.equal(p.lockBtnDisabled, true, '没有可信解锁入口时按钮必须禁用')
  assert.equal(p.lockBtnLabel, '模块已锁定', `锁定态下按钮文案应是「解锁模块」，实际「${p.lockBtnLabel}」`)
  await page.screenshot(join(OUT, '12-locked-panel.png'))
})

maybe('绕过 UI 直接调 editRemoveArchNode(core)：节点仍在，且不发 POST /architecture', async () => {
  const page = await openArchView('core')
  const before = await archWrites(page)

  // 关键：**不经按钮**，直接调组件内部的编辑函数 —— 模拟快捷键/批量调用/未来的自动流程。
  // 若守卫只写在 UI 层，这一条必红。
  const res = await page.evaluate(() => {
    const fn = window.__loomEdit && window.__loomEdit.editRemoveArchNode
    if (typeof fn !== 'function') return { ok: false, why: '没有暴露 __loomEdit.editRemoveArchNode' }
    fn('core')
    return { ok: true }
  })
  assert.ok(res.ok, `应能直接调用编辑函数：${res.why || ''}`)
  await sleep(300)

  const after = await archWrites(page)
  assert.equal(after, before, `锁定节点被删时应拒绝写入，POST /architecture 次数不该增加（${before} → ${after}）`)

  const ids = await archNodeIds(page)
  assert.ok(ids.includes('core'), `锁定模块 core 必须仍在画布上，实际 ${ids.join('、')}`)

  const p = await probePanel(page)
  assert.match(p.lockNotice, /锁定/, '拒绝后应仍显示锁定说明')
})

maybe('没有可信解锁入口时，不伪装可以解除冻结', async () => {
  const page = await openArchView('core')
  const before = await archWrites(page)
  const p = await probePanel(page)
  assert.equal(p.lockBtnDisabled, true)
  assert.equal(p.lockBtnLabel, '模块已锁定')
  assert.equal(await archWrites(page), before)
  assert.ok((await archNodeIds(page)).includes('core'))
})

maybe('锁定模块改字段也被拒（不只是删除）', async () => {
  const page = await openArchView('core')
  const before = await archWrites(page)
  const res = await page.evaluate(() => {
    const fn = window.__loomEdit && window.__loomEdit.editArchNodeField
    if (typeof fn !== 'function') return { ok: false, why: '没有暴露 __loomEdit.editArchNodeField' }
    fn('core', 'title', '被锁期间篡改的标题')
    return { ok: true }
  })
  assert.ok(res.ok, `应能直接调用字段编辑函数：${res.why || ''}`)
  await sleep(280)

  const after = await archWrites(page)
  assert.equal(after, before, `锁定节点改字段应被拒，POST /architecture 不该增加（${before} → ${after}）`)

  const p = await probePanel(page)
  assert.match(p.lockNotice, /锁定/, '应仍处于锁定态')
  // 标题未被改掉：面板里的 input value 不应是篡改值
  const titleVal = await page.evaluate(() => {
    const panel = [...document.querySelectorAll('.loom-panel')].find((x) =>
      (x.querySelector('h4') || {}).textContent === '选中模块')
    const i = panel && panel.querySelector('input[type=text]')
    return i ? i.value : null
  })
  assert.notEqual(titleVal, '被锁期间篡改的标题', '锁定期间标题不该被改写')
})
