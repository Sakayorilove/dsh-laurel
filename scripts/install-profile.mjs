#!/usr/bin/env node
/**
 * Laurel 套件 · profile 安装事务（第二轮 F3 重写；第四轮修 R1 / R2 / R6）
 *
 * ── 为什么需要一个「事务」而不是一句 pnpm add ────────────────────────────
 * laurel-center 是**一个 bundle**，但它管着的子插件在宿主看来是**各自一个直接依赖**
 * （宿主按裸包名从 profile 的 node_modules 解析 loader 行，见 docs/PLUGIN-CONTRACT.md §1）。
 * 实测：只 `pnpm add laurel-center`（无论 link: / file: / tgz）只会把 laurel-center
 * 放到顶层，子包只进 pnpm 的虚拟 store —— 宿主解析不到。
 *
 * 所以「一次安装」在实现上是**一次事务**：写五个依赖 → 跑一次 pnpm install → 校验；
 * 失败就整体回滚。对用户呈现为一个动作。
 *
 *   node scripts/install-profile.mjs                       # 自动找 profile（推荐）
 *   node scripts/install-profile.mjs <profileDir> [--center <安装目录>]
 *   node scripts/install-profile.mjs --check                # 只校验，不改
 *   node scripts/install-profile.mjs --rollback             # 回滚到最近一次备份
 *   node scripts/install-profile.mjs --uninstall            # 移除六个依赖
 *
 * 环境变量：LAUREL_PNPM=<pnpm 可执行文件或 .cjs 的路径>  指定用哪份 pnpm。
 * 机器上有多份 pnpm 时**必须**指定 —— 版本不同可能把整个 profile 的 lockfile
 * 重写一遍（profile 里往往还有别的插件）。见下面 pnpmCommand() 的注释。
 *
 * ── 第二轮修了什么（F3 / F4）──────────────────────────────────────────────
 * 第一轮的回滚只恢复 `package.json` / `pnpm-lock.yaml` 两个文件，实测：
 * 先装有效的旧包、再升级到「宿主入口缺失」的坏包，脚本退出 1、打印「已回滚」，
 * 两个文件确实恢复了，但 `node_modules/laurel` 的 realpath **还是坏包** —— 旧入口不可用。
 * 那不是回滚，只是「两个文件回去了」。
 *
 * 现在：
 *   · 备份**记录存在性**（原来不存在的锁文件，恢复时要删掉，不是留着）
 *   · 备份记录**五个链接的实际装配身份**（realpath）
 *   · 失败后**重建旧链接并复验**，恢复失败单独报（`restoreFailure`）
 *   · 卸载走同一条可恢复流程；pnpm 非零退出**不许**返回成功
 *   · 显式回滚用**备份自己的身份**校验，不再拿当前 `--center` 去核对旧备份
 *   · 装配校验复用 `scripts/assembly-check.mjs`（realpath / 身份 / 入口 / bundle /
 *     patch 唯一性），不再有「名字对就算过」的假阳性
 *
 * ── 第四轮修了什么（R1 / R2 / R6，2026-10-13 公开仓首次使用评审）──────────
 * R1 · 不带参数就跑不通：原来 `positional[0]` 取不到就打印用法退出 2，而 README 的
 *      三步教程第二步就是 `node scripts/install-profile.mjs`。而且 `--center` 的值
 *      会被当成位置参数（`--center X profile` 时 profile 变成了 X）。
 *      → 参数解析统一走 `scripts/cli-args.mjs`；profile 走 `profile-path.mjs` 的
 *        `resolveProfileDir()`（显式 → 唯一候选 → 报错并列出候选，不猜）。
 *
 * R2 · 旧依赖结构迁移/卸载不了：原来只往 `dependencies` 写新目标，`devDependencies`
 *      里的旧同名声明原样留着；而 `assembly-check.mjs` 合并两段时 devDependencies
 *      覆盖 dependencies → 校验看到的是**旧目录**，迁移被判失败并回滚。
 *      卸载同样只删 `dependencies`，四个模块链接残留。
 *      → `normalizeOwnedDeps()` 对 OWNED 五包做规范化：**每个包只留一处**，删掉另一段的
 *        旧声明；卸载与残留检查也认两段。
 *
 * R6 · Windows 上 `execFileSync('pnpm', …)`：pnpm 在 Windows 常由 `.cmd` shim 提供，
 *      Node 官方文档明确 `.cmd` 不能直接以 execFile 启动。
 *      → Windows 上用 `shell: true` 启动，并先做一次 `pnpm --version` 预检，
 *        缺 pnpm 时给明确提示（退出码 5）而不是抛一个看不懂的 ENOENT。
 *
 * ⚠ 本脚本用**当前平台**的 pnpm。Windows profile（/mnt/c/... 或 C:\...）不要在 WSL 里跑 ——
 *   会写出 Windows 解析不了的 Linux 风格相对链接。真实 Windows profile 请用宿主自己的
 *   插件安装流程（DSH 插件页），或在该平台上用本机 Node 运行本脚本。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAssembly, pathFromSpec, SUB_PACKAGES } from './assembly-check.mjs'
import { linkSpec, resolveProfileDir } from './profile-path.mjs'
import { parseArgs } from './cli-args.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(SCRIPT_DIR, '..')
const DEFAULT_CENTER = REPO

const SUB = SUB_PACKAGES.map((s) => s.name)
const OWNED = ['laurel-center', ...SUB]
const TRACKED_FILES = ['package.json', 'pnpm-lock.yaml']
const USAGE = '用法：node scripts/install-profile.mjs [profileDir] [--center <安装目录>] [--check|--rollback|--uninstall]'

/** 退出码：0 成功 / 1 操作失败（已回滚）/ 2 用法 / 3 拒绝平台 / 4 回滚也失败 / 5 缺前置环境。 */
export const EXIT = { ok: 0, operationFailed: 1, usage: 2, refused: 3, restoreFailed: 4, preflight: 5 }

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

