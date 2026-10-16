/**
 * dsh-strata · 装进 profile 之后的验证
 *
 * 跑法：`node tests/installed.mjs`
 *
 * 这个脚本回答一个问题：**插件挂进 `node_modules` 之后，还加载得起来吗？**
 * 它和 `smoke.mjs` 的分工是：
 *   smoke.mjs      从源码目录加载，测逻辑
 *   installed.mjs  从 profile 的 node_modules 解析包名加载，测「装对了没」
 *
 * 覆盖三件事：
 *   1. `require.resolve('dsh-strata/package.json')` 能从 profile 解析到（link 生效）
 *   2. `cordis.patch.yml` 里 `name: ./lib/index.js` 这个**相对路径**能落到真实文件
 *   3. 用假 ctx 跑一遍 `apply()`，八个工具 / pre-step 监听 / /strata 路由都挂得上
 *
 * **不碰真实数据**：把 `DSH_HOME` 指到临时目录，跑完删掉。
 * 不需要 dsh 在运行。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const PROFILE = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop')

let pass = 0
let fail = 0
const failures = []

function check(label, fn) {
  try {
    const ok = fn()
    if (ok === false) throw new Error('断言返回 false')
    pass++
    console.log(`  ✓ ${label}`)
  } catch (error) {
    fail++
    failures.push(`${label} —— ${error?.message ?? error}`)
    console.log(`  ✗ ${label}  →  ${error?.message ?? error}`)
  }
}

console.log(`profile: ${PROFILE}\n`)

/* ---------------- 1. 包名能不能解析 ---------------- */

console.log('包解析')
let pkgDir = null
try {
  const require = createRequire(join(PROFILE, 'package.json'))
  const pkgJsonPath = require.resolve('dsh-strata/package.json')
  pkgDir = dirname(pkgJsonPath)
  check('require.resolve("dsh-strata/package.json") 成功', () => true)
  check('解析到的是源码目录（link 生效）', () => {
    if (!pkgDir.toLowerCase().includes('laurel套件')) throw new Error(`解析到了 ${pkgDir}，不是源码目录`)
    return true
  })
} catch (error) {
  check('require.resolve("dsh-strata/package.json") 成功', () => { throw error })
}

if (!pkgDir) {
  console.log('\n包都解析不到，后面的检查没意义。先确认 pnpm install 跑过了。')
  process.exit(1)
}

/* ---------------- 2. package.json 与 patch 的相对路径 ---------------- */

console.log('\n元数据与入口')
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))

check('package.json 的 name 是 dsh-strata', () => {
  if (pkg.name !== 'dsh-strata') throw new Error(`实际是 ${pkg.name}`)
  return true
})

check('exports["./client"] 指向真实文件', () => {
  const rel = pkg.exports?.['./client']
  if (typeof rel !== 'string') throw new Error('没声明 exports["./client"]')
  if (!existsSync(resolve(pkgDir, rel))) throw new Error(`${rel} 不存在`)
  return true
})

check('dsh.client.inject 非空（否则 boot graph 没有顺序边）', () => {
  const inject = pkg.dsh?.client?.inject
  if (!Array.isArray(inject) || inject.length === 0) throw new Error('是空的')
  return true
})

check('dsh.bundle.patch 指向真实文件', () => {
  const rel = pkg.dsh?.bundle?.patch
  if (typeof rel !== 'string') throw new Error('没声明')
  if (!existsSync(resolve(pkgDir, rel))) throw new Error(`${rel} 不存在`)
  return true
})

// patch 里的 name 是相对路径，宿主的 composeEntries 会把它变成 file URL。
const patchText = readFileSync(resolve(pkgDir, pkg.dsh.bundle.patch), 'utf8')
const nameMatch = patchText.match(/^\s*name:\s*(\S+)\s*$/m)

check('cordis.patch.yml 的 name 是相对路径（不含绝对路径 / 盘符）', () => {
  if (!nameMatch) throw new Error('没找到 name 字段')
  const value = nameMatch[1]
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) throw new Error(`是绝对路径：${value}`)
  return true
})

check('cordis.patch.yml 的 name 能落到真实入口文件', () => {
  const entry = resolve(pkgDir, nameMatch[1])
  if (!existsSync(entry)) throw new Error(`${nameMatch[1]} → ${entry} 不存在`)
  return true
})

/* ---------------- 3. 假 ctx 跑 apply ---------------- */

console.log('\n宿主半边挂载（假 ctx）')

const sandbox = mkdtempSync(join(tmpdir(), 'strata-installed-'))
process.env.DSH_HOME = sandbox

const registeredTools = []
const registeredRoutes = []
const listeners = []
const tapIndexFns = []

const services = {
  tools: { register: (def) => { registeredTools.push(def) } },
  webServer: {
    register: (route) => { registeredRoutes.push(route); return () => {} },
    tapIndex: (fn) => { tapIndexFns.push(fn); return () => {} },
  },
  sessionQuery: null,
}

