/**
 * Laurel 自检（`node tests/smoke-plugin.mjs`，或 `npm test`）
 *
 * 两半都测，而且尽量"真跑"：
 *   - 宿主半边：用假的 ctx 真调 `apply()`，拿真 HTTP handler 发真请求体，
 *     断言配置读写、事件落盘、路由形状；
 *   - 浏览器半边：把 client.js 放进 `node:vm` 里真执行，喂假的
 *     `uiSession.sessionStatus`、假的 `Notification`、假的 `document`，
 *     断言"什么时候该弹、什么时候不该弹"。
 *
 * 依赖只有 node 内置模块。退出码非 0 = 有失败。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')

const store = await import('../lib/store.js')
const host = await import('../lib/index.js')
const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
const clientSource = readFileSync(join(PKG_ROOT, 'lib', 'client.js'), 'utf8')

let passed = 0
const failures = []

async function t(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok    ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL  ${name}\n        ${error?.message ?? error}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

/**
 * 浏览器半边跑在 vm 里，`require('react')` 由下面这个极简替身顶上。
 * 测试里要展开设置页的函数组件（`Toggle` / `Row`）时也必须用**同一个**替身，
 * 否则 `React.createElement` 返回的节点形状和 bundle 里的 `h` 对不上。
 *
 * `useState` 刻意做成"会真的记住"的：不然反复渲染拿到的永远是初始值，
 * 点击按钮之后写进 state 的提示就永远看不见。
 * 槽位在每次 boot 新实例时清空 —— 每个用例都重新 boot，
 * 不清的话会读到上一个用例留下的状态对象。
 */
const testHooks = { slots: [], cursor: 0 }

const testReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    const index = testHooks.cursor++
    if (!(index in testHooks.slots)) testHooks.slots[index] = typeof initial === 'function' ? initial() : initial
    const setState = (next) => {
      const current = testHooks.slots[index]
      testHooks.slots[index] = typeof next === 'function' ? next(current) : next
    }
    return [testHooks.slots[index], setState]
  },
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
}

/** 新起一个受控实例：清掉 hook 槽，组件重新从初始状态开始。 */
function resetTestHooks() {
  testHooks.slots.length = 0
  testHooks.cursor = 0
}

/* ------------------------------------------------------------------ *
 * 假的 HTTP req/res
 * ------------------------------------------------------------------ */

function makeReq(method, url, body) {
  const listeners = { data: [], end: [], error: [] }
  return {
    method,
    url,
    on(event, fn) {
      if (listeners[event]) listeners[event].push(fn)
      return this
    },
    destroy() {},
    flush() {
      if (body !== undefined) for (const fn of listeners.data) fn(Buffer.from(body, 'utf8'))
      for (const fn of listeners.end) fn()
    },
  }
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    headersSent: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value },
    end(payload) { this.body = payload; this.headersSent = true },
  }
}

/** 只提供 webServer 的宿主 ctx，并收集注册的路由。 */
function makeHostCtx(routes) {
  return {
    get(name) {
      if (name === 'webServer') {
        return { register(options) { routes.push(options); return () => {} } }
      }
      return undefined
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer'])
      return callback(this)
    },
    effect(fn) { return fn() },
  }
}

async function call(handler, method, url, body) {
  const req = makeReq(method, url, body)
  const res = makeRes()
  const pending = handler(req, res)
  req.flush()
  await pending
  return { status: res.statusCode, headers: res.headers, body: res.body === undefined ? null : JSON.parse(res.body) }
}

/** 二进制响应（提示音那几条路由返回的是音频字节，不是 JSON）。 */
async function callRaw(handler, method, url) {
  const req = makeReq(method, url)
  const res = makeRes()
  const pending = handler(req, res)
  req.flush()
  await pending
  return { status: res.statusCode, headers: res.headers, body: res.body }
}

/* ------------------------------------------------------------------ *
 * 假的浏览器环境
 * ------------------------------------------------------------------ */

/**
 * 真把 client.js 跑起来。
 * @param {{ config?: object, focused?: boolean, withNotificationApi?: boolean, configFails?: boolean, sessions?: object, snapshot?: Map<string, any> }} options
 */
