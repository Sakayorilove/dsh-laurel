#!/usr/bin/env node
/**
 * Laurel 套件 · release 生成器 / 校验器
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 单一仓库里放的是**完整开发输入**（含 Loom 的 src/tsconfig/scripts/tests）。
 * 安装面（profile 链接指向的那个目录）只该有**运行需要的文件**。
 * 两者之间的映射不能靠人手维护 —— 那就是「两份不一致」的老坑。
 * 所以：安装面由本脚本从仓库**生成**，并逐文件记 hash。
 *
 *   node scripts/release.mjs                 # 生成到 ./release/ 并写 manifest
 *   node scripts/release.mjs --to <dir>      # 生成到指定目录（先过边界检查，再 staging 切换）
 *   node scripts/release.mjs --check [dir]   # 只比对：<dir>（默认 Windows 安装目录）
 *                                            #   是否与本仓库生成结果逐字节一致
 *
 * ⚠ 安装目录不要手改：改了会被下次 release 覆盖。
 *
 * ── 这次修了什么───────────────────────────────────────────────────
 * 旧版拿到 `--to` 就直接 `rmSync(dest, {recursive:true, force:true})`，再逐文件从源码复制。
 * 实测：把 `--to` 设成脚本自己的源码目录，脚本先备份、**删掉源码**、再从已删的源码复制 → ENOENT，
 * 原 payload 没了。现在：
 *   · 任何字符串都不许直接进递归 rm —— 先过 `scripts/release-guard.mjs` 的 realpath + 白名单
 *   · 先生成到 `<dest>.staging-*` 并**逐文件校验**，通过了才切换
 *   · 切换前把旧目录整体备份到 `<dest>.bak-*`，作为**保留的恢复凭据**
 *   · 切换失败（staging 校验不过 / 复制中断）→ 删掉 staging，原目录原样不动
 *   · manifest 记录源码 HEAD / dirty，供运行实例身份核对
 * ── 后续补修──────────────────────────────────────────────────
 * 目标边界检查改到 `scripts/release-guard.mjs`，按**真实路径**判（解析符号链接、
 * 逐级查祖先、拒绝挂载根与 `/mnt/<盘符>`），并且**切换前后都用已验证的物理路径**。
 * 切换改成**分阶段事务**，不再「先复制备份 → 删正式目录 → rename，失败就退回复制」。
 * 上一版在复制中途失败时 `dest` 已经存在，恢复分支的 `!existsSync(dest)` 为假 → 跳过恢复，
 * 正式目录只剩半套新文件（实测夹具只剩 partial.txt，旧入口没了）。现在：
 *   · 旧目录优先 **rename 到备份**；只有明确的跨设备/权限类错误才退回复制，且复制后
 *     先**逐文件核对旧 hash**，确认备份完好才敢删原目录
 *   · 切换失败/正式目录校验失败 → 清掉残目录、从备份恢复、**逐文件核对旧 hash**
 *   · 恢复成功与失败**分开报**（退出码 1 vs 4）；失败时打印备份位置与手动恢复步骤
 *   · 每个阶段都打 `[release] phase=<名字>`，便于事后核对
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { guardDestination, recheckDestination } from './release-guard.mjs'
import { defaultInstallDir } from './profile-path.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// `--check` 的默认目标：不再写死某台机器的安装目录（那既是隐私，也会在别的机器上解析错）。
// 顺序：LAUREL_CENTER_INSTALL → profile 里 laurel-center 的 link 指向 → 本仓库的 release/。
const DEFAULT_INSTALL = defaultInstallDir({ repo: REPO })

/** 只进开发仓库、不进安装面的路径（相对仓库根，glob）。 */
const EXCLUDE = [
  // ⚠ 必须写 `**/node_modules/**`：只写 `node_modules/**` 只排掉根目录那一层，
  // 子包自己的 node_modules（dev 装过 tsc / playwright 就有 .bin）会被当运行文件发出去。
  // 本轮实测：改前会把 packages/dsh-loom/node_modules/.bin/tsc 等 3 个文件打进 release。
  '**/node_modules/**',
  'node_modules/**',
  '.git/**', '.tmp-*/**', 'release/**', 'release-*/**', 'release.bak-*/**', '*.bak-*/**',
  'release.manifest.json',
  // 只进开发仓库、不进安装面的**文档类**文件：README 是包的门面所以要进，
  // 而 SOURCES / MODULES / pnpm-workspace / .gitignore 是仓库自己的东西。
  'SOURCES.md', 'MODULES.md', 'pnpm-workspace.yaml', '.gitignore',
  // 仓库级文档与 CI 配置也不进安装面（安装面只放运行需要的东西）
  'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', '.gitattributes', '.editorconfig', '.github/**',
  // 探针的证据（截图 / JSON）只留在开发仓库 —— 别跟着发进安装面。
  // 命名约定：证据目录一律以 `-evidence` 结尾（如 docs/laurel-center/host-busy-20261012-evidence/）。
  '**/*-evidence/**',
  'scripts/release.mjs',
  '**/*.tgz',
  // 子包自己的开发输入 / 证据
  'packages/dsh-loom/src/**',
  'packages/dsh-loom/tests/**',
  'packages/dsh-loom/scripts/**',
  'packages/dsh-loom/tsconfig.json',
  'packages/dsh-loom/.gitignore',
  'packages/dsh-loom/pnpm-lock.yaml',
  'packages/dsh-loom/.verification/**',
  'packages/dsh-loom/.browser-evidence/**',
  'packages/dsh-claude-parchment/artifacts/**',
  'packages/dsh-claude-parchment/pnpm-lock.yaml',
]

