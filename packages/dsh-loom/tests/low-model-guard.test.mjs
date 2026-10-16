/**
 * 低配模型护栏（P2-9）：连续多次「候选校验未通过」后，给用户换更强模型的建议，
 * 并附一段可直接复制的修复指令。
 *
 * 这里只测两个纯函数（阈值判定 + 指令文本），不启浏览器：它们是面板渲染的输入，
 * 渲染本身在 browser-* 用例里以 DOM 断言覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

let loaded
const window = { __loomAllowTestHooks: true, __ModuleLoader__: { load: (x) => { loaded = x } } }
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window })
const ex = loaded.factory(() => ({}))
const { lowModelGuardText, lowModelGuardCommand, LOW_MODEL_GUARD_THRESHOLD } = ex

test('阈值是 2：一次失败不提示，连续两次才提示换模型', () => {
  assert.equal(LOW_MODEL_GUARD_THRESHOLD, 2)
  assert.equal(lowModelGuardText(0), '', '没失败过不提示')
  assert.equal(lowModelGuardText(1), '', '只失败一次可能是偶发手滑，不提示')
  assert.notEqual(lowModelGuardText(2), '', '连续两次要提示')
  assert.equal(lowModelGuardText(NaN), '', '计数不是数字时不提示')
  assert.equal(lowModelGuardText(undefined), '', '计数缺失时不提示')
})

test('提示文本说明原因、给出建议，并带上实际失败次数', () => {
  const two = lowModelGuardText(2)
  assert.match(two, /连续 2 次/)
  assert.match(two, /更强的模型/)
  const five = lowModelGuardText(5)
  assert.match(five, /连续 5 次/, '次数要跟着走')
})

test('修复指令包含 requestId 与最小必要字段要求，且能带上最近一次错误', () => {
  const text = lowModelGuardCommand('hash-abc', 'payload.nodes: 缺少 goal')
  assert.match(text, /hash-abc/)
  assert.match(text, /换用更强的模型/)
  assert.match(text, /required/)
  assert.match(text, /payload\.nodes: 缺少 goal/, '错误原文要带进指令')
  assert.match(lowModelGuardCommand('', ''), /\(未记录\)/)
})

test('修复指令会截断超长错误，避免粘贴一条几十 KB 的指令', () => {
  const huge = 'x'.repeat(5000)
  const text = lowModelGuardCommand('h', huge)
  assert.ok(text.length < 4000, '指令应被截断，实际 ' + text.length)
})