function bootClient(options = {}) {
  resetTestHooks() // 新实例 = 组件从初始状态重新开始
  const dom = makeDom()
  const state = {
    clock: 1_700_000_000_000,
    focused: options.focused ?? false,
    config: { ...store.DEFAULT_CONFIG, ...(options.config ?? {}) },
    configFails: options.configFails === true,
    audioFails: options.audioFails === true,
    notifications: [],
    events: [],
    fetches: [],
    audios: [],
    focusCalls: 0,
    registration: null,
    /** 模拟「装载机在」：聚合插槽也算已声明，用来验证聚合那条路。 */
    withLaurelCenter: options.withLaurelCenter === true,
    snapshot: options.snapshot ?? new Map(),
    statusListeners: new Set(),
    slots: [],
    sessionsById: options.sessions ?? { s1: { title: '示例会话标题' } },
    soundFiles: options.soundFiles ?? [{ name: 'ding.wav', size: 2048 }],
  }

  /** 每个实例一套 Notification：测试之间不串。 */
  class FakeNotification {
    constructor(title, notificationOptions) {
      this.title = title
      this.options = notificationOptions
      this.onclick = null
      this.onshow = null
      this.onerror = null
      state.notifications.push(this)
    }
  }
  FakeNotification.permission = 'granted'

  /** 自定义提示音走的是 `new Audio(url).play()`，这里记账。 */
  class FakeAudio {
    constructor(src) {
      this.src = src
      this.volume = 1
      state.audios.push(this)
    }
    play() {
      return state.audioFails ? Promise.reject(new Error('音频被挡住了')) : Promise.resolve()
    }
  }

  const FakeDate = class extends Date {
    static now() { return state.clock }
  }

  /**
   * 假 DOM —— 只实现页内卡片真正用到的那一小撮手段。
   *
   * 刻意做得像真的：卡片是**代码自己 createElement 拼出来再挂到 body 上**的，
   * 没有 React 参与。所以要断言"右下角真的出现了一张卡片"，
   * 就得有个能查询、能数子节点的树。
   */
  function makeDom() {
    let idSeq = 0
    function makeNode(tagName) {
      const node = {
        nodeType: 1,
        tagName: String(tagName).toUpperCase(),
        id: '',
        className: '',
        textContent: '',
        title: '',
        type: '',
        style: {},
        dataset: {},
        attributes: {},
        childNodes: [],
        parentNode: null,
        listeners: {},
        get firstChild() { return this.childNodes[0] ?? null },
        setAttribute(name, value) { this.attributes[name] = String(value) },
        getAttribute(name) { return this.attributes[name] ?? null },
        appendChild(child) {
          if (child && child.parentNode) child.parentNode.removeChild(child)
          if (child) child.parentNode = this
          this.childNodes.push(child)
          return child
        },
        removeChild(child) {
          const index = this.childNodes.indexOf(child)
          if (index >= 0) this.childNodes.splice(index, 1)
          if (child) child.parentNode = null
          return child
        },
        addEventListener(type, handler) {
          (this.listeners[type] ??= []).push(handler)
        },
        /** 测试用：模拟一次真实点击。 */
        click() {
          for (const handler of this.listeners.click ?? []) handler({ stopPropagation() {} })
        },
        fire(type) {
          for (const handler of this.listeners[type] ?? []) handler({})
        },
        /** 测试用：把子树压成带类名的列表，便于断言顺序与数量。 */
        flatten() {
          const out = []
          const walk = (node) => {
            out.push(node)
            for (const child of node.childNodes) walk(child)
          }
          walk(this)
          return out
        },
        querySelector(selector) {
          if (!selector.startsWith('.')) return null
          const want = selector.slice(1)
          return this.flatten().find((node) => node !== this && String(node.className).split(/\s+/).includes(want)) ?? null
        },
        querySelectorAll(selector) {
          if (!selector.startsWith('.')) return []
          const want = selector.slice(1)
          return this.flatten().filter((node) => node !== this && String(node.className).split(/\s+/).includes(want))
        },
      }
      Object.defineProperty(node, 'innerText', {
        get() { return [this.textContent, ...this.childNodes.map((c) => c.innerText ?? '')].join('') },
      })
      return node
    }

    const body = makeNode('body')
    const head = makeNode('head')
    const byId = new Map()
    const document = {
      head,
      body,
      hasFocus: () => state.focused,
      visibilityState: 'visible',
      createElement: (tag) => {
        const node = makeNode(tag)
        node.id = `gen-${(idSeq += 1)}`
        return node
      },
      getElementById(id) {
        if (id === 'laurel-toast-host') return byId.get(id) ?? null
        return byId.get(id) ?? null
      },
      appendChild(child) { return body.appendChild(child) },
    }
    // `host`/`style` 是 appendChild 挂上去的，按 id 反查要能查到。
    const originalAppend = body.appendChild.bind(body)
    body.appendChild = (child) => {
      const result = originalAppend(child)
      if (child?.id) byId.set(child.id, child)
      return result
    }
    const originalHeadAppend = head.appendChild.bind(head)
    head.appendChild = (child) => {
      const result = originalHeadAppend(child)
      if (child?.id) byId.set(child.id, child)
      return result
    }
    return { document, body, head, makeNode }
  }

  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error, TypeError, Promise, Map, Set, Symbol,
    isFinite, parseInt, parseFloat, setTimeout, clearTimeout,
    Date: FakeDate,
    document: dom.document,
    navigator: { language: 'zh-CN' },
    location: { origin: 'dsh-app://app' },
    fetch: async (url, init = {}) => {
      const target = String(url)
      state.fetches.push({ url: target, init })
      if (target.endsWith('/config') && init.method === 'POST') {
        const patch = JSON.parse(init.body).config ?? {}
        state.config = { ...state.config, ...patch }
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { config: { ...state.config }, settingsPath: 'S' } }) }
      }
      if (target.endsWith('/config')) {
        // 模拟宿主根本没起来：网络层直接抛。
        if (state.configFails) throw new Error('宿主没起来')
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { config: { ...state.config }, settingsPath: 'S' } }) }
      }
      if (target.endsWith('/sounds')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            data: {
              dir: 'S/sounds',
              files: state.soundFiles,
              configured: state.config.soundFile,
              resolved: state.config.soundFile ? { path: `S/sounds/${state.config.soundFile}`, name: state.config.soundFile, type: 'audio/wav' } : { error: '没有配置自定义提示音（走系统通知音）' },
            },
          }),
        }
      }
      if (target.endsWith('/event')) {
        state.events.push(JSON.parse(init.body))
        return { ok: true, status: 200, json: async () => ({ ok: true }) }
      }
      return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not found' }) }
    },
    window: {
      __ModuleLoader__: { load(definition) { state.registration = definition } },
      focus() { state.focusCalls += 1 },
    },
  }
  if (options.withNotificationApi !== false) sandbox.Notification = FakeNotification
  if (options.withAudioApi !== false) sandbox.Audio = FakeAudio

  vm.runInContext(clientSource, vm.createContext(sandbox), { filename: 'client.js' })
  assert.ok(state.registration, 'client.js 没有调用 window.__ModuleLoader__.load')

  const exportsObject = state.registration.factory((name) => {
    if (name === 'react') return testReact
    throw new Error(`未预期的 require('${name}')`)
  })
  assert.equal(typeof exportsObject.apply, 'function', 'client bundle 没导出 apply')

  const ctx = {
    get(name) {
      if (name === 'uiSession') {
        return {
          sessionStatus: {
            getSnapshot: () => state.snapshot,
            subscribe: (fn) => {
              state.statusListeners.add(fn)
              return () => state.statusListeners.delete(fn)
            },
          },
        }
      }
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: state.sessionsById }) } }
      return undefined
    },
    effect(fn) { return fn() },
    slots: {
      // 只把**聚合插槽**当作「没被声明」—— 这就是「没装装载机」的环境：inject 不回调，
      // 设置页应当走兜底注册 settings.section。其余插槽照常回调（真实里它们由官方声明；
      // 白名单式写法会误伤别的插槽）。想验证聚合那条路见下面那条断言。
      inject: (name, factory) => (name === 'laurel-center.module' && !state.withLaurelCenter ? () => {} : factory()),
      register: (definition, component) => {
        state.slots.push({ definition, component })
        return () => {}
      },
    },
  }

  return {
    state,
    dom,
    exports: exportsObject,
    ctx,
    /** 推进一帧状态快照，并等微任务与定时器队列排空（让配置读取、事件回传落地）。 */
    async emit(next) {
      state.snapshot = next
      for (const fn of [...state.statusListeners]) fn()
      await Promise.resolve()
      await Promise.resolve()
    },
    /** 排空队列：配置读取是"fetch → json"两跳异步，只等微任务会抢跑。 */
    async settle() {
      for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    },
    advance(ms) { state.clock += ms },
    views: () => state.notifications,
    /** 页内卡片：当前挂在页面上的所有 `.laurel-toast`。 */
    toasts: () => {
      const host = dom.document.getElementById('laurel-toast-host')
      return host ? host.querySelectorAll('.laurel-toast') : []
    },
    /** 页内卡片的宿主容器（没弹过就是 null）。 */
    toastHost: () => dom.document.getElementById('laurel-toast-host'),
    /** 给页面里的事件回调放行定时器（自动消失用真定时器，得真的等）。 */
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

/** 启动一个已 apply 的实例（并等首帧配置读取落地）。 */
async function bootApplied(options = {}) {
  const boot = bootClient(options)
  boot.exports.apply(boot.ctx)
  await boot.settle()
  return boot
}

/** "待你回答"的交互对象（形状照 dsh-client-ui-user-questions 的 PendingQuestion）。 */
function pendingQuestion(text) {
  return { kind: 'question', questions: [{ id: 'q1', question: text }] }
}

function sessionFrame(pending, running = true) {
  return new Map([['s1', { running, pendingInteraction: pending ?? null, completionUnread: false }]])
}

/* ------------------------------------------------------------------ *
 * 1. 包结构与静态一致性
 * ------------------------------------------------------------------ */

section('1. 包结构与静态一致性')

await t('package.json 声明了 bundle patch 与 web 客户端半边', () => {
  assert.equal(pkg.name, store.PACKAGE_NAME)
  assert.equal(pkg.version, store.VERSION, 'package.json 的 version 与 store.js 的 VERSION 不一致')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(pkg.exports?.['./client'], './lib/client.js')
  assert.equal(pkg.exports?.['.'], './lib/index.js')
  assert.equal(pkg.private, undefined, '要能发布给别人装，不能是 private')
})

await t('cordis.patch.yml 只有相对路径，没有绝对路径', () => {
  const text = readFileSync(join(PKG_ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(text, /- insert:/)
  assert.match(text, /id: laurel/)
  assert.match(text, /name: \.\/lib\/index\.js/)
  // 注释里可以写示例路径（比如 Windows 自带音效），真正的配置行里不许出现绝对路径。
  const code = text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
  assert.doesNotMatch(code, /[A-Za-z]:[\\/]/, 'patch 的配置行里不该出现 Windows 绝对路径')
})

await t('client.js 是 CJS bundle：id 与包名一致，没有 import/export', () => {
  assert.match(clientSource, /window\.__ModuleLoader__\.load\(/)
  assert.match(clientSource, /id: 'laurel'/)
  assert.doesNotMatch(clientSource, /^\s*import\s/m, 'client bundle 里不能有 import')
  assert.doesNotMatch(clientSource, /^\s*export\s/m, 'client bundle 里不能有 export')
})

await t('client.js 的内置默认值与 store.js 的 DEFAULT_CONFIG 逐项一致', () => {
  const match = clientSource.match(/const FALLBACK = \{([\s\S]*?)\n {4}\}/)
  assert.ok(match, '没找到 FALLBACK 字面量')
  const fallback = new Function(`return {${match[1]}}`)()
  for (const [key, value] of Object.entries(store.DEFAULT_CONFIG)) {
    assert.ok(key in fallback, `client 的 FALLBACK 少了 ${key}`)
    assert.deepEqual(fallback[key], value, `${key} 两边不一致`)
  }
  for (const key of Object.keys(fallback)) assert.ok(key in store.DEFAULT_CONFIG, `client 的 FALLBACK 多了 ${key}`)
})

await t('宿主半边不要求任何必需服务（缺服务只降级，不让宿主起不来）', () => {
  assert.deepEqual(host.inject, [])
  assert.equal(typeof host.apply, 'function')
})

/* ------------------------------------------------------------------ *
 * 2. 配置归一化
 * ------------------------------------------------------------------ */

section('2. 配置归一化')

await t('空输入 → 默认值；未知键被丢掉', () => {
  assert.deepEqual(store.normalizeConfig({}), store.DEFAULT_CONFIG)
  const withJunk = store.normalizeConfig({ 谁知道呢: 1, notifyOnCompletion: true })
  assert.equal(withJunk.notifyOnCompletion, true)
  assert.ok(!('谁知道呢' in withJunk))
})

await t('数值夹到区间，非布尔不当真', () => {
  const cfg = store.normalizeConfig({ throttleSeconds: 99999, maxBodyChars: 1, notifyOnQuestion: 'yes', sound: 0 })
  assert.equal(cfg.throttleSeconds, 3600)
  assert.equal(cfg.maxBodyChars, 20)
  assert.equal(cfg.notifyOnQuestion, store.DEFAULT_CONFIG.notifyOnQuestion, '非布尔值应退回默认，而不是当成 true')
  assert.equal(cfg.sound, store.DEFAULT_CONFIG.sound)
})

await t('soundFile：trim、限长 400、非字符串不接受', () => {
  assert.equal(store.normalizeConfig({ soundFile: '  ding.wav  ' }).soundFile, 'ding.wav')
  assert.equal(store.normalizeConfig({ soundFile: 'x'.repeat(999) }).soundFile.length, 400)
  assert.equal(store.normalizeConfig({ soundFile: 123 }).soundFile, '')
})

/* ------------------------------------------------------------------ *
 * 3. 宿主半边真跑
 * ------------------------------------------------------------------ */

section('3. 宿主半边（真 apply + 真 HTTP handler）')

const tempHome = mkdtempSync(join(tmpdir(), 'laurel-'))
process.env.DSH_HOME = tempHome

try {
  const routes = []
  const first = host.apply(makeHostCtx(routes), {})
  const handler = routes[0]?.handler

  await t('注册了一条 prefix 路由：/laurel', () => {
    assert.equal(routes.length, 1)
    assert.equal(routes[0].kind, 'prefix')
    assert.equal(routes[0].path, '/laurel')
    assert.equal(typeof handler, 'function')
  })

  await t('apply() 返回只读状态快照', () => {
    const snapshot = first.status()
    assert.equal(snapshot.ok, true)
    assert.equal(snapshot.data.package, 'laurel')
    assert.equal(snapshot.data.config.throttleSeconds, store.DEFAULT_CONFIG.throttleSeconds)
    assert.ok(snapshot.data.paths.settings.startsWith(tempHome))
  })

  await t('GET /laurel/config 返回生效配置与两个文件路径', async () => {
    const res = await call(handler, 'GET', '/laurel/config')
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.data.version, store.VERSION)
    assert.ok(res.body.data.settingsPath.endsWith('settings.json'))
    assert.ok(res.body.data.settingsPath.startsWith(tempHome), '数据必须落在 DSH_HOME 下，不能落到 profile 目录里')
    assert.ok(res.body.data.eventsPath.endsWith('events.log'))
  })

  await t('POST /laurel/config 写 settings.json，并在下一次 apply 时盖过 patch 默认值', async () => {
    const res = await call(handler, 'POST', '/laurel/config', JSON.stringify({ config: { notifyOnCompletion: true, throttleSeconds: 5 } }))
    assert.equal(res.status, 200)
    assert.equal(res.body.data.config.notifyOnCompletion, true)
    assert.equal(res.body.data.config.throttleSeconds, 5)

    const settingsPath = join(tempHome, 'laurel', 'settings.json')
    assert.ok(existsSync(settingsPath), 'settings.json 没写出来')
    const saved = JSON.parse(readFileSync(settingsPath, 'utf8'))
    assert.equal(saved.notifyOnCompletion, true)
    assert.equal(saved.throttleSeconds, 5)

    const restarted = host.apply(makeHostCtx([]), { notifyOnCompletion: false })
    assert.equal(restarted.status().data.config.notifyOnCompletion, true, 'settings.json 应当盖过 patch 默认值')
  })

  await t('POST /laurel/config 拒绝非 JSON 请求体', async () => {
    const res = await call(handler, 'POST', '/laurel/config', '这不是 JSON')
    assert.equal(res.status, 400)
    assert.equal(res.body.ok, false)
  })

  await t('POST /laurel/event 落盘、GET /events 读回来', async () => {
    const res = await call(handler, 'POST', '/laurel/event', JSON.stringify({
      kind: 'fire',
      sessionId: 's1',
      title: 'DSH · 示例会话标题',
      body: '有问题想问你：要现在动手吗',
      focused: false,
      supported: true,
    }))
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)

    const events = await call(handler, 'GET', '/laurel/events?limit=5')
    assert.equal(events.status, 200)
    const rows = events.body.data.rows
    assert.ok(rows.length >= 1)
    assert.equal(rows[0].kind, 'fire')
    assert.equal(rows[0].body, '有问题想问你：要现在动手吗')

    const log = readFileSync(join(tempHome, 'laurel', 'events.log'), 'utf8').trim().split('\n')
    assert.ok(log.length >= 2, 'events.log 里应当有 ready 与 fire 两行以上')
    assert.ok(log.every((line) => { try { JSON.parse(line); return true } catch { return false } }), 'events.log 必须是"一行一个 JSON"')
  })

  await t('GET /laurel/status 给出诊断（版本、路径、最后一条事件）', async () => {
    const res = await call(handler, 'GET', '/laurel/status')
    assert.equal(res.status, 200)
    assert.equal(res.body.data.version, store.VERSION)
    assert.ok(res.body.data.events >= 2)
    assert.ok(res.body.data.lastEvent?.t)
  })

  await t('未知端点返回 404', async () => {
    const res = await call(handler, 'GET', '/laurel/忘了')
    assert.equal(res.status, 404)
    assert.equal(res.body.ok, false)
  })

  await t('webServer 晚于插件就绪：等待后挂路由，保存完成通知并可恢复路由', async () => {
    let mount
    let available = false
    const active = new Map()
    const child = {
      get: () => available ? { register(route) {
        assert.equal(active.has(route.path), false, '不能重复挂载')
        active.set(route.path, route)
        return () => active.delete(route.path)
      } } : undefined,
      effect: (fn) => fn(),
    }
    host.apply({
      get: () => undefined,
      inject(deps, callback) {
        assert.deepEqual(deps, ['webServer'])
        mount = callback
      },
    }, {})
    assert.equal(active.size, 0)
    assert.equal(typeof mount, 'function', '服务尚未就绪时也必须登记等待')
    available = true
    const dispose = mount(child)
    const handler = active.get('/laurel').handler
    const saved = await call(handler, 'POST', '/laurel/config', JSON.stringify({ config: { notifyOnCompletion: true } }))
    assert.equal(saved.status, 200)
    assert.equal(saved.body.data.config.notifyOnCompletion, true)
    const loaded = await call(handler, 'GET', '/laurel/config')
    assert.equal(loaded.body.data.config.notifyOnCompletion, true)
    dispose()
    assert.equal(active.size, 0)
    const disposeAgain = mount(child)
    const restored = await call(active.get('/laurel').handler, 'GET', '/laurel/config')
    assert.equal(restored.body.data.config.notifyOnCompletion, true)
    disposeAgain()
  })

  await t('没有 webServer 服务时：等待服务，不抛（插件照样激活）', () => {
    const before = process.env.DSH_HOME
    process.env.DSH_HOME = tempHome
    try {
      let waiting = false
      assert.doesNotThrow(() => host.apply({
        get: () => undefined,
        inject(deps, callback) {
          assert.deepEqual(deps, ['webServer'])
          assert.equal(typeof callback, 'function')
          waiting = true
        },
        effect: (fn) => fn(),
      }, {}))
      assert.equal(waiting, true, '缺少服务时登记等待，不能跳过接口注册')
    } finally {
      process.env.DSH_HOME = before
    }
  })

  /* ---- 自定义提示音 ---- */

  await t('提示音目录：apply 时建好，说明文件就位', () => {
    const dir = store.ensureSoundsDir(tempHome)
    assert.ok(existsSync(dir), '提示音目录没建出来')
    assert.ok(existsSync(join(dir, '把音效放这里.txt')), '应当放一份说明文件，不然用户不知道这个目录干嘛的')
  })

  await t('目录里只列音频文件（说明文件不算）', () => {
    const dir = store.ensureSoundsDir(tempHome)
    writeFileSync(join(dir, 'ding.wav'), Buffer.from('RIFFdingWAVE'))
    writeFileSync(join(dir, 'note.txt'), '不是音频')
    const files = store.listSounds(tempHome)
    assert.deepEqual(files.map((file) => file.name), ['ding.wav'])
    assert.ok(files[0].size > 0)
  })

  await t('GET /laurel/sound?file=… 按字节吐音频，带对的 content-type', async () => {
    const bytes = Buffer.from('RIFFdingWAVE')
    const res = await callRaw(handler, 'GET', '/laurel/sound?file=ding.wav')
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'audio/wav')
    assert.equal(res.headers['content-length'], String(bytes.length))
    assert.ok(Buffer.isBuffer(res.body) && res.body.equals(bytes), '吐出来的应当就是文件字节')
  })

  await t('GET /laurel/sounds 列出目录，并解释当前配置', async () => {
    const res = await call(handler, 'GET', '/laurel/sounds')
    assert.equal(res.status, 200)
    assert.equal(res.body.data.dir, join(tempHome, 'laurel', 'sounds'))
    assert.deepEqual(res.body.data.files.map((file) => file.name), ['ding.wav'])
    assert.ok(res.body.data.resolved.error, '没配 soundFile 时应当说明走系统通知音')
  })

  await t('点名播放不接受路径：不是任意文件读取器', async () => {
    const traversal = await call(handler, 'GET', '/laurel/sound?file=..%2Fevents.log')
    assert.equal(traversal.status, 404)
    assert.match(traversal.body.error, /只接受提示音目录里的文件名/)

    const absolute = await call(handler, 'GET', `/laurel/sound?file=${encodeURIComponent('C:/Windows/Media/ding.wav')}`)
    assert.equal(absolute.status, 404)
    assert.match(absolute.body.error, /只接受提示音目录里的文件名/)
  })

  await t('点名不存在的文件 / 不认的格式 → 404 且说清原因', async () => {
    const missing = await call(handler, 'GET', '/laurel/sound?file=nope.wav')
    assert.equal(missing.status, 404)
    assert.match(missing.body.error, /找不到文件/)

    writeFileSync(join(store.ensureSoundsDir(tempHome), 'sound.exe'), 'nope')
    const wrongType = await call(handler, 'GET', '/laurel/sound?file=sound.exe')
    assert.equal(wrongType.status, 404)
    assert.match(wrongType.body.error, /不认的音频格式/)
  })

  await t('配了文件名 / 绝对路径之后，GET /sound 直接吐配置里那一个', async () => {
    await call(handler, 'POST', '/laurel/config', JSON.stringify({ config: { soundFile: 'ding.wav' } }))
    const byName = await callRaw(handler, 'GET', '/laurel/sound')
    assert.equal(byName.status, 200)
    assert.equal(byName.headers['content-type'], 'audio/wav')

    // Windows 自带音效：写绝对路径，不用拷进目录
    const outside = join(tempHome, 'Windows Notify Calendar.wav')
    writeFileSync(outside, Buffer.from('RIFFoutside'))
    await call(handler, 'POST', '/laurel/config', JSON.stringify({ config: { soundFile: outside } }))
    const byPath = await callRaw(handler, 'GET', '/laurel/sound')
    assert.equal(byPath.status, 200)
    assert.equal(byPath.headers['content-length'], String(Buffer.byteLength('RIFFoutside')))
    assert.equal(byPath.headers['content-type'], 'audio/wav')

    // 远程链接由浏览器直接播，宿主明确拒绝
    await call(handler, 'POST', '/laurel/config', JSON.stringify({ config: { soundFile: 'https://example.com/a.wav' } }))
    const remote = await call(handler, 'GET', '/laurel/sound')
    assert.equal(remote.status, 404)
    assert.match(remote.body.error, /远程链接/)
  })
} finally {
  delete process.env.DSH_HOME
  rmSync(tempHome, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ *
 * 4. 浏览器半边：什么时候该弹
 * ------------------------------------------------------------------ */

section('4. 浏览器半边（client.js 放进 vm 里真跑）')

await t('bundle 暴露 apply/inject，inject 要求 slots + uiSession', () => {
  const boot = bootClient()
  assert.equal(typeof boot.exports.apply, 'function')
  assert.deepEqual([...boot.exports.inject].sort(), ['slots', 'uiSession'])
})

await t('apply() 挂上状态订阅、注册设置页，且启动时不弹任何东西', async () => {
  const boot = await bootApplied()
  assert.equal(boot.state.statusListeners.size, 1, '应当订阅了 uiSession.sessionStatus')
  assert.equal(boot.state.slots.length, 1)
  assert.equal(boot.state.slots[0].definition.id, 'laurel')
  assert.ok(boot.state.events.some((event) => event.kind === 'watch'), '应当回传一条 watch 事件')
  assert.equal(boot.views().length, 0)
})

await t('提问出现 → 弹一条：标题带会话名、正文带问题、不静音、带 tag', async () => {
  const boot = await bootApplied()
  await boot.emit(sessionFrame(pendingQuestion('要不要现在动手改配置')))

  const views = boot.views()
  assert.equal(views.length, 1, `应当只弹一条，实际 ${views.length} 条`)
  assert.match(views[0].title, /示例会话标题/)
  assert.match(views[0].options.body, /有问题想问你/)
  assert.match(views[0].options.body, /要不要现在动手改配置/)
  assert.equal(views[0].options.silent, false, 'sound=true 时不该静音')
  assert.equal(views[0].options.requireInteraction, true, '提问是挡路的事件，默认留在通知中心')
  assert.match(String(views[0].options.tag), /^laurel:question:/)
  assert.ok(boot.state.events.some((event) => event.kind === 'fire' && event.sessionId === 's1'))
})

await t('同一个交互对象反复出现不会重复弹', async () => {
  const boot = await bootApplied()
  const pending = pendingQuestion('重复的那条')
  await boot.emit(sessionFrame(pending))
  await boot.emit(sessionFrame(pending))
  await boot.emit(sessionFrame(pending))
  assert.equal(boot.views().length, 1)
})

await t('时机=两种都发 时：有焦点走卡片，不发系统通知', async () => {
  const boot = await bootApplied({ focused: true, config: { onlyWhenUnfocused: true, toast: true } })
  await boot.emit(sessionFrame(pendingQuestion('有焦点时的问题')))
  assert.equal(boot.views().length, 0, '有焦点不该再发系统通知（同一件事不该弹两遍）')
  assert.equal(boot.toasts().length, 1, '有焦点应当弹一张页内卡片')
  assert.ok(boot.state.events.some((event) => event.kind === 'toast'), '应当留下一条 toast 事件')
})

await t('时机=只后台：有焦点时什么都不发，并留下一条说明原因的 warn', async () => {
  const boot = await bootApplied({ focused: true, config: { onlyWhenUnfocused: true, toast: false } })
  await boot.emit(sessionFrame(pendingQuestion('有焦点时的问题')))
  assert.equal(boot.views().length, 0)
  assert.equal(boot.toasts().length, 0)
  assert.ok(
    boot.state.events.some((event) => event.kind === 'warn' && /通知时机/.test(event.detail ?? '')),
    '应当留下一条按「通知时机」不发通知的 warn',
  )
})

await t('时机=只前台：有焦点弹页内卡片（这一档不走系统通知），窗口收起来时一条都不发', async () => {
  const boot = await bootApplied({ focused: true, config: { onlyWhenUnfocused: false, toastMs: 0 } })
  await boot.emit(sessionFrame(pendingQuestion('前台这一档')))
  assert.equal(boot.toasts().length, 1, '只前台这一档：窗口在前台时走页内卡片')
  assert.equal(boot.views().length, 0, '这一档不走系统通知')

  const away = await bootApplied({ focused: false, config: { onlyWhenUnfocused: false, toastMs: 0 } })
  await away.emit(sessionFrame(pendingQuestion('窗口收起来了')))
  assert.equal(away.views().length, 0, '窗口不在前台时这一档不打扰')
  assert.equal(away.toasts().length, 0)
})

/* -------------------------------------------------------------------------- *
 * 页内卡片（窗口在前台时的通知）
 * -------------------------------------------------------------------------- */

section('4b. 页内卡片：窗口开着也能看到通知')

await t('窗口有焦点时，页面右下角真的出现一张卡片', async () => {
  // toastMs = 0：不自动消失，方便断言；自动消失另外单独测。
  const boot = await bootApplied({ focused: true, config: { toastMs: 0 } })
  await boot.emit(sessionFrame(pendingQuestion('要不要现在动手改配置')))

  const cards = boot.toasts()
  assert.equal(cards.length, 1, '应当有且只有一张卡片')

  const host = boot.toastHost()
  assert.ok(host, '卡片宿主应当挂上了')
  assert.equal(host.style.position, 'fixed', '必须 fixed，否则会跟着滚动跑')
  assert.equal(host.style.right, 20)
  assert.equal(host.style.bottom, 20, '默认在右下角')
  assert.equal(host.style.left, undefined, '右下角不该同时写 left')

  const card = cards[0]
  const text = card.innerText
  assert.match(text, /示例会话标题/, '标题应当带会话名')
  assert.match(text, /需要你回答/, '应当标明这是"需要你回答"这类')
  assert.match(text, /要不要现在动手改配置/, '正文应当带问题内容')
  assert.ok(card.querySelector('.laurel-toast-x'), '应当有右上角关闭按钮')
})

await t('卡片用的是页面自己的字体，不会退化成衬线体', async () => {
  const boot = await bootApplied({ focused: true, config: { toastMs: 0 } })
  await boot.emit(sessionFrame(pendingQuestion('字体检查')))
  // 卡片挂在 body 上，不在 dsh 的字体作用域里：样式表必须显式声明字体。
  const styleEl = boot.dom.document.getElementById('laurel-toast-style')
  assert.ok(styleEl, '应当插入了一份样式表')
  assert.match(styleEl.textContent, /font-family:system-ui/, '必须显式声明无衬线字体栈')
  assert.match(styleEl.textContent, /\.laurel-toast\{/, '样式表里应当有卡片规则')
})

await t('卡片不会把系统通知一起弹出来（同一件事不弹两遍）', async () => {
  const boot = await bootApplied({ focused: true, config: { toastMs: 0 } })
  await boot.emit(sessionFrame(pendingQuestion('别弹两遍')))
  assert.equal(boot.toasts().length, 1)
  assert.equal(boot.views().length, 0, '页内卡片与系统通知二者只走一个')
})

await t('点关闭按钮：卡片消失，并记一条 dismiss', async () => {
  const boot = await bootApplied({ focused: true, config: { toastMs: 0 } })
  await boot.emit(sessionFrame(pendingQuestion('关掉我')))
  assert.equal(boot.toasts().length, 1)

  boot.toasts()[0].querySelector('.laurel-toast-x').click()
  assert.equal(boot.toasts().length, 0, '点关闭后卡片应当从 DOM 里摘掉')
  assert.ok(boot.state.events.some((event) => event.kind === 'dismiss'), '应当记一条 dismiss 事件')
})

await t('点卡片本体：把窗口焦点要回来，并记一条 click', async () => {
  const boot = await bootApplied({ focused: true, config: { toastMs: 0 } })
  await boot.emit(sessionFrame(pendingQuestion('点我')))
  boot.toasts()[0].click()
  assert.equal(boot.state.focusCalls, 1)
  assert.ok(boot.state.events.some((event) => event.kind === 'click' && /页内卡片/.test(event.detail ?? '')))
})

await t('攒够三张就不再多留（旧的先走，否则会糊住整个角落）', async () => {
  const boot = await bootApplied({ focused: true, config: { toastMs: 0, toastOnCompletion: true } })
  // 三个不同的会话，绕开"同一会话节流"
  for (const id of ['s1', 's2', 's3', 's4']) {
    await boot.emit(new Map([
      [id, { running: true, pendingInteraction: { kind: 'question', questions: [{ question: `第 ${id} 条` }] }, completionUnread: false }],
    ]))
  }
  assert.equal(boot.toasts().length, 3, '最多留三张')
  const text = boot.toasts().map((card) => card.innerText).join('\n')
  assert.ok(!/第 s1 条/.test(text), '最早的那张应当被挤掉')
  assert.match(text, /第 s4 条/, '最新的一张应当还在')
})

await t('自动消失：到点自己走掉', async () => {
  const boot = await bootApplied({ focused: true, config: { toastMs: 40 } })
  await boot.emit(sessionFrame(pendingQuestion('我会自己消失')))
  assert.equal(boot.toasts().length, 1)
  await boot.wait(120)
  assert.equal(boot.toasts().length, 0, '到点应当自动消失')
  assert.ok(boot.state.events.some((event) => event.kind === 'dismiss' && /自动消失/.test(event.detail ?? '')))
})

await t('鼠标停在卡片上时先不消失（要能读完正文再点关闭）', async () => {
  const boot = await bootApplied({ focused: true, config: { toastMs: 40 } })
  await boot.emit(sessionFrame(pendingQuestion('别在我看的时候消失')))
  const card = boot.toasts()[0]
  card.fire('mouseenter')
  await boot.wait(120)
  assert.equal(boot.toasts().length, 1, '鼠标在上面时不该自动消失')
  card.fire('mouseleave')
  await boot.wait(120)
  assert.equal(boot.toasts().length, 0, '鼠标离开后重新计时并消失')
})

await t('角落可配：改成左上角就落在左上角', async () => {
  const boot = await bootApplied({ focused: true, config: { toastMs: 0, toastCorner: 'top-left' } })
  await boot.emit(sessionFrame(pendingQuestion('换到左上')))
  const host = boot.toastHost()
  assert.equal(host.style.top, 20)
  assert.equal(host.style.left, 20)
  assert.equal(host.style.bottom, undefined)
  assert.equal(host.style.right, undefined)
})

await t('没有 Notification API 时，卡片仍然能弹出来（这是唯一剩下的通路）', async () => {
  const boot = await bootApplied({ focused: true, config: { toastMs: 0 }, withNotificationApi: false })
  await boot.emit(sessionFrame(pendingQuestion('没有系统通知也要能看到')))
  assert.equal(boot.toasts().length, 1, '系统通知不可用时，页内卡片就是唯一的通知方式')
})

await t('两个通路都关掉时，留下一条说清原因的 error', async () => {
  const boot = await bootApplied({ focused: true, config: { toast: false }, withNotificationApi: false })
  await boot.emit(sessionFrame(pendingQuestion('无路可走')))
  assert.equal(boot.toasts().length, 0)
  assert.equal(boot.views().length, 0)
  assert.ok(
    boot.state.events.some((event) => event.kind === 'error' && /页内卡片也被关掉/.test(event.detail ?? '')),
    '应当明确说清两个通路都不可用',
  )
})

await t('窗口在后台时仍走系统通知（卡片会被最小化的窗口挡住）', async () => {
  const boot = await bootApplied({ focused: false, config: { toastMs: 0 } })
  await boot.emit(sessionFrame(pendingQuestion('后台时的问题')))
  assert.equal(boot.views().length, 1, '后台应当发系统通知')
  assert.equal(boot.toasts().length, 0, '后台不该再插一张看不见的卡片')
})

await t('拿不到 document.body 时：卡片这条路失败，但不抛异常', async () => {
  const boot = await bootApplied({ focused: true, config: { toastMs: 0 } })
  // 把 body 摘掉，模拟文档还没就绪
  boot.dom.document.body = null
  await boot.emit(sessionFrame(pendingQuestion('没有 body')))
  assert.ok(
    boot.state.events.some((event) => event.kind === 'error' && /挂不上去/.test(event.detail ?? '')),
    '应当记一条"挂不上去"的 error，而不是抛出去',
  )
})

await t('同一会话节流：30 秒内第二条被挡，过了就放行', async () => {
  const boot = await bootApplied({ config: { throttleSeconds: 30 } })
  await boot.emit(sessionFrame(pendingQuestion('第一条')))
  assert.equal(boot.views().length, 1)

  boot.advance(5_000)
  await boot.emit(sessionFrame(pendingQuestion('五秒后的第二条')))
  assert.equal(boot.views().length, 1, '节流窗口内不该弹第二条')
  assert.ok(boot.state.events.some((event) => event.kind === 'warn' && /节流/.test(event.detail ?? '')))

  boot.advance(26_000)
  await boot.emit(sessionFrame(pendingQuestion('三十一秒后的第三条')))
  assert.equal(boot.views().length, 2, '过了节流窗口应当放行')
})

await t('审批请求用审批文案，并带上工具名与理由', async () => {
  const boot = await bootApplied({ config: { notifyOnApproval: true } })
  await boot.emit(new Map([['s1', {
    running: true,
    pendingInteraction: { kind: 'approval', toolName: 'pwsh', reason: '需要写工作区外的文件' },
    completionUnread: false,
  }]]))
  const views = boot.views()
  assert.equal(views.length, 1)
  assert.match(views[0].options.body, /pwsh/)
  assert.match(views[0].options.body, /需要写工作区外的文件/)
  assert.match(String(views[0].options.tag), /^laurel:approval:/)
})

await t('审批开关关掉时不弹审批，但提问照弹', async () => {
  const boot = await bootApplied({ config: { notifyOnApproval: false } })
  await boot.emit(new Map([['s1', { running: true, pendingInteraction: { kind: 'approval', toolName: 'pwsh' }, completionUnread: false }]]))
  assert.equal(boot.views().length, 0)
  await boot.emit(sessionFrame(pendingQuestion('审批关了但提问要弹')))
  assert.equal(boot.views().length, 1)
})

await t('计划确认走自己的文案', async () => {
  const boot = await bootApplied()
  await boot.emit(sessionFrame({ kind: 'plan-review', questions: [{ id: 'q1', question: '这版计划可以吗', detail: '……' }] }))
  const views = boot.views()
  assert.equal(views.length, 1)
  assert.match(views[0].options.body, /计划等你确认/)
  assert.match(String(views[0].options.tag), /^laurel:planReview:/)
})

await t('回合结束：默认不弹；打开开关后弹一条（且不常驻）', async () => {
  const off = await bootApplied({ config: { notifyOnCompletion: false } })
  await off.emit(sessionFrame(null, true))
  await off.emit(sessionFrame(null, false))
  assert.equal(off.views().length, 0, '默认关闭时不该因为回合结束而弹')

  const on = await bootApplied({ config: { notifyOnCompletion: true } })
  await on.emit(sessionFrame(null, true))
  await on.emit(sessionFrame(null, false))
  assert.equal(on.views().length, 1)
  assert.equal(on.views()[0].options.requireInteraction, false, '回合结束不该常驻通知中心')
  assert.match(on.views()[0].options.body, /回合结束/)
})

/* -------------------------------------------------------------------------- *
 * 逐类事件 × 两条通路（设置页那张矩阵表）
 * -------------------------------------------------------------------------- */

section('4c. 哪些事件要提醒我：逐类 × 两条通路')

/** 造一个"回合结束"：先 running=true，再 running=false。 */
async function emitTurnEnd(boot) {
  await boot.emit(sessionFrame(null, true))
  await boot.emit(sessionFrame(null, false))
}

await t('"回合结束"默认关（两侧都关），其余三类默认开', async () => {
  assert.equal(store.DEFAULT_CONFIG.notifyOnCompletion, false, '系统通知这一侧默认关：长任务会响很多次')
  assert.equal(store.DEFAULT_CONFIG.toastOnCompletion, false, '页内卡片这一侧也要默认关，两边默认值必须一致')
  assert.equal(store.DEFAULT_CONFIG.toastOnQuestion, true)
  assert.equal(store.DEFAULT_CONFIG.toastOnApproval, true)
  assert.equal(store.DEFAULT_CONFIG.toastOnPlanReview, true)
})

await t('"回合结束"默认关：窗口有焦点时不弹卡片，只留一条说明原因的 warn', async () => {
  const boot = await bootApplied({ focused: true, config: { toastMs: 0 } })
  await emitTurnEnd(boot)
  assert.equal(boot.toasts().length, 0, '默认关就不该弹卡片')
  assert.equal(boot.views().length, 0, '窗口有焦点时也不发系统通知')
  assert.ok(
    boot.state.events.some((event) => event.kind === 'warn' && /completion 这一类已关掉/.test(event.detail ?? '')),
    '应当留下一条说明为什么没弹的 warn',
  )
})

await t('只勾卡片那一列：有焦点弹卡片，系统通知那一侧仍然关着', async () => {
  const boot = await bootApplied({ focused: true, config: { toastOnCompletion: true, notifyOnCompletion: false, toastMs: 0 } })
  await emitTurnEnd(boot)
  assert.equal(boot.toasts().length, 1, '卡片这一列勾上了就该弹')

  // 窗口收起来时走系统通知那一侧 —— 那一侧没勾，所以什么都不发。
  const away = await bootApplied({ focused: false, config: { toastOnCompletion: true, notifyOnCompletion: false } })
  await emitTurnEnd(away)
  assert.equal(away.views().length, 0, '系统通知那一列没勾，窗口收起来时不该响')
  assert.equal(away.toasts().length, 0)
})

await t('只勾系统通知那一列：窗口收起来时弹，有焦点时不弹卡片', async () => {
  const away = await bootApplied({ focused: false, config: { notifyOnCompletion: true, toastOnCompletion: false } })
  await emitTurnEnd(away)
  assert.equal(away.views().length, 1, '系统通知这一列勾上了')

  const here = await bootApplied({ focused: true, config: { notifyOnCompletion: true, toastOnCompletion: false, toastMs: 0 } })
  await emitTurnEnd(here)
  assert.equal(here.toasts().length, 0, '卡片那一列没勾')
})

await t('关掉"回合结束"不影响提问：提问照弹卡片', async () => {
  const boot = await bootApplied({ focused: true, config: { toastOnCompletion: false, toastMs: 0 } })
  await boot.emit(sessionFrame(pendingQuestion('这一类还开着')))
  assert.equal(boot.toasts().length, 1, '关的是完成类，不该连累提问')
})

await t('把提问的卡片那一列也关掉：这类连卡片都不弹', async () => {
  const boot = await bootApplied({ focused: true, config: { toastOnQuestion: false, toastMs: 0 } })
  await boot.emit(sessionFrame(pendingQuestion('这一类被关了')))
  assert.equal(boot.toasts().length, 0)
  assert.equal(boot.views().length, 0)
})

await t('全部关掉：自动的一律不弹，但设置页的测试按钮仍然能弹', async () => {
  const boot = await bootApplied({
    focused: true,
    config: {
      notifyOnQuestion: false, notifyOnApproval: false, notifyOnCompletion: false,
      toastOnQuestion: false, toastOnApproval: false, toastOnPlanReview: false, toastOnCompletion: false,
      toastMs: 0,
    },
  })
  await boot.emit(sessionFrame(pendingQuestion('全关了')))
  await emitTurnEnd(boot)
  assert.equal(boot.toasts().length, 0, '自动的一条都不该弹')

  // 手动按钮是用户自己按的：他按了就得给他看，否则又没法验证了。
  const settings = boot.state.slots[0]
  findButton(renderSettings(settings.component).tree, '试页内卡片').props.onClick()
  assert.equal(boot.toasts().length, 1, '手动测试按钮不受矩阵勾选限制')
})

await t('矩阵里点一下"回合结束 页内卡片"：只改卡片那一侧，并存回宿主', async () => {
  const boot = await bootApplied({ focused: true, config: { toastMs: 0 } })
  const settings = boot.state.slots[0]
  const cell = findButton(renderSettings(settings.component).tree, '回合结束 页内卡片')
  assert.ok(cell, '矩阵里应当有"回合结束 页内卡片"这个格子')
  cell.props.onClick()
  await boot.settle()
  const saved = boot.state.fetches.filter((request) => String(request.url).endsWith('/config') && request.init?.method === 'POST')
  assert.ok(
    saved.some((request) => JSON.parse(request.init.body).config.toastOnCompletion === true),
    '应当把 toastOnCompletion=true 存回宿主',
  )
  assert.ok(
    saved.every((request) => JSON.parse(request.init.body).config.notifyOnCompletion === undefined),
    '不该顺手改掉系统通知那一侧',
  )
  assert.equal(boot.state.config.notifyOnQuestion, true, '不该连带改掉别的类别')
})

await t('真实长度的 sessionId 下，通知 tag 拼上 origin 后不超 Windows 的 64 字符上限', async () => {
  // 回归测试：dsh 真实的 sessionId 是 `session-` + 36 位 UUID（43 字符）。
  // Chromium 交给 Windows 前会把 tag 拼成 `n#<origin>#<tag>`，dsh 的 origin 是
  // dsh-app://app，前缀 `n#dsh-app://app#` 占 16 字符 —— 留给插件的预算只有 48。
  // 曾经直接把 sessionId 塞进 tag，拼完 78 字符，Windows 抛
  // 「通知標籤的大小太大」并**整条丢弃**通知，而 Notification.onerror 不触发，
  // 所以现象是「events.log 记了 fire，但通知永远不弹」。
  const realId = 'session-d6c2fa9e-451a-4cbb-abd5-5c3f5f3a2d81'
  const LIMIT = 64
  const wire = (tag) => `n#dsh-app://app#${tag}`
  const check = (tag, what) => {
    assert.ok(
      wire(tag).length <= LIMIT,
      `${what}的 tag 拼上 origin 后 ${wire(tag).length} 字符，超过 Windows Toast Tag 的 ${LIMIT} 上限（整条通知会被丢弃）：${wire(tag)}`,
    )
  }

  // 提问（走 pendingInteraction 分支）
  const bootQ = await bootApplied()
  await bootQ.emit(new Map([[realId, { running: true, pendingInteraction: pendingQuestion('真实长度的会话 id'), completionUnread: false }]]))
  check(String(bootQ.views().at(-1).options.tag), '提问通知')

  // 回合结束（走 running true→false 分支，正是线上一直不响的那条）
  const bootC = await bootApplied({ config: { notifyOnCompletion: true } })
  await bootC.emit(new Map([[realId, { running: true, pendingInteraction: null, completionUnread: false }]]))
  await bootC.emit(new Map([[realId, { running: false, pendingInteraction: null, completionUnread: true }]]))
  check(String(bootC.views().at(-1).options.tag), '回合结束通知')

  // 压缩后仍要保住「同一会话的通知互相替换」语义：tag 必须对同一 (kind, sessionId) 稳定
  const bootQ2 = await bootApplied()
  await bootQ2.emit(new Map([[realId, { running: true, pendingInteraction: pendingQuestion('换一条问题'), completionUnread: false }]]))
  assert.equal(
    String(bootQ2.views().at(-1).options.tag),
    String(bootQ.views().at(-1).options.tag),
    '同一会话同一 kind 的 tag 必须稳定，否则通知不会互相替换',
  )

  // 短 sessionId 应当原样保留可读 tag（不无谓压缩）
  const bootShort = await bootApplied()
  await bootShort.emit(sessionFrame(pendingQuestion('短 id')))
  assert.equal(String(bootShort.views().at(-1).options.tag), 'laurel:question:s1')
})

await t('"因为提问而停下来"时只弹提问那条，不叠加完成通知', async () => {
  const boot = await bootApplied({ config: { notifyOnCompletion: true } })
  await boot.emit(sessionFrame(null, true))
  await boot.emit(sessionFrame(pendingQuestion('停下来了，等你回答'), false))
  assert.equal(boot.views().length, 1)
  assert.match(boot.views()[0].options.body, /有问题想问你/)
})

await t('正文超长会截断到 maxBodyChars', async () => {
  const boot = await bootApplied({ config: { maxBodyChars: 40 } })
  await boot.emit(sessionFrame(pendingQuestion('这是一句很长的提问'.repeat(20))))
  const body = boot.views()[0].options.body
  assert.ok(body.length <= 40, `正文应当 ≤40 字符，实际 ${body.length}`)
  assert.ok(body.endsWith('…'))
})

await t('标题前缀配置生效', async () => {
  const boot = await bootApplied({ config: { title: 'DSH' } })
  await boot.emit(sessionFrame(pendingQuestion('带前缀')))
  assert.match(boot.views()[0].title, /^DSH · /)
})

await t('拿不到会话标题时退回 DSH', async () => {
  const boot = await bootApplied({ sessions: {} })
  await boot.emit(sessionFrame(pendingQuestion('没有标题')))
  assert.equal(boot.views()[0].title, 'DSH')
})

await t('会话行只给了 displayTitle 时也能当标题', async () => {
  const boot = await bootApplied({ sessions: { s1: { displayTitle: '另一条会话' } } })
  await boot.emit(sessionFrame(pendingQuestion('换个字段')))
  assert.equal(boot.views()[0].title, '另一条会话')
})

await t('点通知会把焦点要回来，并记一条 click', async () => {
  const boot = await bootApplied()
  await boot.emit(sessionFrame(pendingQuestion('点我')))
  const view = boot.views()[0]
  assert.equal(typeof view.onclick, 'function')
  view.onclick()
  assert.equal(boot.state.focusCalls, 1)
  assert.ok(boot.state.events.some((event) => event.kind === 'click'))
})

await t('没有 Notification API 的环境：不抛异常，改走页内卡片', async () => {
  const boot = await bootApplied({ withNotificationApi: false, config: { toastMs: 0 } })
  await boot.emit(sessionFrame(pendingQuestion('没有 API 的环境')))
  assert.equal(boot.views().length, 0, '没有 Notification API 自然弹不出系统通知')
  assert.equal(boot.toasts().length, 1, '但页内卡片仍然能让用户看到')
})

await t('拿不到 uiSession.sessionStatus：记 error，且不炸', async () => {
  const boot = bootClient()
  boot.exports.apply({ get: () => undefined, effect: (fn) => fn(), slots: boot.ctx.slots })
  await boot.settle()
  assert.ok(boot.state.events.some((event) => event.kind === 'error' && /sessionStatus/.test(event.detail ?? '')))
})

await t('读不到宿主配置时：留 warn，并退回内置默认值继续工作', async () => {
  const boot = await bootApplied({ configFails: true })
  assert.ok(boot.state.events.some((event) => event.kind === 'warn' && /宿主没起来/.test(event.detail ?? '')), '应当回传读配置失败的 warn')
  await boot.emit(sessionFrame(pendingQuestion('读不到配置也要弹')))
  assert.equal(boot.views().length, 1, '内置默认值里提问是开的，应当照弹')
})

await t('自定义提示音：通知自动静音，并按配置播那一个', async () => {
  const boot = await bootApplied({ config: { soundFile: 'ding.wav' } })
  await boot.emit(sessionFrame(pendingQuestion('带自定义音')))
  assert.equal(boot.views().length, 1)
  assert.equal(boot.views()[0].options.silent, true, '有自定义音时系统通知音应当静音，避免两声叠一起')
  assert.equal(boot.state.audios.length, 1)
  assert.equal(boot.state.audios[0].src, '/laurel/sound?file=ding.wav')
  assert.ok(boot.state.events.some((event) => event.kind === 'fire' && /自定义提示音/.test(event.detail ?? '')), '事件里应当写明用了自定义音')
})

await t('没配自定义音：走系统通知音，不创建 Audio', async () => {
  const boot = await bootApplied()
  await boot.emit(sessionFrame(pendingQuestion('系统音')))
  assert.equal(boot.views()[0].options.silent, false)
  assert.equal(boot.state.audios.length, 0)
  assert.ok(boot.state.events.some((event) => /系统提示音/.test(event.detail ?? '')))
})

await t('绝对路径走宿主端点；http 链接原样交给浏览器', async () => {
  const byPath = await bootApplied({ config: { soundFile: 'C:/Windows/Media/Windows Notify Calendar.wav' } })
  await byPath.emit(sessionFrame(pendingQuestion('绝对路径')))
  assert.equal(byPath.state.audios[0].src, '/laurel/sound')

  const remote = await bootApplied({ config: { soundFile: 'https://example.com/ding.wav' } })
  await remote.emit(sessionFrame(pendingQuestion('远程链接')))
  assert.equal(remote.state.audios[0].src, 'https://example.com/ding.wav')
})

await t('提示音总开关关掉：静音，且不播自定义音', async () => {
  const boot = await bootApplied({ config: { sound: false, soundFile: 'ding.wav' } })
  await boot.emit(sessionFrame(pendingQuestion('完全静音')))
  assert.equal(boot.views()[0].options.silent, true)
  assert.equal(boot.state.audios.length, 0)
})

await t('提示音播不动：记一条 error，通知照弹', async () => {
  const boot = await bootApplied({ config: { soundFile: 'ding.wav' }, audioFails: true })
  await boot.emit(sessionFrame(pendingQuestion('播不动')))
  await boot.settle()
  assert.equal(boot.views().length, 1, '提示音失败不该影响通知本身')
  assert.ok(boot.state.events.some((event) => event.kind === 'error' && /播放失败/.test(event.detail ?? '')))
})

await t('没有 Audio API：记 error 并退回系统通知音', async () => {
  const boot = await bootApplied({ config: { soundFile: 'ding.wav' }, withAudioApi: false })
  await boot.emit(sessionFrame(pendingQuestion('没有 Audio')))
  assert.equal(boot.views().length, 1)
  assert.equal(boot.views()[0].options.silent, false, '播不了自定义音就该让系统音出声')
  assert.ok(boot.state.events.some((event) => event.kind === 'error' && /Audio API/.test(event.detail ?? '')))
})

await t('装载机在时，设置页聚合进总控插槽、不再单独占一条', async () => {
  const boot = await bootApplied({ withLaurelCenter: true })
  const names = boot.state.slots.map((s) => s.definition.name)
  assert.ok(names.includes('laurel-center.module'), `应当注册进聚合插槽，实际：${JSON.stringify(names)}`)
  assert.ok(!names.includes('settings.section'), `聚合成立后不该再占 settings.section，实际：${JSON.stringify(names)}`)
  assert.equal(boot.state.slots[0].definition.id, 'laurel',
    '聚合后 id 不变 —— 装载机就是靠它把总控里那张卡片和这段设置内容对上的')
})

await t('设置页：注册到 settings.section，组件能真的渲染出树', async () => {
  const boot = await bootApplied()
  const settings = boot.state.slots[0]
  assert.equal(settings.definition.name, 'settings.section')
  assert.equal(settings.definition.label(), '通知')
  assert.ok(boot.state.fetches.some((request) => String(request.url).endsWith('/config')))

  // 直接调一次函数组件（React 用的是测试里的极简替身）：能跑通、返回一棵树，
  // 就说明设置页里没有拼错的变量名或未定义的函数。
  // `h(Toggle, …)` / `h(Row, …)` 的内容在组件返回值里而不在 `.children` 里，
  // 所以交给 walkSettings 展开，否则这些开关行对断言是隐形的。
  const { tree } = renderSettings(settings.component)
  assert.equal(typeof tree, 'object')
  const labels = []
  walkSettings(tree, labels)
  assert.ok(labels.some((label) => label.includes('测试通知')), '设置页里应当有「测试通知」按钮')
  assert.ok(labels.some((label) => label.includes('自定义提示音')), '设置页里应当有自定义提示音输入区')
  assert.ok(labels.some((label) => label === '试听'), '设置页里应当有「试听」按钮')
  assert.ok(labels.some((label) => label.includes('ding.wav')), '设置页里应当列出提示音目录里的文件')
  assert.ok(labels.some((label) => label === '试页内卡片'), '设置页里应当有「试页内卡片」按钮')

  // 通知时机：三档都在场（压成了一行胶囊，所以文案是短的那一版），
  // 原来那两个布尔开关不该再单独出现
  assert.ok(labels.some((label) => label === '通知时机'), '设置页里应当有「通知时机」这一组')
  for (const chip of ['只在后台', '只在前台', '两种都发']) {
    assert.ok(labels.some((label) => label === chip), `三档之一「${chip}」应当在场`)
  }
  assert.ok(!labels.some((label) => label.includes('只在没看窗口时通知')), '旧开关「只在没看窗口时通知」应当已被三选一取代')
  assert.ok(!labels.some((label) => label.includes('窗口在前台时弹页内卡片')), '旧开关「窗口在前台时弹页内卡片」应当已被三选一取代')

  // 事件矩阵：两列表头 + 四行事件
  assert.ok(labels.some((label) => label === '哪些事件要提醒我'), '设置页里应当有事件矩阵')
  assert.ok(labels.some((label) => label === '系统通知'), '矩阵应当有「系统通知」这一列表头')
  assert.ok(labels.some((label) => label === '页内卡片'), '矩阵应当有「页内卡片」这一列表头')
  for (const kind of ['需要你回答', '需要你审批', '计划待确认', '回合结束']) {
    assert.ok(labels.some((label) => label === kind), `矩阵里应当有「${kind}」这一行`)
  }
  assert.ok(!labels.some((label) => label.includes('哪些事值得打断我')), '重复的那一栏应当已并进矩阵')
})

/**
 * 收集设置页那棵树里所有可见文字。
 * `h(Toggle, …)` / `h(Row, …)` 是未展开的函数组件元素：内容不在 `.children` 里，
 * 而在组件返回值里，所以对函数类型的节点要按它的 props 再执行一次。
 *
 * 展开函数组件会消耗极简 React 的 hook 槽，所以先把游标归零 ——
 * 归零后再渲染，拿到的才是"这一帧"的状态，否则会读到别的槽位。
 */
function walkSettings(node, out = []) {
  if (typeof node === 'string') { out.push(node); return out }
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) walkSettings(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  walkSettings(node.children, out)
  if (typeof node.type === 'function') walkSettings(node.type(node.props ?? {}), out)
  return out
}

/** 渲染一次设置页，并把它这一帧的状态读出来（模拟 React 每次渲染从头走 hooks）。 */
function renderSettings(component) {
  testHooks.cursor = 0
  const tree = component()
  return { tree, state: testHooks.slots[0] }
}

/**
 * 在设置页那棵树里按"名字"找一个按钮（React 用的是测试里的极简替身）。
 *
 * 矩阵里那些方格按钮里面只有一个 ✓，光靠可见文字分不出是哪一格，
 * 所以它们的名字放在 `aria-label` / `title` 上（也是给读屏软件用的），
 * 这两种名字一并匹配。
 */
function findButton(node, name) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child, name)
      if (hit) return hit
    }
    return null
  }
  if (typeof node.type === 'string' && node.type === 'button') {
    const props = node.props ?? {}
    if (String(node.children) === name) return node
    if (props['aria-label'] === name || props.title === name) return node
  }
  return findButton(node.children, name)
}

