#!/usr/bin/env node
/**
 * Laurel-Center · 发布产物**独立逐文件**校验（第三轮 E1）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * `lib/identity.js` 的 `buildHash` 是**清单声明**的指纹：它只把
 * `release.manifest.json` 里的 `path/sha256` 汇总一下，**不碰磁盘上的文件**。
 * 实测：把一份正确的清单复制到「缺大部分文件、package.json 也不同」的目录里，
 * `readBuildInfo()` 照样返回 `ok:true` 和同一个 buildHash。
 *
 * 所以身份能回答的是「这个实例读的是哪份清单」，**不是**「磁盘上的代码逐文件都对」。
 * 安装后要证明「新版真的落地了」，必须用这个脚本独立核一遍文件，
 * 再收集真实重启后的实例时间/ID、客户端加载与四插件状态 —— 光截图 v1.1.0
 * 或者只调一次 `identity()` 都不算。
 *
 *   node scripts/verify-release.mjs <目录> [--manifest <清单>] [--against <对照目录>]
 *
 *   · 默认读 `<目录>/release.manifest.json`
 *   · `--against <对照目录>`：再逐字节比对另一份目录（例如源码仓库）
 *   · 退出码 0 = 全部一致；1 = 有问题；2 = 用法
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** 目录下所有文件（相对路径，正斜杠）。 */
function walk(dir, base = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out.sort()
}

/**
 * 逐文件核验一个发布目录。
 * @param {{ dir: string, manifestPath?: string, against?: string }} options
 */
export function verifyRelease(options) {
  const dir = resolve(options.dir)
  const manifestPath = resolve(options.manifestPath ?? join(dir, 'release.manifest.json'))
  const problems = []
  const report = { dir, manifestPath, against: options.against ? resolve(options.against) : null, fileCount: 0, totalBytes: 0 }

  if (!existsSync(manifestPath)) {
    problems.push(`清单不存在：${manifestPath}`)
    return { ok: false, problems, report }
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    problems.push(`清单解析失败：${String(error?.message ?? error)}`)
    return { ok: false, problems, report }
  }
  const files = Array.isArray(manifest?.files) ? manifest.files : null
  if (files === null) {
    problems.push('清单里没有 files 数组')
    return { ok: false, problems, report }
  }
  report.fileCount = files.length
  report.totalBytes = manifest.totalBytes ?? null
  report.declared = { at: manifest.at ?? null, source: manifest.source ?? null, fileCount: manifest.fileCount ?? null, totalBytes: manifest.totalBytes ?? null }

  // 1) 清单声明的每个文件：存在 + hash 一致（+ 可选与对照目录一致）
  for (const f of files) {
    const target = join(dir, f.path.split('/').join(sep))
    if (!existsSync(target)) { problems.push(`缺失 ${f.path}`); continue }
    if (statSync(target).size !== f.size) problems.push(`大小不同 ${f.path}`)
    if (sha256(target) !== f.sha256) problems.push(`内容不同 ${f.path}`)
    if (report.against !== null) {
      const other = join(report.against, f.path.split('/').join(sep))
      if (!existsSync(other)) problems.push(`对照目录缺失 ${f.path}`)
      else if (sha256(other) !== f.sha256) problems.push(`与对照目录不同 ${f.path}`)
    }
  }

  // 2) 反向：目录里多出来的文件
  const declared = new Set(files.map((f) => f.path))
  for (const rel of walk(dir)) {
    if (rel === 'release.manifest.json') continue
    if (!declared.has(rel)) problems.push(`多余 ${rel}`)
  }

  // 3) 清单自身声明的文件数要和 files 长度一致
  if (Number.isInteger(manifest.fileCount) && manifest.fileCount !== files.length) {
    problems.push(`清单 fileCount=${manifest.fileCount} 与实际 ${files.length} 不符`)
  }

  report.problems = problems
  return { ok: problems.length === 0, problems, report }
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
function main(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'))
  const readFlag = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  const dir = positional[0]
  if (!dir) {
    console.error('用法：node scripts/verify-release.mjs <目录> [--manifest <清单>] [--against <对照目录>]')
    return 2
  }
  const result = verifyRelease({ dir, manifestPath: readFlag('--manifest'), against: readFlag('--against') })
  console.log(`独立逐文件校验：${result.report.dir}`)
  console.log(`  清单：${result.report.manifestPath}`)
  console.log(`  声明：${result.report.fileCount} 个文件 / ${result.report.totalBytes} 字节  at=${result.report.declared?.at ?? '-'}`)
  console.log(`  源码：${JSON.stringify(result.report.declared?.source ?? null)}`)
  if (result.report.against) console.log(`  对照目录：${result.report.against}`)
  if (result.ok) {
    console.log('  ✓ 全部文件存在、大小与 sha256 一致，没有多余文件')
    return 0
  }
  console.log(`  ✗ ${result.problems.length} 项不一致：`)
  for (const p of result.problems.slice(0, 40)) console.log('    -', p)
  return 1
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
if (invokedDirectly) process.exit(main(process.argv.slice(2)))