function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i += 1 } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + re + '$')
}
const EXCLUDE_RE = EXCLUDE.map(globToRegExp)

const isExcluded = (rel) => EXCLUDE_RE.some((re) => re.test(rel))

function walk(dir, base = '') {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name
    if (isExcluded(rel)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full, rel))
    else if (e.isFile()) out.push(rel)
  }
  return out.sort()
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 仓库 → 安装面应包含的文件清单。 */
function releaseFiles() {
  return walk(REPO).map((rel) => {
    const full = join(REPO, rel.split('/').join(sep))
    return { path: rel, size: statSync(full).size, sha256: sha256(full) }
  })
}

/** 源码 provenance。 */
function sourceProvenance() {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  }
  const head = run(['rev-parse', 'HEAD'])
  const porcelain = run(['status', '--porcelain'])
  return { head, dirty: porcelain === null ? null : porcelain.length > 0, version: JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version }
}

/** 逐文件核对一个目录与期望清单是否一致（staging 验收用）。 */
function verifyDir(dest, expected) {
  const problems = []
  for (const f of expected) {
    const target = join(dest, f.path.split('/').join(sep))
    if (!existsSync(target)) { problems.push(`缺失 ${f.path}`); continue }
    if (sha256(target) !== f.sha256) problems.push(`内容不同 ${f.path}`)
  }
  const seen = new Set(expected.map((f) => f.path))
  for (const rel of walk(dest)) {
    if (rel === 'release.manifest.json') continue
    if (!seen.has(rel)) problems.push(`多余 ${rel}`)
  }
  return problems
}

/** 读一个目录里的 release.manifest.json（拿不到返回 null）。 */
function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'release.manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 逐文件核对目录与**清单声明**是否一致（不校验清单自身真假，只核对文件）。 */
function verifyAgainstManifest(dir, manifest) {
  const problems = []
  for (const f of manifest?.files ?? []) {
    const target = join(dir, f.path.split('/').join(sep))
    if (!existsSync(target)) { problems.push(`缺失 ${f.path}`); continue }
    if (sha256(target) !== f.sha256) problems.push(`内容不同 ${f.path}`)
  }
  return problems
}

/** 只有这些 rename 失败码才值得退回复制；其它一律当作真故障。 */
const RENAME_FALLBACK_CODES = new Set(['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EINVAL'])