await t('设置页的「试页内卡片」按钮：点了就在右下角弹卡片，不发系统通知', async () => {
  const boot = await bootApplied({ focused: true, config: { toastMs: 0 } })
  const settings = boot.state.slots[0]
  const button = findButton(settings.component(), '试页内卡片')
  assert.ok(button, '设置页里应当能找到「试页内卡片」按钮')
  assert.equal(typeof button.props?.onClick, 'function', '按钮应当挂了点击处理')

  button.props.onClick()

  assert.equal(boot.toasts().length, 1, '点了就应当弹一张卡片 —— 这是唯一能立刻亲眼验证的方式')
  assert.equal(boot.views().length, 0, '不该同时发系统通知')
  assert.match(boot.toasts()[0].innerText, /DSH 通知测试/, '卡片应当是测试文案')

  // 重新渲染一次，才看得到点击后写进 state 的提示。
  const { tree: afterTree } = renderSettings(settings.component)
  const after = walkSettings(afterTree)
  assert.ok(after.some((label) => label.includes('卡片已弹出')), `设置页应当给出"看右下角"的提示，实际文字：${JSON.stringify(after.slice(-12))}`)
})

await t('「试页内卡片」按钮在卡片总开关关掉时说清原因，而不是静默无反应', async () => {
  const boot = await bootApplied({ focused: true, config: { onlyWhenUnfocused: true, toast: false } })
  const settings = boot.state.slots[0]
  const button = findButton(settings.component(), '试页内卡片')
  button.props.onClick()
  assert.equal(boot.toasts().length, 0)
  assert.ok(
    boot.state.events.some((event) => event.kind === 'error' && /卡片已在设置里关掉/.test(event.detail ?? '')),
    '应当说清是总开关关着',
  )
})

