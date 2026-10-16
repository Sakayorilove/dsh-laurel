/**
 * dsh-strata · 上下文领航测试
 *
 * 覆盖这一层新加的东西（借自 ACP / acp-kernel 的做法）：
 *   1. 增长式提醒的判据（**与窗口大小无关**，只看"长大了多少"）
 *   2. 压缩禁区识别（宿主会重新注入的东西，压了等于白压）
 *   3. 已核实台账（文件一改就自动失效——这是它有没有用的分水岭）
 *   4. 折叠经济学（拿不到宿主数字时**必须报 null**，绝不用自己的估算冒充）
 *   5. 注入路径端到端：提醒**只追加**、放在最末、且与记忆注入开关解耦
 *
 * 跑法：
 *   node tests/context-pilot.mjs
 *
 * ── 为什么这些断言值得存在 ─────────────────────────────────────────────
 * 这一层的失败模式全是**静默**的：提醒没追加进去只是"没省到钱"，不会报错；
 * 台账不比对 mtime 只会让模型读到过期结论，也不报错。所以每条都要钉死。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, normalizeConfig } from '../lib/core/config.js'
import {
  NUDGE_SOURCE_KIND, SUMMARY_FRAME, barrierLabels, foldEconomics, growthDecision,
  isBarrier, lastUserIndex, renderNudge,
} from '../lib/core/pilot.js'
import { forgetVerified, listVerified, markVerified, normalizePath, verifiedLabels, verifiedStats } from '../lib/core/verified.js'
import { installInjection } from '../lib/host/inject.js'

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    process.stdout.write(`  ✓ ${name}\n`)
  } catch (error) {
    failed++
    failures.push({ name, error })
    process.stdout.write(`  ✗ ${name}\n      ${error.message}\n`)
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed++
    process.stdout.write(`  ✓ ${name}\n`)
  } catch (error) {
    failed++
    failures.push({ name, error })
    process.stdout.write(`  ✗ ${name}\n      ${error.message}\n`)
  }
}

/** 造一个临时 home，隔离所有落盘。 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'strata-pilot-'))
  return { home, cleanup: () => { try { rmSync(home, { recursive: true, force: true }) } catch { /* 无所谓 */ } } }
}

const msg = (kind, text, role = 'user') => ({ role, source: kind ? { kind } : undefined, content: [{ type: 'text', text }] })

/* ------------------------------------------------------------------ *
 * 1. 配置
 * ------------------------------------------------------------------ */

process.stdout.write('\n配置\n')

test('新键都在默认值里，而且默认是保守的', () => {
  assert.equal(DEFAULT_CONFIG.contextNudge, true)
  assert.equal(DEFAULT_CONFIG.contextNudgeGrowthTokens, 50000)
  assert.equal(DEFAULT_CONFIG.contextNudgeMinTokens, 20000)
  assert.equal(DEFAULT_CONFIG.verifiedLedger, true)
})

test('normalizeConfig：布尔只认布尔，数值夹到区间', () => {
  const out = normalizeConfig({ contextNudge: 'yes', verifiedLedger: false, contextNudgeGrowthTokens: 1, contextNudgeMinTokens: 10 ** 9 })
  // 字符串不是布尔 ⇒ 保留默认 true（不能把 'yes' 当成 true，这是宿主配置三个来处的老坑）
  assert.equal(out.contextNudge, true)
  assert.equal(out.verifiedLedger, false)
  assert.equal(out.contextNudgeGrowthTokens, 2000)   // 下限
  assert.equal(out.contextNudgeMinTokens, 500000)    // 上限
})

test('normalizeConfig 不吃未知键，也不丢已知键', () => {
  const out = normalizeConfig({ totallyUnknown: 1, contextNudge: false })
  assert.equal(out.contextNudge, false)
  assert.ok(!('totallyUnknown' in out))
})

/* ------------------------------------------------------------------ *
 * 2. 增长判据
 * ------------------------------------------------------------------ */

