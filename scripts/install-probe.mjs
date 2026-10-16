#!/usr/bin/env node
/**
 * Laurel 套件 · 安装事务的**隔离复现探针**（第四轮 R2 的回归防线）
 *
 * ── 为什么必须有这个探针 ─────────────────────────────────────────────────
 * 2026-10-13 公开仓首次使用评审（R2）在真实 pnpm 上复现了两个失败：
 *   · 从「旧依赖结构」（装载机在 dependencies、四个模块在 devDependencies，
 *     五处都指向旧安装目录）迁移到新目录 → 装配校验看到的是**旧目录** → 判失败 → 回滚
 *   · 卸载只删 dependencies，四个模块的链接残留 → 判失败 → 回滚
 * 这两个都不是「逻辑读起来对不对」能发现的，只有真的跑一次 pnpm 才暴露。
 *
 * 所以这里把**真实流程**跑一遍：建一个隔离 profile（临时目录，不碰任何真实 profile），
 * 用**真实 pnpm** 建链接，然后调用 `scripts/install-profile.mjs` 跑九个场景：
 *   S1 全新安装 / S2 旧结构迁移 / S3 卸载（真实形状）/ S3b 卸载（全新形状）/
 *   S4 显式回滚 / S5 失败回滚（坏包）/ S5b 失败回滚（缺装载机 patch）/
 *   S6 参数解析 / S7 默认寻址
 * 逐条断言结果。
 *
 * ⚠ 卸载必须用**真实机器的形状**（装载机在 dependencies、四个模块在 devDependencies）来测：
 * 先装再卸时五个包都在 dependencies，只清 dependencies 的实现照样能过 ——
 * 这个缺口是 2026-10-13 用「把 R2 改回去」的反向验证才发现的（见 S3 与 S3b）。
 *
 * ⚠ 「失败回滚」要分两种失败来测：坏包（S5，入口文件缺失）和**缺装载机 patch**（S5b，R7）。
 * 后者会让装配校验核**抛异常**而不是返回失败 —— 抛出去的异常绕过回滚路径，
 * 所以必须单独有一条场景盯着「进程干净退出 1 + 链接真的回去了」。
 *
 * ── 它不碰什么 ───────────────────────────────────────────────────────────
 *   · 不读也不写 `~/.dsh`、真实 profile、`$DSH_HOME`
 *   · 不联网：五处依赖都是 `link:`，pnpm 只建符号链接，不解析也不下载传递依赖
 *     （实测 fixture 里 `pnpm install` 是 21ms / "Already up to date"）
 *   · 不改仓库里的任何文件（唯一写入是 `os.tmpdir()` 下的工作目录）
 *
 * 用法：
 *   node scripts/install-probe.mjs            # 跑全部场景，最后清理
 *   node scripts/install-probe.mjs --keep     # 保留工作目录，打印路径
 *   node scripts/install-probe.mjs --repo <仓库目录>
 *
 * 退出码：0 全通过 / 1 有场景失败 / 2 用法或前置缺失。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { checkAssembly, SUB_PACKAGES } from './assembly-check.mjs'
import { parseArgs } from './cli-args.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(SCRIPT_DIR, '..')
const INSTALLER = join(SCRIPT_DIR, 'install-profile.mjs')

const SUB = SUB_PACKAGES.map((s) => s.name)
const OWNED = ['laurel-center', ...SUB]
/** Windows 上 pnpm 常是 `.cmd` shim，Node 不能直接 execFile（同 install-profile.mjs 的 R6 处理）。 */
const PNPM_VIA_SHELL = process.platform === 'win32'

const parsed = parseArgs(process.argv.slice(2), { knownFlags: ['--keep'], valueOptions: ['--repo'] })
if (parsed.errors.length > 0) {
  for (const e of parsed.errors) console.error(`  ✗ ${e}`)
  process.exit(2)
}
const repo = resolve(parsed.values.get('--repo') ?? REPO)
const keep = parsed.flags.has('--keep')

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const failures = []
let scenario = ''