const ctx = {
  get: (name) => services[name] ?? null,
  inject: (names, cb) => { cb(ctx) },
  on: (event, handler) => { listeners.push({ event, handler }); return () => {} },
  effect: (fn) => fn(),
}

let status = null
try {
  const mod = await import(pathToFileURL(resolve(pkgDir, nameMatch[1])).href)
  check('lib/index.js 能被 import', () => true)
  check('导出 apply 函数', () => typeof mod.apply === 'function')
  check('顶层 inject 是空数组', () => Array.isArray(mod.inject) && mod.inject.length === 0)

  const handle = mod.apply(ctx, {})
  status = handle?.status?.()

  check('apply 返回了 status 快照', () => status?.ok === true)
  check('status.package 是 dsh-strata', () => status?.data?.package === 'dsh-strata')
} catch (error) {
  check('lib/index.js 能被 import 并 apply', () => { throw error })
}

const expectedTools = [
  'memory_recall', 'memory_remember', 'memory_forget', 'memory_link',
  'memory_scope', 'memory_stats', 'memory_backfill', 'memory_handoff',
]

check(`注册了全部 ${expectedTools.length} 个工具`, () => {
  const names = registeredTools.map((t) => t.name)
  const missing = expectedTools.filter((n) => !names.includes(n))
  if (missing.length > 0) throw new Error(`缺：${missing.join(', ')}`)
  return true
})

check('每个工具都有 name / description / parameters / output / execute', () => {
  for (const t of registeredTools) {
    for (const key of ['name', 'description', 'parameters', 'output', 'execute']) {
      if (t[key] == null) throw new Error(`${t.name} 缺 ${key}`)
    }
    if (typeof t.execute !== 'function') throw new Error(`${t.name}.execute 不是函数`)
    if (typeof t.output?.render !== 'function') throw new Error(`${t.name}.output.render 不是函数`)
    if (t.output?.schema == null) throw new Error(`${t.name}.output.schema 缺失`)
  }
  return true
})

// ⚠ 回归防线。踩过一次：把作者 DSL 的 `required: true` 直接写进 JSON Schema。
// 宿主的 JsonSchemaNode 只支持 `required?: string[]`，布尔值会被当未知关键字丢掉，
// **不报错、必填校验静默失效**。这里逐节点扫一遍。
check('parameters 是标准 JSON Schema 形状（required 必须是数组）', () => {
  const walk = (toolName, node, path) => {
    if (node == null || typeof node !== 'object') return
    if ('required' in node && !Array.isArray(node.required)) {
      throw new Error(`${toolName} ${path}: required 不是数组（${JSON.stringify(node.required)}）`)
    }
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      if (child && typeof child === 'object' && 'required' in child) {
        throw new Error(`${toolName} ${path}.properties.${name}: required 写在属性里了，无效`)
      }
      walk(toolName, child, `${path}.properties.${name}`)
    }
    if (node.items) walk(toolName, node.items, `${path}.items`)
    for (const branch of node.oneOf ?? []) walk(toolName, branch, `${path}.oneOf[]`)
  }
  for (const t of registeredTools) {
    walk(t.name, t.parameters, 'parameters')
    walk(t.name, t.output.schema, 'output.schema')
  }
  return true
})

check('required 里的名字都出现在 properties 中', () => {
  for (const t of registeredTools) {
    for (const [label, node] of [['parameters', t.parameters], ['output.schema', t.output.schema]]) {
      for (const name of node.required ?? []) {
        if (!(name in (node.properties ?? {}))) {
          throw new Error(`${t.name}.${label}: required 里的 "${name}" 不在 properties 中`)
        }
      }
    }
  }
  return true
})

check('核心工具的必填参数声明正确', () => {
  const expect = {
    memory_recall: ['query'],
    memory_remember: ['body'],
    memory_link: ['from', 'to'],
  }
  for (const [name, required] of Object.entries(expect)) {
    const def = registeredTools.find((t) => t.name === name)
    if (!def) throw new Error(`没找到 ${name}`)
    const actual = def.parameters.required ?? []
    if (actual.length !== required.length || !required.every((r) => actual.includes(r))) {
      throw new Error(`${name}: 期望 required=${JSON.stringify(required)}，实际 ${JSON.stringify(actual)}`)
    }
  }
  return true
})

check('挂上了 agent/pre-step 监听', () => {
  if (!listeners.some((l) => l.event === 'agent/pre-step')) {
    throw new Error(`实际挂了：${listeners.map((l) => l.event).join(', ') || '(无)'}`)
  }
  return true
})

check('注册了 /strata 路由（prefix 类型）', () => {
  const route = registeredRoutes.find((r) => r.path === '/strata')
  if (!route) throw new Error('没注册')
  if (route.kind !== 'prefix') throw new Error(`kind 是 ${route.kind}`)
  if (typeof route.handler !== 'function') throw new Error('handler 不是函数')
  return true
})

