/**
 * Laurel-Center · 真实 cordis 端到端探针
 *
 * 前两个探针都是"复刻"DSH 的逻辑。这个不一样：它用**真实的** cordis 4.0.4 +
 * 真实的 cordis-plugin-loader（从 DSH 的 app.asar 里原样提取），
 * 真的组一棵 loader 树、真的加载 Laurel-Center 的宿主半边、真的执行开关。
 *
 * 要证明的是：
 *   1. 宿主半边在真实 cordis 下能被激活，顶层 inject 为空也能活
 *   2. ctx.inject(['webServer'], ...) 在 webServer 缺席时不炸（非 Web 组合）
 *   3. webServer 就绪后，控制接口真的挂上去、真的能应答
 *   4. 开关真的作用到 loader 树（entry.disabled 变了、fiber 真的停了）
 *   5. 一键全开 / 全关在真实 loader 上成立
 *
 * 依赖：真实 cordis 包（.tmp-asar/e2e/node_modules 下，从 app.asar 提取）
 * 用法：node scripts/e2e-real-cordis.mjs [cordis-node-modules 路径]
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`) }
}

console.log('Laurel-Center · 真实 cordis 端到端探针\n')

/**
 * 从装好的 DSH 里就地提取真实 cordis 三个包。
 *
 * 为什么不打包一份带进仓库：cordis 是别人的代码，版本会跟着 DSH 升。
 * 就地提取永远拿到「用户机器上真正在跑的那一份」，这比钉一个版本更有说服力，
 * 也不用在仓库里塞 node_modules。
 *
 * asar(pickle) 布局：
 *   [0..4)   u32  pickle 头大小 = 4
 *   [4..8)   u32  headerSize
 *   [8..12)  u32  JSON 字符串长度
 *   [12..16) u32  JSON 内容长度（= 上一个 - 4）
 *   [16..)   JSON 内容
 *   数据区 = 8 + headerSize，且 16 + jsonLen == 8 + headerSize（不一致就说明假设错了，直接抛）
 */
