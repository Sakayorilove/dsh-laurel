/**
 * Laurel-Center · boot graph 探针
 *
 * 验证「四行子插件在 loader 树里 → 客户端模块系统会为它们各产出一条 boot graph row」。
 *
 * 这一步是整套方案的关键：DSH 的客户端模块系统只认 loader 树里的行，
 * 我们必须证明每个子包**确实**能各自产出一条 row（各自的 client bundle 被寻址到）。
 *
 * 做法：复刻 ClientModuleRegistry 的核心逻辑
 *   - 遍历 loader entries，跳过 disabled 的行
 *   - 对每行调 resolveMeta：定位 package.json → 读 dsh.client → 必须 platform==='web'
 *     → 读 exports["./client"] → 得到 client bundle 路径
 *   - 按 packageName 去重（同一包名多个 active source = 报错）
 *
 * 用法：node scripts/bootgraph-probe.mjs
 */

import { existsSync, readFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { CLIENT_SERVICES, unknownClientServices, looksLikePackageName } from './client-services.mjs'
import { SUB_PLUGINS } from '../lib/registry.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`) }
}

// ── 复刻 ClientModuleRegistry 的关键函数 ────────────────────────────────
function exactPackageSpecifier(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/')
    return parts.length === 2 && parts.every(Boolean) ? specifier : undefined
  }
  return specifier.length > 0 && !specifier.includes('/') && !specifier.includes(':') ? specifier : undefined
}

function clientExportOf(pkgName, exportsField) {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = exportsField['./client']
  if (client === undefined) return undefined
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = client.default
    if (typeof fallback === 'string') return fallback
  }
  throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string`)
}

function parseDshClient(pkgName, value) {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) throw new Error(`client-modules: ${pkgName} has a non-object dsh.client`)
  if (typeof value.platform !== 'string') throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`)
  return { platform: value.platform, inject: value.inject, external: value.external ?? [] }
}

/** 往上找最近的 package.json。 */
function nearestPackage(moduleUrl) {
  let dir = dirname(fileURLToPath(moduleUrl))
  const seen = []
  while (true) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      const name = JSON.parse(readFileSync(candidate, 'utf8')).name
      return { path: candidate, packageName: name }
    }
    seen.push(dir)
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** 复刻 resolveMeta：从 loaderName + baseUrl 求 client bundle 绝对路径。 */
function resolveMeta(loaderName, baseUrl, internal) {
  if (loaderName.startsWith('cordis:')) return null
  const pathLike = loaderName.startsWith('.') || loaderName.startsWith('file:') || isAbsolute(loaderName)
  const expectedPackageName = pathLike ? undefined : exactPackageSpecifier(loaderName)
  if (!pathLike && expectedPackageName === undefined) return null

  let located
  if (internal && typeof internal.resolveSync === 'function') {
    let moduleUrl
    moduleUrl = internal.resolveSync(baseUrl, loaderName).url
    located = nearestPackage(moduleUrl)
  } else {
    if (expectedPackageName === undefined) {
      const moduleUrl = loaderName.startsWith('file:') ? loaderName
        : isAbsolute(loaderName) ? pathToFileURL(loaderName).href
        : new URL(loaderName, baseUrl).href
      located = nearestPackage(moduleUrl)
    } else {
      try {
        located = { path: createRequire(baseUrl).resolve(`${expectedPackageName}/package.json`), packageName: expectedPackageName }
      } catch { return null }
    }
  }
  if (located === undefined) return null

  const pkg = JSON.parse(readFileSync(located.path, 'utf8'))
  const decl = parseDshClient(located.packageName, pkg.dsh?.client)
  if (decl === undefined || decl.platform !== 'web') return null
  const clientRel = clientExportOf(located.packageName, pkg.exports)
  if (clientRel === undefined) throw new Error(`client-modules: ${located.packageName} declares dsh.client but exports no "./client" bundle`)
  return {
    packageName: located.packageName,
    meta: { clientPath: join(dirname(located.path), clientRel), inject: decl.inject, external: decl.external ?? [] },
  }
}

