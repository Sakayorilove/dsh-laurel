/** Actual Chromium + HTTP + filesystem. Renderer uses the existing React fixture,
 * not the DSH renderer; this limitation must remain visible in handoff evidence. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LoomStore } from '../lib/store.js'
import { createHandler } from '../lib/http.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { knownCapabilities, normalizeWorkspaceId } from '../lib/core/index.js'
import { requestWorkspace } from '../lib/workspace.js'
import { launchBrowser } from './cdp.mjs'
import { shellHtml } from './browser-harness.mjs'

test('browser unadopted draft reload, empty project, AI roundtrip and session switching', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-browser-http-'))
  const a = join(home, '项目甲'), b = join(home, '项目乙')
  mkdirSync(a); mkdirSync(b)
  const store = new LoomStore(home)
  store.writeSessionActivation('a',true);store.writeSessionActivation('b',true)
  const handler = createHandler({ store, getConfig: () => DEFAULT_CONFIG, setConfig: () => DEFAULT_CONFIG,
    capabilities: knownCapabilities, resolveWorkspace: (req) => requestWorkspace(req, {
      readTitleSnapshot: async (id) => ({ session: { cwd: id === 'a' ? a : id === 'b' ? b : undefined } }) }), log: { warn() {}, error() {} } })
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const boot = `<script>
    window.fetch = window.__nativeLoomFetch;
    window.__loomSent = [];
    let selected = 'a'; const listeners = new Set();
    window.switchLoomSession = (id) => { selected = id; for (const f of listeners) f(); };
    const ui = { adapter: { current: { getSnapshot: () => ({ key: selected }), subscribe: (f) => { listeners.add(f); return () => listeners.delete(f); } } } };
    window.__loomAllowTestHooks = true;
    const ex = window.__loomLoaded[0].factory(window.__loomRequire); let component;
    const sessions = { using: async (id, options, fn) => fn({ ready: Promise.resolve({ session: {
      beginSubmission: () => ({ requestId: 'fixture-request', abandon() {} }),
      prompt: async (content, mode) => { window.__loomSent.push({ id, content, mode }); return { ok: true }; }
    } }) }) };
    ex.apply({ uiSession: ui, sessions, slots: { inject: (n,f) => (n === 'laurel-center.module' ? () => {} : f()), register: (_s,c) => { if (_s.name === 'settings.section') component=c; return () => {}; } }, effect: (f) => f() });
    window.__loomTest.mount(ex.Workbench, document.getElementById('root'));
  </script>`
  const html = shellHtml().replace('<head>', '<head><script>window.__nativeLoomFetch = window.fetch.bind(window);</script>')
    .replace('__BUNDLE__', '/client.js').replace('</body>', boot + '</body>')
  const server = createServer((req, res) => {
    if (req.url.startsWith('/loom')) return handler(req, res)
    res.setHeader('content-type', req.url === '/client.js' ? 'text/javascript' : 'text/html; charset=utf-8')
    res.end(req.url === '/client.js' ? code : html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await launchBrowser()
    const page = await browser.newPage()
    await page.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` })
    const click = async (text) => {
      try { await page.waitForFunction((text) => [...document.querySelectorAll('button')].some((b) => b.textContent === text && !b.disabled), { args: [text] }) }
      catch (error) { throw new Error(`${text}: ${error.message}; ${JSON.stringify(page.pageErrors)}; ${await page.evaluate(() => document.getElementById('root').textContent.slice(0,1800))}`) }
      await page.evaluate((text) => [...document.querySelectorAll('button')].find((b) => b.textContent === text).click(), { args: [text] })
    }
    await click('新建任务草案'); await click('详细设置'); await click('添加节点')
    await page.waitForFunction(() => document.querySelectorAll('.loom-node').length === 1)
    await page.waitForFunction(() => document.body.textContent.includes('已新增节点'))
    assert.equal(store.readDraft(normalizeWorkspaceId(a)).candidate.nodes.length, 1)
    assert.equal(store.listRevisions(normalizeWorkspaceId(a)).length, 0, 'draft is persisted without adoption')
    await page.send('Page.reload')
    await page.waitForFunction(() => document.querySelectorAll('.loom-node').length === 1)
    await click('架构'); await click('新建架构草案'); await click('添加模块')
    await page.waitForFunction(() => document.body.textContent.includes('已新增架构模块'))
    await click('导出架构提示词')
    await page.waitForFunction(() => document.querySelector('[aria-label="AI 架构 JSON 回复"]'))
    await click('发送给当前 AI 会话')
    await page.waitForFunction(() => window.__loomSent.length === 1)
    assert.equal(await page.evaluate(() => window.__loomSent[0].id), 'a')
    assert.equal(await page.evaluate(() => window.__loomSent[0].mode), 'queue')
    assert.match(await page.evaluate(() => window.__loomSent[0].content[0].text), /baseRevision/)
    const ws = normalizeWorkspaceId(a)
    const arch = store.latestArchitecture('loom-architecture', ws)
    const reply = { baseRevision: 1, candidate: structuredClone(arch) }
    reply.candidate.nodes[0].responsibility = 'AI 改进责任'
    await page.evaluate((text) => {
      const box = document.querySelector('[aria-label="AI 架构 JSON 回复"]'); box.value = text
      box.dispatchEvent(new Event('change', { bubbles: true }))
      box.dispatchEvent(new Event('input', { bubbles: true }))
    }, { args: [JSON.stringify(reply)] })
    await click('预览候选改动'); await click('采纳 AI 候选方案')
    await page.waitForFunction(() => document.body.textContent.includes('已采纳 AI 优化方案'))
    assert.equal(store.latestArchitecture('loom-architecture', ws).nodes[0].responsibility, 'AI 改进责任')
    await page.evaluate(() => window.switchLoomSession('b'))
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === '新建架构草案' && !b.disabled))
    assert.equal(await page.evaluate(() => document.querySelectorAll('.loom-node').length), 0)
    await page.evaluate(() => window.switchLoomSession('a'))
    await page.waitForFunction(() => document.querySelectorAll('.loom-node').length === 1 && [...document.querySelectorAll('button')].some((b) => b.textContent === '导出架构提示词' && !b.disabled))
    assert.equal(await page.evaluate(() => document.body.textContent.includes('宿主未提供工作区')), false)
    assert.equal(await page.evaluate(() => document.querySelectorAll('.loom-node').length), 1)
    await page.evaluate(() => {
      const fetch = window.fetch
      window.__holdArchitecture = true; window.__responseHeld = false
      window.fetch = async (...args) => {
        const response = await fetch(...args)
        if (window.__holdArchitecture && String(args[0]).startsWith('/loom/architecture?')) {
          window.__holdArchitecture = false; window.__responseHeld = true
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
        return response
      }
    })
    await click('刷新')
    await page.waitForFunction(() => window.__responseHeld)
    await page.evaluate(() => window.switchLoomSession('b'))
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === '新建架构草案' && !b.disabled))
    await page.evaluate(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })
    assert.equal(await page.evaluate(() => document.querySelectorAll('.loom-node').length), 0)
    assert.equal(await page.evaluate(() => document.querySelector('.loom-error')?.textContent || ''), '')
    await page.evaluate(() => window.switchLoomSession('a'))
    await page.waitForFunction(() => document.querySelectorAll('.loom-node').length === 1 && [...document.querySelectorAll('button')].some((b) => b.textContent === '导出架构提示词' && !b.disabled))
    assert.deepEqual(page.pageErrors, [])
    const out = new URL('../.browser-evidence/', import.meta.url)
    mkdirSync(out, { recursive: true })
    await page.screenshot(join(out.pathname, 'real-backend-roundtrip.png'))
  } finally { if (browser) await browser.close(); await new Promise((resolve) => server.close(resolve)); rmSync(home, { recursive: true, force: true }) }
})