process.stdout.write('\n增长式触发（与窗口无关）\n')

test('关掉就是关掉', () => {
  assert.equal(growthDecision(10 ** 6, 0, { contextNudge: false }).due, false)
})

test('低于地板不提醒（短会话不刷屏）', () => {
  const v = growthDecision(15000, 0, { contextNudgeMinTokens: 20000, contextNudgeGrowthTokens: 5000 })
  assert.equal(v.due, false)
  assert.equal(v.reason, 'below-floor')
})

test('长不够步长不提醒', () => {
  const v = growthDecision(100000, 80000, { contextNudgeMinTokens: 20000, contextNudgeGrowthTokens: 50000 })
  assert.equal(v.due, false)
  assert.equal(v.reason, 'not-grown-enough')
  assert.equal(v.growth, 20000)
})

test('长够了就提醒，growth 如实给出', () => {
  const v = growthDecision(130000, 80000, { contextNudgeMinTokens: 20000, contextNudgeGrowthTokens: 50000 })
  assert.equal(v.due, true)
  assert.equal(v.growth, 50000)
})

test('**关键**：42 万 token 的会话必须提醒（这正是宿主 80% 线不管的场景）', () => {
  // 1M 窗口的 80% 是 80 万；本机实测长会话最高 42 万 ⇒ 宿主压缩从不触发。
  const v = growthDecision(420000, 200000, DEFAULT_CONFIG)
  assert.equal(v.due, true)
})

test('上下文变小 ⇒ 重新起算，不拿旧水位比', () => {
  const v = growthDecision(90000, 300000, DEFAULT_CONFIG)
  assert.equal(v.due, false)
  assert.equal(v.reason, 'reset')
})

/* ------------------------------------------------------------------ *
 * 3. 压缩禁区
 * ------------------------------------------------------------------ */

process.stdout.write('\n压缩禁区\n')

test('策略文件 / 技能目录 / 宿主上下文行 都在禁区里', () => {
  assert.equal(isBarrier(msg('agent-instructions', '# 规矩')), true)
  assert.equal(isBarrier(msg('skill-catalog', 'available')), true)
  assert.equal(isBarrier(msg('runtime-context', '...')), true)
  assert.equal(isBarrier(msg('time-context', '...')), true)
  assert.equal(isBarrier(msg('strata-memory', '资料')), true)
  assert.equal(isBarrier(msg(NUDGE_SOURCE_KIND, '提醒')), true)
})

test('别的插件注入（plugin:<名>:<用途>）也算禁区——不与别的插件打架', () => {
  assert.equal(isBarrier(msg('plugin:whale-widget:panel', 'x')), true)
})

test('source 缺失时靠正文标记兜底认出技能目录', () => {
  assert.equal(isBarrier({ role: 'user', content: [{ type: 'text', text: '<available_skills>\n- a\n' }] }), true)
})

test('普通消息不是禁区', () => {
  assert.equal(isBarrier(msg('user', '帮我看看这个')), false)
  assert.equal(isBarrier({ role: 'assistant', content: [{ type: 'text', text: '好' }] }), false)
})

test('最新一条真人消息受保护，更早的不受', () => {
  const list = [msg('user', '第一句'), msg('model', '答'), msg('user', '第二句')]
  const last = lastUserIndex(list)
  assert.equal(last, 2)
  assert.equal(isBarrier(list[2], { index: 2, lastUserIndex: last }), true)
  assert.equal(isBarrier(list[0], { index: 0, lastUserIndex: last }), false)
})

test('lastUserIndex 跳过本插件自己的两类注入', () => {
  const list = [msg('user', '真话'), msg('strata-memory', '资料'), msg(NUDGE_SOURCE_KIND, '提醒')]
  assert.equal(lastUserIndex(list), 0)
})

