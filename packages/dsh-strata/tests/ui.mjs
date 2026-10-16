import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DEFAULT_CONFIG, normalizeConfig } from '../lib/core/config.js'
import { MemoryStore, GrantLedger } from '../lib/core/store.js'
import { HistorySearch } from '../lib/core/history.js'
import { createHandler } from '../lib/host/http.js'
import { saveSettings } from '../lib/core/settings.js'

const playwrightModule = process.env.STRATA_PLAYWRIGHT ?? 'playwright'
const { chromium } = await import(playwrightModule.startsWith('/') ? pathToFileURL(playwrightModule).href : playwrightModule)
const uiDeps = process.env.STRATA_UI_DEPS ?? resolve('node_modules')
const output = process.env.STRATA_UI_OUTPUT ?? '/tmp/strata-ui-evidence'
mkdirSync(output, { recursive: true })
const home = mkdtempSync(join(tmpdir(), 'strata-ui-'))
const A = 'D:/演示项目/项目 A'
const B = 'D:/演示项目/项目 B'
const C = 'D:/演示项目/需要完整显示的很长工作区路径/项目 C'
let config = normalizeConfig({})
const store = new MemoryStore(home)
const ledger = new GrantLedger(home)
const headers = [{ id: 'a1', cwd: A }, { id: 'a2', cwd: A }, { id: 'b1', cwd: B }, { id: 'c1', cwd: C }]
const service = {
  listSessions: async () => headers.map((header) => ({ header })),
  readSession: async (id) => ({ session: headers.find((h) => h.id === id), events: [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'alpha 我们决定使用 pnpm。' }], source: { kind: 'user' }, role: 'user' } },
  ] }),
}
const deps = { home, store, ledger, sessionQuery: () => service, config: () => config,
  getConfig: () => config, setConfig: (patch) => { const next = normalizeConfig(patch, config); saveSettings(next, home); config = next; return config } }
