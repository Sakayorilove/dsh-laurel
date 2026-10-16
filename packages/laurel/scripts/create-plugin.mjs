/**
 * 生成一个带全套契约的 Laurel 系列插件骨架。
 *
 *   node scripts/create-plugin.mjs <id> [--dir <目标目录>] [--title <显示名>]
 *
 * 例：
 *   node scripts/create-plugin.mjs timer
 *   → 生成 ../Laurel-timer/，一个能直接 `npm run build:client` + 装进 DSH 的插件
 *
 * ── 为什么要有这个脚本 ──────────────────────────────────────────────────
 * docs/PLUGIN-CONTRACT.md 里那些坑（跨 realm 的 instanceof、漏写
 * dsh.client.inject、exports["./client"] 指错、顶层 import…）都是**静默失效**：
 * 插件装上了但什么都不发生，没有任何报错。靠人记是记不住的，
 * 所以把"正确写法"直接生成出来 —— 骨架本身就是一份可执行的契约。
 *
 * 生成的文件全部零依赖：只复用 Laurel 的 kit 与 lib/core，不引第三方包。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 宿主侧 core 模块的文件清单（生成物按名字 import）。 */
const CORE_MODULES = ['home.js', 'logger.js', 'config.js', 'settings.js', 'events.js', 'http.js']

const HELP = `
用法：node scripts/create-plugin.mjs <id> [选项]

  <id>              插件短名，小写字母/数字/连字符，例如 timer
                    → 包名 laurel-<id>，端点前缀 /laurel-<id>

选项：
  --dir <路径>      输出目录（默认：与 Laurel 平级的 ../Laurel-<id>）
  --title <文字>    设置页里显示的标题（默认用 <id>）
  --force           目录已存在时也继续（会覆盖同名文件）
  --help            显示这段帮助

生成后：
  cd <目录> && npm run build:client     # 打包客户端半边
  把目录 link 进 profile 的 node_modules，再在 cordis.patch.yml 里 insert
`

function fail(message) {
  console.error(`✗ ${message}`)
  process.exitCode = 1
  return null
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true }
  const readFlag = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  const id = argv.find((a) => !a.startsWith('-') && a !== readFlag('--dir') && a !== readFlag('--title'))
  return {
    id,
    dir: readFlag('--dir'),
    title: readFlag('--title'),
    force: argv.includes('--force'),
  }
}

/** 校验短名：要能安全地进包名、URL 路径与目录名。 */
function validateId(id) {
  if (!id) return '缺少 <id>。用法：node scripts/create-plugin.mjs <id>'
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) {
    return `<id> 只能是小写字母开头、由小写字母/数字/连字符组成（≤31 字符），收到：${id}`
  }
  if (id.endsWith('-')) return `<id> 不能以连字符结尾：${id}`
  // id 会拼成 laurel-<id>，所以 id 取 'laurel' 会生成 laurel-laurel ——
  // 包名和端点都跟 Laurel 本体撞脸，之后排错时会很费解。
  if (id === 'laurel') return `<id> 不能用 "laurel"（会生成 laurel-laurel，与 Laurel 本体重名）`
  return null
}

/* ------------------------------------------------------------------ *
 * 模板
 * ------------------------------------------------------------------ */

function packageJson({ id, packageName, title, coreRel }) {
  return `${JSON.stringify({
    name: packageName,
    version: '0.1.0',
    description: `${title} —— Laurel 系列插件`,
    license: 'MIT',
    type: 'module',
    main: './lib/index.js',
    exports: {
      '.': './lib/index.js',
      // ★ 客户端 bundle 就是靠这一行寻址的，别改成别的字段名。
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    files: ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE'],
    keywords: ['dsh-plugin', 'deepseek-harness', 'laurel-series'],
    engines: { node: '^22.19.0 || >=24.0.0' },
    scripts: {
      test: 'node tests/contract.mjs && node tests/host.mjs',
      'test:client': 'node tests/contract.mjs',
      'test:host': 'node tests/host.mjs',
      'build:client': `node ${join(coreRel, 'scripts/build-client.mjs')} --entry lib/client/index.mjs --out lib/client.js --id ${packageName}`,
      'check:client': `node ${join(coreRel, 'scripts/build-client.mjs')} --check --entry lib/client/index.mjs --out lib/client.js --id ${packageName}`,
    },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: {
        platform: 'web',
        // ★ 漏了这个字段 → boot graph 没有顺序边 → 设置页"有时候不出现"。
        //   这里必须列全"客户端服务供给方包"。用 slots 就要 ui-settings。
        inject: ['@deepseek-ai/dsh-client-ui-settings'],
      },
    },
  }, null, 2)}\n`
}