test('barrierLabels 会点名禁区，且在需要时带上"最新一条用户消息"', () => {
  const list = [msg('agent-instructions', '# 规矩'), msg('skill-catalog', '目录'), msg('user', '真话')]
  const labels = barrierLabels(list)
  assert.ok(labels.some((l) => l.includes('策略文件')))
  assert.ok(labels.some((l) => l.includes('技能目录')))
  assert.ok(labels.some((l) => l.includes('最新一条用户消息')))
})

test('没有禁区时 bar 列表为空（提醒里就不会出现那句话）', () => {
  assert.deepEqual(barrierLabels([msg('user', '只说一句话')]).length, 1) // 它自己就是最新用户消息
  assert.deepEqual(barrierLabels([]), [])
})

/* ------------------------------------------------------------------ *
 * 4. 提醒正文
 * ------------------------------------------------------------------ */

process.stdout.write('\n提醒正文\n')

test('带标源框、带数字、带禁区与已核实清单', () => {
  const body = renderNudge({ usedTokens: 420000, growthTokens: 52000, barriers: ['策略文件（AGENTS.md 等）'], verified: ['a.cpp', 'b.h'] })
  assert.ok(body.startsWith('<strata-nudge>'))
  assert.ok(body.includes(SUMMARY_FRAME))
  assert.ok(body.includes('420,000'))
  assert.ok(body.includes('52,000'))
  assert.ok(body.includes('AGENTS.md'))
  assert.ok(body.includes('a.cpp'))
  assert.ok(body.trimEnd().endsWith('</strata-nudge>'))
})

test('**必须短**：它会被后续每一步重发', () => {
  const body = renderNudge({ usedTokens: 420000, growthTokens: 52000, barriers: ['策略文件（AGENTS.md 等）', '技能目录'], verified: ['a.cpp'] })
  assert.ok(body.length < 600, `提醒正文 ${body.length} 字符，太长了`)
})

test('没有已核实清单就不出现那一行', () => {
  const body = renderNudge({ usedTokens: 100000, growthTokens: 50000 })
  assert.ok(!body.includes('已核实'))
})

test('可以关掉标源框', () => {
  const body = renderNudge({ usedTokens: 100000, growthTokens: 50000, frame: false })
  assert.ok(!body.includes(SUMMARY_FRAME))
})

/* ------------------------------------------------------------------ *
 * 5. 折叠经济学（拿不到就报 null，绝不编）
 * ------------------------------------------------------------------ */

process.stdout.write('\n折叠经济学\n')

test('宿主没报数 ⇒ 全是 null，不编', () => {
  const f = foldEconomics({})
  assert.equal(f.usedTokens, null)
  assert.equal(f.cacheReadTokens, null)
  assert.equal(f.hitRate, null)
  assert.equal(f.healthy, null)
  assert.ok(f.note.includes('未上报'))
})

test('正常样本算出命中率并判定健康', () => {
  const f = foldEconomics({ usedTokens: 400000, cacheReadTokens: 380000, cacheWriteTokens: 0, freshInputTokens: 1000 })
  assert.equal(f.hitRate, 0.95)
  assert.equal(f.healthy, true)
})

test('命中率低于 95% 时给出归因提示，而不是下结论', () => {
  const f = foldEconomics({ usedTokens: 400000, cacheReadTokens: 200000, freshInputTokens: 200000 })
  assert.ok(f.hitRate < 0.95)
  assert.equal(f.healthy, false)
  assert.ok(f.note.includes('TTL'))
})

/* ------------------------------------------------------------------ *
 * 6. 已核实台账
 * ------------------------------------------------------------------ */

process.stdout.write('\n已核实台账\n')

test('normalizePath 统一分隔符与大小写', () => {
  assert.equal(normalizePath('D:\\A\\B\\'), 'd:/a/b')
  assert.equal(normalizePath('/home/x/y/'), '/home/x/y')
  assert.equal(normalizePath(''), '')
})