await t('「测试通知」按钮走系统通知，不受窗口是否有焦点影响', async () => {
  // 这条按钮刻意 force：窗口在前台也发系统通知，这样用户能验证通知中心那一路。
  const boot = await bootApplied({ focused: true, config: { toastMs: 0 } })
  const settings = boot.state.slots[0]
  findButton(settings.component(), '测试通知').props.onClick()
  await boot.settle()
  assert.equal(boot.views().length, 1, '应当发一条系统通知')
  assert.equal(boot.toasts().length, 0, '不该同时插一张卡片')
})

/* -------------------------------------------------------------------------- *
 * 4f. 设置页版面：功能重复的控件已合并
 * -------------------------------------------------------------------------- */

section('4f. 设置页版面：重复的控件合并、区块归位')

/**
 * 取出某个区块（`data-laurel-block` 认领的那一层）里的全部可见文字。
 * 界面上一堆 div 长得一样，"这几个控件在同一块里"只能靠这个锚点断言。
 */
function blockLabels(tree, title) {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (node.props?.['data-laurel-block'] === title) { walkSettings(node.children, out); return }
    walk(node.children)
  }
  walk(tree)
  return out
}

await t('刷新动作只剩一个：两个同功能的按钮（重新读取配置 / 重新扫描目录）已并成一个', async () => {
  const boot = await bootApplied()
  const labels = walkSettings(renderSettings(boot.state.slots[0].component).tree)
  assert.equal(labels.filter((label) => label === '重新读取').length, 1, '「重新读取」应当只出现一次')
  assert.ok(!labels.includes('重新扫描目录'), '旧的「重新扫描目录」应当已合并掉')
  assert.ok(!labels.includes('重新读取配置'), '旧的「重新读取配置」应当已改名')
})