function cordisPatch({ id, packageName, title }) {
  return `# ${packageName} —— 挂进 DSH profile 的那一层。
#
# name 用**相对路径**（相对本文件解析），所以包被 link 到哪里都能跑。
# 下面的 config 是**默认值**：优先级 = 本文件 < $DSH_HOME/${packageName}/settings.json
- insert:
    - id: ${id}
      name: ./lib/index.js
      config:
        enabled: true
        # 插件自己的配置写在这里；新增字段也要同步到 lib/index.js 的 FIELDS。
        logLevel: info
`
}

function hostEntry({ packageName, title, coreFromLib, prefix }) {
  const core = (file) => `${coreFromLib}/lib/core/${file}`
  return `/**
 * ${title} · 宿主半边
 *
 * 三件事，只做三件事：
 *   1. 配置的权威来源（patch 默认值 + settings.json 覆盖），浏览器半边通过 HTTP 读；
 *   2. 事件回收站 —— 浏览器半边回传"做了什么/失败了"，落盘后可事后核对；
 *   3. 不干别的。不注入提示词、不注册工具、不说话。
 *
 * ── 纪律（照 docs/PLUGIN-CONTRACT.md §6）────────────────────────────────
 *   1. 顶层 inject **留空**。cordis 的 Context 是受控代理，没写进 inject 的服务
 *      用 ctx.X 会直接抛；Web 路由用子插件等 webServer 就绪再挂。
 *   2. 家目录只认 DSH_HOME，不从 DSH_PROFILE_DIR 推。
 *   3. **所有 IO 都吞异常** —— 这个插件坏掉，不许影响宿主里的任何别的东西。
 */

import { createDefaults, createNormalizer, pickKnown } from '${core('config.js')}'
import { createEventWriter } from '${core('events.js')}'
import { resolveDshHome, pluginPaths } from '${core('home.js')}'
import { createRouter, ok } from '${core('http.js')}'
import { makeLogger } from '${core('logger.js')}'
import { loadSettings, saveSettings } from '${core('settings.js')}'

export const PACKAGE_NAME = '${packageName}'
export const VERSION = '0.1.0'
export const API_PREFIX = '${prefix}'

/** 配置字段声明。**只认这里有的键**；类型不对退回 base 值（不抛）。 */
const FIELDS = {
  enabled: { type: 'boolean', default: true },
  logLevel: { type: 'enum', default: 'info', values: ['debug', 'info', 'warn', 'error'] },
}

export const DEFAULT_CONFIG = createDefaults(FIELDS)
const normalizeConfig = createNormalizer(FIELDS)

/** 顶层留空：见文件头纪律 1。 */
export const inject = []

/**
 * @param {any} ctx cordis 上下文
 * @param {Record<string, unknown>} config patch 里那份 config（当默认值用）
 */
export function apply(ctx, config = {}) {
  const home = resolveDshHome()
  const fromPatch = normalizeConfig(config, DEFAULT_CONFIG)
  const log = makeLogger(\`[\${PACKAGE_NAME}]\`, fromPatch.logLevel)

  /** 生效配置 = settings.json 盖在 patch 默认值上。 */
  let current = (() => {
    const stored = loadSettings(PACKAGE_NAME, home)
    return stored.config ? normalizeConfig(stored.config, fromPatch) : fromPatch
  })()

  const getConfig = () => ({ ...current })

  const setConfig = (patch) => {
    current = normalizeConfig(patch, current)
    try {
      saveSettings(current, PACKAGE_NAME, home)
    } catch (error) {
      log.warn(\`配置落盘失败（本次改动只在内存里生效）：\${error?.message ?? error}\`)
    }
    return getConfig()
  }

  const events = createEventWriter({ name: PACKAGE_NAME, kinds: ['ready', 'fire', 'warn', 'error', 'test'] })

  /** 只读快照。同一份数据既给 HTTP /status，也给宿主/测试直接调 \`mod.status()\`。 */
  const statusData = () => ({
    package: PACKAGE_NAME,
    version: VERSION,
    home,
    config: getConfig(),
    paths: pluginPaths(PACKAGE_NAME, home),
    defaults: pickKnown(DEFAULT_CONFIG, FIELDS),
  })

  // 路由表形状：'/路径' → { 方法: ({ req, res, body, home, log }) => 响应 }。
  // ok/fail 由 core 保证 \`{ ok: true, data }\` / \`{ ok: false, error }\` 这一种形状。
  const router = createRouter({
    prefix: API_PREFIX,
    log,
    home,
    routes: {
      '/config': {
        GET: ({ res }) => ok(res, { config: getConfig(), defaults: pickKnown(DEFAULT_CONFIG, FIELDS) }),
        POST: ({ res, body }) => ok(res, { config: setConfig(body?.config ?? {}) }),
      },
      '/event': {
        POST: ({ res, body }) => { events.append(body ?? {}, home); return ok(res, {}) },
      },
      '/events': {
        GET: ({ res, url }) => ok(res, events.read(Number(url.searchParams.get('limit') ?? 20), home)),
      },
      '/status': ({ res }) => ok(res, statusData()),
    },
  })

  try {
    // 子插件：cordis 负责等待 webServer、服务重建与路由清理；顶层不强制依赖 Web。
    ctx.inject(['webServer'], (routeCtx) => {
      const webServer = (() => { try { return routeCtx.get?.('webServer') ?? null } catch { return null } })()
      if (!webServer?.register) return
      return routeCtx.effect(() => webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: router,
      }), '${id_slug(packageName)}.routes')
    })
  } catch (error) {
    log.warn(\`路由订阅失败（设置页与配置读取不可用）：\${error?.message ?? error}\`)
  }

  events.append({ kind: 'ready', detail: \`host \${VERSION}\` }, home)
  log.info(\`已挂载：端点 \${API_PREFIX} 启用=\${current.enabled}\`)

  return {
    /** 只读快照。返回**裸数据**，不是 HTTP 响应形状（调用方可能没有 res）。 */
    status: statusData,
  }
}
`
}