test('记账 → 列出 → 文件被改就自动失效（这是它有没有用的分水岭）', () => {
  const { home, cleanup } = makeHome()
  try {
    const file = join(home, 'sample.txt')
    writeFileSync(file, 'v1')
    const marked = markVerified(home, 'D:/ws', file)
    assert.equal(marked.ok, true, JSON.stringify(marked))
    assert.equal(listVerified(home, 'D:/ws').length, 1)

    // 文件改了 ⇒ 旧结论作废
    writeFileSync(file, 'v2-longer')
    assert.equal(listVerified(home, 'D:/ws').length, 0)
    const stats = verifiedStats(home, 'D:/ws')
    assert.equal(stats.recorded, 1)
    assert.equal(stats.live, 0)
    assert.equal(stats.stale, 1)
  } finally { cleanup() }
})

test('不存在的文件不记账——记了只会误导后续回合', () => {
  const { home, cleanup } = makeHome()
  try {
    const r = markVerified(home, 'D:/ws', join(home, 'nope.txt'))
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'not-readable')
    assert.equal(listVerified(home, 'D:/ws').length, 0)
  } finally { cleanup() }
})

test('工作区隔离：A 的台账不会漏到 B', () => {
  const { home, cleanup } = makeHome()
  try {
    const file = join(home, 'a.txt')
    writeFileSync(file, 'x')
    markVerified(home, 'D:/ws-a', file)
    assert.equal(listVerified(home, 'D:/ws-a').length, 1)
    assert.equal(listVerified(home, 'D:/ws-b').length, 0)
  } finally { cleanup() }
})

test('forget 单独移除一条', () => {
  const { home, cleanup } = makeHome()
  try {
    const file = join(home, 'a.txt')
    writeFileSync(file, 'x')
    markVerified(home, 'D:/ws', file)
    assert.equal(forgetVerified(home, 'D:/ws', file), true)
    assert.equal(listVerified(home, 'D:/ws').length, 0)
    assert.equal(forgetVerified(home, 'D:/ws', file), false)
  } finally { cleanup() }
})

test('台账坏了也不抛——读取路径上不许冒泡', () => {
  const { home, cleanup } = makeHome()
  try {
    writeFileSync(join(home, 'verified.json'), '{ this is not json')
    assert.deepEqual(listVerified(home, 'D:/ws'), [])
    assert.equal(markVerified(home, 'D:/ws', join(home, 'whatever.txt')).ok, false)
  } finally { cleanup() }
})

test('verifiedLabels 只给文件名（这段每轮重发，路径前缀是纯浪费）', () => {
  const { home, cleanup } = makeHome()
  try {
    const dir = join(home, 'deep')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'thing.cpp')
    writeFileSync(file, 'x')
    markVerified(home, 'D:/ws', file)
    assert.deepEqual(verifiedLabels(home, 'D:/ws'), ['thing.cpp'])
  } finally { cleanup() }
})

/* ------------------------------------------------------------------ *
 * 7. 注入路径端到端
 * ------------------------------------------------------------------ */

process.stdout.write('\n注入路径（端到端）\n')

/** 造一个最小的宿主替身：只为跑通 pre-step，不需要任何真实服务。 */
function makeHarness(configPatch = {}) {
  const { home, cleanup } = makeHome()
  const listeners = new Map()
  const ctx = {
    on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) },
    off: (name) => listeners.delete(name),
  }
  const config = normalizeConfig({ injectSection: false, ...configPatch }, DEFAULT_CONFIG)
  const deps = {
    store: { live: () => [], get: () => null, stats: () => ({}) },
    ledger: { active: () => [] },
    history: { search: async () => ({ hits: [], stats: {} }) },
    config: () => config,
    home,
    sessionQuery: () => null,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  }
  const dispose = installInjection(ctx, deps)
  return { home, config, listeners, deps, dispose, cleanup }
}

/**
 * 让宿主"上报"上一次请求的用量。
 *
 * ⚠ 走 `session/event`，不是 `llm/stream`。综合评审 R2 已证实：
 * `llm/stream` 的回调入参是**请求 options**，usage 只存在于 `next()` 返回的
 * chunk 流里，所以旧版从这里一个 usage 也采不到（提醒从未真正触发）。
 * 现在按官方 `dsh-token-meter` 的 `usageOf()` 口径从持久化事件里取。
 */