await t('矩阵里每一行都有自己的系统通知格：提问与计划确认不再共用一个开关', async () => {
  const boot = await bootApplied({ focused: true, config: { toastMs: 0 } })
  const settings = boot.state.slots[0]
  const tree = renderSettings(settings.component).tree

  // 每一行都得画全两格 —— 旧版的跨行合并格视觉上落在第二行，
  // 「需要你回答」的系统通知格看起来是空的，被当成错位（2026-09-30 用户截图）。
  for (const label of ['需要你回答', '计划待确认', '需要你审批', '回合结束']) {
    assert.ok(findButton(tree, `${label} 系统通知`), `「${label}」应当有自己的系统通知格`)
    assert.ok(findButton(tree, `${label} 页内卡片`), `「${label}」应当有自己的页内卡片格`)
  }
  assert.equal(
    findButton(tree, '需要你回答 / 计划待确认 系统通知'),
    null,
    '不该再有跨行的合并格 —— 那正是"看着像错位"的来源',
  )
  assert.equal(findButton(tree, '计划待确认 系统通知').props['aria-pressed'], true, '默认开着')

  // 点「计划待确认」的系统通知格：只改它自己的 notifyOnPlanReview，别连坐提问。
  findButton(tree, '计划待确认 系统通知').props.onClick()
  await boot.settle()
  const saved = boot.state.fetches.filter((request) => String(request.url).endsWith('/config') && request.init?.method === 'POST')
  assert.ok(
    saved.some((request) => JSON.parse(request.init.body).config.notifyOnPlanReview === false),
    '「计划待确认」的系统通知格改的应当是它自己的 notifyOnPlanReview',
  )
  assert.ok(
    saved.every((request) => Object.keys(JSON.parse(request.init.body).config).length === 1),
    '一次只改这一个键，别连坐改掉别的类别',
  )
})