/** 生成一个合法的 JS 标识符片段（用于 effect 的 key）。 */
function id_slug(name) {
  return String(name).replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')) || 'plugin'
}

function clientEntry({ packageName, title, prefix }) {
  return `/**
 * ${title} · 客户端半边入口
 *
 * 这份骨架**已经满足** docs/PLUGIN-CONTRACT.md §9 的自查清单，照着改就行。
 *
 * ── 四条硬约束（踩一条就白屏，见契约 §3）────────────────────────────────
 *   1. 不许顶层 import / export default / 动态 import()（产物是 CJS factory）
 *   2. require 只能拿到 platform seed 表里的东西（react 等）；共享代码靠打包内联
 *   3. 必须 export function apply(ctx)
 *   4. exports.inject 里的服务，供给方包要写进 package.json 的 dsh.client.inject
 *
 * ── 两个静默失效的坑（契约 §5）──────────────────────────────────────────
 *   · 跨 realm 的 Map：\`x instanceof Map\` 恒为 false → 一律用 kit 的 toMap()
 *   · uiSession.sessionStatus 是可观察对象（getSnapshot + subscribe），
 *     **不是** Map，也没有 'uiSession/session-status' 事件名
 */

const API = '${prefix}'
const inject = ['slots', 'uiSession']

const FALLBACK = { enabled: true, logLevel: 'info' }

const TEXT = {
  zh: { label: '${title}', heading: '${title}', intro: '由 Laurel kit 渲染的设置区。' },
  en: { label: '${title}', heading: '${title}', intro: 'Settings block rendered by the Laurel kit.' },
}

/**
 * 订阅会话状态。
 *
 * 快照是 Map<sessionId, status>；status.pendingInteraction 表示"在等你"。
 * 一定要**自己 diff 前后两代快照**，否则每次快照都会响。
 */
function watchSessions(ctx, state) {
  const throttle = createThrottle(() => Date.now(), 30, 2000)

  function install() {
    const source = ctx.uiSession?.sessionStatus
    if (!source || typeof source.getSnapshot !== 'function') return () => {}

    let previous = new Map()
    const react = () => {
      // ★ 必须走 toMap：跨 realm 时 instanceof Map 是 false，
      //   会把有内容的 Map 换成空 Map，然后安静地什么都不做。
      const current = toMap(source.getSnapshot())
      state.sessions = current.size

      for (const [sessionId, value] of current) {
        const pendingNow = value?.pendingInteraction != null
        if (pendingNow && !previous.get(sessionId)?.pendingInteraction) {
          const verdict = throttle.check(sessionId)
          if (verdict.allowed) {
            throttle.mark(sessionId)
            reportEvent(API, { kind: 'fire', sessionId, detail: '检测到等待中的交互' })
          } else {
            reportEvent(API, { kind: 'warn', sessionId, detail: \`被节流挡住（\${verdict.reason}）\` })
          }
        }
      }
      previous = current
    }

    react()
    const stop = typeof source.subscribe === 'function' ? source.subscribe(react) : null
    return () => { if (typeof stop === 'function') stop() }
  }

  if (typeof ctx.effect === 'function') return ctx.effect(install, '${id_slug(packageName)}.watch')
  return install()
}

/** 插件入口：DSH 客户端 boot 时调用。 */
export function apply(ctx) {
  const React = require('react')
  const h = React.createElement

  const state = {
    config: { ...FALLBACK },
    sessions: 0,
    environment: probeEnvironment(typeof Notification !== 'undefined' ? Notification : null),
  }

  // 先按内置默认值把界面立起来，再去读宿主配置 —— 读不到也不该是一片空白。
  loadConfig(API, (kind, message) => reportEvent(API, { kind: 'error', detail: \`\${kind}: \${message}\` }))
    .then((config) => { if (config) state.config = { ...FALLBACK, ...config } })

  watchSessions(ctx, state)

  const Row = (label, value) => h('div',
    { style: { display: 'flex', gap: '12px', padding: '3px 0', fontSize: 12, opacity: 0.85 } },
    h('span', { style: { minWidth: 96, opacity: 0.7 } }, label),
    h('span', { style: { wordBreak: 'break-all' } }, String(value ?? '—')))

  function PluginSettings() {
    const config = state.config
    const t = pickText(TEXT, config.language)
    const [, bump] = React.useState(0)
    const refresh = () => bump((n) => n + 1)

    const save = (patch) => {
      state.config = { ...state.config, ...patch }
      refresh()
      // 写失败不该卡住界面：本地先生效，失败由事件日志留痕。
      requestJSON(API, '/config', { method: 'POST', body: { config: patch } })
        .catch((error) => reportEvent(API, { kind: 'error', detail: \`保存失败：\${error.message}\` }))
    }

    return h('div', { style: { padding: '4px 2px 24px', fontSize: 13 } },
      h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, t.heading),
      h('div', { style: { opacity: 0.7, marginBottom: 12 } }, t.intro),

      h('label', { style: { display: 'block', padding: '6px 0', cursor: 'pointer' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('input', {
            type: 'checkbox',
            checked: config.enabled !== false,
            onChange: (e) => save({ enabled: e.target.checked }),
          }),
          h('span', null, '启用'))),

      h('div', { style: { marginTop: 20, fontSize: 13, fontWeight: 600 } }, '运行状态'),
      Row('页面来源', state.environment.origin),
      Row('通知 API', state.environment.supported ? 'yes' : 'no'),
      Row('通知权限', state.environment.permission),
      Row('会话数', state.sessions))
  }

  try {
    registerSettingsSection(ctx, {
      id: '${packageName}',
      order: 60,
      label: () => pickText(TEXT, state.config.language).label,
      component: PluginSettings,
      slots: ctx.slots,
    })
  } catch (error) {
    // 设置页注册失败**不影响**插件实际功能 —— 降级成没 UI，而不是整个哑掉。
    reportEvent(API, { kind: 'error', detail: \`设置页注册失败：\${error?.message ?? error}\` })
  }
}
`
}

