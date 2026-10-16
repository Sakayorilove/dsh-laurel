/**
 * 客户端 kit 与打包契约自检：`node tests/kit-client.mjs`（或 `npm run test:kit`）
 *
 * ── 为什么需要这个文件 ──────────────────────────────────────────────────
 * `tests/smoke-plugin.mjs` 跑的是**手写**的 `lib/client.js`，
 * 而 kit（`lib/client-kit.js`）根本不参与那条路径 ——
 * 也就是说 kit 错了整套冒烟测试都是绿的。
 *
 * 这个文件补上那个盲区，并且**直接测打包产物**：
 *   1. 先生成 `library/laurel-sample/client.js`（真跑打包器）
 *   2. 再把这份产物丢进 `node:vm` 里按宿主的约定执行
 *   3. 断言它注册对了 id、导出了 apply/inject、订阅能真的触发
 *
 * 只依赖 node 内建模块，退出码非 0 = 真失败。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { buildBundle, readBundleId, stripSource, validateModule, writeBundle, DEFAULT_MANIFEST } from '../scripts/build-client.mjs'
import { createThrottle, pickText, toMap, truncateBody } from '../lib/client-kit.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const SAMPLE_SRC = 'lib/client/index.mjs'
const SAMPLE_OUT = 'library/laurel-sample/client.js'

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

/* ------------------------------------------------------------------ *
 * 0. 真跑一次打包器（不是读旧的产物）
 * ------------------------------------------------------------------ */

section('0. 打包器')

const built = await t('能打出 laurel-sample（真跑 buildBundle）', async () => {
  const result = buildBundle({ manifest: [...DEFAULT_MANIFEST.slice(0, -1), SAMPLE_SRC], id: 'laurel-sample' })
  assert.ok(result.code.length > 1000, '产物太小，八成没打进去')
  assert.equal(result.id, 'laurel-sample')
  assert.ok(existsSync(join(PKG_ROOT, SAMPLE_OUT)), `应当已经落盘到 ${SAMPLE_OUT}`)
})

const bundleSource = readFileSync(join(PKG_ROOT, SAMPLE_OUT), 'utf8')

/* ------------------------------------------------------------------ *
 * 1. 契约拒绝：坏源码必须被打包器拦下
 * ------------------------------------------------------------------ */

section('1. 契约拒绝（不能被静默放过的坏写法）')

await t('顶层 import 会被拒', () => {
  assert.throws(() => validateModule('bad.js', "import x from 'y'\nexport function apply() {}\n"), /顶层 import/)
})

await t('动态 import() 会被拒（真正调用，而不是写在注释里）', () => {
  assert.throws(() => validateModule('bad.js', 'export function apply() { import("x") }\n'), /动态 import/)
})

await t('export default 会被拒', () => {
  assert.throws(() => validateModule('bad.js', 'export default function apply() {}\n'), /export default/)
})

await t('entry 必须导出 apply', () => {
  assert.throws(() => validateModule('bad.js', 'export function notApply() {}\n', { needsApply: true }), /apply/)
})

await t('**注释里**出现 import() 不该被误判 —— 文档就是会写这些词', () => {
  // 这个曾把示例自己判死：注释里写「不许用 import()」，正则就把示例拒了。
  const src = [
    '// 注意：不许用 import() 这种动态导入，也不许写顶层 import',
    '/* 而且 export default 也是禁止的 */',
    'export function apply() {}',
    '',
  ].join('\n')
  const stripped = stripSource(src)
  assert.doesNotMatch(stripped, /import/, '注释应当被剥掉；剥不干净才会误判')
  // 校验用的是**剥注释后**的源码，所以这份带"违规词"的注释能正常通过。
  validateModule('ok.js', stripped, { needsApply: true })
  assert.match(stripped, /function apply/)
})

/* ------------------------------------------------------------------ *
 * 2. 产物形状
 * ------------------------------------------------------------------ */

section('2. 产物形状')

