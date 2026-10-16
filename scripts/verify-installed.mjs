/**
 * Laurel-Center · 装机后装配检查（**只读**，不改任何东西）
 *
 * 前几个探针验的是「我们自己的代码对不对」。这个验的是另一件事：
 * **它有没有被正确地装进 profile**。装完（或升级完）跑一次，
 * 就能知道重启后 DSH 会不会按预期组出那 6 行。
 *
 * ── 第二轮改成复用同一个核心（F4）─────────────────────────────────────────
 * 第一轮这里是「有 realpath 强校验的那一份」，而 `scripts/install-profile.mjs`
 * 自己还有一份只看名字的 `verify()`。交付时拿本文件的结论去证明安装器的行为，
 * 是偷换证据。现在两边都调 `scripts/assembly-check.mjs` —— 一份实现、两份入口。
 *
 * 本文件额外补 profile 自身的卫生检查（旧死引用、重复 bundle 声明），
 * 这些不属于「装配」，但属于「这个 profile 干不干净」。
 *
 * 用法：node scripts/verify-installed.mjs [profile 目录] [--center <安装目录>]
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAssembly, normPath } from './assembly-check.mjs'
import { depTarget, resolveProfileDir, toPosixPath } from './profile-path.mjs'
import { parseArgs } from './cli-args.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(SCRIPT_DIR, '..')

// 参数解析统一走 cli-args（第四轮 R1：带值的选项，它的值不能进位置参数）。
const parsed = parseArgs(process.argv.slice(2), { valueOptions: ['--center'] })
if (parsed.errors.length > 0) {
  for (const e of parsed.errors) console.error(`  ✗ ${e}`)
  process.exit(2)
}
// 默认 profile **不再写死某个用户的路径**（既是隐私，也会在别的机器/WSL 里解析错：
// `C:/Users/...` 被 resolve() 当相对路径，拼成 <仓库>/C:/Users/... → 报「profile 不存在」）。
// 显式传参优先；否则按 DSH_HOME / 用户主目录去找；找不到或**多个候选**就列出来，不猜。
const resolvedProfile = resolveProfileDir({ explicit: parsed.positional[0] ?? null })
if (resolvedProfile.dir === undefined) {
  console.error(`  ✗ ${resolvedProfile.error}`)
  if (resolvedProfile.candidates.length > 0) {
    console.error('  候选（把正确的那个显式传进来）：')
    for (const c of resolvedProfile.candidates) console.error(`    ${c}`)
  }
  console.error('  node scripts/verify-installed.mjs <profileDir> [--center <安装目录>]')
  process.exit(2)
}
const P = resolve(resolvedProfile.dir)
// center 默认也跟着 profile 走：profile 里 `laurel-center` 的 link 指向**就是**
// 这台机器实际的安装面。写死 REPO 会让「不带参数跑」验的是开发仓库而不是装机结果 ——
// 那正是这个脚本名字承诺的反面（实测会报 10 个假失败）。
const centerArg = parsed.values.get('--center')
const center = resolve(toPosixPath(centerArg ?? depTarget(P, 'laurel-center') ?? REPO))

console.log(`Laurel-Center · 装机装配检查（profile: ${P}，center: ${center}）\n`)

let bad = 0
const t = (name, cond, detail = '') => { console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  → ' + detail)); if (!cond) bad += 1 }

// ── 1. 共用核心的装配校验（realpath / 身份 / 入口 / bundle / patch 唯一性）──
const assembly = checkAssembly({ profileDir: P, centerDir: center })
console.log('1. 装配校验（scripts/assembly-check.mjs 同一份实现）')
for (const c of assembly.checks) t(c.name, c.ok, c.detail)

// ── 2. profile 自身的卫生 ───────────────────────────────────────────────
console.log('\n2. profile 卫生')
const pkgPath = join(P, 'package.json')
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  // 与 assembly-check.mjs 同一口径：模块链接可能落在 devDependencies（真实机器就是这样），
  // 宿主解析只看 profile 的 node_modules，所以两处都要认。
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const bundles = pkg.dsh?.profile?.bundles ?? []
  t('gen-4 死引用已清', !('dsh-infinite-gen-4' in deps))
  t('dsh-strata 不在 bundles（避免重复声明）', !bundles.includes('dsh-strata'))
  t('dsh-loom 不在 bundles（避免重复声明）', !bundles.includes('dsh-loom'))
  t('laurel-center 在 bundles 里恰好一次', bundles.filter((b) => b === 'laurel-center').length === 1,
    JSON.stringify(bundles.filter((b) => b === 'laurel-center')))
  const linkTargets = Object.entries(deps)
    .filter(([n]) => n === 'laurel-center' || n.startsWith('dsh-') || n === 'laurel')
    .map(([n, spec]) => `${n}=${String(spec).startsWith('link:') ? normPath(String(spec).slice(5)) : String(spec)}`)
  console.log('  · 相关依赖：' + linkTargets.join(', '))
}

console.log(bad ? `\n${bad} 项有问题` : '\n全部通过')
process.exit(bad ? 1 : 0)
