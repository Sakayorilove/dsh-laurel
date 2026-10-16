/**
 * dsh-strata · 真人消息识别回归（补充评审 R9-B，P1）
 *
 * ── 钉住什么 ───────────────────────────────────────────────────────────
 * 旧代码用**黑名单**挑"用户消息"，只排除 `strata-memory` 与 `strata-nudge`。
 * 于是任何其他插件注入的 `role:'user'` 消息都会被当成"用户新提问"：
 *   - 被拿去做记忆召回的 query（越滚越偏）
 *   - 顶掉"一回合至多注入一次"的闸门
 *   - 参与跨工作区授权判断（这条最危险）
 *
 * 补充评审已复现两条反例，这里把它们变成常驻回归：
 *   ① 同批次「真人问题 → warden 提醒」 旧版选中 warden 提醒
 *   ② 同批次「真人问题 → loom-draft」  旧版选中 Loom 规划快照
 *
 * ── 判据来自宿主自己的合同 + 本机真实日志普查 ──────────────────────────
 * 实读 `dsh-llm` `createUserMessage()` / `dsh-subagent`（提交子代理 prompt 时
 * 写 `source: { kind: "user" }`）/ `createAssistantMessage()`（写
 * `source: { kind: "model", ... }`）：**`source.kind === 'user'` 就是真人输入**。
 *
 * 本机 25 个真实会话日志的 `user/message` source.kind 普查
 * （`docs/warden/scripts/extract-user-message-fixtures.sh` 产出
 * `tests/fixtures/real-user-message-sources.json`）：
 *   `user` 只有 44 条，而注入类合计 400+ 条、共 19 种 kind
 *   （time-context 79、team-message 73、tool-jobs 70、strata-memory 44、
 *     skill-catalog 34、compact-checkpoint 28、runtime-context 25、
 *     subagent-settled 23、agent-instructions 14、plugin:trisoul-x:* 33、
 *     user-approval 8、agent-message 4、goal 4、model-selection 3、
 *     loom-draft 2、tool-goal 1 ……）。
 * 注入约为真人的 10 倍，黑名单永远追不完 —— 所以本测试直接用**真实普查里
 * 出现过的全部 kind** 做输入，而不是自己编两三种。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  HUMAN_SOURCE_KIND, countHumanMessages, isHumanUserMessage, lastHumanIndex, latestHumanText,
} from '../lib/core/human.js'
import { lastUserIndex } from '../lib/core/pilot.js'

let passed = 0
let failed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { failed++; failures.push({ name, error }); console.log(`  ✗ ${name}\n      ${String(error?.message ?? error).split('\n').join('\n      ')}`) }
}

const HUMAN_TEXT = '修复插件等待上限'
const human = (text = HUMAN_TEXT) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const injected = (kind, text) => ({ role: 'user', source: { kind }, content: [{ type: 'text', text }] })

// 补充评审 compat-probes.json 里的两条原始反例
const WARDEN_NOTICE = '[warden] 同一个文件已经读了3次，回上下文找'
const LOOM_DRAFT = 'Loom规划快照：六个任务'

// 真实日志普查里出现过的全部注入 kind（不含 'user'）
const REAL_INJECTED_KINDS = [
  'time-context', 'team-message', 'tool-jobs', 'strata-memory', 'skill-catalog',
  'compact-checkpoint', 'runtime-context', 'subagent-settled', 'agent-instructions',
  'plugin:trisoul-x:trace', 'plugin:trisoul-x:tasks', 'plugin:trisoul-x:task-reminder',
  'plugin:trisoul-x:dream-memory', 'user-approval', 'agent-message', 'goal',
  'model-selection', 'loom-draft', 'tool-goal', 'strata-nudge', 'warden',
]

console.log('\n── R9-B · 真人消息识别 ─────────────────────────────────────')

test('夹具存在：真实日志的 source.kind 普查', () => {
  const file = join(import.meta.dirname, 'fixtures/real-user-message-sources.json')
  assert.ok(existsSync(file), `缺少 ${file}，先跑 docs/warden/scripts/extract-user-message-fixtures.sh`)
  const data = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(data.sourceKindCensus.length > 5, '普查样本太少，不足以证明黑名单不可行')
  const human = data.sourceKindCensus.find((r) => r.kind === 'user')
  assert.ok(human, '真实日志里没有 source.kind === "user"，宿主合同可能变了，需要重新核对')
  const injectedTotal = data.sourceKindCensus.filter((r) => r.kind !== 'user' && r.kind !== '(absent)')
    .reduce((sum, r) => sum + r.count, 0)
  assert.ok(injectedTotal > human.count, `注入消息（${injectedTotal}）应当多于真人消息（${human.count}），否则黑名单风险被夸大`)
})

test('反例①：真人问题 → warden 提醒，选中的必须是真人问题', () => {
  const messages = [human(), injected('warden', WARDEN_NOTICE)]
  assert.equal(latestHumanText(messages), HUMAN_TEXT, '选中了 warden 的提醒文案')
  assert.equal(lastHumanIndex(messages), 0)
})

test('反例②：真人问题 → loom-draft，选中的必须是真人问题', () => {
  const messages = [human(), injected('loom-draft', LOOM_DRAFT)]
  assert.equal(latestHumanText(messages), HUMAN_TEXT, '选中了 Loom 的规划快照')
})

test('真实普查里的每一种注入 kind 都不会被当成真人消息', () => {
  for (const kind of REAL_INJECTED_KINDS) {
    assert.equal(isHumanUserMessage(injected(kind, 'x')), false, `source.kind="${kind}" 被误判成真人消息`)
  }
})

test('用真实普查的全部 kind 混排，仍然只挑出真人那一条', () => {
  const messages = REAL_INJECTED_KINDS.map((kind, i) => injected(kind, `注入正文 ${i}`))
  messages.splice(7, 0, human('真正的问题在这里'))
  messages.push(...REAL_INJECTED_KINDS.slice(0, 5).map((kind) => injected(kind, '尾部注入')))
  assert.equal(latestHumanText(messages), '真正的问题在这里')
  assert.equal(lastHumanIndex(messages), 7)
  assert.equal(countHumanMessages(messages), 1)
})

test('source.kind === "user" 是唯一的真人判据', () => {
  assert.equal(HUMAN_SOURCE_KIND, 'user')
  assert.equal(isHumanUserMessage({ role: 'user', source: { kind: 'user' } }), true)
  assert.equal(isHumanUserMessage({ role: 'user', source: { kind: 'model' } }), false)
  assert.equal(isHumanUserMessage({ role: 'assistant', source: { kind: 'user' } }), false, 'role 不是 user 也算真人')
})

test('历史兼容：没有 source 的老消息按真人处理（不许重演"静默全丢"）', () => {
  // history.js 记着一次事故：曾用"有 source 就跳过"，结果真实日志里每条消息
  // 都带 source，导致 4 天 53 次加载 0 次注入。失败方向必须是"宁可多认"。
  assert.equal(isHumanUserMessage({ role: 'user', content: [{ type: 'text', text: '老格式' }] }), true)
  assert.equal(latestHumanText([{ role: 'user', content: '老格式字符串' }]), '老格式字符串')
  assert.equal(isHumanUserMessage({ role: 'user', source: {} }), true, 'source 存在但没有 kind 时应当保守按真人处理')
})

test('反例先红：旧的黑名单判据确实会选错（证明上面的断言不是恒真）', () => {
  // 把旧实现原样搬过来：只排除自家两种 kind
  const legacyLatestUserText = (messages) => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m?.role !== 'user') continue
      if (m.source?.kind === 'strata-memory' || m.source?.kind === 'strata-nudge') continue
      const c = m.content
      if (typeof c === 'string') return c
      if (!Array.isArray(c)) continue
      const t = c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n')
      if (t.length > 0) return t
    }
    return ''
  }
  // 补充评审 compat-probes.json 记录的两条真实反例，旧实现必须踩中
  assert.equal(legacyLatestUserText([human(), injected('warden', WARDEN_NOTICE)]), WARDEN_NOTICE,
    '旧实现在 warden 反例上没踩坑 —— 说明这条对照构造得不对')
  assert.equal(legacyLatestUserText([human(), injected('loom-draft', LOOM_DRAFT)]), LOOM_DRAFT,
    '旧实现在 loom-draft 反例上没踩坑 —— 说明这条对照构造得不对')
  // 新实现必须修好这两条
  assert.equal(latestHumanText([human(), injected('warden', WARDEN_NOTICE)]), HUMAN_TEXT)
  assert.equal(latestHumanText([human(), injected('loom-draft', LOOM_DRAFT)]), HUMAN_TEXT)
  // 旧实现在真实普查的 kind 面前错得有多离谱：数一下
  const wrong = REAL_INJECTED_KINDS.filter((kind) => legacyLatestUserText([human(), injected(kind, 'x')]) !== HUMAN_TEXT)
  assert.ok(wrong.length >= REAL_INJECTED_KINDS.length - 2,
    `旧实现只挡住了自家两种 kind，其余 ${wrong.length} 种全会误判`)
})

test('pilot.lastUserIndex 与 human.js 口径一致（不再有第二套黑名单）', () => {
  const messages = [human('第一句'), injected('warden', WARDEN_NOTICE), injected('loom-draft', LOOM_DRAFT)]
  assert.equal(lastUserIndex(messages), 0, 'pilot 仍在用旧黑名单')
  assert.equal(lastUserIndex(messages), lastHumanIndex(messages))
})

test('countHumanMessages 不被注入消息顶掉闸门', () => {
  const base = [human('问一句')]
  assert.equal(countHumanMessages(base), 1)
  // 加十条注入，真人条数不变 ⇒ "一回合至多注入一次"的闸门不会被顶掉
  const withInjected = [...base, ...REAL_INJECTED_KINDS.slice(0, 10).map((k) => injected(k, 'x'))]
  assert.equal(countHumanMessages(withInjected), 1)
  // 真人真的又说了一句，才该 +1
  assert.equal(countHumanMessages([...withInjected, human('再问一句')]), 2)
})

test('latestHumanText 跳过空文本的真人消息，取最近一条有内容的', () => {
  const messages = [
    human('早先的问题'),
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', data: 'AA' }] },
    injected('warden', WARDEN_NOTICE),
  ]
  assert.equal(latestHumanText(messages), '早先的问题')
})

test('找不到真人消息时返回空串，不退回注入内容', () => {
  const messages = REAL_INJECTED_KINDS.map((kind) => injected(kind, 'x'))
  assert.equal(latestHumanText(messages), '')
  assert.equal(lastHumanIndex(messages), -1)
  assert.equal(countHumanMessages(messages), 0)
})

test('非数组 / 空输入不抛', () => {
  assert.equal(latestHumanText(undefined), '')
  assert.equal(latestHumanText(null), '')
  assert.equal(lastHumanIndex([]), -1)
  assert.equal(countHumanMessages(undefined), 0)
  assert.equal(isHumanUserMessage(null), false)
})

console.log(`\n${'='.repeat(58)}`)
console.log(`R9-B 真人消息识别：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  for (const f of failures) console.log(`  ✗ ${f.name}`)
  process.exit(1)
}
process.exit(0)
