/**
 * Loom · 测试运行器
 *
 * ── 它要解决的两件事 ─────────────────────────────────────────────────────
 * 1. **一个文件崩掉不该带走整轮**。原来的写法是「跑一个、失败就 break」，
 *    而宿主相关的测试文件会在**加载期**抛（createRequire 一个不存在的锚点），
 *    于是后面所有文件根本没跑，却看起来像「测过了」。现在每个文件都跑完，
 *    失败的输出照打，最后统一汇总。
 *
 * 2. **独立单元测试与需要宿主的集成测试要分开报**（2026-10-13 的反馈）。
 *    没有本机 DSH 宿主时，宿主相关的用例会自己 skip（原因见
 *    `scripts/host-anchor.mjs` 的 `hostSkipReason`），但那**不是通过** ——
 *    所以这里会显式打出「跳过了哪些、为什么」，并写进 results.json。
 *    想让缺宿主直接失败（CI 的集成任务）：加 `--require-host`。
 *
 * 用法：
 *   node scripts/run-tests.mjs                # 单元测试 + 宿主测试（宿主缺失则 skip）
 *   node scripts/run-tests.mjs --browser      # 额外跑浏览器用例
 *   node scripts/run-tests.mjs --require-host # 没有宿主就算失败
 *   node scripts/run-tests.mjs --keep-going   # 失败也继续跑后面的文件（默认就继续；留作显式表达）
 *
 * 结论有三种（见文件末）：`pass` / `partial`（宿主集成用例被跳过，**不算通过**）/ `fail`。
 * 结果：`.verification/results.json` + 每个文件一份 `.log`。
 */
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { hostAnchor, hasHost, hostSkipReason } from './host-anchor.mjs'

const root = resolve(import.meta.dirname, '..')
const browser = process.argv.includes('--browser')
const requireHost = process.argv.includes('--require-host')

/**
 * 需要**本机 DSH 宿主**的测试文件（显式清单，不靠猜）。
 * 这些文件里的相关用例用 `hostTest` 注册：没有宿主就 skip 并打印准备步骤。
 */
const HOST_REQUIRED = new Set([
  'approval-progress.test.mjs',
  'commands.test.mjs',
  'structured-dispatch.test.mjs',
  'wsl-fs.test.mjs',
  'remote-host.test.mjs',
  'preflight-resolution.test.mjs',
  'recovery-command.test.mjs',
  'history-diagnostics.test.mjs',
  'planning-gate.test.mjs',
  'wsl-shell.test.mjs',
  'host-helpers.test.mjs',
])

const files = readdirSync(resolve(root, 'tests'))
  .filter((f) => f.endsWith('.test.mjs') && (browser || !f.startsWith('browser-')))
  .sort()
const targets = [...files, 'installed.mjs', 'client.mjs']

console.log(`# dsh-loom 测试`)
console.log(`  宿主锚点：${hostAnchor ?? '（未找到 —— 需要宿主的用例会 skip）'}`)
if (!hasHost) console.log(`  ⚠ ${hostSkipReason}`)

const results = []
mkdirSync(resolve(root, '.verification'), { recursive: true })
for (const file of targets) {
  const hostDependent = HOST_REQUIRED.has(file) || file.startsWith('browser-')
  const result = spawnSync(process.execPath, ['tests/' + file], { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024, env: process.env })
  const output = (result.stdout || '') + (result.stderr || '')
  writeFileSync(resolve(root, '.verification', file + '.log'), output)
  const counts = Object.fromEntries([...output.matchAll(/(?:ℹ |# )(tests|pass|fail|skipped)\s+(\d+)/g)].map((m) => [m[1], Number(m[2])]))
  const checks = /(?:通过|全部通过)（(\d+) 项）/.exec(output)
  if (checks) counts.checks = Number(checks[1])
  const skippedAll = (counts.tests ?? 0) > 0 && counts.skipped === counts.tests
  results.push({ file, hostDependent, exitCode: result.status, signal: result.signal, counts, skippedAll, error: result.error?.message })
  const verdict = result.status === 0 ? (skippedAll ? 'SKIP(no host)' : 'PASS') : 'FAIL'
  console.log(`${file}: ${verdict}${Object.keys(counts).length ? ' ' + JSON.stringify(counts) : ''}`)
  if (result.status !== 0) console.error(output.slice(-10000))
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
const hostSkipped = results.filter((r) => r.hostDependent && (r.skippedAll || (r.counts.skipped ?? 0) > 0))
const failed = results.filter((r) => r.exitCode !== 0)
// 浏览器文件多跑一轮就为了「真的跑了」：全跳过不算过。
const browserNotRun = results.filter((r) => r.file.startsWith('browser-') && ((r.counts.skipped ?? 0) > 0 || (r.counts.tests ?? 0) === 0))

/*
 * 三种结论，不是两种 —— 「跑过但没全验」必须能和「全绿」「真失败」分开：
 *   pass    所有用例真的执行并通过（含浏览器用例），且没有跳过任何宿主集成用例
 *   partial 单元用例通过，但宿主集成用例被跳过 → **不算通过**，也不是失败。
 *           默认退出 0，免得没装宿主的开发机本地跑不动；CI 的集成任务加
 *           `--require-host` 把它变成 fail。
 *   fail    有用例失败 / 浏览器用例没真跑 / `--require-host` 但本机没宿主。
 */
const verdict = failed.length > 0 || browserNotRun.length > 0 || (requireHost && !hasHost)
  ? 'fail'
  : hostSkipped.length > 0 ? 'partial' : 'pass'

if (hostSkipped.length > 0) {
  console.log(`\n⚠ 宿主集成用例被跳过（**不算通过**，结论为 partial）：${hostSkipped.map((r) => r.file).join('、')}`)
  console.log(`  原因：${hasHost ? '该文件内部分用例需要宿主，已按 skip 报告' : hostSkipReason}`)
  if (!requireHost) console.log('  想让跳过直接算失败：加 --require-host')
}
if (failed.length > 0) console.log(`\n失败 ${failed.length} 个文件：${failed.map((r) => r.file).join('、')}`)
if (browserNotRun.length > 0) console.log(`\n浏览器用例没有真跑（按失败处理）：${browserNotRun.map((r) => r.file).join('、')}`)
if (requireHost && !hasHost) console.log('\n--require-host：本机没有可用宿主，按失败处理。')

writeFileSync(resolve(root, '.verification', 'results.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  browser,
  requireHost,
  hostAnchor,
  hostAvailable: hasHost,
  hostSkipped: hostSkipped.map((r) => r.file),
  verdict,
  passed: verdict === 'pass',
  results,
}, null, 2) + '\n')
console.log(verdict === 'pass'
  ? '\n全部通过'
  : verdict === 'partial'
    ? '\n未全验：单元用例通过，宿主集成用例被跳过（不算通过）'
    : '\n未通过')
process.exitCode = verdict === 'fail' ? 1 : 0