const parsed = parseArgs(process.argv.slice(2), {
  valueOptions: ['--center'],
  knownFlags: ['--check', '--rollback', '--uninstall', '--help'],
})
if (parsed.errors.length > 0) {
  for (const e of parsed.errors) console.error(`  ✗ ${e}`)
  console.error(USAGE)
  process.exit(EXIT.usage)
}
if (parsed.flags.has('--help')) { console.log(USAGE); process.exit(EXIT.ok) }

const MODES = ['--check', '--rollback', '--uninstall']
const chosen = MODES.filter((m) => parsed.flags.has(m))
if (chosen.length > 1) {
  console.error(`  ✗ ${chosen.join(' / ')} 只能选一个`)
  console.error(USAGE)
  process.exit(EXIT.usage)
}
const mode = chosen[0]?.slice(2) ?? 'install'

const centerArg = parsed.values.get('--center')
const center = resolve(centerArg ?? DEFAULT_CENTER)

const resolvedProfile = resolveProfileDir({ explicit: parsed.positional[0] ?? null })
if (resolvedProfile.dir === undefined) {
  console.error(`  ✗ ${resolvedProfile.error}`)
  if (resolvedProfile.candidates.length > 0) {
    console.error('  候选（把正确的那个显式传进来）：')
    for (const c of resolvedProfile.candidates) console.error(`    ${c}`)
  }
  console.error(`  ${USAGE}`)
  process.exit(EXIT.usage)
}
const P = resolve(resolvedProfile.dir)

/** WSL 里操作 Windows 路径会写坏链接，直接拒绝。 */
if (process.platform === 'linux' && /^\/mnt\/[a-z]\//.test(P)) {
  console.error('拒绝：不要从 WSL 向 Windows profile 安装（会写出 Windows 解析不了的相对链接）。')
  console.error('请在 Windows 上用本机 Node 运行本脚本，或用 DSH 插件页的安装流程。')
  process.exit(EXIT.refused)
}

