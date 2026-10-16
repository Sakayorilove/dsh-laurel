#!/usr/bin/env node
/**
 * Laurel-Center · 装配校验核心（**只读**，零副作用）
 *
 * ── 为什么必须只有一个核心（第二轮 F4）───────────────────────────────────
 * 第一轮有两个「检查」：
 *   · `scripts/install-profile.mjs` 自己的 `verify()` —— 只看名字和文件在不在
 *   · `scripts/verify-installed.mjs` —— 有 realpath 强校验
 * 交付时拿后者的结论去证明前者的行为，是**偷换证据**。实测已经复现：
 * manifest 的每个 link spec 正确、全部 node_modules 链接**全部指向另一目录的同名包**，
 * 名字对、入口文件也在，安装器自己的 verify 照样返回 0。
 *
 * 所以校验只写一遍，放在这里，被安装器和独立检查脚本同时调用。
 *
 * ── 它到底核什么 ──────────────────────────────────────────────────────────
 *   1. profile 的 `dsh.profile.bundles` 里 `laurel-center` **恰好一次**
 *   2. 每个依赖都在，且**解析后的 realpath** 落在预期位置：
 *         laurel-center      → <center>
 *         <子包>             → <center>/packages/<dir>
 *      （realpath 才是真凭据；`link:` 字符串和「文件存在」都不是）
 *   3. 每个包的 package.json 名字与目录一致、宿主入口与 client bundle **真实存在**
 *   4. profile 用户层（cordis.patch.yml）里每个稳定 id **各自至多一行**
 *   5. 装载机 patch 插了 6 行、全部子插件默认 `disabled: true`、id 各唯一
 *
 * 任何一项不满足 → `ok:false`，并把问题逐条列出来。
 *
 * 用法（CLI）：node scripts/assembly-check.mjs [profileDir] [--center <安装目录>]
 *
 * 不传 profileDir 时按 `profile-path.mjs` 的 `resolveProfileDir()` 自动找；
 * 找不到或找到多个都**拒绝猜**，列出候选让人显式传参（第四轮 R1）。
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPatchFile } from '../lib/patch.js'
// 模块清单的唯一真相在注册表（理由见下面 SUB_PACKAGES 的注释）——这里只 import，不再手抄。
import { SUB_PLUGINS } from '../lib/registry.js'
import { resolveProfileDir, depTarget } from './profile-path.mjs'
import { parseArgs } from './cli-args.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(SCRIPT_DIR, '..')

/**
 * 子包清单**从注册表推导**，不在这里再抄一份。
 *
 * 这里曾经是第二份手写清单（`[{name,dir} × 4]` + `STABLE_IDS × 4`），与
 * `lib/registry.js` 的 `SUB_PLUGINS` 是同一个事实的两份副本 —— 正是本项目反复踩过的
 * 「两份不一致」：加/删一个模块时漏改这里，校验会**照旧通过**（它校验的是自己那份
 * 过期清单），而装配已经错了。
 *
 * 现在唯一真相是 `lib/registry.js`：客户端清单在构建期内联自同一处
 * （`scripts/build-client.mjs` 的清单里有 `lib/registry.js`）。一致性由
 * `node scripts/module.mjs check` 与 `scripts/check.mjs` 第 11 节把守。
 *
 * name = 包名 = profile 的 node_modules 下的目录名；dir = 本仓库 packages/ 下的目录名。
 */
export const SUB_PACKAGES = SUB_PLUGINS.map((p) => ({ name: p.entry, dir: p.dir }))

/** 装载机自己 + 全部子包。 */
export const ALL_PACKAGES = [{ name: 'laurel-center', dir: '.' }, ...SUB_PACKAGES]

/** 全部稳定 id（loader 行 id，同时是用户层 patch 的定位键）。 */
export const STABLE_IDS = SUB_PLUGINS.map((p) => p.id)

/** 统一斜杠，避免 Windows 反斜杠与 realpath 的差异。 */
export function normPath(p) {
  return String(p).split(sep).join('/')
}