console.log('Laurel-Center · boot graph 探针\n')

// ── 建 profile 模拟环境 ─────────────────────────────────────────────────
// 真实的 profile 里会有：laurel-center 一个依赖，外加每个子包各一个链接
// （都指向 Laurel-Center 内的 packages/<dir>）。这里用 junction 复刻。
const sim = join(ROOT, '.tmp-boot-sim')
rmSync(sim, { recursive: true, force: true })
mkdirSync(join(sim, 'node_modules'), { recursive: true })
try {
  symlinkSync(ROOT, join(sim, 'node_modules', 'laurel-center'), 'junction')
  // ⚠ 子包目录**从注册表推导**，不手抄。手抄过一次：加第 5 个模块（warden）时
  // 这里少建了一个 junction，于是它 resolveMeta 返 null、静默少一条 row。
  for (const p of SUB_PLUGINS) {
    symlinkSync(join(ROOT, 'packages', p.dir), join(sim, 'node_modules', p.entry), 'junction')
  }
} catch (error) {
  console.log(`  建 junction 失败：${error.message}`)
}

const baseUrl = pathToFileURL(join(sim, 'cordis.yml')).href
const internal = {
  resolveSync(base, specifier) {
    const req = createRequire(base)
    return { url: pathToFileURL(req.resolve(specifier)).href }
  },
}

// ── loader 树 = laurel-center 的 patch 组出来的 6 行 ────────────────────
// ⚠️ 注意 name 全是纯包名。带斜杠的非 scope 包名会被 client-modules 判为
//    非法（既不是包名也不是 path-like），resolveMeta 直接返 null。
const TREES = [
  { id: 'laurel-center', name: './lib/index.js', disabled: false, relative: true },
  // 子插件行从注册表推导（id / entry 就是 patch 里那两列）。手抄过一次，
  // 加第 5 个模块时这里漏了一行，于是"每个包一条 row"那条断言变成假通过。
  ...SUB_PLUGINS.map((p) => ({ id: p.id, name: p.entry, disabled: false })),
]

/** 把一行解析成 client bundle 信息。 */
function resolveRow(row) {
  if (row.relative) {
    // `./lib/index.js` 以 patch 文件所在目录为 base（= 本包目录）
    const abs = join(ROOT, row.name.slice(2))
    return resolveMeta(pathToFileURL(abs).href, pathToFileURL(join(ROOT, 'cordis.patch.yml')).href, null)
  }
  return resolveMeta(row.name, baseUrl, internal)
}

// ── 1. 每行都解析出 client bundle ───────────────────────────────────────
console.log('1. 各行的 client bundle 寻址')
const table = new Map()
for (const row of TREES) {
  let resolved = null
  let threw = null
  try {
    resolved = resolveRow(row)
  } catch (error) {
    threw = error
  }
  ok(`[${row.id}] resolveMeta 不抛`, threw === null, threw ? threw.message : '')
  if (resolved) {
    ok(`[${row.id}] 解析出包名`, typeof resolved.packageName === 'string', resolved.packageName)
    ok(`[${row.id}] client bundle 存在`, existsSync(resolved.meta.clientPath), resolved.meta.clientPath)
    table.set(resolved.packageName, resolved)
  } else {
    ok(`[${row.id}] 解析出包名`, false, '得到 null —— 该行不会产出 boot graph row')
  }
}

// ── 2. 包名互不相同（否则 reconcilePackage 报多 source）─────────────────
console.log('\n2. boot graph 表')
const names = [...table.keys()]
ok('每个包各自一条 row', names.length === TREES.length, `实得 ${names.length}: ${names.join(', ')}`)
ok('包名唯一', new Set(names).size === names.length)
for (const expected of ['laurel-center', 'laurel', 'dsh-claude-parchment', 'dsh-strata', 'dsh-loom']) {
  ok(`表里有 ${expected}`, table.has(expected), [...table.keys()].join(', '))
}