const readPkg = () => JSON.parse(readFileSync(join(P, 'package.json'), 'utf8'))
const writePkg = (p) => writeFileSync(join(P, 'package.json'), JSON.stringify(p, null, 2) + '\n')
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

function safeRealpath(p) {
  try { return realpathSync(p) } catch { return null }
}

/* ------------------------------------------------------------------ *
 * 依赖声明：OWNED 全部包只在一处（R2）
 * ------------------------------------------------------------------ */

/** 全部依赖的目标 spec。 */
function desiredDeps() {
  const d = { 'laurel-center': linkSpec(center) }
  for (const n of SUB) d[n] = linkSpec(`${center}/packages/${n}`)
  return d
}

/**
 * 规范化 OWNED 全部包的依赖声明。
 *
 * 规则（三条，都是为了「迁移旧结构」而不只是「写新的」）：
 *   1. 每个包**只在一个段**里出现 —— 两段都有的，保留 `dependencies` 那处、删掉
 *      `devDependencies` 的重复。理由：`assembly-check.mjs` 合并两段时 devDependencies
 *      覆盖 dependencies，留着旧的那份等于校验看的是旧目录（R2 复现的根因）。
 *   2. 段落归属**跟着现状走**：原来在哪段就更新哪段；两段都没有才放进 `dependencies`。
 *      真实机器上装载机在 `dependencies`、四个模块在 `devDependencies`（宿主插件页装的），
 *      所以不能一刀切全塞进 `dependencies`。
 *   3. 值统一用 `link:` + 正斜杠（见 `profile-path.mjs` 的 `linkSpec`）。
 *
 * @returns {{ changes: string[] }} 逐条人话差异，供日志与回传使用。
 */
function normalizeOwnedDeps(pkg) {
  const desired = desiredDeps()
  const deps = { ...(pkg.dependencies ?? {}) }
  const dev = { ...(pkg.devDependencies ?? {}) }
  const changes = []

  for (const n of OWNED) {
    const inDeps = Object.prototype.hasOwnProperty.call(deps, n)
    const inDev = Object.prototype.hasOwnProperty.call(dev, n)
    // 两段都有 → 留 dependencies；只在 devDependencies → 留在 devDependencies。
    const target = inDeps || !inDev ? deps : dev
    const other = target === deps ? dev : deps
    const targetName = target === deps ? 'dependencies' : 'devDependencies'
    const otherName = target === deps ? 'devDependencies' : 'dependencies'

    if (Object.prototype.hasOwnProperty.call(other, n)) {
      delete other[n]
      changes.push(`${n}: 删掉 ${otherName} 里的重复声明（保留 ${targetName} 那处）`)
    }
    const before = target[n]
    target[n] = desired[n]
    if (before === undefined) changes.push(`${n}: 新增到 ${targetName} → ${desired[n]}`)
    else if (before !== desired[n]) changes.push(`${n}: ${before} → ${desired[n]}`)
  }

  pkg.dependencies = deps
  if (Object.keys(dev).length > 0) pkg.devDependencies = dev
  else delete pkg.devDependencies
  return { changes }
}

/** 从两段里删掉 OWNED 五包（卸载）。 */
function removeOwnedDeps(pkg) {
  const changes = []
  for (const section of ['dependencies', 'devDependencies']) {
    const table = pkg[section]
    if (table === null || typeof table !== 'object') continue
    for (const n of OWNED) {
      if (Object.prototype.hasOwnProperty.call(table, n)) {
        changes.push(`${n}: 从 ${section} 移除`)
        delete table[n]
      }
    }
    if (Object.keys(table).length === 0) delete pkg[section]
  }
  return { changes }
}

/** 两段合并后的依赖表（与 `assembly-check.mjs` 同一口径）。 */
function mergedDeps(pkg) {
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
}

/* ------------------------------------------------------------------ *
 * 备份 / 恢复
 * ------------------------------------------------------------------ */