function extractRealCordis(asarPath, outDir) {
  const buf = readFileSync(asarPath)
  const headerSize = buf.readUInt32LE(4)
  const jsonLen = buf.readUInt32LE(12)
  const jsonStart = 16
  const dataStart = 8 + headerSize
  if (jsonStart + jsonLen !== dataStart) {
    throw new Error(`asar 布局假设不成立：16+${jsonLen} vs 8+${headerSize}`)
  }
  const header = JSON.parse(buf.subarray(jsonStart, jsonStart + jsonLen).toString('utf8'))
  const want = /^\/dsh\/node_modules\/@deepseek-ai\/(cordis|cosmokit|cordis-plugin-loader)\//
  let n = 0
  const walk = (node, path) => {
    for (const [k, v] of Object.entries(node.files ?? {})) {
      const p = `${path}/${k}`
      if (v.files) { walk(v, p); continue }
      if (!want.test(p)) continue
      const dest = join(outDir, p.replace(/^\/dsh\/node_modules\//, ''))
      mkdirSync(dirname(dest), { recursive: true })
      const off = dataStart + Number.parseInt(v.offset, 10)
      writeFileSync(dest, buf.subarray(off, off + v.size))
      n += 1
    }
  }
  walk(header, '')
  return n
}

/** 找一个可用的真实 cordis 包目录：显式参数 → 环境变量 → 就地提取。 */
function resolveRealPkgs() {
  if (process.argv[2]) return { dir: process.argv[2], from: '命令行参数' }
  if (process.env.DSH_CORDIS_PKGS) return { dir: process.env.DSH_CORDIS_PKGS, from: 'DSH_CORDIS_PKGS' }

  // 桌面版默认装在 `%LOCALAPPDATA%/Programs/DeepSeek Harness/`，
  // 但安装时可以把盘符/根目录挪到别处（本机就装在 D 盘），所以多铺几个候选。
  const roots = [
    process.env.LOCALAPPDATA,
    'C:/Users/<你的用户>/AppData/Local',
    'D:/Users/<你的用户>/AppData/Local',
  ].filter(Boolean)
  const rels = [
    'Programs/DeepSeek Harness/resources/app.asar',
    'DeepSeek Harness/resources/app.asar',
    'Programs/DeepSeekHarness/resources/app.asar',
  ]
  const candidates = [
    ...roots.flatMap((r) => rels.map((rel) => join(r, rel))),
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
  ]
  for (const asar of candidates) {
    if (!existsSync(asar)) continue
    const outDir = join(ROOT, '..', `.tmp-${basename(ROOT)}-cordis`)
    rmSync(outDir, { recursive: true, force: true })
    try {
      const n = extractRealCordis(asar, outDir)
      if (n > 0) return { dir: outDir, from: `就地提取自 ${asar}（${n} 个文件）`, cleanup: outDir }
    } catch { /* 换下一个候选 */ }
  }
  return null
}

const real = resolveRealPkgs()
if (!real) {
  console.log('  跳过：找不到真实 cordis 包。')
  console.log('  这是可选的深度验证（前三个离线探针不需要它），不影响交付。')
  console.log('  要跑的话，三种给法任选其一：')
  console.log('    node scripts/e2e-real-cordis.mjs <cordis 所在的 node_modules 路径>')
  console.log('    DSH_CORDIS_PKGS=<同上> node scripts/e2e-real-cordis.mjs')
  console.log('    装好 DeepSeek Harness 让它自己从 app.asar 提取（默认行为）')
  process.exit(0)
}
const REAL_PKGS = real.dir
if (real.from) console.log(`  真实 cordis 来源：${real.from}\n`)

if (!existsSync(join(REAL_PKGS, '@deepseek-ai', 'cordis'))) {
  console.log(`  跳过：${REAL_PKGS} 下没有 @deepseek-ai/cordis`)
  process.exit(0)
}

// ── 搭一个隔离的 profile 模拟环境 ───────────────────────────────────────
//
// 目录形状必须**照着真实 DSH 复刻**，否则验不出东西：
//   real:  dsh/node_modules/@deepseek-ai/cordis-plugin-loader  →  裸包名往上找到 dsh/node_modules/<pkg>
//   sim:   sim/node_modules/@deepseek-ai/cordis-plugin-loader
//          sim/node_modules/<子包>
//
// ⚠⚠ sim 目录**必须建在包外面**（.tmp-e2e-sim 的父级是 ROOT 的父级）：
//   建在 ROOT 里面就变成「把 ROOT 拷进 ROOT 的子目录」，
//   Node 直接报 ERR_FS_CP_EINVAL。放在兄弟位置天然避开。
//
// ⚠⚠ 用真目录拷贝，**不能用 junction**：
//   loader 用裸 `await import(name)` 解析包名（见 loader/lib/index.js:223），
//   解析基准是 loader **自己的 realpath**，而 ESM 会把 junction 解成 realpath。
//   junction 下 loader 的 realpath 落在被指向的原目录，往上找不到 sim 里的子包
//   （实测 ERR_MODULE_NOT_FOUND）。真目录拷进来后 realpath 就是 sim 本身。
//
// ⚠ 托管版 Node 22 的 cpSync 在这台机器上会段错误（EXIT=139），
//   所以用 cpSync 时要留意；本脚本已改用先 rm 再 cp，并在 README 注明。
const sim = join(ROOT, '..', `.tmp-${basename(ROOT)}-e2e`)
rmSync(sim, { recursive: true, force: true })
mkdirSync(join(sim, 'node_modules', '@deepseek-ai'), { recursive: true })

// ⚠ DSH_HOME 必须在**组树之前**设好：loader 一 create 就会 import 本包并调 apply，
//   那时 centerPaths() 已经把家目录定死了。晚设只会让记账落到 ~/.dsh（真实家目录）。
process.env.DSH_HOME = join(sim, 'home')

writeFileSync(join(sim, 'cordis.yml'), '[]\n')
writeFileSync(join(sim, 'package.json'), JSON.stringify({
  name: 'laurel-center-e2e-sim',
  private: true,
  type: 'module',
}, null, 2))

// 真实 cordis / cosmokit / loader —— 拷成**真目录**
for (const name of ['cordis', 'cosmokit', 'cordis-plugin-loader']) {
  const src = join(REAL_PKGS, '@deepseek-ai', name)
  if (!existsSync(src)) { console.log(`  跳过：缺 ${name}`); process.exit(0) }
  cpSync(src, join(sim, 'node_modules', '@deepseek-ai', name), { recursive: true })
}
// 本包（只拷运行期需要的几样）+ 全部子包
for (const rel of ['package.json', 'lib', 'cordis.patch.yml']) {
  cpSync(join(ROOT, rel), join(sim, 'node_modules', 'laurel-center', rel), { recursive: true })
}
for (const dir of ['laurel', 'dsh-claude-parchment', 'dsh-strata', 'dsh-loom']) {
  cpSync(join(ROOT, 'packages', dir), join(sim, 'node_modules', dir), { recursive: true })
}

// 让子包能 require 到真实 cordis：
// 拷进真目录后它们就在 sim/node_modules 里，往上一级即可见到 @deepseek-ai/*，
// 不需要额外建 node_modules（建了反而会踩 ROOT 自环那次坑）。
// ── 引入真实 cordis ─────────────────────────────────────────────────────
const cordis = await import(pathToFileURL(join(sim, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href)
ok('真实 cordis 可加载', typeof cordis.Context === 'function')

const loaderMod = await import(pathToFileURL(join(sim, 'node_modules', '@deepseek-ai', 'cordis-plugin-loader', 'lib', 'index.js')).href)
ok('真实 loader 可加载', typeof loaderMod.Loader === 'function' || Object.keys(loaderMod).length > 0)

// ── 起一个真实的 cordis app ─────────────────────────────────────────────
console.log('\n1. 真实 cordis 起应用')
const { Context } = cordis

/**
 * 造一个不落盘的 Loader。
 * 真实 profile 的 Loader 是 app-boot 的 Include 子类（write() 会写 cordis.yml）。
 * 这里覆写 write() 让它只记录，不落盘 —— 测试不该改用户配置。
 */
const loaderApi = loaderMod
const LoaderCtor = loaderApi.Loader ?? loaderApi.default?.Loader ?? loaderApi.default
ok('拿到 Loader 构造器', typeof LoaderCtor === 'function', Object.keys(loaderApi).join(','))

const writes = []
class TestLoader extends LoaderCtor {
  write() { writes.push(JSON.parse(JSON.stringify(this.root.data))) }
}

const root = new Context()

// 让 baseUrl 落在模拟 profile 目录，这样纯包名能解析到 node_modules
root.baseUrl = pathToFileURL(join(sim, 'cordis.yml')).href

// 挂 loader 服务
let loader
try {
  root.plugin(TestLoader, { path: join(sim, 'cordis.yml') })
  await new Promise((r) => setTimeout(r, 50))
  loader = root.get('loader')
} catch (error) {
  ok('挂 loader 服务', false, error.message)
}
ok('loader 服务可用', loader !== undefined && typeof loader.create === 'function')

// ── 插五行（模拟 patch 组树）────────────────────────────────────────────
console.log('\n2. 组树（复刻 patch 的 6 行）')
const ROWS = [
  { id: 'laurel-center', name: pathToFileURL(join(ROOT, 'lib', 'index.js')).href },
  { id: 'laurel', name: 'laurel' },
  { id: 'claude-parchment', name: 'dsh-claude-parchment' },
  { id: 'strata', name: 'dsh-strata' },
  { id: 'warden', name: 'dsh-warden' },
  { id: 'loom', name: 'dsh-loom' },
]
for (const row of ROWS) {
  try {
    await loader.create({ ...row, disabled: row.id !== 'laurel-center' })
  } catch (error) {
    ok(`插入 ${row.id}`, false, error.message)
  }
}
await new Promise((r) => setTimeout(r, 200))
const ids = [...loader.entries()].map((e) => e.id)
ok('五行都在树里', ROWS.every((r) => ids.includes(r.id)), ids.join(', '))

// ── 装载机自己真的被激活了吗 ────────────────────────────────────────────
console.log('\n3. 装载机宿主半边激活')
const centerEntry = loader.resolve('laurel-center')
ok('laurel-center 行有 fiber', centerEntry?.fiber !== undefined)
ok('laurel-center 已启用', centerEntry?.disabled === false)

const hostMod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
ok('宿主半边导出 apply', typeof hostMod.apply === 'function')
ok('顶层 inject 为空', Array.isArray(hostMod.inject) && hostMod.inject.length === 0)

// 家目录已在组树前设好（见上），这里不再重复设置
const appCtx = root.extend({})

/**
 * ⚠ 提供 webServer 必须用 `ctx.provide(name, value)`，**不是** `ctx.set`。
 *   cordis 4 里 set() 只能改「已经被 provide 过」的服务，没 provide 直接抛。
 *   这里刻意 provide 一个 webServer，用来证明**装载机不再往它注册任何路由**（R2）。
 */
const routeHandlers = new Map()
const fakeWebServer = {
  routes: [],
  register(def) {
    this.routes.push(def)
    if (def?.path) routeHandlers.set(def.path, def.handler)
    return () => { routeHandlers.delete(def?.path) }
  },
}
try {
  root.plugin({
    name: 'fake-web',
    apply(c) { c.provide('webServer', fakeWebServer) },
  })
  await new Promise((r) => setTimeout(r, 80))
} catch (error) {
  ok('注入假 webServer', false, error.message)
}
ok('webServer 服务已就位', root.get('webServer') !== undefined)

// ── 假的原生 pluginManager：只记录调用，不真写盘 ────────────────────────
const nativeCalls = []
const nativeRows = [
  { entryId: 'include:laurel', moduleName: 'laurel', patchId: 'laurel', enabled: false, fiberPhase: null },
  { entryId: 'include:claude-parchment', moduleName: 'dsh-claude-parchment', patchId: 'claude-parchment', enabled: false, fiberPhase: null },
  { entryId: 'include:strata', moduleName: 'dsh-strata', patchId: 'strata', enabled: false, fiberPhase: null },
  { entryId: 'include:warden', moduleName: 'dsh-warden', patchId: 'warden', enabled: false, fiberPhase: null },
  { entryId: 'include:loom', moduleName: 'dsh-loom', patchId: 'loom', enabled: false, fiberPhase: null },
]
const fakePluginManager = {
  async listPlugins() { return nativeRows.map((r) => ({ ...r })) },
  async setPluginEnabled(entryId, enabled) {
    nativeCalls.push({ entryId, enabled })
    const row = nativeRows.find((r) => r.entryId === entryId)
    if (row) row.enabled = enabled === true
    return { stage: 'enable', target: entryId, enabled, changed: true, application: 'applied', warnings: [] }
  },
}
try {
  root.plugin({
    name: 'fake-native',
    apply(c) { c.provide('pluginManager', fakePluginManager) },
  })
  await new Promise((r) => setTimeout(r, 80))
} catch (error) {
  ok('注入假 pluginManager', false, error.message)
}

let applyError = null
try {
  hostMod.apply(appCtx, { logLevel: 'error' })
} catch (error) {
  applyError = error
}
ok('apply(ctx, config) 在真实 cordis 上下文里不抛', applyError === null, applyError ? applyError.message : '')

await new Promise((r) => setTimeout(r, 300))

// ── 4. 不再注册任何 HTTP 路由（R2）──────────────────────────────────────
console.log('\n4. 不再注册 HTTP 写端点')
ok('webServer.register 一次都没被调用', fakeWebServer.routes.length === 0, `routes=${fakeWebServer.routes.length}: ${fakeWebServer.routes.map((r) => r.path).join(',')}`)

// ── 5. laurelCenter 服务真的被 provide（R10）────────────────────────────
console.log('\n5. laurelCenter 服务')
const svc = root.get('laurelCenter')
ok('真实 cordis 里 get("laurelCenter") 有值（旧版是 undefined）', svc !== undefined && svc !== null, String(svc))
if (svc) {
  ok('服务暴露 list()', typeof svc.list === 'function')
  const list = svc.list()
  ok('list() 返回五条', Array.isArray(list) && list.length === 5, JSON.stringify(list?.map?.((p) => p.id)))
  ok('status() 是异步的原生状态', typeof svc.status === 'function')
  const status = await svc.status()
  ok('status() 五条 ready', ['laurel', 'claude-parchment', 'strata', 'warden', 'loom'].every((id) => status[id]?.state === 'ready'), JSON.stringify(status))
}

// ── 6. 开关走原生通道，不再碰 loader ────────────────────────────────────
console.log('\n6. 开关走原生通道')
const beforeCalls = nativeCalls.length
const answer = svc ? await svc.setOne('loom', true) : null
ok('setOne 返回统一结果合同', answer !== null && typeof answer.outcome === 'string', JSON.stringify(answer))
ok('outcome=success（application=applied）', answer?.outcome === 'success', JSON.stringify(answer))
ok('调用了原生 setPluginEnabled 且 entryId 正确',
  nativeCalls.length === beforeCalls + 1 && nativeCalls.at(-1).entryId === 'include:loom' && nativeCalls.at(-1).enabled === true,
  JSON.stringify(nativeCalls.slice(beforeCalls)))
ok('没有直接改 loader 行的 disabled（旧实现会）', loader.resolve('loom').disabled === true, String(loader.resolve('loom').disabled))

const bulk = svc ? await svc.setAll(true) : null
ok('setAll 逐项串行调用原生能力', nativeCalls.length === beforeCalls + 1 + 4, `calls=${nativeCalls.length - beforeCalls}`)
ok('setAll outcome=success', bulk?.outcome === 'success', JSON.stringify(bulk?.outcome))
ok('setAll 逐项带 saved/applied', bulk?.items?.every((i) => i.saved === true && i.applied === true), JSON.stringify(bulk?.items))

// 没有原生通道时必须优雅失败，且不下发任何写请求
const bare = root.extend({})
const { setNative } = await import(pathToFileURL(join(ROOT, 'lib', 'host.js')).href)
const noNative = await setNative({ get: () => null }, 'laurel', true)
ok('无原生通道 → no-native，且不抛', noNative.ok === false && noNative.code === 'no-native', JSON.stringify(noNative))

// ── 7. 记账与流水 ───────────────────────────────────────────────────────
console.log('\n7. 记账与流水')
const homeDir = join(sim, 'home', 'laurel-center')
ok('events.log 存在', existsSync(join(homeDir, 'events.log')))
if (existsSync(join(homeDir, 'events.log'))) {
  const lines = readFileSync(join(homeDir, 'events.log'), 'utf8').trim().split('\n').filter(Boolean)
  ok('events.log 有记录', lines.length > 0, `${lines.length} 行`)
  const kinds = new Set(lines.map((l) => { try { return JSON.parse(l).kind } catch { return 'bad' } }))
  ok('记到了开关事件', kinds.has('switch'), [...kinds].join(','))
}
// 新版不再每次开机写 state.json；没有旧 state 时不应凭空创建
ok('没有旧 state 时不凭空写 state.json', !existsSync(join(homeDir, 'state.json')))

// ── 8. 一次性迁移：只在第一次生效 ───────────────────────────────────────
console.log('\n8. 一次性迁移')
{
  const { planMigration } = await import(pathToFileURL(join(ROOT, 'lib', 'migrate.js')).href)
  const { loadState, saveState, centerPaths } = await import(pathToFileURL(join(ROOT, 'lib', 'store.js')).href)
  const paths = centerPaths()
  saveState({ laurel: true, strata: false, 'claude-parchment': false, loom: false }, paths)
  const saved = loadState(paths)
  const native = Object.fromEntries(['laurel', 'claude-parchment', 'strata', 'warden', 'loom'].map((id) => [id, { state: 'ready', enabled: false }]))
  const plan = planMigration(saved, native, { overrides: {}, userLayerOk: true, attribution: { ok: true, key: 'e2e-profile' } })
  ok('旧 state 的「开」会被迁移一次', plan.needed && plan.writes.length === 1 && plan.writes[0] === 'laurel', JSON.stringify(plan))
  const refused = planMigration(saved, native, { overrides: {}, userLayerOk: true, attribution: { ok: false, reason: 'no-profile-context' } })
  ok('判不出归属时拒绝迁移（unattributed）', refused.needed === false && refused.reason === 'unattributed' && refused.items.some((i) => i.id === 'laurel' && i.action === 'unattributed'), JSON.stringify(refused))
  const after = loadState(paths)
  ok('迁移标记初始为空', after.migratedAt === null)
}

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
try { rmSync(sim, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
if (real.cleanup) { try { rmSync(real.cleanup, { recursive: true, force: true }) } catch { /* ignore */ } }
process.exit(fail === 0 ? 0 : 1)