let usageStep = 0
function reportUsage(listeners, sessionId, usage) {
  const fn = listeners.get('session/event')
  assert.equal(typeof fn, 'function', 'session/event 监听没挂上')
  usageStep += 1
  // step 递增，避免被"同 (turn,step) 按替换处理"的去重口径吃掉
  return fn(
    { id: sessionId, header: { cwd: 'D:/ws' }, seq: usageStep },
    { type: 'assistant/message', seq: usageStep, time: Date.now(), data: { turn: 1, step: usageStep, usage } },
  )
}

async function runPreStep(listeners, payload) {
  const fn = listeners.get('agent/pre-step')
  assert.equal(typeof fn, 'function', 'agent/pre-step 监听没挂上')
  return fn(payload, async () => ({ kind: 'enter', messages: payload.messages }))
}

const userTurn = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const agentPayload = (messages) => ({ agent: { session: { id: 's1', header: { cwd: 'D:/ws' } } }, messages, step: 3 })

await testAsync('拿不到宿主用量 ⇒ 一条都不追加（绝不用自己的估算冒充）', async () => {
  const h = makeHarness()
  try {
    const payload = agentPayload([userTurn('看看这个项目')])
    const out = await runPreStep(h.listeners, payload)
    assert.equal(out.messages.length, 1)
  } finally { h.cleanup() }
})

await testAsync('水位不到地板 ⇒ 不追加', async () => {
  const h = makeHarness({ contextNudgeMinTokens: 100000 })
  try {
    reportUsage(h.listeners, 's1', { totalTokens: 30000, cacheReadTokens: 28000, inputTokens: 500, outputTokens: 200 })
    const payload = agentPayload([userTurn('看看这个项目')])
    const out = await runPreStep(h.listeners, payload)
    assert.equal(out.messages.filter((m) => m.source?.kind === NUDGE_SOURCE_KIND).length, 0)
  } finally { h.cleanup() }
})

await testAsync('长够了 ⇒ 追加一条提醒，且**追加在最后**', async () => {
  const h = makeHarness({ contextNudgeMinTokens: 1000, contextNudgeGrowthTokens: 1000 })
  try {
    reportUsage(h.listeners, 's1', { totalTokens: 250000, cacheReadTokens: 240000, inputTokens: 2000, outputTokens: 300 })
    const payload = agentPayload([userTurn('看看这个项目')])
    const out = await runPreStep(h.listeners, payload)
    const nudges = out.messages.filter((m) => m.source?.kind === NUDGE_SOURCE_KIND)
    assert.equal(nudges.length, 1)
    assert.equal(out.messages[out.messages.length - 1].source.kind, NUDGE_SOURCE_KIND)
    assert.ok(nudges[0].content[0].text.includes('242,000'))
  } finally { h.cleanup() }
})

await testAsync('同一个用户回合内不重复追加（一回合至多一次）', async () => {
  const h = makeHarness({ contextNudgeMinTokens: 1000, contextNudgeGrowthTokens: 1 })
  try {
    reportUsage(h.listeners, 's1', { inputTokens: 250000, outputTokens: 0 })
    const first = agentPayload([userTurn('看看这个项目')])
    const out1 = await runPreStep(h.listeners, first)
    // 第二轮步：消息里已经有提醒了，但"真实用户消息条数"没变 ⇒ 不该再加
    const second = agentPayload(out1.messages)
    const out2 = await runPreStep(h.listeners, second)
    assert.equal(out2.messages.filter((m) => m.source?.kind === NUDGE_SOURCE_KIND).length, 1)
  } finally { h.cleanup() }
})