/**
 * 造一次备份。**记录存在性与实际装配身份**，不只是拷两个文件。
 *
 * `meta.center` 记的是**这次操作之前**的安装面（从被备份的 package.json 里读出来，
 * **两段都认** —— 第四轮 R2），不是这次要装的 `--center` —— 否则回滚时会拿新目标去
 * 核对旧备份（F3 的第 4 条）。
 * @returns {{ dir: string, meta: object }}
 */
function makeBackup() {
  const dir = join(P, `.laurel-center-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(dir, { recursive: true })
  const files = {}
  for (const f of TRACKED_FILES) {
    const src = join(P, f)
    const present = existsSync(src)
    files[f] = { present, sha256: present ? sha256(src) : null }
    if (present) cpSync(src, join(dir, f))
  }
  const links = {}
  for (const n of OWNED) links[n] = safeRealpath(join(P, 'node_modules', n))

  // 备份自己的身份：这次操作**之前**的安装面
  let previousCenter = null
  let expectInstalled = false
  try {
    const before = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    previousCenter = pathFromSpec(mergedDeps(before)['laurel-center'])
    expectInstalled = previousCenter !== null
  } catch { /* 没有旧 package.json 就下面兜底 */ }

  const meta = {
    at: new Date().toISOString(),
    profile: P,
    center: previousCenter ?? center,
    installingCenter: center,
    centerSource: previousCenter === null ? 'run-argument' : 'previous-package-json',
    // 备份时**本来就没装**：恢复后的正确状态是「没装」，不是「装着这次的目标」
    expectInstalled,
    files,
    links,
  }
  writeFileSync(join(dir, 'backup.json'), JSON.stringify(meta, null, 2) + '\n')
  return { dir, meta }
}

/** 最近一次**带 backup.json** 的备份。没有 backup.json 的旧备份目录不具备可校验身份。 */
function loadLatestBackup() {
  const dirs = readdirSync(P)
    .filter((n) => n.startsWith('.laurel-center-backup-'))
    .sort()
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    const dir = join(P, dirs[i])
    const metaPath = join(dir, 'backup.json')
    if (!existsSync(metaPath)) continue
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      return { dir, meta }
    } catch {
      return { dir, meta: null, unreadable: true }
    }
  }
  return null
}

/** 备份自身的身份是否可校验（F3：不许拿当前 --center 去核对旧备份）。 */
function validateBackup(backup) {
  const problems = []
  if (!backup) { problems.push('没有可回滚的备份'); return problems }
  if (backup.unreadable || backup.meta === null) { problems.push(`备份身份文件不可读：${backup.dir}/backup.json`); return problems }
  if (backup.meta.profile !== P) problems.push(`备份属于另一个 profile：${backup.meta.profile}`)
  if (backup.meta.expectInstalled !== false) {
    if (typeof backup.meta.center !== 'string' || !existsSync(backup.meta.center)) {
      problems.push(`备份记录的安装目录不存在：${backup.meta.center}`)
    }
  }
  for (const [f, info] of Object.entries(backup.meta.files ?? {})) {
    if (info.present && !existsSync(join(backup.dir, f))) problems.push(`备份里缺少 ${f}`)
    if (info.present && existsSync(join(backup.dir, f)) && sha256(join(backup.dir, f)) !== info.sha256) {
      problems.push(`备份里的 ${f} 与记录 hash 不一致`)
    }
  }
  return problems
}

/**
 * 恢复备份：文件存在性 + 重建链接 + 复验。
 * @returns {{ failures: string[], steps: string[] }}
 */
function restoreBackup(backup) {
  const failures = []
  const steps = []

  /** 把 TRACKED_FILES 恢复到备份记录的样子（存在性也恢复）。 */
  const applyFileState = (phase) => {
    for (const f of TRACKED_FILES) {
      const info = backup.meta.files?.[f] ?? { present: false }
      const target = join(P, f)
      try {
        if (info.present) {
          if (phase === 'restore') {
            cpSync(join(backup.dir, f), target)
            steps.push(`恢复 ${f}`)
          }
        } else if (existsSync(target)) {
          // 原来不存在的文件（常见：本来没有 pnpm-lock.yaml）恢复时要删掉，不是留着。
          rmSync(target, { force: true })
          steps.push(`${phase === 'restore' ? '删除' : '清掉重建的'}本不存在的 ${f}`)
        }
      } catch (error) {
        failures.push(`恢复 ${f} 失败：${String(error?.message ?? error)}`)
      }
    }
  }

  applyFileState('restore')
  // 重建 node_modules 链接：只恢复两个文件的话，链接还指着坏包（F3 实测）。
  if (!pnpmInstall(true)) failures.push('恢复后 pnpm install 失败（链接可能没重建）')
  else steps.push('pnpm install --force 重建链接')
  // pnpm install 会把「原本不存在的锁文件」再生成一遍，所以最后再压一次存在性。
  applyFileState('enforce')

  // 复验：拿**备份记录的身份**核对，而不是当前 --center。
  if (backup.meta.expectInstalled === false) {
    // 备份时本来就没装 → 恢复后的正确状态是「没装」，不是「装着这次的目标」。
    const residual = verifyUninstalled()
    if (residual.length > 0) failures.push(...residual.map((p) => `恢复后仍有残留：${p}`))
    else steps.push('装配复验通过（备份时本就未安装 → 已回到未安装状态）')
  } else {
    const expectedCenter = backup.meta.center ?? center
    const assembly = checkAssemblySafe(expectedCenter)
    if (!assembly.ok) failures.push(...assembly.problems.map((p) => `恢复后装配仍不合格：${p}`))
    else steps.push(`装配复验通过（按备份身份 ${expectedCenter}）`)
  }
  return { failures, steps }
}

/* ------------------------------------------------------------------ *
 * pnpm / 校验
 * ------------------------------------------------------------------ */

/**
 * Windows 上 pnpm 常是 `.cmd` shim，Node 官方文档明确 `.cmd` **不能**直接以 execFile
 * 启动（R6）。`shell: true` 让 Node 走 cmd.exe 解释器 —— 官方给的就是这条路。
 * 参数都是本脚本写死的字面量（`install` / `--no-frozen-lockfile` / `--force`），
 * 不含用户输入，所以经过 shell 没有注入面。
 */
const PNPM_VIA_SHELL = process.platform === 'win32'

/**
 * 用哪个 pnpm 跑安装。
 *
 * ── 为什么允许指定（2026-10-15 实测的真问题）─────────────────────────────
 * 这台机器上有**两份** pnpm：PATH 里的是全局 12.4.2，而 Harness 客户端自带
 * `resources/runtime/pnpm/bin/pnpm.cjs` 是 **11.7.0**。profile 的 lockfile 是
 * `lockfileVersion: 9.0`、store 是 `v11` —— 拿一个版本不同的 pnpm 去跑 install，
 * 它**可能把整个 profile 的 lockfile 重写一遍**（真实 profile 里有十几个别的插件，
 * 不是只有本套件，代价很大）。
 *
 * 所以给一个显式入口：`LAUREL_PNPM=<pnpm 可执行文件或 .cjs 的路径>`。
 * 不设时行为与以前完全一致（走 PATH 里的 `pnpm`）。
 *
 * 传 `.cjs` / `.mjs` / `.js` 时用**当前 node** 跑它，并且**不走 shell** ——
 * Windows 的 cmd 不认识 `.cjs`；而 `process.execPath` 带空格（`C:\Program Files\...`），
 * 走 shell 反而会被拆坏。
 *
 * @returns {{ file: string, args: string[], shell: boolean }}
 */
function pnpmCommand() {
  const bin = process.env.LAUREL_PNPM
  if (typeof bin !== 'string' || bin.length === 0) return { file: 'pnpm', args: [], shell: PNPM_VIA_SHELL }
  if (/\.(cjs|mjs|js)$/i.test(bin)) return { file: process.execPath, args: [bin], shell: false }
  return { file: bin, args: [], shell: PNPM_VIA_SHELL }
}

function pnpmInstall(force = false) {
  const argv = ['install', '--no-frozen-lockfile', ...(force ? ['--force'] : [])]
  const { file, args, shell } = pnpmCommand()
  console.log('  $ ' + [file, ...args, ...argv].join(' '))
  try {
    execFileSync(file, [...args, ...argv], { cwd: P, stdio: 'inherit', shell })
    return true
  } catch (error) {
    console.error('  pnpm install 失败：', error?.message ?? error)
    return false
  }
}

/**
 * 前置环境预检：没有可用的 pnpm 就**在动手改 profile 之前**说清楚（R6）。
 * 不预检的话，第一次 `pnpm install` 才炸，而且报的是看不懂的 ENOENT。
 * @returns {string | null} pnpm 版本；不可用返回 null。
 */
function checkPnpm() {
  const { file, args, shell } = pnpmCommand()
  try {
    return execFileSync(file, [...args, '--version'], { encoding: 'utf8', shell }).trim()
  } catch {
    return null
  }
}

/**
 * pnpm 认为 lockfile 已满足时不会重建被外部删掉的 node_modules 链接
 * （实测：手动 rm node_modules/laurel 后，普通 pnpm install 报 "Already up to date"，
 * 链接不会回来）。所以校验失败时先强制重链一次，再考虑回滚。
 */
function installWithRepair() {
  if (!pnpmInstall()) return false
  if (verifyAssembly().ok) return true
  console.log('  首次安装后校验未通过，强制重链一次…')
  return pnpmInstall(true)
}

/**
 * 装配校验，**绝不抛异常**。
 *
 * 事务里任何一次未捕获的异常都会让进程直接死掉 —— 而 `failWithRestore()` 就走不到了，
 * profile 会停在半装状态。实测（R7）：目标安装面缺 `cordis.patch.yml` 时校验核抛
 * `rows is not iterable`，安装器崩在回滚之前。所以这里把「校验核自己坏了」也变成
 * 一条普通的校验失败，让它走正常的失败 + 回滚路径。
 */
function checkAssemblySafe(centerDir) {
  try {
    return checkAssembly({ profileDir: P, centerDir })
  } catch (error) {
    return {
      ok: false,
      problems: [`装配校验自身抛错（${centerDir}）：${String(error?.message ?? error)}`],
      checks: [],
    }
  }
}

/** 用共用的只读装配校验核心（F4）。 */
function verifyAssembly() {
  return checkAssemblySafe(center)
}

function report(problems) {
  if (problems.length === 0) { console.log('  ✓ 装配检查通过'); return true }
  for (const p of problems) console.log('  ✗', p)
  return false
}

/** 卸载后应该是什么样：五个依赖（**两段都查**）与五个链接都不在。 */
function verifyUninstalled() {
  const problems = []
  const pkg = readPkg()
  const deps = mergedDeps(pkg)
  for (const n of OWNED) {
    if (n in deps) {
      const where = Object.prototype.hasOwnProperty.call(pkg.dependencies ?? {}, n) ? 'dependencies' : 'devDependencies'
      problems.push(`${where} 里仍有 ${n}`)
    }
    if (existsSync(join(P, 'node_modules', n))) problems.push(`node_modules/${n} 仍在`)
  }
  if (Array.isArray(pkg.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes('laurel-center')) {
    problems.push('bundles 里仍有 laurel-center')
  }
  return problems
}

/** 统一的失败收尾：分别报 operationFailure / restoreFailure，并按严重程度给退出码。 */
function failWithRestore(backup, operationFailure) {
  console.error(`  操作失败：${operationFailure}`)
  const restore = restoreBackup(backup)
  if (restore.failures.length === 0) {
    console.error(`  已回滚（${restore.steps.join('；')}）`)
    process.exit(EXIT.operationFailed)
  }
  console.error('  ⚠ 回滚**没有完成**，profile 可能处于中间状态：')
  for (const f of restore.failures) console.error('    -', f)
  console.error(`  备份仍在：${backup.dir}`)
  process.exit(EXIT.restoreFailed)
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

console.log(`profile : ${P}`)
console.log(`center  : ${center}`)
console.log(`模式    : ${mode}`)

if (!existsSync(join(P, 'package.json'))) { console.error(`profile 里没有 package.json：${P}`); process.exit(EXIT.usage) }

if (mode === 'check') {
  const assembly = verifyAssembly()
  process.exit(report(assembly.problems) ? EXIT.ok : EXIT.operationFailed)
}

// 回滚、安装、卸载都要靠 pnpm 建链接，所以三条路都先做一次前置预检（R6）。
const pnpmVersion = checkPnpm()
if (pnpmVersion === null) {
  console.error('  ✗ 找不到可用的 pnpm —— 安装事务要靠它建链接。')
  console.error('    先装：npm i -g pnpm   （或 corepack enable pnpm），确认 `pnpm --version` 能跑再重试。')
  process.exit(EXIT.preflight)
}
console.log(`pnpm    : ${pnpmVersion}${PNPM_VIA_SHELL ? '（Windows：经 shell 启动）' : ''}`)

if (mode === 'rollback') {
  const backup = loadLatestBackup()
  const problems = validateBackup(backup)
  if (problems.length > 0) {
    for (const p of problems) console.error('  ✗', p)
    console.error('  拒绝回滚：备份身份不可校验时不猜着恢复。')
    process.exit(EXIT.operationFailed)
  }
  console.log(`  回滚到 ${backup.dir}`)
  const restore = restoreBackup(backup)
  for (const s of restore.steps) console.log('  ·', s)
  if (restore.failures.length > 0) {
    for (const f of restore.failures) console.error('  ✗', f)
    process.exit(EXIT.restoreFailed)
  }
  console.log('  回滚完成')
  process.exit(EXIT.ok)
}

if (mode === 'uninstall') {
  const backup = makeBackup()
  console.log(`  备份 → ${backup.dir}`)
  // 卸载也走失败可恢复流程：pnpm 非零退出**不许**返回成功（F3）；
  // 未预期的异常同样**必须**先回滚再退出（R7），不能崩在回滚之前。
  try {
    const pkg = readPkg()
    const { changes } = removeOwnedDeps(pkg)
    for (const c of changes) console.log('  ·', c)
    if (Array.isArray(pkg.dsh?.profile?.bundles)) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== 'laurel-center')
    }
    writePkg(pkg)

    if (!pnpmInstall()) failWithRestore(backup, 'pnpm install 在卸载阶段非零退出')
    const problems = verifyUninstalled()
    if (problems.length > 0) failWithRestore(backup, `卸载后仍残留：${problems.join('；')}`)
  } catch (error) {
    failWithRestore(backup, `卸载阶段未预期的异常：${String(error?.message ?? error)}`)
  }
  console.log(`  已移除五个依赖与 bundle 选择；备份在 ${backup.dir}`)
  process.exit(EXIT.ok)
}

// ── 安装事务 ────────────────────────────────────────────────────────────
const backup = makeBackup()
console.log(`  备份 → ${backup.dir}`)
// 整段包在 try 里：任何未预期的异常都要先回滚再退出（R7），
// 否则「装了一半又崩掉」比「明确失败并回滚」糟得多。
try {
  const pkg = readPkg()
  const { changes } = normalizeOwnedDeps(pkg)
  for (const c of changes) console.log('  ·', c)
  pkg.dsh ??= {}
  pkg.dsh.profile ??= {}
  pkg.dsh.profile.bundles = [...new Set([...(pkg.dsh.profile.bundles ?? []), 'laurel-center'])]
  writePkg(pkg)

  if (!installWithRepair()) failWithRestore(backup, 'pnpm install 非零退出')

  const assembly = verifyAssembly()
  if (!report(assembly.problems)) failWithRestore(backup, '装配校验未通过')
} catch (error) {
  failWithRestore(backup, `安装阶段未预期的异常：${String(error?.message ?? error)}`)
}
console.log('  安装事务完成')