await t('注册在 window.__ModuleLoader__.load 上，且 id 正确', () => {
  assert.match(bundleSource, /window\.__ModuleLoader__\.load\(/)
  const idMatch = bundleSource.match(/id:\s*["']([^"']+)["']/)
  assert.equal(idMatch?.[1], 'laurel-sample', 'bundle 的 id 必须是包名')
})

await t('产物里没有不会被解析的 ESM 语法', () => {
  // 注意：这里不能要求"完全没有 import 字样" —— 注释里会有。
  // 只需要保证没有**顶层** import / export default（会被当 ESM 解析而崩）。
  assert.doesNotMatch(bundleSource, /^\s*import\s/m)
  assert.doesNotMatch(bundleSource, /^\s*export\s+default/m)
})

await t('未验证过的判定不许出现在产物里（instanceof 跨 realm 会静默失效）', () => {
  // 跨 realm 的 Map / Array 等内建类型，instanceof 都可能为 false。
  // 这类判定一旦写进产物，症状是"安静地什么都不做"，所以直接静态禁掉。
  // 先在注释里出现不算 —— 注释是给人解释这个坑的，先剥掉再查。
  const code = stripSource(bundleSource)
  assert.doesNotMatch(code, /instanceof\s+(Map|Set|Array|Promise|Error)\b/,
    '不要用 instanceof 判内建类型；要判容器请用 kit 的 toMap')
})

await t('kit 与入口都内联进去了（共享同一作用域）', () => {
  assert.match(bundleSource, /lib\/client-kit\.js/, '注释里的来源标注应当保留')
  assert.match(bundleSource, /lib\/client\/index\.mjs/)
})

/* ------------------------------------------------------------------ *
 * 2b. 防误覆盖（真出过事：Laurel 自己的 lib/client.js 被别人的 bundle 顶掉）
 * ------------------------------------------------------------------ */

section('2b. 防误覆盖')

/** 内存版 fs，专测守卫本身，不碰真实磁盘。 */
function fakeFs(initial) {
  const files = new Map(Object.entries(initial ?? {}))
  return {
    files,
    read: (p) => {
      if (!files.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      return files.get(p)
    },
    write: (p, c) => { files.set(p, c) },
    exists: (p) => files.has(p),
    mkdir: () => {},
  }
}

await t('拒绝把本包 bundle 写进另一个包的 bundle 路径', () => {
  // 场景复现：Laurel 的 lib/client.js（id 是 'laurel'，且是**单引号**手写产物）
  // 被一个绑错 repoRootPath 的脚手架测试写成了 id 为 'laurel-demo2' 的产物。
  const fs = fakeFs({ '/x/lib/client.js': "window.__ModuleLoader__.load({\n  id: 'laurel',\n})" })
  assert.equal(readBundleId(fs.files.get('/x/lib/client.js')), 'laurel', '单引号手写 bundle 也要能读出 id')
  assert.throws(
    () => writeBundle({ id: 'laurel-demo2', code: '...' }, '/x/lib/client.js', fs),
    /拒绝覆盖[\s\S]*laurel[\s\S]*laurel-demo2/,
    'id 不是自己的就该拒绝写',
  )
  assert.match(fs.files.get('/x/lib/client.js'), /id: 'laurel'/, '被拒绝时原文件必须一字未动')
})

await t('同一个包重复构建照常覆盖（守卫不能挡住正常流程）', () => {
  const fs = fakeFs({ '/x/lib/client.js': "window.__ModuleLoader__.load({\n  id: 'laurel',\n})" })
  writeBundle({ id: 'laurel', code: 'NEW' }, '/x/lib/client.js', fs)
  assert.equal(fs.files.get('/x/lib/client.js'), 'NEW')
})

await t('目标不存在时正常写入（首次构建）', () => {
  const fs = fakeFs()
  writeBundle({ id: 'laurel-demo', code: 'NEW' }, '/x/lib/client.js', fs)
  assert.equal(fs.files.get('/x/lib/client.js'), 'NEW')
})

await t('目标不是 bundle（读不出 id）时不误判，允许写入', () => {
  const fs = fakeFs({ '/x/lib/client.js': '// 我自己写的别的东西' })
  writeBundle({ id: 'laurel-demo', code: 'NEW' }, '/x/lib/client.js', fs)
  assert.equal(fs.files.get('/x/lib/client.js'), 'NEW')
})

await t('真实产物能被 readBundleId 读回自己的 id', () => {
  assert.equal(readBundleId(bundleSource), 'laurel-sample')
})

/* ------------------------------------------------------------------ *
 * 3. 在 vm 里按宿主约定真跑一遍
 * ------------------------------------------------------------------ */

section('3. 在 vm 里真跑产物（跨 realm，这才是宿主的真实环境）')

/**
 * 造一个宿主的"假壳"：window、fetch、Notification、document，
 * 以及 uiSession.sessionStatus 这个**可观察对象**。
 *
 * 关键：快照是**宿主 realm 的 Map**，而产物在 vm 里执行 ——
 * 两者 instanceof Map 互相为 false。之前就是在这里踩的坑。
 */
function bootSample({ snapshot = new Map(), configReply = { language: 'zh' }, withLaurelCenter = false } = {}) {
  const state = {
    registration: null,
    snapshot,
    statusListeners: new Set(),
    events: [],
    requests: [],
    configReply,
    slots: [],
    clock: 1_700_000_000_000,
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    AbortController,
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [state.clock])) } static now() { return state.clock } },
    navigator: { language: 'zh-CN', languages: ['zh-CN'] },
    location: { origin: 'http://127.0.0.1:19387' },
    document: { visibilityState: 'visible', hasFocus: () => false },
    Notification: Object.assign(function FakeNotification() {}, {
      permission: 'granted',
      requestPermission: async () => 'granted',
    }),
    fetch: async (url, init) => {
      state.requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
      if (String(url).endsWith('/event')) {
        state.events.push(JSON.parse(init.body))
        return { status: 200, json: async () => ({ ok: true, data: {} }) }
      }
      if (String(url).endsWith('/config')) {
        return { status: 200, json: async () => ({ ok: true, data: { config: state.configReply } }) }
      }
      return { status: 200, json: async () => ({ ok: true, data: {} }) }
    },
    window: {
      __ModuleLoader__: { load(definition) { state.registration = definition } },
      focus() {},
    },
  }
  sandbox.globalThis = sandbox

  vm.runInContext(bundleSource, vm.createContext(sandbox), { filename: 'client.js' })
  assert.ok(state.registration, '产物没有调用 window.__ModuleLoader__.load')

  const exportsObject = state.registration.factory((name) => {
    if (name === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {},
      }
    }
    throw new Error(`未预期的 require('${name}')`)
  })

  const ctx = {
    uiSession: {
      sessionStatus: {
        getSnapshot: () => state.snapshot,
        subscribe: (fn) => { state.statusListeners.add(fn); return () => state.statusListeners.delete(fn) },
      },
    },
    effect(fn) { return fn() },
    slots: {
      // 默认模拟「没装装载机」：聚合插槽 `laurel-center.module` 没被声明，inject 不回调，
      // 于是模块应当走兜底 —— 照旧注册 settings.section。其余插槽照常回调（真实里
      // 它们由官方声明；白名单式写法会误伤别的插槽）。传 withLaurelCenter: true 可验证聚合。
      inject: (name, factory) => (name === 'laurel-center.module' && !withLaurelCenter ? () => {} : factory()),
      register: (definition, component) => { state.slots.push({ definition, component }); return () => {} },
    },
  }

  return {
    state,
    exports: exportsObject,
    ctx,
    async emit(next) {
      state.snapshot = next
      for (const fn of [...state.statusListeners]) fn()
      await Promise.resolve()
      await Promise.resolve()
    },
    async settle() {
      for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

async function bootApplied(options) {
  const boot = bootSample(options)
  boot.exports.apply(boot.ctx)
  await boot.settle()
  return boot
}

await t('factory 能执行，且导出 apply 与 inject', async () => {
  const boot = bootSample()
  assert.equal(typeof boot.exports.apply, 'function', '没导出 apply')
  assert.deepEqual([...boot.exports.inject], ['slots', 'uiSession'])
})

await t('跨 realm 的 Map：订阅能真的触发并落一条事件', async () => {
  // 这条就是回归测试：曾经因为 `snapshot instanceof Map` 跨 realm 为 false，
  // 把一个有内容的 Map 换成空 Map，于是**永远不触发且不报错**。
  const boot = await bootApplied()
  assert.equal(boot.state.statusListeners.size, 1, '应当订阅了 sessionStatus')
  assert.equal(boot.state.events.length, 0, '初态不该有事件')

  await boot.emit(new Map([['s1', { running: true, pendingInteraction: { kind: 'question' }, title: 'T1' }]]))
  await boot.settle()

  const fired = boot.state.events.filter((event) => event.kind === 'fire')
  assert.equal(fired.length, 1, `应当正好触发一次，实际 ${boot.state.events.length} 条：${JSON.stringify(boot.state.events)}`)
  assert.equal(fired[0].sessionId, 's1')
  assert.equal(fired[0].title, 'T1')
})

await t('事件里带上环境探针字段（排错要看这几项）', async () => {
  const boot = await bootApplied()
  await boot.emit(new Map([['s1', { running: true, pendingInteraction: { kind: 'question' } }]]))
  await boot.settle()
  const fired = boot.state.events.find((event) => event.kind === 'fire')
  assert.ok(fired, '应当有 fire 事件')
  for (const key of ['origin', 'supported', 'permission', 'visibility', 'focused']) {
    assert.ok(key in fired, `事件里缺 ${key}`)
  }
})

await t('纯 running 变化不触发（避免"每次快照都响"）', async () => {
  const boot = await bootApplied()
  await boot.emit(new Map([['s1', { running: true, pendingInteraction: null }]]))
  await boot.settle()
  await boot.emit(new Map([['s1', { running: false, pendingInteraction: null }]]))
  await boot.settle()
  assert.equal(boot.state.events.filter((e) => e.kind === 'fire').length, 0)
})

await t('节流：同一会话在间隔内第二次只留 warn，不再 fire', async () => {
  const boot = await bootApplied()
  await boot.emit(new Map([['s1', { running: true, pendingInteraction: { kind: 'question' } }]]))
  await boot.settle()
  boot.state.clock += 10_000 // 越过 2s 全局底线，但仍在默认 30s 每会话间隔内

  await boot.emit(new Map([['s1', { running: true, pendingInteraction: null }]]))
  await boot.settle()
  await boot.emit(new Map([['s1', { running: true, pendingInteraction: { kind: 'question' } }]]))
  await boot.settle()

  const kinds = boot.state.events.map((e) => e.kind)
  assert.equal(kinds.filter((k) => k === 'fire').length, 1, `只该 fire 一次：${JSON.stringify(kinds)}`)
  assert.ok(kinds.includes('warn'), `应当留下 warn：${JSON.stringify(kinds)}`)
})

await t('读不到宿主配置时退回内置默认值，照样渲染设置页', async () => {
  const boot = bootSample()
  boot.state.configReply = null // 让 config 返回 null
  boot.exports.apply(boot.ctx)
  await boot.settle()

  const section_ = boot.state.slots.find((s) => s.definition?.name === 'settings.section')
  assert.ok(section_, '应当注册了 settings.section')
  assert.equal(section_.definition.id, 'laurel-sample')
  const tree = section_.component({})
  assert.ok(tree, 'SetPage 组件应当能真的渲染出树')
})

await t('装载机在时聚合进总控插槽，且不再单独占一条设置页', async () => {
  const boot = bootSample({ withLaurelCenter: true })
  boot.exports.apply(boot.ctx)
  await boot.settle()

  assert.equal(
    boot.state.slots.filter((s) => s.definition?.name === 'settings.section').length, 0,
    '聚合成立后不该再往 settings.section 注册 —— 否则会同时出现在设置导航和总控里两处',
  )
  const grouped = boot.state.slots.find((s) => s.definition?.name === 'laurel-center.module')
  assert.ok(grouped, '应当注册到 laurel-center.module')
  assert.equal(grouped.definition.id, 'laurel-sample', '聚合后 id 不变，总控台靠它把内容对回卡片')
  assert.ok(grouped.component({}), '聚合后组件仍应能渲染出树')
})

/* ------------------------------------------------------------------ *
 * 4. kit 单元（跨 realm 陷阱的直接回归）
 * ------------------------------------------------------------------ */

section('4. kit 单元')

await t('toMap：跨 realm 的 Map **不会**被换成空 Map', () => {
  // 在别的作用域里造一个 Map，模拟宿主 realm 传进来的快照。
  const foreign = vm.runInNewContext('new Map([["s1", { running: true }]])')
  assert.equal(foreign instanceof Map, false, '前提：跨 realm 的 Map instanceof 必须为 false')
  assert.equal(foreign.size, 1)

  const mapped = toMap(foreign)
  assert.equal(mapped.size, 1, '被换成空 Map 就是这个 bug 复发了')
  assert.deepEqual([...mapped.keys()], ['s1'])
})

await t('toMap：同 realm 的 Map、null、普通对象都能吃', () => {
  assert.equal(toMap(new Map([['a', 1]])).size, 1)
  assert.equal(toMap(null).size, 0)
  assert.equal(toMap(undefined).size, 0)
  assert.deepEqual([...toMap({ a: 1, b: 2 }).keys()], ['a', 'b'])
})

await t('createThrottle：全局底线与每键间隔各挡一次', () => {
  let now = 0
  const gate = createThrottle(() => now, 30, 2000)
  assert.equal(gate.check('a').allowed, true)
  gate.mark('a')

  now = 1000
  assert.equal(gate.check('b').allowed, false, '全局底线应当挡住 b')
  assert.equal(gate.check('b').reason, 'global')

  now = 3000
  assert.equal(gate.check('b').allowed, true, '越过全局底线后 b 应放行')

  now = 10_000
  assert.equal(gate.check('a').allowed, false, 'a 是 30s 每键间隔，10s 时还不该放行')
  assert.equal(gate.check('a').reason, 'per-key')

  now = 40_000
  assert.equal(gate.check('a').allowed, true, '越过 30s 后应放行')
})

await t('truncateBody：省略号算在长度里', () => {
  assert.equal(truncateBody('abcdef', 4), 'abc…')
  assert.equal(truncateBody('abc', 10), 'abc')
  assert.equal(truncateBody(null, 4), '')
})

await t('pickText：中文才算 zh，其它一律落到 en', () => {
  const table = { zh: { v: 'zh' }, en: { v: 'en' } }
  assert.equal(pickText(table, 'zh').v, 'zh')
  assert.equal(pickText(table, 'en').v, 'en')
})

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

console.log('')
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const { name, error } of failures) console.log(`  - ${name}: ${error?.message ?? error}`)
  console.log(`\n${passed} 项通过，${failures.length} 项失败`)
  process.exit(1)
}
console.log(`全部通过：${passed} 项通过，0 项失败`)