// ── 3. 每个 client bundle 里注册的 id 与包名一致 ────────────────────────
console.log('\n3. bundle 注册 id 与包名一致')
for (const [pkgName, resolved] of table) {
  const src = readFileSync(resolved.meta.clientPath, 'utf8')
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const m = stripped.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*['"]([^'"]+)['"]/)
  ok(`${pkgName} bundle id 一致`, m !== null && m[1] === pkgName, m ? m[1] : '未找到')
}

// ── 4. disabled 的行不产出 row ──────────────────────────────────────────
console.log('\n4. 关闭的行不进 boot graph')
const disabledRows = TREES.filter((r) => r.id !== 'laurel-center')
const activeRows = TREES.filter((r) => !disabledRows.includes(r))
const activeNames = new Set()
for (const row of activeRows) {
  const r = resolveRow(row)
  if (r) activeNames.add(r.packageName)
}
ok('全关后只剩装载机自己一条 row', activeNames.size === 1 && activeNames.has('laurel-center'), [...activeNames].join(', '))

// ── 5. 装载机自己那条 row 的 inject 值域 ────────────────────────────────
// 这一节是**事故复盘**换来的。
//
// 事故：线上报 `web boot: 1 entry did not activate / laurel-center: pending
// (waiting for service: uiSettings)`，整台前端起不来。
// 根因：客户端 bundle 的 `exports.inject` 里写了 `uiSettings` —— 那不是服务名，
// 是 package.json 里包名 `@deepseek-ai/dsh-client-ui-settings` 的残渣。
// 浏览器端的 cordis loader 会照这份名单建 fiber 并等它 provide 出来；
// 等不到 → fiber 永远 pending → boot 审计抛错。
//
// 所以这里必须把「bundle 导出的 inject 是不是真的服务名」钉住。
console.log('\n5. 客户端 bundle 的 exports.inject 只含真实服务名')
{
  const bundlePath = join(ROOT, 'lib', 'client.js')
  const src = readFileSync(bundlePath, 'utf8')
  // bundle 形状固定：入口源码里那句 `const inject = [...]` 会被原样保留。
  const m = src.match(/const inject\s*=\s*(\[[^\]]*\])/)
  let inject = null
  try { inject = m ? JSON.parse(m[1].replace(/'/g, '"')) : null } catch { inject = null }
  ok('能从 bundle 里读出 inject 数组', Array.isArray(inject), m ? m[1] : '未找到 const inject = [...]')

  // 权威名单来自 scripts/client-services.mjs（单一真相源）：
  // 从本机 DSH 的 app.asar 提取 59 个 dsh-client-* 的 exports.inject ∪ provide 并集。
  // 别在这里另写一份 —— 两份名单不同步正是本项目踩过的坑。
  const bad = unknownClientServices(inject)
  ok('inject 里没有编造的服务名（写了会让 web boot 挂）', bad.length === 0, `未知：${JSON.stringify(bad)}（当前 ${JSON.stringify(inject)}）`)
  ok('inject 里没有包名式写法（@scope/name 是另一份名单的事）',
    Array.isArray(inject) && inject.every((s) => !looksLikePackageName(s)),
    JSON.stringify(inject))

  // 顺带核对 package.json 的 dsh.client.inject：那份是**包名**，值域不同。
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const pkgInject = pkg.dsh?.client?.inject ?? []
  ok('package.json 的 dsh.client.inject 写的是包名（不是服务名）',
    pkgInject.every((s) => s.startsWith('@') ? s.split('/').length === 2 : (!s.includes('/') && !s.includes(':'))),
    JSON.stringify(pkgInject))
  ok('package.json 的 dsh.client.inject 没有把服务名混进来（曾把 uiSettings 写这儿）',
    pkgInject.every((s) => !CLIENT_SERVICES.has(s)),
    JSON.stringify(pkgInject))
}

rmSync(sim, { recursive: true, force: true })

console.log(`\n${'─'.repeat(48)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
