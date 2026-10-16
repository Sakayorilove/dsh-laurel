/**
 * 客户端产物的离线验证。
 *
 * 验四件事（都不需要浏览器）：
 *   1. 产物语法合法，且顶部只注册一个 factory（id = dsh-loom）
 *   2. 没有顶层 import / export（那会被当 ESM 解析而崩）
 *   3. factory 的 `require` 只用平台 seed 表里的 `react`
 *   4. factory 返回的 exports 有 `apply` 与 `inject`，且 `apply(fakeCtx)` 注册了设置页插槽
 *
 * ⚠ 这不是「真实 DSH 客户端挂载」验证 —— 那需要真的启动宿主。
 * 这里只证明**产物形状对、依赖边界对、入口能跑**。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(dirname(here), 'lib', 'client.js')

let failures = 0
let checks = 0
function check(name, condition, detail = '') {
  checks += 1
  if (condition) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

const code = readFileSync(bundlePath, 'utf8')

/* ---------- 1. 形状 ---------- */
try {
  new vm.Script(code, { filename: 'client.js' })
  check('产物语法合法', true)
} catch (error) {
  check('产物语法合法', false, String(error?.message ?? error))
}
check('形状是 __ModuleLoader__.load({...})', /window\.__ModuleLoader__\.load\(\{/.test(code))
check('id 是 dsh-loom', /id:\s*'dsh-loom'/.test(code))
check('没有顶层 import', !/^\s*import\s/m.test(code))
check('没有 export 语句', !/^\s*export\s/m.test(code))
check('导出 apply', /module\.exports\.apply\s*=/.test(code))
check('导出 inject', /module\.exports\.inject\s*=/.test(code))

/* ---------- 2. 在沙箱里跑 ---------- */
const loaded = []
const sandbox = {
  window: { __ModuleLoader__: { load: (spec) => loaded.push(spec) } },
  document: {
    head: { appendChild: () => {} },
    createElement: () => ({ setAttribute: () => {}, style: {}, textContent: '', appendChild: () => {} }),
    createElementNS: () => ({ setAttribute: () => {}, appendChild: () => {}, style: {} }),
    elementFromPoint: () => null,
  },
  fetch: () => Promise.reject(new Error('sandbox 里不联网')),
  AbortController,
  setTimeout,
  clearTimeout,
  console,
}

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useRef: (v) => ({ current: v }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  version: '18.3.1',
}
const requested = new Set()
const requireStub = (spec) => {
  requested.add(spec)
  if (spec === 'react') return reactStub
  throw new Error(`unexpected require("${spec}") — 客户端只允许平台 seed 表里的 react`)
}

try {
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'client.js', timeout: 10_000 })
  check('能在无浏览器沙箱里执行完（不抛）', true)
} catch (error) {
  check('能在无浏览器沙箱里执行完（不抛）', false, String(error?.message ?? error))
}

check('注册了且只注册了一个 bundle', loaded.length === 1, `实际 ${loaded.length}`)
const spec = loaded[0]
check('bundle id 是 dsh-loom', spec?.id === 'dsh-loom', String(spec?.id))
check('factory 是函数', typeof spec?.factory === 'function')

if (typeof spec?.factory === 'function') {
  let exports = null
  try {
    exports = spec.factory(requireStub)
    check('factory 执行不抛', true)
  } catch (error) {
    check('factory 执行不抛', false, String(error?.message ?? error))
  }

  check('require 只用到 react', [...requested].every((s) => s === 'react'), [...requested].join('、'))
  check('exports.apply 是函数', typeof exports?.apply === 'function')
  check('exports.inject 是数组', Array.isArray(exports?.inject))

  if (typeof exports?.apply === 'function') {
    const registrations = []
    // 只把**聚合插槽**当作「没被声明」—— 这就是「没装装载机」的环境：inject 不回调，
    // 模块应当走兜底注册 settings.section。其余插槽照常回调（真实里它们由官方声明；
    // 白名单式写法会把 loom 注册的其他插槽一起挡掉，那是错的）。
    const slots = {
      inject: (name, fn) => (name === 'laurel-center.module' ? () => {} : fn()),
      register: (spec2, component) => {
        registrations.push({ spec: spec2, component })
        return () => {}
      },
    }
    const fakeCtx = {
      slots,
      effect: (fn) => {
        fn()
        return () => {}
      },
    }
    try {
      exports.apply(fakeCtx)
      check('apply(fakeCtx) 不抛', true)
      const standalone = registrations.find((r) => r.spec?.name === 'settings.section')
      check('没有装载机时注册一个 settings.section 插槽项（兜底路径）', Boolean(standalone),
        JSON.stringify(registrations.map((r) => r.spec?.name)))
      check('插槽项 id 是 loom', standalone?.spec?.id === 'loom', String(standalone?.spec?.id))
      check('插槽项带组件函数', typeof standalone?.component === 'function')
    } catch (error) {
      check('apply(fakeCtx) 不抛', false, String(error?.message ?? error))
    }

    // 装载机在时：设置页聚合进总控插槽，且不再单独占一条设置页导航。
    const groupedRegs = []
    try {
      exports.apply({
        slots: {
          // 全声明：连聚合插槽也在 —— 模拟「装载机在」。
          inject: (name, fn) => fn(),
          register: (spec2, component) => {
            groupedRegs.push({ spec: spec2, component })
            return () => {}
          },
        },
        effect: (fn) => {
          fn()
          return () => {}
        },
      })
      const grouped = groupedRegs.find((r) => r.spec?.name === 'laurel-center.module')
      check('装载机在时聚合进 laurel-center.module', Boolean(grouped),
        JSON.stringify(groupedRegs.map((r) => r.spec?.name)))
      check('聚合成立后不再单独占一条 settings.section',
        !groupedRegs.some((r) => r.spec?.name === 'settings.section'),
        JSON.stringify(groupedRegs.map((r) => r.spec?.name)))
      check('聚合后 id 仍是 loom（总控台靠它把内容对回卡片）', grouped?.spec?.id === 'loom', String(grouped?.spec?.id))
    } catch (error) {
      check('装载机在时聚合进 laurel-center.module', false, String(error?.message ?? error))
    }

    // slots 缺失时必须抛得清楚，而不是静默不注册
    let threw = false
    try {
      exports.apply({ effect: (fn) => fn() })
    } catch {
      threw = true
    }
    check('拿不到 slots 时明确抛错（不静默）', threw)
  }
}

console.log('')
console.log(failures === 0 ? `✅ 客户端产物验证全部通过（${checks} 项）` : `❌ ${failures} 项失败 / 共 ${checks} 项`)
process.exit(failures === 0 ? 0 : 1)