function contractTest({ packageName, title, coreFromTests, coreRel }) {
  return `/**
 * ${title} · 契约自检：\`npm test\`
 *
 * 只查"契约级"的东西（那些**静默失效**、不报错但什么都不发生的写法），
 * 不查业务逻辑 —— 业务逻辑自己加断言。
 *
 * 会**重新打包**再验，所以永远在验当前源码，不是一份过期产物。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// 本文件在 tests/ 下，所以到 Laurel 的相对路径比插件根目录多退一级。
import { buildBundle, writeBundle, stripSource, DEFAULT_MANIFEST } from '${coreFromTests}/scripts/build-client.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
// ROOT 已经是插件根目录，所以这里用从根目录算的那份相对路径。
const CORE = resolve(ROOT, '${coreRel}')

let passed = 0
const failures = []
async function t(name, fn) {
  try { await fn(); passed += 1; console.log(\`  ok    \${name}\`) }
  catch (error) { failures.push({ name, error }); console.log(\`  FAIL  \${name}\\n        \${error?.message ?? error}\`) }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

console.log('\\n1. 先重新打包（不是读旧的产物）')
// 宿主 bundle 路径来自 package.json。先真跑一遍打包，把产物落盘，再按文件去验。
const outPath = join(ROOT, pkg.exports['./client'])
const built = buildBundle({
  repoRootPath: CORE,                       // kit 清单按这个根解析
  manifest: [...DEFAULT_MANIFEST.slice(0, -1), 'lib/client/index.mjs'],
  id: pkg.name,
})
// 用 writeBundle 而不是裸 writeFileSync：它拒绝把本包的 bundle 写进
// **另一个包**的 bundle 路径（真出过事，被覆盖的插件会静默失效）。
writeBundle(built, outPath)
console.log(\`  ✓ 已重新生成 \${pkg.exports['./client']}（\${built.code.length} 字节）\`)

console.log('\\n2. package.json 契约')
await t('exports["./client"] 指向真实存在的产物', () => {
  assert.ok(pkg.exports?.['./client'], '缺 exports["./client"] —— 宿主就是靠它找 bundle 的')
  assert.ok(readFileSync(outPath, 'utf8').length > 100, 'bundle 是空的')
})
await t('dsh.client.platform 是 web', () => assert.equal(pkg.dsh?.client?.platform, 'web'))
await t('dsh.client.inject 非空（少了它设置页会"有时候不出现"）', () => {
  assert.ok(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0,
    'dsh.client.inject 必须列全客户端服务供给方包')
})
await t('files 覆盖了 bundle 所在目录', () => {
  const dir = pkg.exports['./client'].replace(/^\\.\\//, '').split('/')[0]
  assert.ok(pkg.files?.includes(dir), \`files 里缺少 "\${dir}"，发出去会没有 bundle\`)
})

console.log('\\n3. 产物静态检查')
await t('产物能被 JS 引擎解析', () => { new vm.Script(built.code) })
await t('产物里没有 instanceof 判内建类型（跨 realm 会静默失效）', () => {
  assert.doesNotMatch(stripSource(built.code), /instanceof\\s+(Map|Set|Array|Promise|Error)\\b/,
    '判容器请用 kit 的 toMap')
})
await t('产物注册在 window.__ModuleLoader__.load 上', () => {
  assert.match(built.code, /window\\.__ModuleLoader__\\.load\\(/)
})

console.log('\\n4. 在 vm 里真跑（跨 realm，宿主的真实环境）')
function boot() {
  const state = { registration: null, slots: [], events: [], snapshot: new Map() }
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, queueMicrotask, AbortController,
    navigator: { language: 'zh-CN', languages: ['zh-CN'] },
    location: { origin: 'http://127.0.0.1:19387' },
    document: { visibilityState: 'visible', hasFocus: () => false },
    Notification: Object.assign(function () {}, { permission: 'granted', requestPermission: async () => 'granted' }),
    fetch: async () => ({ status: 200, json: async () => ({ ok: true, data: { config: {} } }) }),
    window: { __ModuleLoader__: { load(d) { state.registration = d } } },
  }
  sandbox.globalThis = sandbox
  vm.runInContext(built.code, vm.createContext(sandbox), { filename: 'client.js' })
  assert.ok(state.registration, '产物没有调用 window.__ModuleLoader__.load')
  const exportsObject = state.registration.factory((name) => {
    if (name === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      }
    }
    throw new Error(\`未预期的 require('\${name}')\`)
  })
  const ctx = {
    uiSession: { sessionStatus: { getSnapshot: () => state.snapshot, subscribe: (fn) => { state.listeners = fn; return () => {} } } },
    effect(fn) { return fn() },
    slots: {
      inject: (name, factory) => factory(),
      register: (definition, component) => { state.slots.push({ definition, component }); return () => {} },
    },
  }
  return { state, exports: exportsObject, ctx }
}

await t('导出 apply 与 inject，apply 能跑完不抛', () => {
  const boot_ = boot()
  assert.equal(typeof boot_.exports.apply, 'function', '必须 export function apply')
  assert.ok(Array.isArray(boot_.exports.inject), '应当导出 inject 数组')
  boot_.exports.apply(boot_.ctx)
})
await t('注册了 settings.section 且组件能渲染出树', async () => {
  const boot_ = boot()
  boot_.exports.apply(boot_.ctx)
  await new Promise((r) => setTimeout(r, 0))
  const section = boot_.state.slots.find((s) => s.definition?.name === 'settings.section')
  assert.ok(section, '没有注册 settings.section')
  assert.ok(section.component({}), '组件应当能渲染出树')
})

console.log('')
if (failures.length) {
  console.log(\`失败 \${failures.length} 项：\`)
  for (const { name, error } of failures) console.log(\`  - \${name}: \${error?.message ?? error}\`)
  process.exit(1)
}
console.log(\`全部通过：\${passed} 项通过，0 项失败\`)
`
}