function ok(label, cond, detail = '') {
  if (cond) { console.log(`    ✓ ${label}`); return true }
  console.log(`    ✗ ${label}${detail ? `  → ${detail}` : ''}`)
  failures.push(`[${scenario}] ${label}${detail ? ` → ${detail}` : ''}`)
  return false
}

function start(name) {
  scenario = name
  console.log(`\n── ${name} ──`)
}

/** 跑一次安装事务，返回 `{ status, output }`（非零退出**不抛**，由调用方断言）。 */
function runInstaller(args, cwd, extraEnv = {}) {
  try {
    const output = execFileSync(process.execPath, [INSTALLER, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    })
    return { status: 0, output }
  } catch (error) {
    return { status: error?.status ?? -1, output: `${error?.stdout ?? ''}${error?.stderr ?? ''}` }
  }
}

function pnpmInstall(cwd) {
  try {
    execFileSync('pnpm', ['install', '--no-frozen-lockfile'], { cwd, encoding: 'utf8', shell: PNPM_VIA_SHELL })
    return true
  } catch (error) {
    console.error(`    pnpm install 失败：${error?.stdout ?? ''}${error?.stderr ?? ''}`)
    return false
  }
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n')
const realpathOrNull = (p) => { try { return realpathSync(p) } catch { return null } }
const linkOf = (profile, name) => realpathOrNull(join(profile, 'node_modules', name))

/** OWNED 五包在两段依赖里的出现次数（迁移后必须是 1，不能一段新一段旧）。 */
function ownedOccurrences(pkg) {
  const out = {}
  for (const n of OWNED) {
    let count = 0
    for (const section of ['dependencies', 'devDependencies']) {
      if (Object.prototype.hasOwnProperty.call(pkg[section] ?? {}, n)) count += 1
    }
    out[n] = count
  }
  return out
}

/** 真实机器上的旧依赖形状：装载机在 dependencies、四个模块在 devDependencies。 */
function legacyPackageJson(center) {
  return {
    name: 'laurel-install-probe',
    private: true,
    dependencies: { 'laurel-center': `link:${center}`, 'some-other-plugin': 'link:/nonexistent/other-plugin' },
    devDependencies: Object.fromEntries(SUB.map((n) => [n, `link:${center}/packages/${n}`])),
    dsh: { profile: { bundles: ['laurel-center', 'some-other-plugin'] } },
  }
}

/** 全新 profile：装了别的插件，但没装 Laurel。 */
function freshPackageJson() {
  return {
    name: 'laurel-install-probe',
    private: true,
    dependencies: { 'some-other-plugin': 'link:/nonexistent/other-plugin' },
    dsh: { profile: { bundles: ['some-other-plugin'] } },
  }
}

/* ------------------------------------------------------------------ *
 * 工作目录
 * ------------------------------------------------------------------ */

const workRoot = join(tmpdir(), `laurel-install-probe-${process.pid}`)
rmSync(workRoot, { recursive: true, force: true })
mkdirSync(workRoot, { recursive: true })

const pnpmVersion = (() => {
  try { return execFileSync('pnpm', ['--version'], { encoding: 'utf8', shell: PNPM_VIA_SHELL }).trim() } catch { return null }
})()
if (pnpmVersion === null) {
  console.error('  ✗ 找不到可用的 pnpm —— 这个探针要用真实 pnpm 建链接。')
  console.error('    先装：npm i -g pnpm   （或 corepack enable pnpm）')
  process.exit(2)
}
console.log(`install-probe · repo=${repo}`)
console.log(`node ${process.version} · pnpm ${pnpmVersion} · 工作目录 ${workRoot}`)

/** 「旧安装面」= 仓库的一份副本（不含 .git / node_modules / 临时目录）。 */
const oldCenter = join(workRoot, 'old-center')
cpSync(repo, oldCenter, {
  recursive: true,
  filter: (p) => {
    const parts = p.split(/[\\/]/)
    return !parts.some((n) => n === '.git' || n === 'node_modules' || n.startsWith('.laurel-center-backup-') || n === 'release')
  },
})

/** 「坏安装面」= 名字对、入口文件缺失（模拟升级到半成品包）。 */
const brokenCenter = join(workRoot, 'broken-center')
mkdirSync(join(brokenCenter, 'packages'), { recursive: true })
writeJson(join(brokenCenter, 'package.json'), { name: 'laurel-center', version: '0.0.0-broken', main: './lib/index.js' })

function newProfile(name, pkg) {
  const dir = join(workRoot, name)
  mkdirSync(dir, { recursive: true })
  writeJson(join(dir, 'package.json'), pkg)
  return dir
}

/** 迁移场景的前置：把 profile 恢复成旧形状并让 pnpm 真的建出旧链接。 */
function installLegacy(profile) {
  writeJson(join(profile, 'package.json'), legacyPackageJson(oldCenter))
  rmSync(join(profile, 'node_modules'), { recursive: true, force: true })
  rmSync(join(profile, 'pnpm-lock.yaml'), { force: true })
  return pnpmInstall(profile)
}

/* ------------------------------------------------------------------ *
 * S1 · 全新安装（无旧依赖）
 * ------------------------------------------------------------------ */

start('S1 全新安装：profile 里没有 Laurel 的任何依赖')
const p1 = newProfile('s1-fresh', freshPackageJson())
{
  const r = runInstaller([p1, '--center', repo], repo)
  ok('install-profile 退出 0', r.status === 0, `exit=${r.status}\n${r.output}`)
  const pkg = readJson(join(p1, 'package.json'))
  const occ = ownedOccurrences(pkg)
  ok('五个包各出现一次（不多不少）', Object.values(occ).every((c) => c === 1), JSON.stringify(occ))
  const links = Object.fromEntries(OWNED.map((n) => [n, linkOf(p1, n)]))
  const expected = { 'laurel-center': realDir(repo), ...Object.fromEntries(SUB.map((n) => [n, join(realDir(repo), 'packages', n)])) }
  ok('五个链接 realpath 都落在新安装目录', OWNED.every((n) => links[n] === expected[n]),
    JSON.stringify(links, null, 2))
  const assembly = checkAssembly({ profileDir: p1, centerDir: repo })
  ok('装配校验通过', assembly.ok, assembly.problems.join('；'))
  ok('无关依赖没被动过', pkg.dependencies['some-other-plugin'] === 'link:/nonexistent/other-plugin')
}

/* ------------------------------------------------------------------ *
 * S2 · 旧依赖结构迁移（R2 的主场景）
 * ------------------------------------------------------------------ */

start('S2 旧结构迁移：五个依赖原先都指向旧安装目录（模块在 devDependencies）')
const p2 = newProfile('s2-legacy', legacyPackageJson(oldCenter))
{
  ok('前置：旧结构 pnpm install 成功', installLegacy(p2))
  const before = Object.fromEntries(OWNED.map((n) => [n, linkOf(p2, n)]))
  ok('前置：五个链接指向旧目录', OWNED.every((n) => before[n] === (n === 'laurel-center' ? oldCenter : join(oldCenter, 'packages', n))),
    JSON.stringify(before, null, 2))

  const r = runInstaller([p2, '--center', repo], repo)
  ok('install-profile 退出 0（评审 R2 里这里是 1 + 回滚）', r.status === 0, `exit=${r.status}\n${r.output}`)
  const pkg = readJson(join(p2, 'package.json'))
  const occ = ownedOccurrences(pkg)
  ok('五个包各只留一处（旧的同名声明已清掉）', Object.values(occ).every((c) => c === 1), JSON.stringify(occ))
  const after = Object.fromEntries(OWNED.map((n) => [n, linkOf(p2, n)]))
  const expected = { 'laurel-center': realDir(repo), ...Object.fromEntries(SUB.map((n) => [n, join(realDir(repo), 'packages', n)])) }
  ok('五个链接 realpath 都离开旧目录', OWNED.every((n) => after[n] === expected[n]), JSON.stringify(after, null, 2))
  const assembly = checkAssembly({ profileDir: p2, centerDir: repo })
  ok('装配校验通过', assembly.ok, assembly.problems.join('；'))
}

/* ------------------------------------------------------------------ *
 * S3 · 卸载（两段都要清）
 * ------------------------------------------------------------------ */

start('S3 卸载 · 真实机器形状：模块在 devDependencies（评审 R2 就栽在这里）')
const p3 = newProfile('s3-uninstall-legacy', legacyPackageJson(oldCenter))
{
  ok('前置：旧结构（模块在 devDependencies）装好', installLegacy(p3))
  const before = Object.fromEntries(OWNED.map((n) => [n, linkOf(p3, n)]))
  ok('前置：五个链接都在', OWNED.every((n) => before[n] !== null), JSON.stringify(before, null, 2))

  const r = runInstaller([p3, '--uninstall'], repo)
  ok('--uninstall 退出 0（评审 R2 里这里是 1 + 回滚）', r.status === 0, `exit=${r.status}\n${r.output}`)
  const pkg = readJson(join(p3, 'package.json'))
  const occ = ownedOccurrences(pkg)
  // 只清 dependencies 会在这里留下四个模块 —— 这正是评审 R2 的失败点。
  ok('两段依赖里都没有 OWNED 五包（devDependencies 也必须清）', Object.values(occ).every((c) => c === 0), JSON.stringify(occ))
  ok('node_modules 里五个链接都不在', OWNED.every((n) => linkOf(p3, n) === null))
  ok('bundles 里没有 laurel-center', !(pkg.dsh?.profile?.bundles ?? []).includes('laurel-center'))
  ok('无关依赖仍在', pkg.dependencies['some-other-plugin'] === 'link:/nonexistent/other-plugin')
}

start('S3b 卸载 · 全新安装后再卸（五个都在 dependencies）')
const p3b = newProfile('s3-uninstall-fresh', freshPackageJson())
{
  ok('前置：安装成功', runInstaller([p3b, '--center', repo], repo).status === 0)
  const r = runInstaller([p3b, '--uninstall'], repo)
  ok('--uninstall 退出 0', r.status === 0, `exit=${r.status}\n${r.output}`)
  const pkg = readJson(join(p3b, 'package.json'))
  const occ = ownedOccurrences(pkg)
  ok('两段依赖里都没有 OWNED 五包', Object.values(occ).every((c) => c === 0), JSON.stringify(occ))
  ok('node_modules 里五个链接都不在', OWNED.every((n) => linkOf(p3b, n) === null))
  ok('无关依赖仍在', pkg.dependencies['some-other-plugin'] === 'link:/nonexistent/other-plugin')
}

/* ------------------------------------------------------------------ *
 * S4 · 显式回滚
 * ------------------------------------------------------------------ */

start('S4 显式回滚：装到新目录后 --rollback 应回到旧目录')
const p4 = newProfile('s4-rollback', legacyPackageJson(oldCenter))
{
  ok('前置：旧结构装好', installLegacy(p4))
  ok('前置：迁到新目录成功', runInstaller([p4, '--center', repo], repo).status === 0)
  const r = runInstaller([p4, '--rollback'], repo)
  ok('--rollback 退出 0', r.status === 0, `exit=${r.status}\n${r.output}`)
  const after = Object.fromEntries(OWNED.map((n) => [n, linkOf(p4, n)]))
  const back = { 'laurel-center': oldCenter, ...Object.fromEntries(SUB.map((n) => [n, join(oldCenter, 'packages', n)])) }
  ok('五个链接回到旧目录', OWNED.every((n) => after[n] === back[n]), JSON.stringify(after, null, 2))
  const pkg = readJson(join(p4, 'package.json'))
  ok('package.json 回到旧 spec', pkg.dependencies['laurel-center'] === `link:${oldCenter}`, pkg.dependencies['laurel-center'])
}

/* ------------------------------------------------------------------ *
 * S5 · 失败回滚（装到坏包 → 必须退回旧目录，且链接真的回来）
 * ------------------------------------------------------------------ */

start('S5 失败回滚：目标安装面入口缺失时，失败并退回旧目录')
const p5 = newProfile('s5-failrollback', legacyPackageJson(oldCenter))
{
  ok('前置：旧结构装好', installLegacy(p5))
  const r = runInstaller([p5, '--center', brokenCenter], repo)
  ok('install-profile 退出 1（操作失败，已回滚）', r.status === 1, `exit=${r.status}\n${r.output}`)
  const after = Object.fromEntries(OWNED.map((n) => [n, linkOf(p5, n)]))
  const back = { 'laurel-center': oldCenter, ...Object.fromEntries(SUB.map((n) => [n, join(oldCenter, 'packages', n)])) }
  ok('五个链接都回到旧目录（不是「文件回去了、链接还指着坏包」）', OWNED.every((n) => after[n] === back[n]),
    JSON.stringify(after, null, 2))
  const pkg = readJson(join(p5, 'package.json'))
  ok('package.json 回到旧 spec', pkg.dependencies['laurel-center'] === `link:${oldCenter}`, pkg.dependencies['laurel-center'])
}

/* ------------------------------------------------------------------ *
 * S5b · 安装面缺装载机 patch（R7 现场：校验核抛错也必须干净失败 + 回滚）
 * ------------------------------------------------------------------ */

start('S5b 安装面缺装载机 patch：校验核抛错也要干净失败并回滚（R7）')
const noPatchCenter = join(workRoot, 'no-patch-center')
const p5b = newProfile('s5b-no-patch', legacyPackageJson(oldCenter))
{
  // 「安装面不完整」最真实的形态：目录在、包也在，就是少了自己声明的那份 patch。
  // 这一下会把 `assembly-check.mjs` 推到 `readPatchFile` 的「文件不存在」提前返回上，
  // 而那正是 R7 的现场 —— 当时那个返回对象少一个 `rows` 键，于是
  // `[...entries, ...rows]` 抛 TypeError，安装器**崩在回滚之前**，profile 停在半装状态。
  cpSync(repo, noPatchCenter, {
    recursive: true,
    filter: (p) => {
      const parts = p.split(/[\\/]/)
      return !parts.some((n) => n === '.git' || n === 'node_modules' || n.startsWith('.laurel-center-backup-') || n === 'release')
    },
  })
  rmSync(join(noPatchCenter, 'cordis.patch.yml'), { force: true })
  ok('前置：安装面确实没有 cordis.patch.yml', !existsSync(join(noPatchCenter, 'cordis.patch.yml')))
  ok('前置：旧结构装好', installLegacy(p5b))

  const r = runInstaller([p5b, '--center', noPatchCenter], repo)
  ok('install-profile 退出 1（操作失败，不是崩掉）', r.status === 1, `exit=${r.status}\n${r.output}`)
  ok('输出里点名「装载机 patch」（不是只有一句 rows is not iterable）',
    /装载机 patch/.test(r.output), r.output)
  const after = Object.fromEntries(OWNED.map((n) => [n, linkOf(p5b, n)]))
  const back = { 'laurel-center': oldCenter, ...Object.fromEntries(SUB.map((n) => [n, join(oldCenter, 'packages', n)])) }
  ok('五个链接都回到旧目录（崩在回滚之前的话这里必红）', OWNED.every((n) => after[n] === back[n]),
    JSON.stringify(after, null, 2))
}

/* ------------------------------------------------------------------ *
 * S6 · 参数解析（R1 的回归防线：不带参数 / 选项值不吃位置参数）
 * ------------------------------------------------------------------ */

start('S6 参数解析：选项值不能被当成位置参数')
{
  // 位置参数在选项之后：修之前 `--center X <profile>` 会把 X 当 profile。
  const r = runInstaller(['--center', repo, p5], repo)
  ok('`--center <目录> <profile>` 顺序下仍操作正确的 profile', r.status === 0 && r.output.includes(`profile : ${p5}`),
    `exit=${r.status}\n${r.output}`)

  const missing = runInstaller(['--center'], repo)
  ok('`--center` 缺值 → 退出 2 且不静默继续', missing.status === 2, `exit=${missing.status}\n${missing.output}`)

  const unknown = runInstaller(['--nope'], repo)
  ok('不认识的选项 → 退出 2', unknown.status === 2, `exit=${unknown.status}\n${unknown.output}`)

  const bogusProfile = runInstaller(['/nonexistent/profile', '--center', repo], repo)
  ok('显式传的 profile 不存在 → 退出 2 且说清路径', bogusProfile.status === 2, `exit=${bogusProfile.status}\n${bogusProfile.output}`)
}

/* ------------------------------------------------------------------ *
 * S7 · 默认寻址（R1 的回归防线：README 那条**不带位置参数**的命令要真能用）
 * ------------------------------------------------------------------ */

start('S7 默认寻址：不传位置参数，靠 DSH_HOME 自动找到 profile')
const s7Home = join(workRoot, 's7-dsh-home')
const p7 = join(s7Home, 'profiles', 'desktop')
{
  mkdirSync(p7, { recursive: true })
  writeJson(join(p7, 'package.json'), freshPackageJson())
  // HOME / USERPROFILE 指到空目录、WSL_DISTRO_NAME 清空：
  // 确保「找得到」只可能来自 DSH_HOME，而不是本机真实 profile 或 /mnt/*/Users 扫描。
  // （不这样做的话，在 WSL 开发机上 S7 会因为扫到真实 profile 而变成「多个候选」。）
  const emptyHome = join(workRoot, 's7-empty-home')
  mkdirSync(emptyHome, { recursive: true })
  const base = { HOME: emptyHome, USERPROFILE: emptyHome, WSL_DISTRO_NAME: '' }

  const found = runInstaller(['--center', repo], repo, { ...base, DSH_HOME: s7Home })
  ok('不带位置参数也能装成功（README 的默认命令）', found.status === 0, `exit=${found.status}\n${found.output}`)
  ok('操作的正是 DSH_HOME 下的那个 profile', found.output.includes(`profile : ${p7}`), found.output)
  const links = Object.fromEntries(OWNED.map((n) => [n, linkOf(p7, n)]))
  const expected = { 'laurel-center': realDir(repo), ...Object.fromEntries(SUB.map((n) => [n, join(realDir(repo), 'packages', n)])) }
  ok('五个链接落在这个 profile 里', OWNED.every((n) => links[n] === expected[n]), JSON.stringify(links, null, 2))

  const none = runInstaller(['--center', repo], repo, { ...base, DSH_HOME: join(workRoot, 's7-nothing') })
  ok('一个候选都没有 → 退出 2，且说清是「找不到」而不是甩用法',
    none.status === 2 && /找不到 Harness profile/.test(none.output), `exit=${none.status}\n${none.output}`)
}

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

console.log('\n' + '─'.repeat(56))
if (failures.length === 0) {
  console.log('全部场景通过')
} else {
  console.log(`${failures.length} 项失败：`)
  for (const f of failures) console.log(`  · ${f}`)
}
if (keep) console.log(`工作目录保留：${workRoot}`)
else rmSync(workRoot, { recursive: true, force: true })
process.exit(failures.length === 0 ? 0 : 1)

/** 安装目录的 realpath（`--center <repo>` 之后链接会指向它）。 */
function realDir(dir) {
  return realpathOrNull(dir) ?? dir
}