/**
 * 把旧版本恢复到 `dest`，并**逐文件核对旧 hash**。备份本身保留（它是恢复凭据）。
 * @returns {{ ok: boolean, steps: string[], failures: string[], problems: string[], oldManifest: string }}
 */
function restoreOld({ dest, backup, hadDest }) {
  const steps = []
  const failures = []
  const problems = []
  // 1) 清掉可能残留的半个新目录
  if (existsSync(dest)) {
    try {
      rmSync(dest, { recursive: true, force: true })
      steps.push('清掉残留的目标目录')
    } catch (error) {
      failures.push(`清掉残留目录失败：${String(error?.message ?? error)}`)
      return { ok: false, steps, failures, problems, oldManifest: 'not-attempted' }
    }
  }
  if (!hadDest) {
    steps.push('原本没有旧目录 → 正确状态就是「不存在」')
    return { ok: true, steps, failures, problems, oldManifest: 'none' }
  }
  // 2) 用备份恢复（复制而不是改名 —— 备份要留作凭据）
  try {
    cpSync(backup, dest, { recursive: true })
    steps.push(`从备份复制回 ${dest}`)
  } catch (error) {
    failures.push(`从备份恢复失败：${String(error?.message ?? error)}`)
    return { ok: false, steps, failures, problems, oldManifest: 'unknown' }
  }
  // 3) 逐文件核对旧 hash
  const manifest = readManifest(backup)
  if (manifest === null) {
    return { ok: failures.length === 0, steps, failures, problems, oldManifest: 'missing' }
  }
  problems.push(...verifyAgainstManifest(dest, manifest))
  return { ok: failures.length === 0 && problems.length === 0, steps, failures, problems, oldManifest: 'verified' }
}

/**
 * 生成到 staging，校验通过后**分阶段事务切换**；任何失败都不许留下半个正式目录，
 * 也不许悄悄丢掉旧版本。
 *
 * 阶段（每个都写日志 `[release] phase=<名字>`，便于事后核对）：
 *   staging-ready → backup-done / backup-skipped → switch-start → replaced
 *   失败时：staging-failed / staging-verify-failed / backup-failed / backup-verify-failed
 *           / switch-failed / dest-verify-failed → restore-ok / restore-failed
 *
 * @param {{ dest: string, destPhysical: string }} guard 已验证的目标身份
 */