await testAsync('提醒**只增不改**：下一轮不会把上一条撤掉（保住前缀缓存）', async () => {
  const h = makeHarness({ contextNudgeMinTokens: 1000, contextNudgeGrowthTokens: 1000 })
  try {
    reportUsage(h.listeners, 's1', { inputTokens: 200000, outputTokens: 0 })
    const out1 = await runPreStep(h.listeners, agentPayload([userTurn('第一句')]))
    const nudge1 = out1.messages.find((m) => m.source?.kind === NUDGE_SOURCE_KIND)
    assert.ok(nudge1)

    // 用户说了新的一句，上下文继续长 ⇒ 该再加一条，但旧的那条必须原样留着
    reportUsage(h.listeners, 's1', { inputTokens: 260000, outputTokens: 0 })
    const out2 = await runPreStep(h.listeners, agentPayload([...out1.messages, userTurn('第二句')]))
    const nudges = out2.messages.filter((m) => m.source?.kind === NUDGE_SOURCE_KIND)
    assert.equal(nudges.length, 2)
    assert.equal(nudges[0].id, nudge1.id, '旧的提醒被换掉了——前缀缓存会作废')
  } finally { h.cleanup() }
})

await testAsync('上下文被压缩变小 ⇒ 重新起算，不立刻再提醒', async () => {
  const h = makeHarness({ contextNudgeMinTokens: 1000, contextNudgeGrowthTokens: 1000 })
  try {
    reportUsage(h.listeners, 's1', { inputTokens: 400000, outputTokens: 0 })
    const out1 = await runPreStep(h.listeners, agentPayload([userTurn('第一句')]))
    assert.equal(out1.messages.filter((m) => m.source?.kind === NUDGE_SOURCE_KIND).length, 1)

    // 宿主压缩后水位掉回 12 万 ⇒ 不提醒，并且水位被重置
    reportUsage(h.listeners, 's1', { inputTokens: 120000, outputTokens: 0 })
    const out2 = await runPreStep(h.listeners, agentPayload([...out1.messages, userTurn('第二句')]))
    assert.equal(out2.messages.filter((m) => m.source?.kind === NUDGE_SOURCE_KIND).length, 1)
  } finally { h.cleanup() }
})

await testAsync('关掉领航 ⇒ 一条都不追加', async () => {
  const h = makeHarness({ contextNudge: false, contextNudgeMinTokens: 0, contextNudgeGrowthTokens: 1 })
  try {
    reportUsage(h.listeners, 's1', { inputTokens: 500000, outputTokens: 0 })
    const out = await runPreStep(h.listeners, agentPayload([userTurn('看看')]))
    assert.equal(out.messages.filter((m) => m.source?.kind === NUDGE_SOURCE_KIND).length, 0)
  } finally { h.cleanup() }
})

await testAsync('提醒写进了审计日志（events.log 里能事后核对）', async () => {
  const h = makeHarness({ contextNudgeMinTokens: 1000, contextNudgeGrowthTokens: 1000 })
  try {
    reportUsage(h.listeners, 's1', { totalTokens: 250000, cacheReadTokens: 240000, inputTokens: 2000, outputTokens: 300 })
    await runPreStep(h.listeners, agentPayload([userTurn('看看这个项目')]))
    const log = readFileSync(join(h.home, 'strata', 'events.log'), 'utf8')
    assert.ok(log.includes('"kind":"nudge"'), 'events.log 里没有 nudge 记录')
    assert.ok(log.includes('used=242000'))
    // 审计文件里不许出现用户原话正文（只记数字）
    assert.ok(!log.includes('看看这个项目'))
  } finally { h.cleanup() }
})

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

process.stdout.write(`\n${'─'.repeat(56)}\n`)
if (failed === 0) {
  process.stdout.write(`通过 ${passed} 项，失败 0 项\n全绿。\n`)
  process.exit(0)
} else {
  process.stdout.write(`通过 ${passed} 项，失败 ${failed} 项\n`)
  for (const f of failures) process.stdout.write(`  ✗ ${f.name}: ${f.error?.stack ?? f.error}\n`)
  process.exit(1)
}