function hostTest({ packageName, coreFromTests, coreRel }) {
  return `/**
 * 宿主半边自检：\`npm run test:host\`
 *
 * 真 import \`lib/index.js\`、真挂路由、用真 req/res 打每个端点。
 * DSH_HOME 指向临时目录，**不会碰你机器上真实的插件数据**。
 *
 * 查的是那些"看起来装上了、其实坏了"的问题：路由没挂上、
 * saveSettings 参数顺序反了、pickKnown 少传参数、响应形状不对…
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

// 必须在 import 插件之前把 DSH_HOME 指到临时目录：apply() 里会读它。
const home = mkdtempSync(join(tmpdir(), '${packageName}-'))
process.env.DSH_HOME = home

const mod = await import(\`file://\${join(ROOT, 'lib/index.js').replace(/\\\\/g, '/')}\`)

let passed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1; console.log(\`  ok    \${name}\`) }
  catch (error) { failures.push({ name, error }); console.log(\`  FAIL  \${name}\\n        \${error?.message ?? error}\`) }
}

/* ---- 搭一个最小宿主壳 ---- */

let handler = null
const ctx = {
  inject(_services, cb) {
    // 模拟 cordis 子上下文：让 cb 拿到一个"已就绪的 webServer"。
    cb({
      get: (name) => (name === 'webServer'
        ? { register: (route) => { handler = route.handler; return () => {} } }
        : null),
      effect: (fn) => fn(),
    })
  },
  effect: (fn) => fn(),
}

const api = mod.apply(ctx, { enabled: true, logLevel: 'debug' })

function makeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.destroy = () => {}
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
  return req
}

function makeRes() {
  const res = { statusCode: 0, headers: {}, headersSent: false, body: undefined }
  res.setHeader = (k, v) => { res.headers[k] = v }
  res.end = (chunk) => { res.headersSent = true; res.body = chunk }
  return res
}

async function call(method, url, body) {
  const req = makeReq(method, url, body)
  const res = makeRes()
  await handler(req, res)
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined }
}

const P = mod.API_PREFIX

/* ---- 契约 ---- */

console.log('\\n1. 模块契约')
check('导出 apply，且顶层 inject 为空', () => {
  assert.equal(typeof mod.apply, 'function', '必须 export function apply')
  assert.deepEqual(mod.inject, [], '顶层 inject 必须留空（契约 §6）')
})
check('挂上了路由 handler', () => assert.ok(handler, '没有 ctx.inject([webServer]) → register'))
check('status() 返回裸数据（不带 res 也能调）', () => {
  assert.equal(api.status().package, '${packageName}')
})

console.log('\\n2. 端点行为')
await (async () => {
  const r = await call('GET', \`\${P}/config\`)
  check('GET /config → 200 且形状正确', () => {
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.data.config.enabled, true)
    assert.equal(r.json.data.defaults.logLevel, 'info')
  })
})()

await (async () => {
  // 故意混进一个未知键 + 一个非法 enum 值，验证归一化真的在把关。
  const r = await call('POST', \`\${P}/config\`, { config: { enabled: false, logLevel: '乱写', 未知键: 1 } })
  check('POST /config 归一化：未知键丢掉、非法 enum 退回默认', () => {
    assert.equal(r.status, 200)
    assert.equal(r.json.data.config.enabled, false)
    assert.equal(r.json.data.config.logLevel, 'info', '非法 enum 应当退回 default')
    assert.ok(!('未知键' in r.json.data.config), '未知键必须被丢掉')
  })
  check('配置真的落盘到 $DSH_HOME/${packageName}/settings.json', () => {
    const saved = readFileSync(join(home, '${packageName}', 'settings.json'), 'utf8')
    assert.match(saved, /"enabled": false/)
  })
})()

await (async () => {
  const r = await call('GET', \`\${P}/config\`)
  check('重读拿到落盘后的值（settings.json 确实在生效）', () => {
    assert.equal(r.json.data.config.enabled, false)
  })
})()

await (async () => {
  await call('POST', \`\${P}/event\`, { kind: 'fire', sessionId: 's1', detail: '测试事件' })
  const r = await call('GET', \`\${P}/events?limit=5\`)
  check('POST /event 落盘，GET /events 能读回（倒序，最新在前）', () => {
    assert.equal(r.status, 200)
    assert.equal(r.json.data[0].kind, 'fire')
    assert.equal(r.json.data[0].detail, '测试事件')
  })
})()

await (async () => {
  const r = await call('GET', \`\${P}/status\`)
  check('GET /status → 200', () => {
    assert.equal(r.status, 200)
    assert.equal(r.json.data.package, '${packageName}')
  })
})()

await (async () => {
  const notFound = await call('GET', \`\${P}/nope\`)
  const badMethod = await call('DELETE', \`\${P}/config\`)
  check('未知端点 404、方法不支持 405（分开报，排错快）', () => {
    assert.equal(notFound.status, 404)
    assert.equal(badMethod.status, 405)
  })
})()

console.log('')
if (failures.length) {
  console.log(\`失败 \${failures.length} 项：\`)
  for (const { name, error } of failures) console.log(\`  - \${name}: \${error?.message ?? error}\`)
  process.exit(1)
}
console.log(\`全部通过：\${passed} 项通过，0 项失败\`)
`
}

