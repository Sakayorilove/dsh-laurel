/**
 * Loom · 测试报告的机器可读断言（CI 用，也可本地跑）
 *
 * 读 `.verification/results.json`（`scripts/run-tests.mjs` 产出）并断言三件事：
 *
 *   1. **没有任何测试文件是崩着结束的**（`exitCode !== 0`）。
 *      2026-10-13 的那一类事故就是这一种：宿主锚点写死成一个不存在的路径，
 *      文件在**模块加载期**就抛；当时的运行器「失败即 break」，
 *      于是后面几十个文件根本没跑，却看起来像「测过了」。
 *
 *   2. **本机有宿主 → 结论必须是 `pass`**：不许还有跳过的宿主用例。
 *
 *   3. **本机没有宿主 → 结论必须是 `partial`，且 `hostSkipped` 必须列出**
 *      跳过了哪些文件。评审要求「不能默默全部跳过」，所以「什么都没报」也算失败。
 *
 * 用法：
 *   node scripts/run-tests.mjs && node scripts/check-test-report.mjs
 *   node scripts/run-tests.mjs --browser && node scripts/check-test-report.mjs
 *
 * 退出码：0 报告如实 / 1 报告有问题 / 2 没有报告可读（先跑 run-tests.mjs）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPORT = join(ROOT, '.verification', 'results.json')

if (!existsSync(REPORT)) {
  console.error(`  ✗ 找不到测试报告：${REPORT}`)
  console.error('    先跑：node scripts/run-tests.mjs   （或 npm test）')
  process.exit(2)
}

let report
try {
  report = JSON.parse(readFileSync(REPORT, 'utf8'))
} catch (error) {
  console.error(`  ✗ 测试报告不是合法 JSON：${error.message}`)
  process.exit(1)
}

let fail = 0
const ok = (name, cond, extra = '') => {
  console.log(cond ? `  ✓ ${name}` : `  ✗ ${name}${extra ? '  → ' + extra : ''}`)
  if (!cond) fail += 1
}

const results = Array.isArray(report.results) ? report.results : []
const crashed = results.filter((r) => r.exitCode !== 0)
const ran = results.filter((r) => !r.file.startsWith('browser-') || report.browser)

console.log(`Loom 测试报告断言 · ${REPORT}`)
console.log(`  生成于 ${report.generatedAt} · 宿主 ${report.hostAvailable ? report.hostAnchor : '（没有）'} · 结论 ${report.verdict}`)

ok('报告里每个文件都跑完（没有在加载期崩掉的文件）', crashed.length === 0,
  crashed.map((r) => `${r.file}(exit=${r.exitCode})`).join('、'))
ok('跑过的文件数 > 0（报告不是空的）', ran.length > 0, `共 ${results.length} 条`)
ok('浏览器用例没有被静默跳过', !report.browser || report.results.filter((r) => r.file.startsWith('browser-')).every((r) => (r.counts.tests ?? 0) > 0))

if (report.hostAvailable) {
  ok('本机有宿主 → 结论是 pass（没有跳过的宿主用例）', report.verdict === 'pass' && report.passed === true,
    `verdict=${report.verdict} · 跳过 ${JSON.stringify(report.hostSkipped)}`)
} else {
  ok('本机没有宿主 → 结论是 partial（不是 pass）', report.verdict === 'partial', `verdict=${report.verdict}`)
  ok('跳过的宿主文件被逐个列出（不是默默全跳过）',
    Array.isArray(report.hostSkipped) && report.hostSkipped.length > 0,
    JSON.stringify(report.hostSkipped))
  if (report.hostSkipped?.length) console.log(`    跳过的文件：${report.hostSkipped.join('、')}`)
  console.log('    想让跳过直接算失败：node scripts/run-tests.mjs --require-host')
}

console.log(fail === 0 ? '\n报告如实' : `\n报告有问题（${fail} 项）`)
process.exit(fail === 0 ? 0 : 1)