await t('版面：五个区块各就各位，控件都收进了自己那一块', async () => {
  const boot = await bootApplied()
  const tree = renderSettings(boot.state.slots[0].component).tree
  const labels = walkSettings(tree)

  for (const title of ['通知时机', '哪些事件要提醒我', '系统通知（窗口没在前台时）', '页内卡片（窗口在前台时）', '其他']) {
    assert.ok(labels.includes(title), `设置页里应当有「${title}」这一块`)
  }

  // 提示音与自定义提示音原本被拆在两块里，现在是同一块。
  const soundBlock = blockLabels(tree, '系统通知（窗口没在前台时）')
  for (const label of ['提示音', '自定义提示音', '试听', '留在通知中心']) {
    assert.ok(soundBlock.includes(label), `「${label}」应当在「系统通知」那一块里`)
  }

  // 卡片长什么样（停留、角落）都归到「页内卡片」块。
  const cardBlock = blockLabels(tree, '页内卡片（窗口在前台时）')
  assert.ok(cardBlock.some((label) => label.startsWith('停留（秒')), '卡片停留时长应当在「页内卡片」块里')
  assert.ok(cardBlock.includes('角落'), '角落选择应当在「页内卡片」块里')
  for (const name of ['右下', '左下', '右上', '左上']) {
    assert.ok(cardBlock.includes(name), `角落下拉里应当有「${name}」`)
  }

  // 「其他」只剩节流与标题前缀 —— 别再往里塞开关，否则又变成杂物间。
  const otherBlock = blockLabels(tree, '其他')
  assert.ok(otherBlock.some((label) => label.startsWith('同一会话最小间隔')), '节流应当在「其他」块里')
  assert.ok(otherBlock.some((label) => label.startsWith('标题前缀')), '标题前缀应当在「其他」块里')
  assert.ok(!otherBlock.includes('提示音'), '提示音开关不该再留在「其他」块里（已并进「系统通知」）')
})