function readme({ packageName, title, id, prefix, coreRel }) {
  return `# ${title}

Laurel 系列插件（由 \`scripts/create-plugin.mjs\` 生成）。

## 装进 DSH

1. \`npm run build:client\` —— 打客户端半边到 \`lib/client.js\`
2. 把本目录 link 到 profile 的 \`node_modules\`：
   \`\`\`powershell
   New-Item -ItemType Junction -Path "<profile>\\node_modules\\${packageName}" -Target "<本目录>"
   \`\`\`
3. 在 profile 的 \`cordis.patch.yml\` 里 insert（或用 bundle 机制挂）：
   \`\`\`yaml
   - insert:
       - id: ${id}
         name: ${packageName}/lib/index.js
   \`\`\`
4. 客户端半边**热替换**：刷新页面即生效；宿主半边改了要重启 DSH。

## 端点

宿主半边挂在 \`${prefix}\`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | \`/status\` | 只读快照（配置、版本、路径） |
| GET | \`/config\` | 生效配置 |
| POST | \`/config\` | 改配置（归一化后落盘） |
| POST | \`/event\` | 浏览器半边回传事件，落 \`$DSH_HOME/${packageName}/events.log\` |
| GET | \`/events\` | 读回事件（\`?limit=N\`，最新在前） |

## 测试

\`\`\`powershell
npm test          # 两套都跑
npm run test:client   # 客户端半边：打包 → vm 里按宿主约定真跑
npm run test:host     # 宿主半边：真挂路由，用真 req/res 打每个端点
\`\`\`

- **test:client** 查的是客户端契约：产物形状、\`window.__ModuleLoader__.load\`、
  跨 realm 的 Map 快照、设置页插槽、静态守卫（不许出现 \`instanceof Map\` 判内建类型）。
- **test:host** 查的是宿主契约：路由真挂上了、配置归一化真在把关（未知键丢掉、
  非法 enum 退回默认）、配置真落盘、404 与 405 分开报。
  它把 \`DSH_HOME\` 指到临时目录，**不会碰你机器上真实的插件数据**。

## 改的时候

- 客户端代码写 \`lib/client/index.mjs\`，**不要手改 \`lib/client.js\`**（生成物）
- 加配置字段：同时改 \`lib/index.js\` 的 \`FIELDS\` 和 \`cordis.patch.yml\` 的 \`config\`
- 改完跑 \`npm test\`

## 复用 Laurel 的核心

本插件 import \`${coreRel}\` 下的 kit 与 core（相对路径，已写进生成物）：

- \`lib/client-kit.js\` —— requestJSON / loadConfig / reportEvent / probeEnvironment /
  ensurePermission / createThrottle / pickText / truncateBody / **toMap** / registerSettingsSection
- \`lib/core/*.js\` —— home / logger / config / settings / events / http

**先读 \`${coreRel}/docs/PLUGIN-CONTRACT.md\`**：那些静默失效的坑都在里面。
`
}