/** realpath，失败返回 null（断链）。 */
export function safeRealpath(p, realpath = realpathSync) {
  try {
    return normPath(realpath(p))
  } catch {
    return null
  }
}

/** 从 `link:` / `file:` spec 里取路径（取不到返回 null）。 */
export function pathFromSpec(spec) {
  if (typeof spec !== 'string') return null
  const m = /^(?:link|file):(.*)$/.exec(spec)
  return m ? m[1] : null
}

/**
 * 路径的「平台无关比较形式」：把 Windows 盘符路径和 WSL 的 /mnt/<盘>/ 映射到同一形状。
 * 只用于**字符串兜底比较**，不用于任何 IO。
 */
export function canonPath(p) {
  const text = normPath(p)
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(text)
  if (win) return `/${win[1].toLowerCase()}/${win[2]}`
  const mnt = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(text)
  if (mnt) return `/${mnt[1].toLowerCase()}/${mnt[2]}`
  return text
}

/**
 * 路径比较：优先用 realpath（强证据）；realpath 不可用时退回**规范化字符串**比较
 * （弱证据，大小写不敏感、跨平台盘符归一）。
 *
 * 为什么需要退路：profile 的依赖 spec 可能是**另一个平台**写的（例如 Windows 上装的
 * `link:D:/…`，而我们正在 WSL 里检查）。这时 realpath 必然失败，但那**不是**装配坏了 ——
 * 真正的强证据是同一次检查里的 `node_modules/<name>` realpath。
 *
 * @returns {{ same: boolean, evidence: 'realpath'|'string'|'none', actual: string | null }}
 */
export function comparePath(specPath, expectedDir, realpath) {
  const real = safeRealpath(specPath, realpath)
  if (real !== null) {
    const expectedReal = safeRealpath(expectedDir, realpath)
    return { same: expectedReal !== null && real === expectedReal, evidence: 'realpath', actual: real }
  }
  const a = canonPath(specPath).toLowerCase()
  const b = canonPath(expectedDir).toLowerCase()
  return { same: a === b, evidence: 'string', actual: normPath(specPath) }
}

/**
 * 校验一个 profile 的装配。
 *
 * @param {{
 *   profileDir: string,
 *   centerDir: string,
 *   expectBundles?: boolean,
 *   readFile?: Function, exists?: Function, realpath?: Function,
 * }} options
 * @returns {{
 *   ok: boolean,
 *   problems: string[],
 *   checks: Array<{ name: string, ok: boolean, detail?: string }>,
 *   details: object,
 * }}
 */