deps.history = new HistorySearch(deps)
const handler = createHandler(deps)
const bootstrap = `
let Plugin, Setting;
window.__ModuleLoader__ = { load({factory}) { Plugin = factory((id)=> { if(id==='react')return React; throw Error(id) }, {}); } };
const listeners = new Set(); let binding = {key:'a1'};
window.changeSession = (id) => { binding = {key:id}; for(const fn of listeners)fn(); };
window.root = ReactDOM.createRoot(document.getElementById('root'));
window.activate = () => Plugin.apply({
  uiSession: {adapter:{current:{getSnapshot:()=>binding,subscribe:(fn)=>{listeners.add(fn);return()=>listeners.delete(fn)}}}},
  // 这里扮演「没有装载机」的宿主：聚合插槽 laurel-center.module 尚未被任何父级声明，
  // 所以它必须当未声明处理（真实 SlotCore 下 inject 未声明的键压根不会回调）。
  // 于是 strata 落回兜底路径，自己占一条 settings.section —— 正是本用例要测的形态。
  // 若这里无条件回调，就会把聚合路径也当成可用，测的就不是「单装 strata」了。
  slots: {
    inject:(name,fn)=>(name==='laurel-center.module'?()=>{}:fn()),
    register:(spec,component)=>{window.slotName=spec.name;Setting=component;root.render(React.createElement(Setting));return()=>{}},
  },
  effect:(fn)=>fn()
});`
const fixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;padding:22px;font:14px system-ui,sans-serif;background:#fafafa;color:#252525;color-scheme:light}button,input,select,textarea{font:inherit;color:inherit;border:1px solid #999;border-radius:4px;background:#fff}button:disabled{opacity:.6}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid #176aa3;outline-offset:2px}input[type=checkbox]{accent-color:#176aa3;width:16px;height:16px;flex-shrink:0}
@media(prefers-color-scheme:dark){body{background:#202124;color:#eee;color-scheme:dark}button,input,select,textarea{background:#292b2e;border-color:#888}}
@media(max-width:480px){body{padding:12px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
</style><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>${bootstrap}</script><script src="/client.js"></script><script>activate()</script></html>`
const server = createServer((req, res) => {
  if (req.url === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(fixture) }
  const files = {
    '/react.js': join(uiDeps, 'react/umd/react.development.js'),
    '/react-dom.js': join(uiDeps, 'react-dom/umd/react-dom.development.js'),
    '/client.js': resolve('lib/client.js'),
  }
  if (files[req.url]) { res.setHeader('content-type', 'application/javascript'); return res.end(readFileSync(files[req.url])) }
  return handler(req, res)
})
let browser
let checks = 0
const check = (name, fn) => { fn(); checks++; console.log(`  ✓ ${name}`) }
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_CHROMIUM, args: ['--no-sandbox'] })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1100, height: 950 } })
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const ready = () => page.getByText(/已连接宿主|设置已保存|跨工作区选择已保存|记忆已保存/).first().waitFor()
  await page.goto(url)
  try { await ready() } catch (error) {
    console.log('Page errors:', errors)
    console.log('Page text:', (await page.locator('body').innerText()).slice(0, 1500))
    await page.screenshot({ path: join(output, 'load-failure.png'), fullPage: true })
    throw error
  }
  check('宿主服务能将设置页绑定到当前 A1 会话', () => assert.equal(errors.length, 0))
  assert.equal(await page.evaluate(() => window.slotName), 'settings.section')
  checks++
  console.log('  ✓ 没有装载机时走兜底路径，自己占一条 settings.section（没误注册聚合插槽）')
  assert.equal(await page.getByLabel('工作区', { exact: true }).inputValue(), A)
  assert.equal(await page.getByLabel('会话（保存本会话记忆时需要）', { exact: true }).inputValue(), 'a1')

  const grantB = page.getByLabel(`允许读取工作区: ${B}`, { exact: true })
  await grantB.click(); await ready()
  check('逐工作区勾选保存到授权台账', () => assert.equal(ledger.check(B).allowed, true))
  await grantB.click(); await ready()
  check('取消勾选立即撤销授权', () => assert.equal(ledger.check(B).allowed, false))
  await page.getByLabel('读取全局记忆', { exact: true }).click(); await ready()
  check('全局读取可以独立关闭', () => assert.equal(config.readGlobal, false))

  await page.getByRole('button', { name: '上下文力度', exact: true }).click()
  await page.getByRole('button', { name: '轻量', exact: true }).click(); await ready()
  check('轻量预设修改预算但没有扩大授权', () => { assert.equal(config.maxInjectChars, 800); assert.equal(ledger.active().length, 0) })
  const chars = page.getByLabel('自动注入字符上限（含出处）', { exact: true })
  await chars.fill('1200'); await chars.press('Enter'); await ready()
  check('自定义预算通过键盘保存', () => assert.equal(config.maxInjectChars, 1200))

  await page.getByRole('button', { name: '记忆管理', exact: true }).click()
  const body = page.getByLabel('要记住的内容', { exact: true })
  await body.fill('alpha 工作区决定：使用 pnpm。')
  assert.equal(await body.inputValue(), 'alpha 工作区决定：使用 pnpm。')
  await page.getByRole('button', { name: '保存记忆', exact: true }).click(); await ready()
  check('输入可编辑，手工记忆准确保存到 A1 所属工作区', () => {
    const saved = store.live().find((r) => r.body.includes('工作区决定'))
    assert.equal(saved.workspacePath, A); assert.equal(saved.sessionId, 'a1')
  })
  await page.getByLabel('搜索记忆', { exact: true }).fill('不存在的正文')
  await page.getByRole('button', { name: '搜索', exact: true }).click(); await ready()
  assert.equal(await page.locator('article').count(), 0)
  checks++; console.log('  ✓ 搜索输入和空结果状态可用')

  await page.getByRole('button', { name: '召回预览', exact: true }).click()
  await page.getByLabel('查询内容', { exact: true }).fill('alpha')
  await page.getByRole('button', { name: '运行预览', exact: true }).click()
  await page.locator('pre').waitFor()
  const preview = await page.locator('pre').innerText()
  check('预览显示有出处的内容并遵守所选预算', () => { assert.ok(preview.includes('a2')); assert.ok(preview.length <= 1200) })

  // Inject a failed save and verify that the confirmed toggle stays unchanged.
  await page.getByRole('button', { name: '范围与授权', exact: true }).click()
  await page.route('**/strata/config', async (route) => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '演示保存失败' }) })
    else await route.continue()
  })
  const globalRead = page.getByLabel('读取全局记忆', { exact: true })
  await globalRead.click(); await page.getByRole('alert').waitFor()
  assert.equal(await globalRead.isChecked(), false)
  checks++; console.log('  ✓ 保存失败明确显示错误，勾选不会假装成功')
  await page.unroute('**/strata/config')
  await page.getByText('调整手工保存与预览来源', { exact: true }).click()
  await page.getByRole('button', { name: '刷新连接', exact: true }).click(); await ready()
  await page.getByText('调整手工保存与预览来源', { exact: true }).click()

  await page.evaluate(() => changeSession('b1'))
  await page.waitForFunction((expected) => document.querySelector('select')?.value === expected, B)
  checks++; console.log('  ✓ 切换实际会话后，设置自动跟随 B1')
  await page.evaluate(() => changeSession('a1'))
  await page.waitForFunction((expected) => document.querySelector('select')?.value === expected, A)

  // A single representative viewport/theme batch; no unbounded style iteration.
  for (const [name, width, colorScheme] of [
    ['desktop-light', 1100, 'light'], ['desktop-dark', 1100, 'dark'], ['narrow-light', 375, 'light'], ['narrow-dark', 375, 'dark'],
  ]) {
    await page.setViewportSize({ width, height: 950 }); await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    assert.equal(overflow, false, `${name} must not scroll horizontally`)
    checks++
    console.log(`  ✓ ${name} 无水平溢出`)
  }
  check('浏览器运行无 React/JavaScript 错误', () => assert.deepEqual(errors, []))
  console.log(`浏览器验证通过 ${checks} 项；截图：${output}`)
} finally {
  if (browser) await browser.close()
  await new Promise((resolve) => server.close(resolve))
  rmSync(home, { recursive: true, force: true })
}
