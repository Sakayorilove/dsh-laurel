/**
 * 计划文件恢复候选（S2 / ）：真实 Chromium + 真实 HTTP handler + 真实 store。
 *
 * 场景就是「窗口重开」：页面重新加载，客户端内存里既没有导出记录（st.promptText）
 * 也没有回复缓存（st.replyText），但项目里的 `.loom/plan.json` 还在，服务端也记着
 * 最近一次规划请求的 requestId。用例只断言两件事：
 *   1. 文件里的 requestId 与最近一次请求一致 → 面板自动出现候选；
 *   2. 不一致（旧文件/别人的文件）→ 不自动预览，手动路径原样保留。
 *
 * 限制（与 browser-real-backend 相同，必须留在证据里）：渲染器是 React fixture，
 * 不是 DSH 真实渲染器；宿主会话服务是 fixture。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoomStore } from '../lib/store.js'
import { createHandler } from '../lib/http.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { knownCapabilities, normalizeWorkspaceId } from '../lib/core/index.js'
import { requestWorkspace } from '../lib/workspace.js'
import { launchBrowser } from './cdp.mjs'
import { shellHtml } from './browser-harness.mjs'
import { samplePlanningReply } from './fixtures.mjs'

const boot = (session) => `<script>
  window.fetch = window.__nativeLoomFetch;
  let selected = '${session}'; const listeners = new Set();
  const ui = { adapter: { current: { getSnapshot: () => ({ key: selected }), subscribe: (f) => { listeners.add(f); return () => listeners.delete(f); } } } };
  window.__loomAllowTestHooks = true;
  const ex = window.__loomLoaded[0].factory(window.__loomRequire); let component;
  const sessions = { using: async (id, options, fn) => fn({ ready: Promise.resolve({ session: {
    beginSubmission: () => ({ requestId: 'fixture-request', abandon() {} }),
    prompt: async () => ({ ok: true })
  } }) }) };
  ex.apply({ uiSession: ui, sessions, slots: { inject: (n, f) => (n === 'laurel-center.module' ? () => {} : f()), register: (_s, c) => { if (_s.name === 'settings.section') component = c; return () => {} } }, effect: (f) => f() });
  window.__loomTest.mount(ex.Workbench, document.getElementById('root'));
</script>`

/**
 * 起一个「已经规划过、模型也写了计划文件」的项目，然后加载客户端页面。
 * 页面加载前客户端没有任何内存状态 —— 这就是窗口重开。
 */