await t('矩阵下面说明了每一类事件、每一条通路各自独立', async () => {
  const boot = await bootApplied()
  const labels = walkSettings(renderSettings(boot.state.slots[0].component).tree)
  assert.ok(
    labels.some((label) => label.includes('各有一个开关')),
    '矩阵下面应当说明每一类事件、每一条通路都各有一个开关',
  )
  assert.ok(
    !labels.some((label) => label.includes('共用一个开关')),
    '不该再提"共用一个开关" —— 那个跨行合并格已经拆掉了',
  )
})

section('4g. 版面瘦身：顶部摘要 + 低频项折叠')

await t('顶部有「当前效果」摘要：把时机与事件表折算成一句人话', async () => {
  const boot = await bootApplied({ config: { notifyOnCompletion: true, toastOnCompletion: true } })
  const tree = renderSettings(boot.state.slots[0].component).tree
  assert.ok(walkSettings(tree).includes('当前效果'), '设置页顶部应当有「当前效果」这一块')

  const effect = blockLabels(tree, '当前效果')
  assert.ok(
    effect.some((label) => label.includes('提醒：')),
    '摘要里应当列出当前会提醒哪几类事件（用户不必自己在四块之间做乘法）',
  )
  assert.ok(
    effect.some((label) => label.includes('回合结束')),
    '「回合结束」打开后，摘要里应当能看到它',
  )
})