check('悬浮窗脚本随包发出（lib/widget/strata-widget.js 存在且是裸 JS）', () => {
  const widgetPath = resolve(pkgDir, 'lib', 'widget', 'strata-widget.js')
  if (!existsSync(widgetPath)) throw new Error(`${widgetPath} 不存在（没随包发出去）`)
  const text = readFileSync(widgetPath, 'utf8')
  if (/^\s*(import|export)\s/m.test(text)) throw new Error('悬浮窗脚本里出现了 ESM 语句（必须是裸 IIFE）')
  if (!text.includes('__STRATA_WIDGET__')) throw new Error('没有幂等守卫 __STRATA_WIDGET__（重复注入会挂两次）')
  if (!text.includes('/strata/live')) throw new Error('没有拉 /strata/live')
  return true
})

check('桌面通道注册了 webserver/index-inject（否则 Electron 里没有悬浮窗）', () => {
  const hit = listeners.find((l) => l.event === 'webserver/index-inject')
  if (!hit) throw new Error('没监听 webserver/index-inject')
  if (typeof hit.handler !== 'function') throw new Error('处理器不是函数')
  return true
})

check('悬浮窗的桌面注入行走 kind:script（用 script-src 会 404 白屏）', () => {
  const sink = []
  const hit = listeners.find((l) => l.event === 'webserver/index-inject')
  if (!hit) throw new Error('没监听 webserver/index-inject')
  try { hit.handler(sink) } catch (e) { throw new Error(`处理器炸了：${e.message}`) }
  if (!Array.isArray(sink) || sink.length === 0) throw new Error('没往表里推任何行')
  const row = sink.find((r) => r && r.kind === 'script')
  if (!row) throw new Error(`没找到 kind:script 的行，实际 kind=${sink.map((r) => r?.kind).join(',')}`)
  if (!/strata-widget|__STRATA|strata\/widget/.test(row.text ?? '')) {
    throw new Error('script 行里没有悬浮窗相关内容')
  }
  if (sink.some((r) => r?.kind === 'script-src')) throw new Error('出现了 script-src（宿主会 await loadScript，404 白屏）')
  return true
})

check('Web 通道挂了 tapIndex，且幂等（HTML 里已有就不重复插）', () => {
  if (tapIndexFns.length === 0) throw new Error('没注册 webServer.tapIndex')
  const fn = tapIndexFns[0]
  const html = '<html><body><div id="app"></div></body></html>'
  const once = fn(html)
  if (typeof once !== 'string') throw new Error('tapIndex 没回字符串')
  if (!once.includes('/strata/widget.js')) throw new Error('没插进 widget.js')
  if (!once.includes('</body>')) throw new Error('把 HTML 结构搞坏了')
  const twice = fn(once)
  if (twice !== once) throw new Error('不幂等：第二次又插了一遍')
  if (once.split('/strata/widget.js').length - 1 !== 1) throw new Error('插了不止一次')
  return true
})

check('数据目录落在临时 DSH_HOME 下（没写真实数据）', () => {
  const dir = join(sandbox, 'strata')
  if (!existsSync(dir)) throw new Error(`${dir} 没建出来`)
  if (!existsSync(join(dir, 'events.log'))) throw new Error('events.log 没写')
  return true
})

check('events.log 里记了 ready', () => {
  const text = readFileSync(join(sandbox, 'strata', 'events.log'), 'utf8')
  if (!text.includes('"ready"')) throw new Error('没有 ready 事件')
  return true
})

/* ---------------- 4. 客户端产物的契约 ---------------- */

console.log('\n客户端产物')
const clientPath = resolve(pkgDir, pkg.exports['./client'])
const clientText = readFileSync(clientPath, 'utf8')

check('产物是 __ModuleLoader__.load 的 CJS factory 形状', () => {
  if (!clientText.includes('__ModuleLoader__')) throw new Error('没找到 __ModuleLoader__')
  return true
})

check('产物里没有顶层 import / export default', () => {
  if (/^\s*import\s/m.test(clientText)) throw new Error('有顶层 import')
  if (/export\s+default/.test(clientText)) throw new Error('有 export default')
  return true
})

check('产物里没有 instanceof Map / Set（跨 realm 恒为 false）', () => {
  const m = clientText.match(/instanceof\s+(Map|Set)\b/)
  if (m) throw new Error(`出现了 instanceof ${m[1]}`)
  return true
})

check('产物 id 与包名一致', () => {
  const m = clientText.match(/id:\s*["']([^"']+)["']/)
  if (!m) throw new Error('没找到 id')
  if (m[1] !== 'dsh-strata') throw new Error(`id 是 ${m[1]}`)
  return true
})

/* ---------------- 收尾 ---------------- */

try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 删不掉就算了，在 tmp 里 */ }

console.log('\n' + '─'.repeat(56))
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('全绿。插件装好了，重启 Harness 就能在设置里看到「记忆地层」。')