function license() {
  return `MIT License

Copyright (c) 2026 Laurel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
}

function gitignore() {
  return `node_modules/
*.log
.bak
`
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function main(argv) {
  const args = parseArgs(argv)
  if (args.help) { console.log(HELP.trim()); return 0 }

  const invalid = validateId(args.id)
  if (invalid) return fail(invalid) ?? 1

  const { id } = args
  const packageName = `laurel-${id}`
  const title = args.title ?? id
  const prefix = `/${packageName}`
  const outDir = resolve(args.dir ?? join(REPO_ROOT, '..', packageName))

  // 生成到 Laurel 仓库自己头上：coreRel 会变成 '.'，生成物的 import 全断。
  // 这个检查要放在"目录已存在"之前，否则通用报错会把它盖掉，看不出真正原因。
  if (resolve(outDir) === resolve(REPO_ROOT)) {
    return fail(`目标目录不能就是 Laurel 仓库本身：${outDir}\n  生成物 import Laurel 的 kit/core，同一目录下相对路径无解。`) ?? 1
  }

  if (existsSync(outDir) && !args.force) {
    return fail(`目录已存在：${outDir}\n  要覆盖同名文件就加 --force`) ?? 1
  }

  // 生成物 import Laurel 的 kit/core：**按每个文件自己的位置**算相对路径。
  // 目录深度不同，退的级数就不同 —— 算错就是 ERR_MODULE_NOT_FOUND：
  //   lib/index.js        → 退 2 级
  //   tests/contract.mjs  → 退 2 级
  //   根目录（package.json 的脚本）→ 退 1 级
  const coreRel = relative(outDir, REPO_ROOT).replace(/\\/g, '/')
  const coreFromLib = relative(join(outDir, 'lib'), REPO_ROOT).replace(/\\/g, '/')
  const coreFromTests = relative(join(outDir, 'tests'), REPO_ROOT).replace(/\\/g, '/')

  const files = {
    'package.json': packageJson({ id, packageName, title, coreRel }),
    'cordis.patch.yml': cordisPatch({ id, packageName, title }),
    'lib/index.js': hostEntry({ packageName, title, coreFromLib, prefix }),
    'lib/client/index.mjs': clientEntry({ packageName, title, prefix }),
    'tests/contract.mjs': contractTest({ packageName, title, coreFromTests, coreRel }),
    'tests/host.mjs': hostTest({ packageName, coreFromTests, coreRel }),
    'README.md': readme({ packageName, title, id, prefix, coreRel }),
    'LICENSE': license(),
    '.gitignore': gitignore(),
  }

  const written = []
  for (const [rel, content] of Object.entries(files)) {
    const full = join(outDir, rel)
    if (existsSync(full) && !args.force) return fail(`文件已存在：${rel}（加 --force 覆盖）`) ?? 1
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
    written.push(rel)
  }

  // 校验一下生成物里的 import 路径真的能解析（生成骨架最容易在这里悄悄错）。
  const missing = CORE_MODULES.filter((file) => !existsSync(join(REPO_ROOT, 'lib/core', file)))
  if (missing.length) {
    console.warn(`⚠ Laurel 的 lib/core 缺文件：${missing.join(', ')}（生成物会 import 失败）`)
  }
  if (!existsSync(join(REPO_ROOT, 'lib/client-kit.js'))) {
    console.warn('⚠ 找不到 Laurel 的 lib/client-kit.js（生成物会 import 失败）')
  }

  const relOut = relative(process.cwd(), outDir) || outDir
  console.log(`✓ 已生成 ${packageName}（${written.length} 个文件）于 ${outDir}`)
  console.log(`  复用 Laurel core：${coreRel}`)
  console.log('')
  console.log('接下来：')
  console.log(`  1. cd ${relOut}`)
  console.log('  2. npm run build:client        # 打客户端半边')
  console.log('  3. npm test                    # 契约自检（重新打包 + vm 里真跑）')
  console.log('')
  console.log(`  端点前缀：${prefix}   设置页 id：${packageName}`)
  console.log(`  契约全文：${coreRel}/docs/PLUGIN-CONTRACT.md`)
  return 0
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedDirectly) process.exitCode = main(process.argv.slice(2)) ?? 0
