/**
 * 宿主半边「装完之后」该跑的验证。
 *
 * 验三件事：
 *   1. 包名能从 profile 的 node_modules 解析到（link / 安装生效）
 *   2. `cordis.patch.yml` 的 `name: dsh-loom` 能落到真实的 lib/index.js
 *   3. 用**假 ctx** 跑一遍 `apply()`：10 个工具 + 1 条 HTTP 路由都挂得上，status() 正常
 *   4. `loom_worktree` 在真 git 仓库上端到端跑通（建树 / 脏树保留 / 干净树移除 / 强制移除**已从工具移除**）
 *
 * `DSH_HOME` 指到临时目录，**不碰用户真实数据**。
 * 没装进 profile 时回退到本包目录，方便在开发工作区直接跑。
 *
 * 用法：
 *   node tests/installed.mjs
 *   LOOM_PROFILE_DIR=~/.dsh/profiles/desktop node tests/installed.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const profileDir = process.env.LOOM_PROFILE_DIR || join(process.env.HOME ?? '', '.dsh', 'profiles', 'desktop')

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

console.log('# dsh-loom 安装后验证')
console.log(`  profile 目录：${profileDir}`)
console.log(`  包目录：${pkgRoot}`)

/* ---------- 1. 包名解析 ---------- */
let entry = null
let resolvedFrom = 'local'
if (existsSync(join(profileDir, 'node_modules'))) {
  try {
    const requireFromProfile = createRequire(join(profileDir, 'noop.cjs'))
    entry = dirname(requireFromProfile.resolve('dsh-loom/package.json'))
    resolvedFrom = 'profile'
  } catch {
    /* 没装，回退 */
  }
}
if (!entry) entry = pkgRoot
check(`包可解析（来源：${resolvedFrom}）`, existsSync(join(entry, 'package.json')))

const pkg = JSON.parse(readFileSync(join(entry, 'package.json'), 'utf8'))
check('包名是 dsh-loom', pkg.name === 'dsh-loom', pkg.name)
check('main 指向 lib/index.js', pkg.main === './lib/index.js', pkg.main)
check('声明了 dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml', String(pkg.dsh?.bundle?.patch))
check('声明了 dsh.client.inject', Array.isArray(pkg.dsh?.client?.inject))
check('运行时零依赖（dependencies 为空或不存在）', !pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
  JSON.stringify(pkg.dependencies))

/* ---------- 2. patch 入口 ---------- */
const patchPath = join(entry, pkg.dsh.bundle.patch)
check('cordis.patch.yml 存在', existsSync(patchPath))
const patchText = readFileSync(patchPath, 'utf8')
check('patch 里插入了 id: loom', /id:\s*loom/.test(patchText))
check('patch 里 name 是 dsh-loom', /name:\s*dsh-loom/.test(patchText))
check('lib/index.js 存在（构建产物）', existsSync(join(entry, 'lib', 'index.js')))

/* ---------- 3. 假 ctx 挂载 ---------- */
const dshHome = mkdtempSync(join(tmpdir(), 'loom-installed-'))
process.env.DSH_HOME = dshHome

const registeredTools = []
let routeRegistration = null
const listeners = []

const fakeCtx = {
  get: (name) => {
    if (name === 'commands') return { register: () => () => {} }
    if (name === 'tools') return { register: (def) => registeredTools.push(def) }
    if (name === 'webServer') {
      return {
        register: (opts) => {
          routeRegistration = opts
          return () => {}
        },
      }
    }
    return null
  },
  inject: (_names, cb) => {
    cb(fakeCtx)
    return () => {}
  },
  on: (event, handler) => {
    listeners.push({ event, handler })
    return () => {}
  },
  effect: (fn) => {
    const d = fn()
    return () => {
      try {
        d?.()
      } catch {
        /* noop */
      }
    }
  },
  off: () => {},
}

let mod = null
try {
  mod = await import(pathToFileURL(join(entry, 'lib', 'index.js')).href)
  check('lib/index.js 可被 import', true)
} catch (error) {
  check('lib/index.js 可被 import', false, String(error?.message ?? error))
}