await t('摘要会跟着事件表变：把「回合结束」关掉，摘要里就不再提它', async () => {
  const boot = await bootApplied({ config: { notifyOnCompletion: false, toastOnCompletion: false } })
  const effect = blockLabels(renderSettings(boot.state.slots[0].component).tree, '当前效果')
  assert.ok(effect.some((label) => label.includes('提醒：')), '摘要仍在')
  assert.ok(
    !effect.some((label) => label.includes('回合结束')),
    '两侧都关掉之后，摘要里不该再出现「回合结束」',
  )
})

await t('低频项默认收起：自定义提示音 / 其他 / 运行状态', async () => {
  const boot = await bootApplied()
  const tree = renderSettings(boot.state.slots[0].component).tree
  for (const title of ['自定义提示音', '其他', '运行状态']) {
    const head = findButton(tree, title)
    assert.ok(head, `「${title}」应当有一个可点的折叠标题`)
    assert.equal(head.props['aria-expanded'], false, `「${title}」默认应当是收起的`)
  }
})

await t('折叠只走 display 隐藏，正文仍留在 tree 里（版面断言依赖这一点）', async () => {
  const boot = await bootApplied()
  const tree = renderSettings(boot.state.slots[0].component).tree
  // 这两条在"默认收起"状态下仍必须取得到 —— 一旦改成条件渲染，4f 的归位断言会凭空失败。
  assert.ok(
    blockLabels(tree, '其他').some((label) => label.startsWith('同一会话最小间隔')),
    '「其他」收起时，里面的控件仍必须在 tree 里',
  )
  assert.ok(
    blockLabels(tree, '系统通知（窗口没在前台时）').includes('试听'),
    '「自定义提示音」收起时，里面的「试听」仍必须在 tree 里',
  )
})

await t('点折叠标题能展开', async () => {
  const boot = await bootApplied()
  const tree = renderSettings(boot.state.slots[0].component).tree
  findButton(tree, '其他').props.onClick()
  await boot.settle()
  const after = renderSettings(boot.state.slots[0].component).tree
  assert.equal(findButton(after, '其他').props['aria-expanded'], true, '点过之后应当展开')
})

await t('某类事件只开了一条通路时，行名旁点出「仅后台 / 仅前台」', async () => {
  // 只勾系统通知那一侧 —— 这正是"勾了回合结束却一直不弹"的成因，
  // 而这件事在界面上原本完全看不出来。
  const onlySystemBoot = await bootApplied({ config: { notifyOnCompletion: true, toastOnCompletion: false } })
  const onlySystemLabels = walkSettings(renderSettings(onlySystemBoot.state.slots[0].component).tree)
  assert.ok(onlySystemLabels.includes('仅后台'), '只勾系统通知时，应当标出「仅后台」')

  // 只勾卡片那一侧
  const onlyCardBoot = await bootApplied({ config: { notifyOnCompletion: false, toastOnCompletion: true } })
  const onlyCardLabels = walkSettings(renderSettings(onlyCardBoot.state.slots[0].component).tree)
  assert.ok(onlyCardLabels.includes('仅前台'), '只勾页内卡片时，应当标出「仅前台」')

  // 两侧状态一致（都开）就不该挂标记，否则四个标签会把表格挤乱
  const bothBoot = await bootApplied({ config: { notifyOnCompletion: true, toastOnCompletion: true } })
  const bothLabels = walkSettings(renderSettings(bothBoot.state.slots[0].component).tree)
  assert.ok(
    !bothLabels.includes('仅后台') && !bothLabels.includes('仅前台'),
    '两侧都开时不该出现任何一侧标记',
  )
})

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

console.log(`\n${failures.length === 0 ? '全部通过' : '有失败'}：${passed} 项通过，${failures.length} 项失败\n`)
if (failures.length > 0) {
  process.exitCode = 1
}