function writeRelease(guard) {
  // ⚠ 一律用**已验证的物理路径**，不用用户给的字符串。
  const dest = guard.destPhysical
  const files = releaseFiles()
  const source = sourceProvenance()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const staging = `${dest}.staging-${stamp}`
  const backup = `${dest}.bak-${stamp}`
  const report = { dest, staging, backup, phases: [], exitCode: 0 }

  const phase = (name, detail = {}) => {
    report.phases.push({ phase: name, at: new Date().toISOString(), ...detail })
    console.log(`[release] phase=${name} ${JSON.stringify(detail)}`)
  }
  const cleanupStaging = () => { try { rmSync(staging, { recursive: true, force: true }) } catch { /* 清不掉也不该掩盖原故障 */ } }

  const manifest = {
    at: new Date().toISOString(),
    repo: REPO,
    dest,
    source,
    fileCount: files.length,
    totalBytes: files.reduce((s, f) => s + f.size, 0),
    files,
  }

  // ── 1) 生成 staging（与正式目录**同父目录**）────────────────────────────
  try {
    mkdirSync(dirname(dest), { recursive: true })
    mkdirSync(staging, { recursive: true })
    for (const f of files) {
      const target = join(staging, f.path.split('/').join(sep))
      mkdirSync(dirname(target), { recursive: true })
      cpSync(join(REPO, f.path.split('/').join(sep)), target)
    }
    writeFileSync(join(staging, 'release.manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  } catch (error) {
    cleanupStaging()
    phase('staging-failed', { error: String(error?.message ?? error) })
    console.error(`生成 staging 失败，原目录未动：${error?.message ?? error}`)
    report.exitCode = 1
    return report
  }

  // ── 2) 校验 staging 与期望清单逐字节一致 ────────────────────────────────
  const stagingProblems = verifyDir(staging, files)
  if (stagingProblems.length > 0) {
    cleanupStaging()
    phase('staging-verify-failed', { problems: stagingProblems.slice(0, 10) })
    console.error(`staging 校验未通过（${stagingProblems.length} 项），原目录未动：`)
    for (const p of stagingProblems.slice(0, 20)) console.error('  ✗', p)
    report.exitCode = 1
    return report
  }
  phase('staging-ready', { fileCount: files.length, totalBytes: manifest.totalBytes })

  // ── 3) 备份旧目录：先试 rename，只有明确的跨设备/权限类错误才退回复制 ────
  const hadDest = existsSync(dest)
  let backupMethod = null
  if (hadDest) {
    try {
      renameSync(dest, backup)
      backupMethod = 'rename'
    } catch (error) {
      const code = String(error?.code ?? '')
      if (!RENAME_FALLBACK_CODES.has(code)) {
        cleanupStaging()
        phase('backup-failed', { code, error: String(error?.message ?? error) })
        console.error(`备份旧目录失败（${code || 'unknown'}），原目录未动：${error?.message ?? error}`)
        report.exitCode = 1
        return report
      }
      try {
        cpSync(dest, backup, { recursive: true })
        backupMethod = 'copy'
      } catch (copyError) {
        cleanupStaging()
        phase('backup-failed', { code: String(copyError?.code ?? ''), error: String(copyError?.message ?? copyError) })
        console.error(`复制备份失败，原目录未动：${copyError?.message ?? copyError}`)
        report.exitCode = 1
        return report
      }
      // 复制法的备份必须**先核对旧 hash**，确认无误后才敢删原目录
      const oldManifest = readManifest(backup)
      const backupProblems = oldManifest === null ? [] : verifyAgainstManifest(backup, oldManifest)
      if (backupProblems.length > 0) {
        cleanupStaging()
        try { rmSync(backup, { recursive: true, force: true }) } catch { /* ignore */ }
        phase('backup-verify-failed', { problems: backupProblems.slice(0, 10), oldManifest: oldManifest === null ? 'missing' : 'verified' })
        console.error(`备份与旧清单不一致（${backupProblems.length} 项），原目录未动`)
        report.exitCode = 1
        return report
      }
      try {
        rmSync(dest, { recursive: true, force: true })
      } catch (rmError) {
        cleanupStaging()
        phase('backup-rm-failed', { error: String(rmError?.message ?? rmError) })
        console.error(`删除旧目录失败（备份已在 ${backup}）：${rmError?.message ?? rmError}`)
        report.exitCode = 1
        return report
      }
    }
    phase('backup-done', { backup, method: backupMethod })
  } else {
    phase('backup-skipped', { reason: 'dest-not-exists' })
  }

  // ── 4) 切换 ────────────────────────────────────────────────────────────
  phase('switch-start', { staging, dest, hadDest })
  const failAndRestore = (phaseName, error) => {
    phase(phaseName, { error: String(error?.message ?? error) })
    cleanupStaging()
    const restore = restoreOld({ dest, backup, hadDest })
    for (const s of restore.steps) console.log(`[release]   · ${s}`)
    report.restore = restore
    if (restore.ok) {
      phase('restore-ok', { oldManifest: restore.oldManifest })
      console.error(`切换失败，已恢复旧版本：${error?.message ?? error}`)
      report.exitCode = 1
    } else {
      phase('restore-failed', { failures: restore.failures, problems: restore.problems.slice(0, 10) })
      console.error('⚠ 切换失败，且**恢复没有完成**。请手动恢复：')
      console.error(`   1) 旧版本完整备份保留在：${backup}`)
      console.error(`   2) 删除 ${dest} 后，把上面那个备份复制成 ${dest}`)
      if (restore.failures.length > 0) console.error(`   失败原因：${restore.failures.join('；')}`)
      if (restore.problems.length > 0) console.error(`   旧 hash 核对未通过 ${restore.problems.length} 项：${restore.problems.slice(0, 5).join('；')}`)
      report.exitCode = 4
    }
    return report
  }

  try {
    try {
      renameSync(staging, dest)
    } catch (error) {
      const code = String(error?.code ?? '')
      if (!RENAME_FALLBACK_CODES.has(code)) throw error
      cpSync(staging, dest, { recursive: true })
      rmSync(staging, { recursive: true, force: true })
    }
  } catch (error) {
    return failAndRestore('switch-failed', error)
  }

  // ── 5) 校验正式目录与新清单一致 ─────────────────────────────────────────
  const destProblems = verifyDir(dest, files)
  if (destProblems.length > 0) {
    return failAndRestore('dest-verify-failed', new Error(`${destProblems.length} 项与清单不一致：${destProblems.slice(0, 5).join('；')}`))
  }

  writeFileSync(join(REPO, 'release.manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  phase('replaced', { fileCount: files.length, totalBytes: manifest.totalBytes, backup: hadDest ? backup : null })
  console.log(`已生成 ${files.length} 个文件 / ${manifest.totalBytes} 字节 → ${dest}`)
  if (hadDest) console.log(`恢复凭据保留在：${backup}`)
  return report
}

function check(dest) {
  const expected = releaseFiles()
  const missing = []
  const differing = []
  const extra = []
  for (const f of expected) {
    const target = join(dest, f.path.split('/').join(sep))
    if (!existsSync(target)) { missing.push(f.path); continue }
    const got = sha256(target)
    if (got !== f.sha256) differing.push({ path: f.path, expected: f.sha256, got })
  }
  // 反向：安装面里多出来的文件（排除 manifest 与备份）
  const seen = new Set(expected.map((f) => f.path))
  for (const rel of walk(dest)) {
    if (rel === 'release.manifest.json') continue
    if (!seen.has(rel)) extra.push(rel)
  }
  console.log(`期望 ${expected.length} 个文件；缺失 ${missing.length}，内容不同 ${differing.length}，多余 ${extra.length}`)
  for (const p of missing.slice(0, 30)) console.log('  MISSING', p)
  for (const d of differing.slice(0, 30)) console.log('  DIFF   ', d.path)
  for (const p of extra.slice(0, 30)) console.log('  EXTRA  ', p)
  return missing.length === 0 && differing.length === 0 && extra.length === 0
}

const args = process.argv.slice(2)
const toIdx = args.indexOf('--to')
const checkIdx = args.indexOf('--check')

if (checkIdx >= 0) {
  const dest = args[checkIdx + 1] ?? DEFAULT_INSTALL
  console.log(`校验安装面：${dest}`)
  process.exit(check(dest) ? 0 : 1)
}
const dest = toIdx >= 0 ? args[toIdx + 1] : join(REPO, 'release')
if (!dest) { console.error('--to 需要一个目录'); process.exit(2) }

// /任何字符串都不许直接进递归 rm —— 先过 realpath + 白名单。
const guard = guardDestination(dest, { repo: REPO })
if (!guard.ok) {
  console.error(`拒绝写入目标：${guard.reason}`)
  console.error(`  dest=${guard.dest}`)
  console.error(`  destPhysical=${guard.destPhysical}`)
  console.error(`  repo=${guard.evidence.repo} (physical ${guard.evidence.repoPhysical})`)
  console.error(`  nearestExisting=${guard.evidence.nearestExisting}  realpathApplied=${guard.evidence.realpathApplied}`)
  console.error('  未做任何删除或复制。')
  process.exit(2)
}

// 切换前再核一次身份：guard 与真正的写之间不允许链接被换掉。
const recheck = recheckDestination(guard)
if (!recheck.ok) {
  console.error(`拒绝写入目标：${recheck.reason}`)
  console.error('  未做任何删除或复制。')
  process.exit(2)
}

const report = writeRelease(guard)
process.exit(report.exitCode ?? 0)