if (mod) {
  check('导出 apply()', typeof mod.apply === 'function')
  check('顶层 inject 是空数组', Array.isArray(mod.inject) && mod.inject.length === 0)

  let handle = null
  try {
    handle = mod.apply(fakeCtx, {})
    check('apply() 不抛', true)
  } catch (error) {
    check('apply() 不抛', false, String(error?.message ?? error))
  }

  if (handle) {
    const status = handle.status()
    check('status().ok 为真', status?.ok === true)
    check('status() 带能力表', typeof status?.data?.capabilities === 'object')
    check('status() 带数据目录', typeof status?.data?.paths?.root === 'string')
    check('返回 dispose()', typeof handle.dispose === 'function')
  }

  check('注册了 10 个工具', registeredTools.length === 10, `实际 ${registeredTools.length}`)
  const names = registeredTools.map((t) => t.name).sort()
  const expected = ['loom_adopt', 'loom_capabilities', 'loom_compile', 'loom_prompt', 'loom_resolve_questions', 'loom_run', 'loom_status', 'loom_submit_plan', 'loom_validate', 'loom_worktree']
  check('工具名与预期完全一致', JSON.stringify(names) === JSON.stringify(expected), names.join(','))

  for (const t of registeredTools) {
    check(`工具 ${t.name} 的 parameters.required 是数组`, t.parameters?.required === undefined || Array.isArray(t.parameters.required))
    check(`工具 ${t.name} 有 output.render`, typeof t.output?.render === 'function')
    check(`工具 ${t.name} 用 execute 而不是 handler`, typeof t.execute === 'function')
  }

  const capTool = registeredTools.find((t) => t.name === 'loom_capabilities')
  if (capTool) {
    const out = await capTool.execute({}, {})
    check('loom_capabilities 能跑出文本', typeof out?.text === 'string' && out.text.includes('worktreeIsolation'))
    check('loom_capabilities 说明来源是「宿主提供 / 本项目自建」', out.text.includes('本项目自建') && out.text.includes('宿主提供'))
  }

  check('注册了 HTTP 前缀路由 /loom', routeRegistration?.kind === 'prefix' && routeRegistration?.path === '/loom')
  check('HTTP handler 是函数', typeof routeRegistration?.handler === 'function')
  check('挂了 agent/pre-step 监听', listeners.some((l) => l.event === 'agent/pre-step'))

  /* ---------- 4. loom_worktree 工具端到端 ---------- */
  const wtTool = registeredTools.find((t) => t.name === 'loom_worktree')
  check('存在 loom_worktree 工具', wtTool !== undefined)

  if (wtTool !== undefined) {
    // 建一个真 git 仓库（临时目录，与 DSH_HOME 分开）
    const repo = mkdtempSync(join(tmpdir(), 'loom-wt-repo-'))
    const runGit = (args) =>
      spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    runGit(['init', '-q', '-b', 'main'])
    runGit(['config', 'user.email', 'loom@test.local'])
    runGit(['config', 'user.name', 'Loom Test'])
    writeFileSync(join(repo, 'a.txt'), 'hello\n', 'utf8')
    runGit(['add', '-A'])
    runGit(['commit', '-q', '-m', 'init'])

    // preview 不落盘
    const pv = await wtTool.execute({ action: 'preview', runId: 'run-t', taskIds: ['api', 'web'] }, { agent: { session: { id: 'installed-test-session', header: { cwd: repo } } } })
    check('preview 返回 2 条计划', Array.isArray(pv?.plans) && pv.plans.length === 2)
    check('preview 不落盘（目录不存在）', !existsSync(pv.plans[0].path))

    // create
    const cr = await wtTool.execute({ action: 'create', runId: 'run-t', repoPath: repo, taskIds: ['api', 'web'] }, { agent: { session: { id: 'installed-test-session', header: { cwd: repo } } } })
    check('create 成功', cr?.ok === true, JSON.stringify(cr?.problems))
    check('create 建了 2 棵', cr?.worktrees?.length === 2)
    check('create 的 baseSha 是 40 位 hex', /^[0-9a-f]{40}$/.test(String(cr?.baseSha)))
    check('工作树目录真的在磁盘上', existsSync(cr.worktrees[0].path))
    check('工作树里有仓库内容', existsSync(join(cr.worktrees[0].path, 'a.txt')))

    // 两棵树的 baseSha 一致（并行合并的前提）
    check('两棵树 baseSha 相同', cr.worktrees[0].baseSha === cr.worktrees[1].baseSha)

    // list
    const ls = await wtTool.execute({ action: 'list', runId: 'run-t' }, { agent: { session: { id: 'installed-test-session', header: { cwd: repo } } } })
    check('list 返回 2 棵活着的树', ls?.count === 2)

    // 让 api 树变脏，web 树保持干净
    writeFileSync(join(cr.worktrees[0].path, 'dirty.txt'), 'wip\n', 'utf8')

    const st = await wtTool.execute({ action: 'settle', runId: 'run-t' }, { agent: { session: { id: 'installed-test-session', header: { cwd: repo } } } })
    check('settle 移除 1 棵（干净）', st?.removed === 1, JSON.stringify({ r: st?.removed, k: st?.kept }))
    check('settle 保留 1 棵（脏）', st?.kept === 1)
    check('脏树目录仍在', existsSync(cr.worktrees[0].path))
    check('干净树目录已消失', !existsSync(cr.worktrees[1].path))

    // 二次 settle 幂等：只剩脏树，仍然保留
    const st2 = await wtTool.execute({ action: 'settle', runId: 'run-t' }, { agent: { session: { id: 'installed-test-session', header: { cwd: repo } } } })
    check('二次 settle 仍保留脏树', st2?.kept === 1 && st2?.removed === 0)

    // 强制移除必须**已经从模型工具里消失**。
    // 这条断言是本步骤最关键的负例：模型手里不能有这把刀。
    let removeThrew = false
    let removeError = ''
    try {
      const r = await wtTool.execute({ action: 'remove', runId: 'run-t', taskId: 'api' }, {})
      removeError = String(r?.text ?? '')
    } catch (error) {
      removeThrew = true
      removeError = error.message
    }
    check('remove 动作已被移除 —— 模型调用不生效', removeThrew || /未知 action/.test(removeError), removeError)
    check('未授权强删**没有**碰到底层删除：脏树目录仍在', existsSync(cr.worktrees[0].path))
    check('脏树里的未提交改动仍在', existsSync(join(cr.worktrees[0].path, 'dirty.txt')))

    // 工具声明里也不该再出现 remove
    check('工具 action 枚举里没有 remove', !/['"]remove['"]/.test(JSON.stringify(wtTool.parameters ?? {})))

    // migrate 只做预览，不落盘
    const mg = await wtTool.execute({ action: 'migrate', workspaceId: 'ignored-model-input' }, { agent: { session: { id: 'installed-test-session', header: { cwd: repo } } } })
    check('migrate 返回预览结构（含 blockers）', mg !== undefined && Array.isArray(mg?.plans) && Array.isArray(mg?.blockers))

    // 未知/脏树必须在 settle 里保留
    check('未知路径的树不会被 settle 误删', existsSync(cr.worktrees[0].path))

    // 非法输入必须被拒绝
    let threw = false
    try {
      await wtTool.execute({ action: 'create', runId: 'run-x', repoPath: repo, taskIds: ['BAD_ID'] }, {})
    } catch {
      threw = true
    }
    // 非法任务 id 由 planIsolation 拦下 → create 返回 ok:false（不抛）
    check('非法任务 id 不会静默成功', threw || (await wtTool.execute({ action: 'create', runId: 'run-x', repoPath: repo, taskIds: ['BAD_ID'] }, {}))?.ok === false)

    let unknownThrew = false
    try {
      await wtTool.execute({ action: 'nonsense' }, {})
    } catch {
      unknownThrew = true
    }
    check('未知 action 明确抛错', unknownThrew)

    try {
      rmSync(repo, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  }
}

try {
  rmSync(dshHome, { recursive: true, force: true })
} catch {
  /* noop */
}

console.log('')
console.log(failures === 0 ? `✅ 全部通过（${checks} 项）` : `❌ ${failures} 项失败 / 共 ${checks} 项`)
process.exit(failures === 0 ? 0 : 1)