async function openProject({ fileRequestId, planRequestId = 'unused', corrupt = false }) {
  const home = mkdtempSync(join(tmpdir(), 'loom-restore-home-'))
  const cwd = join(home, '项目甲')
  mkdirSync(cwd, { recursive: true })
  const store = new LoomStore(home)
  store.writeSessionActivation('a', true)
  const handler = createHandler({
    store, getConfig: () => DEFAULT_CONFIG, setConfig: () => DEFAULT_CONFIG,
    capabilities: knownCapabilities,
    resolveWorkspace: (req) => requestWorkspace(req, { readTitleSnapshot: async () => ({ session: { cwd } }) }),
    resolveSessionCwd: () => cwd,
    log: { warn() {}, error() {} },
  })
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const html = shellHtml()
    .replace('<head>', '<head><script>window.__nativeLoomFetch = window.fetch.bind(window);</script>')
    .replace('__BUNDLE__', '/client.js')
    .replace('</body>', boot('a') + '</body>')
  const server = createServer((req, res) => {
    if (req.url.startsWith('/loom')) return handler(req, res)
    res.setHeader('content-type', req.url === '/client.js' ? 'text/javascript' : 'text/html; charset=utf-8')
    res.end(req.url === '/client.js' ? code : html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const api = async (route, body) => {
    const res = await fetch(url + '/loom' + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-loom-session': 'a' },
      body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, ...await res.json() }
  }
  // 之前那次规划：导出请求（服务端记 requestId）+ 模型写进项目的计划文件。
  const exported = await api('/planning/export', { goal: '原创任务管理项目，包括前后端', constraints: ['WSL'],
    expectedArchitectureRevision: null, expectedWorkflowRevision: null })
  assert.equal(exported.status, 200, JSON.stringify(exported))
  const reply = samplePlanningReply(exported.data.request)
  const onDisk = { ...reply, requestId: fileRequestId === 'match' ? exported.data.request.payloadHash : fileRequestId }
  // corrupt：把方案改成一坨结构不合法的东西（requestId 仍然匹配，所以会被
  // 认领为「上次的方案」），用来验「找回的候选校验不过」这条路径。
  if (corrupt) {
    onDisk.workflow = { ...onDisk.workflow, nodes: [{ id: 'broken', goal: 123, ownership: {}, inputs: 'not-an-array', outputs: [{ name: 'x', artifactType: 'x' }] }] }
  }
  mkdirSync(join(cwd, '.loom'), { recursive: true })
  writeFileSync(join(cwd, '.loom', 'plan.json'), JSON.stringify(onDisk))
  void planRequestId
  return { home, cwd, store, server, url, workspaceId: normalizeWorkspaceId(cwd), requestId: exported.data.request.payloadHash, fileText: JSON.stringify(onDisk) }
}

async function close(env) {
  await new Promise((resolve) => env.server.close(resolve))
  rmSync(env.home, { recursive: true, force: true })
}

test('a reopened window restores the candidate from the project plan file', async () => {
  const env = await openProject({ fileRequestId: 'match' })
  let browser
  try {
    browser = await launchBrowser()
    const page = await browser.newPage()
    await page.send('Page.navigate', { url: `${env.url}/` })
    // 恢复路径是自动的：面板一打开就应该出现候选，不需要任何点击。
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === '采纳 AI 候选方案'), { timeoutMs: 15000 })
    const text = await page.evaluate(() => document.getElementById('root').textContent)
    assert.match(text, /个架构模块 · 2 个任务/, '候选预览应显示真实模块/任务数：' + text.slice(0, 600))
    const area = await page.evaluate(() => { const n = document.querySelector('[aria-label="AI 架构 JSON 回复"]'); return n ? n.value : null })
    assert.equal(area, env.fileText, '找回的文本应回填到手动粘贴框')
    assert.equal(env.store.listArchitectures(env.workspaceId).length, 0, '自动预览不得写入架构')
    assert.equal(env.store.listRevisions(env.workspaceId).length, 0, '自动预览不得写入任务图')
    assert.deepEqual(page.pageErrors, [])
  } finally { await browser?.close(); await close(env) }
})

test('a restored candidate that fails validation fills the error panel (not just a one-line notice)', async () => {
  // P2-8：重开窗口后找回的候选如果通不过校验，错误要交给**完整错误面板**，
  // 而不是只在 notice 里写一句截断的提示 —— 用户看到的应与关窗口前一致。
  const env = await openProject({ fileRequestId: 'match', corrupt: true })
  let browser
  try {
    browser = await launchBrowser()
    const page = await browser.newPage()
    await page.send('Page.navigate', { url: `${env.url}/` })
    await page.waitForFunction(() => Boolean(document.querySelector('.loom-error')), { timeoutMs: 15000 })
    const state = await page.evaluate(() => ({
      hasErrorPanel: Boolean(document.querySelector('.loom-error')),
      panelText: (document.querySelector('.loom-error') || {}).textContent || '',
      bodyText: document.body.textContent,
      // 找回的文本应回填到手动粘贴框，方便用户继续处理
      paste: (() => { const n = document.querySelector('[aria-label="AI 架构 JSON 回复"]'); return n ? n.value : null })(),
    }))
    assert.equal(state.hasErrorPanel, true, '找回的候选校验不过时应显示错误面板')
    assert.match(state.panelText, /项错误|错误/, '错误面板要有内容：' + state.panelText.slice(0, 200))
    assert.match(state.bodyText, /找回/, '应说明这是从项目里找回的：' + state.bodyText.slice(0, 400))
    assert.ok(state.paste && state.paste.length > 0, '找回的文本要回填到粘贴框')
    assert.deepEqual(page.pageErrors, [])
  } finally { await browser?.close(); await close(env) }
})

test('a plan file from another request is not auto-previewed', async () => {
  const env = await openProject({ fileRequestId: 'someone-elses-request' })
  let browser
  try {
    browser = await launchBrowser()
    const page = await browser.newPage()
    await page.send('Page.navigate', { url: `${env.url}/` })
    // 手动路径先就绪（会话已绑定、面板可用），再确认候选没有被自动认领。
    await page.waitForFunction(() => document.body.textContent.includes('规划并发送给 AI'), { timeoutMs: 15000 })
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 800)))
    const state = await page.evaluate(() => ({
      accept: [...document.querySelectorAll('button')].some((b) => b.textContent === '采纳 AI 候选方案'),
      preview: document.getElementById('root').textContent.includes('个架构模块'),
      paste: (() => { const n = document.querySelector('[aria-label="AI 架构 JSON 回复"]'); return n ? n.value : null })(),
    }))
    assert.equal(state.accept, false, 'requestId 不匹配时不得出现候选按钮')
    assert.equal(state.preview, false, '不得渲染候选预览')
    assert.equal(state.paste, null, '没有导出记录就不该凭空出现候选面板')
    assert.deepEqual(page.pageErrors, [])
  } finally { await browser?.close(); await close(env) }
})