export function checkAssembly(options) {
  const profileDir = resolve(options.profileDir)
  const centerDir = resolve(options.centerDir)
  const readFile = options.readFile ?? ((p, enc) => readFileSync(p, enc))
  const exists = options.exists ?? existsSync
  const realpath = options.realpath ?? realpathSync

  const problems = []
  const checks = []
  const t = (name, ok, detail = '') => { checks.push({ name, ok, detail }); if (!ok) problems.push(detail ? `${name} —— ${detail}` : name) }

  const centerReal = safeRealpath(centerDir, realpath)
  const pkgPath = join(profileDir, 'package.json')
  if (!exists(pkgPath)) {
    t('profile package.json 存在', false, pkgPath)
    return { ok: false, problems, checks, details: { profileDir, centerDir } }
  }
  let pkg
  try {
    pkg = JSON.parse(readFile(pkgPath, 'utf8'))
  } catch (error) {
    t('profile package.json 可解析', false, String(error?.message ?? error))
    return { ok: false, problems, checks, details: { profileDir, centerDir } }
  }
  // 装载机必须在 dependencies（它是 bundle 本体）；各模块的链接**两处都认**：
  // 宿主按裸包名从 profile 的 node_modules 解析，devDependencies 装出来的链接同样能解析；
  // 真实机器上（宿主插件页装的）各模块就在 devDependencies 里。只读 dependencies
  // 会让本校验在真实机器上报一串**假失败** —— 实测过，虚假告警比不报更费人。
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const bundles = pkg.dsh?.profile?.bundles ?? []

  // ── 1. bundle 选择 ──────────────────────────────────────────────────────
  t('laurel-center 在 dependencies', 'laurel-center' in deps)
  if (options.expectBundles !== false) {
    t('laurel-center 在 bundles', bundles.includes('laurel-center'))
    t('laurel-center 在 bundles 里恰好一次（重复即假装配）',
      bundles.filter((b) => b === 'laurel-center').length === 1,
      JSON.stringify(bundles.filter((b) => b === 'laurel-center')))
  }

  // ── 2. 依赖 spec 指向（realpath 优先，跨平台 spec 退回字符串比较）───────
  const centerSpec = pathFromSpec(deps['laurel-center'])
  t('laurel-center 的依赖是 link/file 指向', centerSpec !== null, String(deps['laurel-center']))
  if (centerSpec !== null) {
    const cmp = comparePath(centerSpec, centerDir, realpath)
    t('laurel-center 依赖路径指向预期安装目录',
      cmp.same, `${cmp.actual} vs ${normPath(centerDir)}（${cmp.evidence}）`)
  }
  for (const s of SUB_PACKAGES) {
    const spec = pathFromSpec(deps[s.name])
    if (spec === null) { t(`[${s.name}] 依赖存在且是 link/file`, false, String(deps[s.name])); continue }
    const expectedDir = join(centerDir, 'packages', s.dir)
    const cmp = comparePath(spec, expectedDir, realpath)
    t(`[${s.name}] 依赖路径指向 <center>/packages/${s.dir}`,
      cmp.same, `${cmp.actual} vs ${normPath(expectedDir)}（${cmp.evidence}）`)
  }

  // ── 3. 真实链接 / 身份 / 入口（F4 的核心）───────────────────────────────
  const links = {}
  for (const p of ALL_PACKAGES) {
    const link = join(profileDir, 'node_modules', p.name)
    const real = safeRealpath(link, realpath)
    links[p.name] = real
    const expected = centerReal === null
      ? null
      : (p.dir === '.' ? centerReal : `${centerReal}/packages/${p.dir}`)
    t(`[${p.name}] node_modules 链接 realpath 落在预期位置`,
      real !== null && expected !== null && real === expected,
      real === null ? '断链' : `${real}（期望 ${expected}）`)
    if (real === null) continue

    const subPkgPath = join(link, 'package.json')
    if (!exists(subPkgPath)) { t(`[${p.name}] package.json 存在`, false, subPkgPath); continue }
    let sub
    try {
      sub = JSON.parse(readFile(subPkgPath, 'utf8'))
    } catch (error) {
      t(`[${p.name}] package.json 可解析`, false, String(error?.message ?? error))
      continue
    }
    t(`[${p.name}] 包名与目录一致`, sub.name === p.name, `${sub.name} vs ${p.name}`)
    t(`[${p.name}] 声明了版本`, typeof sub.version === 'string' && sub.version.length > 0, String(sub.version))
    const mainRel = typeof sub.exports?.['.'] === 'string' ? sub.exports['.'] : sub.main
    t(`[${p.name}] 宿主入口真实存在`, typeof mainRel === 'string' && exists(join(link, mainRel)), String(mainRel))
    const clientRel = sub.exports?.['./client']
    if (clientRel !== undefined) {
      t(`[${p.name}] client bundle 真实存在`, typeof clientRel === 'string' && exists(join(link, clientRel)), String(clientRel))
    }
  }

  // ── 4. 用户层 patch 唯一性 ──────────────────────────────────────────────
  const profilePatchPath = join(profileDir, 'cordis.patch.yml')
  const profilePatch = readPatchFile(profilePatchPath, { readFile, exists })
  if (!profilePatch.ok) {
    t('profile 用户层 patch 可读', false, profilePatch.error)
  } else {
    for (const id of STABLE_IDS) {
      const count = profilePatch.entries.filter((e) => e.id === id && !e.hasInsert).length
      t(`profile 用户层里 ${id} 至多一行（重复会抢方向盘）`, count <= 1, `实得 ${count}`)
    }
  }

  // ── 5. 装载机 patch ─────────────────────────────────────────────────────
  const loaderPatchPath = join(centerDir, 'cordis.patch.yml')
  const loaderPatch = readPatchFile(loaderPatchPath, { readFile, exists })
  if (!loaderPatch.ok) {
    t('装载机 patch 可读', false, loaderPatch.error)
  } else {
    // `readPatchFile` 对**用户层**文件把「不存在」当正常（用户没写过 override），
    // 但装载机自己的 patch 是**包自己声明的**，缺了就是装配不全。两种语义在这里分岔，
    // 所以显式点名 —— R7 的现场正是这个文件缺失，当时只看到一句
    // `loaderPatch.rows is not iterable`，看不出到底缺了什么。
    t('装载机 patch 文件存在', loaderPatch.present, loaderPatchPath)
    // `insert:` 下面的行在 rows 里；顶层容器本身没有 id，不计。
    // `rows ?? []` 是防御性的：`readPatchFile` 已经保证有这个键（R7），但校验核
    // 崩掉的代价是「安装事务在回滚之前死掉」，所以这里再兜一层。
    const allRows = [...(loaderPatch.entries ?? []), ...(loaderPatch.rows ?? [])]
    const subRows = allRows.filter((e) => STABLE_IDS.includes(e.id))
    // 数量也从注册表推导：写死 4 会在增删模块时变成一条永远为真的断言。
    t('装载机 patch 声明了全部子插件行', subRows.length === STABLE_IDS.length, `实得 ${subRows.length} / 应有 ${STABLE_IDS.length}`)
    for (const id of STABLE_IDS) {
      const matched = allRows.filter((e) => e.id === id)
      t(`装载机 patch 里 ${id} 唯一`, matched.length === 1, `实得 ${matched.length}`)
      t(`装载机 patch 里 ${id} 默认 disabled: true`, matched[0]?.disabled === true, JSON.stringify(matched[0]))
    }
    const centerRow = allRows.find((e) => e.id === 'laurel-center')
    t('装载机 patch 声明了 laurel-center 自己', centerRow !== undefined, JSON.stringify(centerRow))
  }

  return { ok: problems.length === 0, problems, checks, details: { profileDir, centerDir, centerReal, links } }
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
function main(argv) {
  const parsed = parseArgs(argv, { valueOptions: ['--center'] })
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) console.error(`  ✗ ${e}`)
    return 2
  }
  const resolved = resolveProfileDir({ explicit: parsed.positional[0] ?? null })
  if (resolved.dir === undefined) {
    console.error(`  ✗ ${resolved.error}`)
    if (resolved.candidates.length > 0) {
      console.error('  候选（把正确的那个显式传进来）：')
      for (const c of resolved.candidates) console.error(`    ${c}`)
    }
    console.error('用法：node scripts/assembly-check.mjs [profileDir] [--center <安装目录>]')
    return 2
  }
  const profileDir = resolved.dir
  // center 默认**跟着 profile 走**：profile 里 `laurel-center` 的 link 指向就是这台机器
  // 实际的安装面。默认 REPO 会让「不带参数跑」验的是开发仓库而不是装机结果
  // （与 verify-installed.mjs 同一口径）。
  const centerDir = parsed.values.get('--center') ?? depTarget(profileDir, 'laurel-center') ?? REPO
  const result = checkAssembly({ profileDir, centerDir })
  console.log(`装配校验：profile=${resolve(profileDir)} center=${resolve(centerDir)}`)
  for (const c of result.checks) console.log(`${c.ok ? '  ✓' : '  ✗'} ${c.name}${c.ok ? '' : `  → ${c.detail ?? ''}`}`)
  console.log(result.ok ? '\n装配校验通过' : `\n${result.problems.length} 项不通过`)
  return result.ok ? 0 : 1
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])
if (invokedDirectly) process.exit(main(process.argv.slice(2)))
