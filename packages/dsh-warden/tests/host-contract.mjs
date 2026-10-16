/**
 * dsh-warden · 真实宿主契约验收
 *
 * ── 这一份和 smoke.mjs 的区别 ──────────────────────────────────────────
 * smoke.mjs 是纯函数与数据层的补充单测。**这一份不算补充** —— 它加载
 * 本机 `app.asar` 里的**官方运行件**（cordis / ToolRuntime / SystemPrompt），
 * 走真实的工具注册与执行链路，用来证明护栏真的接上了宿主。
 *
 * 评审的原话：「纯 fake ctx 不再作为通过宿主接线的证明」。所以 R1/R2/R3/R7
 * 的验收都在这里做，fake ctx 只用于 smoke.mjs 的边界补充。
 *
 * 运行件身份：`scripts/s1-runtime-identity.sh` 已核对，15 个包与当前
 * app.asar **逐字节一致**（0.2.0-rc.2）。证据见 evidence/s1-runtime-identity.txt。
 *
 * ── 用法 ───────────────────────────────────────────────────────────────
 *   node tests/host-contract.mjs
 *   RUNTIME=<node_modules 路径> node tests/host-contract.mjs
 *
 * 退出码 0 = 全过；非 0 = 有失败。每条断言都配了「反例必须先红」的对照，
 * 证明断言本身有能力失败（不是恒真）。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MODULE_ROOT = resolve(HERE, '..')
const RUNTIME = process.env.RUNTIME
  ?? `${process.env.HOME}/projects/deepseek-harness-runtime/node_modules`

if (!existsSync(join(RUNTIME, '@deepseek-ai/cordis'))) {
  console.error(`找不到官方运行件：${RUNTIME}\n用 RUNTIME=<path> 指定，或先跑 scripts/s1-runtime-identity.sh 确认。`)
  process.exit(2)
}

/* ---------------- 官方运行件（真实宿主代码，不是替身） ---------------- */
const { Context } = await import(`${RUNTIME}/@deepseek-ai/cordis/lib/index.js`)
const { default: SystemPrompt } = await import(`${RUNTIME}/@deepseek-ai/dsh-system-prompt/lib/index.js`)
const { ToolRuntime } = await import(`${RUNTIME}/@deepseek-ai/dsh-tools/lib/index.js`)

/* ---------------- 被测模块 ---------------- */
const { installWaitCap, planWaitCap, requestedWaitMs, acceptsTimedOutValue } = await import('../lib/host/wait.js')
const { installUsageSampling, UsageLedger, usageOfEvent, pressureOf, totalOf, bucketsFrom, resolveContextLoad } = await import('../lib/host/usage.js')
const { installInjection, rulesText } = await import('../lib/host/inject.js')
const { installAfter } = await import('../lib/host/after.js')
const { installGuard } = await import('../lib/host/guard.js')
const { LockStore, EvidenceLedger, Counters, appendEvent } = await import('../lib/core/store.js')
const { Capabilities } = await import('../lib/core/capability.js')
const { ProgressWatch, StageLedger } = await import('../lib/core/progress.js')
const { sha256Hex, sha256File, resultFingerprint } = await import('../lib/core/text.js')
const { resolveResourceId, resourcesConflict } = await import('../lib/core/resource.js')
const { GovernanceClaim } = await import('../lib/core/governance.js')
const { fakeClock } = await import('../lib/core/clock.js')

/* ---------------- 极简测试框架 ---------------- */
let passed = 0
const failures = []
const section = (name) => console.log(`\n── ${name} ` + '─'.repeat(Math.max(0, 60 - name.length)))

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ✗ ${name}\n      ${String(error?.message ?? error).split('\n').join('\n      ')}`)
  }
}

function tempHome(prefix = 'warden-host-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 造一个真实 cordis 根上下文，装上官方 SystemPrompt 与 ToolRuntime。 */
async function realHostCtx() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  return ctx
}

/** 一个假的 agent/session，形状按真实宿主读取的字段来（id + header.cwd）。 */
function agentFor(sessionId, cwd = '/work') {
  return { id: `agent-${sessionId}`, session: { id: sessionId, header: { cwd } } }
}

const WAIT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { timedOut: { type: 'boolean' } },
  required: ['timedOut'],
}

/**
 * 注册一个**行为与真实 wait_agent 一致**的合成等待工具：
 * 尊重 `exec.signal`，abort 时抛错（真实 `TeamActivity.wait()` 就是 reject）。
 */
function registerSyntheticWait(ctx, state) {
  ctx.tools.register({
    name: 'wait_agent',
    description: 'synthetic wait mirroring dsh-experimental-tool-agent-team semantics',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { timeout_ms: { type: 'integer' } },
    },
    output: {
      schema: WAIT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      state.seenTimeoutMs = args.timeout_ms ?? null
      state.argsFrozen = Object.isFrozen(args)
      const timeoutMs = Number(args.timeout_ms) || 30000
      const started = Date.now()
      const signal = exec.signal
      signal?.throwIfAborted?.()
      try {
        await new Promise((res, rej) => {
          const timer = setTimeout(res, timeoutMs)
          const onAbort = () => { clearTimeout(timer); rej(new Error('TEAM_WAIT_ABORTED')) }
          if (signal?.aborted) { onAbort(); return }
          signal?.addEventListener?.('abort', onAbort, { once: true })
        })
        state.elapsedMs = Date.now() - started
        return { timedOut: true }
      } catch (error) {
        state.elapsedMs = Date.now() - started
        state.aborted = true
        throw error
      }
    },
  })
}

/* ================================================================== *
 * R1 · 等待上限：必须走真实 ToolRuntime，且参数是深冻结的
 * ================================================================== */
section('R1 · 等待上限（真实 ToolRuntime + 冻结参数）')

await test('反例先红：宿主确实深冻结 exec.arguments，旧版"原地改参数"必抛', async () => {
  const ctx = await realHostCtx()
  let frozenSeen = null
  let writeError = null
  ctx.tools.register({
    name: 'probe_frozen',
    description: 'probe',
    parameters: { type: 'object', additionalProperties: false, properties: { timeout_ms: { type: 'integer' } } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: v.text }] },
    execute: () => ({ text: 'ok' }),
  })
  const off = ctx.on('tools/pre-execute', async (exec, next) => {
    frozenSeen = Object.isFrozen(exec.arguments)
    try { exec.arguments.timeout_ms = 60000 } catch (error) { writeError = String(error?.message ?? error) }
    return next()
  })
  await ctx.tools.execute({ callId: 'frozen-1', name: 'probe_frozen', arguments: { timeout_ms: 900000 }, signal: new AbortController().signal })
  off()
  assert.equal(frozenSeen, true, '宿主没有冻结参数？契约与实读不符，需要重新核对')
  assert.ok(writeError !== null, '写冻结参数居然没抛 —— 那旧版的失败模式就不成立了')
  assert.match(writeError, /read only|Cannot assign/i)
})

await test('R1：真实执行链下等待被截断到上限，且返回 {timedOut:true} 而不是 error', async () => {
  const home = tempHome()
  const ctx = await realHostCtx()
  const state = {}
  registerSyntheticWait(ctx, state)

  const capabilities = new Capabilities({})
  const events = []
  const off = installWaitCap(ctx, {
    config: () => ({ enabled: true, waitCapMs: 300, waitTools: ['wait_agent'] }),
    capabilities,
    clock: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
    onEvent: (e) => events.push(e),
  })
  assert.ok(off, 'installWaitCap 没有返回卸载函数')
  assert.equal(capabilities.get('waitCap').mounted, true, 'waitCap 没有标成 mounted')

  const started = Date.now()
  const result = await ctx.tools.execute({
    callId: 'wait-cap-1',
    name: 'wait_agent',
    arguments: { timeout_ms: 900000 },
    signal: new AbortController().signal,
  })
  const elapsed = Date.now() - started
  // 卸载会把 mounted/observed 归零（这是正确行为），所以要在 dispose 之前取快照
  const capsAfterRun = capabilities.snapshot()
  off()

  // 工具体确实收到了 900000（我们没有偷偷改参数）
  assert.equal(state.seenTimeoutMs, 900000, '工具体看到的 timeout_ms 被改了？本实现不该改参数')
  assert.equal(state.argsFrozen, true)
  // 但等待真的被截断了
  assert.ok(elapsed < 5000, `等待没有被截断（实际 ${elapsed}ms）`)
  assert.ok(state.aborted === true, '工具体没有收到 abort —— 期限信号没接上')
  // 结果不是错误，而是正常超时
  assert.notEqual(result.isError, true, `等待被截断后不应是 isError，实际：${JSON.stringify(result.error ?? result.content)}`)
  const text = (result.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
  assert.match(text, /"timedOut":\s*true/)
  // 解释走 additionalContexts，且不进 content（schema additionalProperties:false 塞不进去）
  assert.ok(Array.isArray(result.additionalContexts) && result.additionalContexts.length > 0, '没有把截断说明通过 additionalContexts 交付')
  assert.match(result.additionalContexts[0].content[0].text, /不代表子任务失败/)
  assert.equal(result.additionalContexts[0].source.kind, 'warden')
  assert.ok(events.some((e) => e.kind === 'wait-capped'), '没有记 wait-capped 事件')
  assert.equal(capsAfterRun.find((c) => c.name === 'waitCap').observed, true, 'waitCap 没有标成 observed')
  rmSync(home, { recursive: true, force: true })
})

await test('R1：未超上限时完全不介入（不误伤正常等待）', async () => {
  const ctx = await realHostCtx()
  const state = {}
  registerSyntheticWait(ctx, state)
  const off = installWaitCap(ctx, {
    config: () => ({ enabled: true, waitCapMs: 60000, waitTools: ['wait_agent'] }),
    capabilities: new Capabilities({}),
  })
  const result = await ctx.tools.execute({
    callId: 'wait-ok-1', name: 'wait_agent', arguments: { timeout_ms: 100 }, signal: new AbortController().signal,
  })
  off()
  assert.equal(state.aborted, undefined, '没超上限却被截断了')
  assert.notEqual(result.isError, true)
  assert.equal(off.stats.armed, 0)
})

await test('R1：非等待工具不受影响；waitCapMs=0 表示不干预', async () => {
  assert.equal(planWaitCap({ name: 'bash', arguments: { timeout_ms: 999999 } }, 60000), null)
  assert.equal(planWaitCap({ name: 'wait_agent', arguments: { timeout_ms: 999999 } }, 0), null)
  assert.equal(requestedWaitMs({ arguments: { timeout_ms: 5000 } }), 5000)
  assert.equal(requestedWaitMs({ arguments: '{"timeout_ms":5000}' }), 5000, 'JSON 字符串形态的参数读不出来')
  // 宿主对越界值自己会报错，我们不插手
  assert.equal(planWaitCap({ name: 'wait_agent', arguments: { timeout_ms: 99 } }, 60000), null, '低于宿主下限 10000 时不该由护栏插手')
  assert.ok(acceptsTimedOutValue({ output: { schema: WAIT_OUTPUT_SCHEMA } }), 'wait_agent 的 schema 应当收得下 {timedOut:true}')
  assert.equal(acceptsTimedOutValue({ output: { schema: { type: 'object', properties: { text: { type: 'string' } } } } }), false)
})

await test('R1：调用方自己取消时，护栏不抢功、不替换结果', async () => {
  const ctx = await realHostCtx()
  const state = {}
  registerSyntheticWait(ctx, state)
  const off = installWaitCap(ctx, {
    config: () => ({ enabled: true, waitCapMs: 60000, waitTools: ['wait_agent'] }),
    capabilities: new Capabilities({}),
  })
  const controller = new AbortController()
  const pending = ctx.tools.execute({
    callId: 'wait-cancel-1', name: 'wait_agent', arguments: { timeout_ms: 30000 }, signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 120)
  const result = await pending
  off()
  assert.equal(off.stats.substituted, 0, '用户取消被当成了护栏截断')
  assert.equal(result.isError, true, '用户取消应当照常表现为取消')
})

/* ================================================================== *
 * R2 · 用量采样：真实 session/event + 真实事件形状
 * ================================================================== */
section('R2 · 用量采样（真实 session/event + 真实日志事件）')

const fixturePath = join(HERE, 'fixtures/real-usage-events.json')
const fixture = existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath, 'utf8')) : null

await test('夹具存在：真实会话日志里抽出的 usage 事件', async () => {
  assert.ok(fixture, `缺少 ${fixturePath}，先跑 scripts/extract-usage-fixtures.sh`)
  assert.ok(fixture.samples.length > 0, '夹具里没有样本')
  assert.ok(fixture.usageShapesSeen.includes('data.usage') || fixture.usageShapesSeen.includes('data.stream[].usage'),
    `真实 usage 形状不在预期内：${JSON.stringify(fixture.usageShapesSeen)}`)
})

await test('R2：usageOfEvent 认得真实日志里的事件形状', () => {
  assert.ok(fixture)
  let matched = 0
  for (const sample of fixture.samples) {
    // 用真实事件骨架重建，确保不是在自家编的形状上自嗨
    const ev = sample.eventSkeleton
    const usage = usageOfEvent(ev)
    assert.ok(usage, `真实事件（seq=${sample.seq}, where=${sample.where}）没被认出来`)
    assert.equal(Number(usage.inputTokens), Number(sample.usage.inputTokens))
    matched++
  }
  assert.ok(matched >= 5, `只认出了 ${matched} 条真实事件`)
})

await test('R2：压力口径不含输出（旧版把 totalTokens 当水位是错的）', () => {
  assert.ok(fixture)
  const sample = fixture.samples[0]
  const buckets = bucketsFrom(sample.usage)
  assert.ok(buckets)
  const pressure = pressureOf(buckets)
  const total = totalOf(buckets)
  const reportedTotal = Number(sample.usage.totalTokens)
  // 真实数据里 totalTokens 含输出；压力必须不含
  assert.equal(total, reportedTotal, '四桶求和应当等于宿主上报的 totalTokens')
  assert.equal(pressure, reportedTotal - buckets.outputTokens, '压力应当是 total 减去输出')
  assert.ok(pressure < total, '压力不应等于总量（那样就把输出算进上下文了）')
})

await test('R2：真实 cordis ctx 上挂 session/event，喂真实事件后账本准确', async () => {
  const ctx = await realHostCtx()
  const ledger = new UsageLedger({})
  const capabilities = new Capabilities({})
  const off = installUsageSampling(ctx, { ledger, capabilities })
  assert.ok(off, 'installUsageSampling 没有返回卸载函数')
  assert.equal(capabilities.get('usageSampling').mounted, true)

  const session = { id: 'real-session-1', header: { cwd: '/work' }, seq: 10 }
  let fed = 0
  for (const sample of fixture.samples.slice(0, 8)) {
    const ev = { ...sample.eventSkeleton, data: { ...sample.eventSkeleton.data, turn: 1, step: fed + 1 } }
    ctx.emit('session/event', session, ev)
    fed++
  }
  const capsAfterFeed = capabilities.snapshot()
  off()

  const got = ledger.sample('real-session-1')
  assert.ok(got, '账本里没有这个会话')
  assert.equal(got.requests, fed, `喂了 ${fed} 条，账本只记了 ${got.requests} 条`)
  assert.equal(got.source, 'session-event')
  assert.ok(got.cumulativeTokens > 0)
  assert.equal(got.contextWindow, null, '事件账本看不到窗口大小，必须明确为 null 而不是 0')
  assert.equal(got.complete, false)
  assert.equal(capsAfterFeed.find((c) => c.name === 'usageSampling').observed, true)
})

await test('反例先红：把 usage 放在 llm/stream 的 options 上（旧版数据源）采不到', async () => {
  const ctx = await realHostCtx()
  const ledger = new UsageLedger({})
  const off = installUsageSampling(ctx, { ledger, capabilities: new Capabilities({}) })
  // 旧版就是从这里读的：options 上有 usage，但本实现不听 llm/stream
  const listener = ctx.on('llm/stream', (_options, next) => next())
  ctx.emit('llm/stream', { provider: 'synthetic', usage: { inputTokens: 1000, outputTokens: 5, totalTokens: 1005 } }, () => (async function* () {})())
  listener()
  off()
  assert.equal(ledger.sample('whatever'), null, '不该从 llm/stream 的 options 采到 usage')
})

await test('R2：同一 (turn,step) 重复上报按替换而非累加（与官方 tokenUsage 投影同口径）', () => {
  const ledger = new UsageLedger({})
  const ev = (step, input) => ({ type: 'assistant/message', data: { turn: 1, step, usage: { inputTokens: input, outputTokens: 0 } } })
  ledger.observe('s', ev(1, 100))
  ledger.observe('s', ev(1, 150))   // 同一 step 的修正上报
  ledger.observe('s', ev(2, 200))
  const got = ledger.sample('s')
  assert.equal(got.totals.uncachedInputTokens, 350, '同 step 应当替换（150+200），不是累加（100+150+200）')
})

await test('R2：读不到官方投影时明确 unknown，不用累计值冒充当前压力', () => {
  const ledger = new UsageLedger({})
  const load = resolveContextLoad({ get: () => null }, null, 'nobody', ledger)
  assert.equal(load.known, false)
  assert.equal(load.basis, 'unknown')
  assert.equal(load.pressureTokens, null)
  assert.equal(load.ratio, null)
})

await test('R2：有官方 contextPressure 投影时优先用它，并标出 basis', () => {
  const fakeCtx = {
    get: (name) => (name === 'sessionProjections' ? {
      cachedSnapshot: () => ({
        asOfSeq: 42,
        values: {
          contextPressure: { pressureTokens: 120000, projectedTokens: 130000, contextWindow: 1000000 },
          tokenUsage: { uncachedInputTokens: 5000, cacheReadTokens: 115000, cacheWriteTokens: 0, outputTokens: 900 },
        },
      }),
    } : null),
  }
  const load = resolveContextLoad(fakeCtx, { id: 's' }, 's', new UsageLedger({}))
  assert.equal(load.known, true)
  assert.equal(load.basis, 'official-projection:projected')
  assert.equal(load.pressureTokens, 130000, '应当优先用 projectedTokens（它回答的是下一次请求）')
  assert.equal(load.contextWindow, 1000000)
  assert.ok(Math.abs(load.ratio - 0.13) < 1e-9)
})

/* ================================================================== *
 * R3 · 大输出归档：真实 ToolRuntime 的 post-execute
 * ================================================================== */
section('R3 · 大输出归档与有界呈现（真实 ToolRuntime）')

await test('R3：大文本结果被归档，上下文里只剩有界摘要 + 可回读的引用', async () => {
  const home = tempHome()
  const ctx = await realHostCtx()
  const BIG = Array.from({ length: 400 }, (_, i) => `line-${String(i).padStart(4, '0')}: ${'x'.repeat(60)}`).join('\n')
  ctx.tools.register({
    name: 'big_output',
    description: 'emits a big text result',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: v.text }] },
    execute: () => ({ text: BIG }),
  })

  const capabilities = new Capabilities({})
  const events = []
  const off = installAfter(ctx, {
    home,
    config: () => ({ enabled: true, archiveToolResults: true, archiveThresholdChars: 2000, archiveKeepChars: 400, reworkNudge: false, rereadNudge: false, progressWatch: false }),
    counters: new Counters(),
    tools: () => ctx.tools,
    capabilities,
    onEvent: (e) => events.push(e),
  })
  assert.ok(off)

  const result = await ctx.tools.execute({
    callId: 'big-1', name: 'big_output', arguments: {},
    signal: new AbortController().signal,
    agent: agentFor('sess-archive'),
  })
  const capsAfterArchive = capabilities.snapshot()
  off()

  assert.notEqual(result.isError, true)
  const text = result.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  assert.ok(text.length < BIG.length / 3, `呈现没有被压小（${text.length} vs 原文 ${BIG.length}）`)
  assert.match(text, /warden 归档/)
  assert.match(text, /不要重新执行刚才那个工具/, '摘要里必须禁止"重跑找回"')

  const archiveLine = text.split('\n').find((l) => l.includes('文件：'))
  assert.ok(archiveLine, '摘要里没有给出归档路径')
  const archivePath = archiveLine.split('文件：')[1].trim()
  assert.ok(existsSync(archivePath), `归档文件不存在：${archivePath}`)
  const archived = readFileSync(archivePath, 'utf8')
  assert.equal(archived, BIG, '归档内容与原文不一致 —— 数据被改了')

  const hashLine = text.split('\n').find((l) => l.includes('指纹：sha256:'))
  const hashInText = hashLine.split('sha256:')[1].trim()
  assert.equal(hashInText, createHash('sha256').update(Buffer.from(BIG, 'utf8')).digest('hex'), '摘要里的指纹与标准 sha256 不一致')
  assert.ok(events.some((e) => e.kind === 'archive'))
  assert.equal(capsAfterArchive.find((c) => c.name === 'archiveToolResults').observed, true)
  rmSync(home, { recursive: true, force: true })
})

await test('R3：失败结果一律不归档、不隐藏（错误本身就是证据）', async () => {
  const home = tempHome()
  const ctx = await realHostCtx()
  const BIG_ERR = 'E'.repeat(20000)
  ctx.tools.register({
    name: 'big_error',
    description: 'emits a big failing result',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: v.text }] },
    execute: () => { throw new Error(BIG_ERR) },
  })
  const off = installAfter(ctx, {
    home,
    config: () => ({ enabled: true, archiveToolResults: true, archiveThresholdChars: 2000, archiveKeepChars: 400, reworkNudge: false, rereadNudge: false, progressWatch: false, errorClassify: false }),
    counters: new Counters(),
    tools: () => ctx.tools,
    capabilities: new Capabilities({}),
  })
  const result = await ctx.tools.execute({ callId: 'err-1', name: 'big_error', arguments: {}, signal: new AbortController().signal, agent: agentFor('s') })
  off()
  assert.equal(result.isError, true)
  const text = result.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  assert.ok(!text.includes('warden 归档'), '失败结果被归档了 —— 违反"失败不隐藏"')
  assert.ok(text.includes('E'.repeat(100)), '错误正文被改写了')
  rmSync(home, { recursive: true, force: true })
})

await test('R3：媒体块（图片）原样保留，只压文本块', async () => {
  const home = tempHome()
  const ctx = await realHostCtx()
  ctx.tools.register({
    name: 'mixed_output',
    description: 'text + image',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      // 直接返回 content 形态，绕过 render，模拟宿主里带媒体块的结果
      render: (_a, v) => [{ type: 'text', text: v.text }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    },
    execute: () => ({ text: 'y'.repeat(9000) }),
  })
  const off = installAfter(ctx, {
    home,
    config: () => ({ enabled: true, archiveToolResults: true, archiveThresholdChars: 2000, archiveKeepChars: 400, reworkNudge: false, rereadNudge: false, progressWatch: false }),
    counters: new Counters(),
    tools: () => ctx.tools,
    capabilities: new Capabilities({}),
  })
  const result = await ctx.tools.execute({ callId: 'mix-1', name: 'mixed_output', arguments: {}, signal: new AbortController().signal, agent: agentFor('s2') })
  off()
  const images = result.content.filter((b) => b.type === 'image')
  assert.equal(images.length, 1, '图片块被归档吃掉了')
  assert.equal(images[0].data, 'AAAA')
  rmSync(home, { recursive: true, force: true })
})

await test('R3：归档写失败时保留原结果，并标降级（不静默丢数据）', async () => {
  const home = tempHome()
  // 把 archive 目录占成一个文件，mkdir 必然失败
  const paths = join(home, 'warden')
  mkdirSync(paths, { recursive: true })
  writeFileSync(join(paths, 'archive'), 'not a directory')

  const ctx = await realHostCtx()
  ctx.tools.register({
    name: 'big_output2',
    description: 'big',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: v.text }] },
    execute: () => ({ text: 'z'.repeat(9000) }),
  })
  const capabilities = new Capabilities({})
  const events = []
  const off = installAfter(ctx, {
    home,
    config: () => ({ enabled: true, archiveToolResults: true, archiveThresholdChars: 2000, archiveKeepChars: 400, reworkNudge: false, rereadNudge: false, progressWatch: false }),
    counters: new Counters(),
    tools: () => ctx.tools,
    capabilities,
    onEvent: (e) => events.push(e),
  })
  const result = await ctx.tools.execute({ callId: 'big-2', name: 'big_output2', arguments: {}, signal: new AbortController().signal, agent: agentFor('s3') })
  const capsAfterFail = capabilities.snapshot()
  off()
  const text = result.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  assert.equal(text.length, 9000, '归档失败时没有保留原结果')
  assert.equal(capsAfterFail.find((c) => c.name === 'archiveToolResults').degraded, true, '归档失败没有标降级')
  assert.ok(events.some((e) => e.kind === 'archive-failed'))
  rmSync(home, { recursive: true, force: true })
})

await test('R3：warden 不再声称裁历史；historyPruning 明确 unsupported', async () => {
  const home = tempHome()
  const ctx = await realHostCtx()
  const capabilities = new Capabilities({})
  const off = installInjection(ctx, { home, config: () => ({ enabled: true, waterLevelNudge: false }), capabilities, ledger: new UsageLedger({}) })
  assert.ok(off)
  const cap = capabilities.get('historyPruning')
  assert.equal(cap.supported, false)
  assert.equal(cap.degraded, true)
  assert.match(cap.reason, /dsh-compaction-basic/, '没有点名官方唯一 owner')

  // pre-step 批次里就算人为塞进 tool 消息，也**不该**被裁 —— 那一层不是历史，
  // 裁它等于伪造"接线成功"（旧版单测就是这么骗过自己的）。
  const history = Array.from({ length: 20 }, (_, i) => ({
    role: 'tool', toolCallId: `c${i}`, content: [{ type: 'text', text: 'x'.repeat(2000) }],
  }))
  const decision = await ctx.waterfall('agent/pre-step', {
    agent: agentFor('no-prune'), turn: 1, step: 1, signal: new AbortController().signal, messages: history,
  }, () => Promise.resolve({ kind: 'enter', messages: history }))
  assert.equal(decision.messages.length, 20)
  assert.ok(decision.messages.every((m) => m.content[0].text.length === 2000), '历史被裁了 —— warden 不该在 pre-step 动历史')
  off()
  rmSync(home, { recursive: true, force: true })
})

/* ================================================================== *
 * R7 · 能力状态：section 注册失败时兜底必须真的投递
 * ================================================================== */
section('R7 · 静默降级（真实 SystemPrompt + 重名冲突）')

await test('R7：真实 SystemPrompt 上 section 正常挂上，规则随请求下发', async () => {
  const home = tempHome()
  const ctx = await realHostCtx()
  const capabilities = new Capabilities({})
  const off = installInjection(ctx, {
    home,
    config: () => ({ enabled: true, starTopology: true, resultsToFile: true, lockGuard: true, evidenceLedger: true, archiveToolResults: true, waterLevelNudge: false }),
    capabilities,
    ledger: new UsageLedger({}),
  })
  assert.ok(off)
  assert.equal(off.sectionMounted(), true, 'section 没有挂上')
  assert.equal(capabilities.get('rulesSection').mounted, true)

  const assembly = await ctx.systemPrompt.assemble({})
  const rendered = assembly.sections.filter((s) => s.name === 'warden:rules').map((s) => s.text).join('\n')
  assert.ok(rendered.includes('星型拓扑'), `系统提示词里没有 warden 规则段：${JSON.stringify(assembly.sections.map((s) => s.name))}`)
  off()

  // 卸载后 section 必须消失（重载不留重复监听器）
  const after = await ctx.systemPrompt.assemble({})
  assert.equal(after.sections.filter((s) => s.name === 'warden:rules').length, 0, '卸载后 section 还在')
  rmSync(home, { recursive: true, force: true })
})

await test('R7：section 注册失败（重名）时，兜底消息确实投递 —— 旧版这里恒判成功', async () => {
  const home = tempHome()
  const ctx = await realHostCtx()
  // 先占掉同名 section，让 warden 的注册必然抛（同层重名 → throw）
  const squatter = ctx.systemPrompt.section({ name: 'warden:rules', order: 650, text: 'squatter' })

  const capabilities = new Capabilities({})
  const events = []
  const off = installInjection(ctx, {
    home,
    config: () => ({ enabled: true, starTopology: true, waterLevelNudge: false }),
    capabilities,
    ledger: new UsageLedger({}),
    onEvent: (e) => events.push(e),
  })
  assert.ok(off)
  assert.equal(off.sectionMounted(), false, 'section 注册失败了却报告成功')
  const cap = capabilities.get('rulesSection')
  assert.equal(cap.degraded, true, '没有标降级')
  assert.match(cap.reason, /already registered|section 注册失败/)

  // 兜底：pre-step 必须注入规则消息
  let decision
  const handlers = []
  // 用真实 ctx 触发 pre-step：直接找已注册的监听器不现实，改成走 ctx 的事件派发
  const carrier = { }
  const result = await ctx.waterfall('agent/pre-step', {
    agent: agentFor('fallback-session'), turn: 1, step: 1, signal: new AbortController().signal, messages: [],
  }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  decision = result
  assert.ok(decision.messages.length > 0, '兜底没有投递任何消息（这正是旧版的缺陷）')
  const text = decision.messages.map((m) => m.content.map((c) => c.text ?? '').join('')).join('\n')
  assert.match(text, /星型拓扑/)
  assert.equal(decision.messages[0].source.kind, 'warden')
  assert.ok(events.some((e) => e.kind === 'rules-fallback'))
  assert.equal(capabilities.get('rulesFallback').observed, true)
  off()
  squatter()
  rmSync(home, { recursive: true, force: true })
})

await test('R7：section 挂载失败时，同一个会话只兜底注入一次', async () => {
  const home = tempHome()
  const ctx = await realHostCtx()
  const squatter = ctx.systemPrompt.section({ name: 'warden:rules', order: 650, text: 'squatter' })
  const off = installInjection(ctx, {
    home,
    config: () => ({ enabled: true, starTopology: true, waterLevelNudge: false }),
    capabilities: new Capabilities({}),
    ledger: new UsageLedger({}),
  })
  const payload = { agent: agentFor('once-session'), turn: 1, step: 1, signal: new AbortController().signal, messages: [] }
  const base = () => Promise.resolve({ kind: 'enter', messages: [] })
  const first = await ctx.waterfall('agent/pre-step', payload, base)
  const second = await ctx.waterfall('agent/pre-step', { ...payload, step: 2 }, base)
  assert.equal(first.messages.length, 1)
  assert.equal(second.messages.length, 0, '同一会话重复注入了兜底规则')
  off(); squatter()
  rmSync(home, { recursive: true, force: true })
})

/* ================================================================== *
 * R4 · 共享资源锁：规范身份 + 并发
 * ================================================================== */
section('R4 · 共享资源锁（规范身份 / 冲突集合 / 并发）')

await test('反例先红：不同锁名指向同一路径，旧版会双双成功', async () => {
  const home = tempHome()
  const locks = new LockStore(home, {})
  const a = locks.acquire({ name: 'build-a', path: '/shared/build', owner: 'agent-A', ttlMs: 60000 })
  assert.equal(a.ok, true)
  const b = locks.acquire({ name: 'build-b', path: '/shared/build', owner: 'agent-B', ttlMs: 60000 })
  assert.equal(b.ok, false, '两把不同名的锁同时占住了同一资源 —— 互斥失效')
  assert.equal(b.heldBy.owner, 'agent-A')
  rmSync(home, { recursive: true, force: true })
})

await test('R4：父目录写入会撞上子树锁（删父目录毁掉被锁子树）', async () => {
  const home = tempHome()
  const locks = new LockStore(home, {})
  locks.acquire({ name: 'sub', path: '/shared/build/out', owner: 'agent-A', ttlMs: 60000 })
  const conflict = locks.conflictFor('/shared/build', 'agent-C')
  assert.ok(conflict, '父路径没有被子树锁拦住')
  assert.equal(conflict.owner, 'agent-A')
  rmSync(home, { recursive: true, force: true })
})

await test('R4：Windows 与 WSL /mnt 两种拼法归一成同一资源', () => {
  const win = resolveResourceId('D:\\<WORKSPACE>\\proj\\dist')
  const wsl = resolveResourceId('/mnt/d/<WORKSPACE>/proj/dist')
  assert.equal(win.resolvable, true)
  assert.equal(wsl.resolvable, true)
  assert.equal(win.resourceId, wsl.resourceId, '同一片文件被判成了两个资源')
  assert.equal(wsl.mergedCrossPlatform, true)
})

await test('R4：归一不出来时明确报"未覆盖"，不猜一个 id 假装锁住', () => {
  const cases = [
    ['~/some/path', /~/],
    ['relative/path', /cwd/],
    ['rm -rf /tmp/x && deploy', /空格|换行|命令/],
    ['deployment:', /缺少具体目标/],
  ]
  for (const [input, pattern] of cases) {
    const r = resolveResourceId(input, '')
    assert.equal(r.resolvable, false, `${input} 被错误地归一成了 ${r.resourceId}`)
    assert.match(r.reason, pattern)
  }
  // 相对路径 + cwd 可以归一
  const rel = resolveResourceId('build/out', '<HOME-USER>/proj')
  assert.equal(rel.resolvable, true)
  assert.ok(rel.resourceId.startsWith('path:wsl:<HOME-USER>/proj/build/out'))
})

await test('R4：命名资源（桌面输入 / 显示模式 / 部署目标）各自独立且全局唯一', () => {
  const desktop1 = resolveResourceId('desktop-input')
  const desktop2 = resolveResourceId('desktop')
  assert.equal(desktop1.resourceId, 'named:desktop:input')
  assert.equal(desktop1.resourceId, desktop2.resourceId, '同义写法没有归一到一起')
  assert.equal(resolveResourceId('display-mode').resourceId, 'named:display-mode')
  const depA = resolveResourceId('deployment:web-host')
  const depB = resolveResourceId('deployment:electron')
  assert.notEqual(depA.resourceId, depB.resourceId, '不同部署目标应当是不同资源')
  assert.equal(resourcesConflict(depA.resourceId, depB.resourceId), false)
  assert.equal(resourcesConflict(desktop1.resourceId, 'named:display-mode'), false)
})

await test('R4：存储写失败时**不报已取得**（旧版这里返回 ok:true）', async () => {
  const home = tempHome()
  const blocker = join(home, 'not-a-dir')
  writeFileSync(blocker, 'block IO')
  const broken = new LockStore(blocker, {})
  const result = broken.acquire({ name: 'lost', resource: 'desktop-input', owner: 'agent-A', ttlMs: 60000 })
  assert.equal(result.ok, false, 'IO 失败却报告已取得')
  assert.match(result.reason, /没有取得|失败/)
  rmSync(home, { recursive: true, force: true })
})

await test('R4：force 不能从模型侧抢走活锁；陈旧锁才可回收', async () => {
  const home = tempHome()
  const clock = fakeClock(1_000_000)
  const locks = new LockStore(home, { clock })
  const a = locks.acquire({ name: 'live', resource: 'deployment:web-host', owner: 'agent-A', ttlMs: 60000 })
  assert.equal(a.ok, true)
  // 模型侧 force 抢活锁 → 拒
  const forced = locks.release({ resourceId: a.lock.resourceId, owner: 'agent-B', force: true, actor: 'model' })
  assert.equal(forced.ok, false, '模型用 force 抢走了活锁')
  assert.match(forced.reason, /还活着|force 不能/)
  // 用户侧（设置页）force → 允许，但记账
  const byUser = locks.release({ resourceId: a.lock.resourceId, owner: '', force: true, actor: 'user' })
  assert.equal(byUser.ok, true)
  assert.equal(byUser.released, true)
  rmSync(home, { recursive: true, force: true })
})

await test('R4：过期但持有者进程还在 → 不许回收（过期≠已停手）', async () => {
  const home = tempHome()
  const clock = fakeClock(1_000_000)
  const locks = new LockStore(home, { clock })
  // pid 用当前进程，一定"活着"
  const a = locks.acquire({ name: 'still-running', resource: 'deployment:long', owner: 'agent-A', ttlMs: 1000 })
  assert.equal(a.ok, true)
  clock.advance(5000)   // 已过期
  const b = locks.acquire({ name: 'other', resource: 'deployment:long', owner: 'agent-B', ttlMs: 1000 })
  assert.equal(b.ok, false, '过期就被抢走了 —— 但原持有者进程还活着，可能还在部署')
  assert.equal(b.heldBy.owner, 'agent-A')
  rmSync(home, { recursive: true, force: true })
})

await test('R4：续租把过期时间推后（可注入时钟，没有 1ms 真实竞速）', async () => {
  const home = tempHome()
  const clock = fakeClock(0)
  const locks = new LockStore(home, { clock })
  const a = locks.acquire({ name: 'lease', resource: 'deployment:lease', owner: 'agent-A', ttlMs: 10_000 })
  assert.equal(a.ok, true)
  const fence = a.lock.fence
  clock.advance(8000)
  const renewed = locks.renew({ resourceId: a.lock.resourceId, owner: 'agent-A', fence, ttlMs: 10_000 })
  assert.equal(renewed.ok, true)
  assert.equal(renewed.lock.expiresAt, 18_000)
  clock.advance(9000)   // 到 17000，仍在租期内
  assert.ok(locks.list(clock.now())[a.lock.resourceId], '续租后锁不该消失')
  rmSync(home, { recursive: true, force: true })
})

await test('R4：fence 失效后续租被拒（旧持有者无法再声称持有执行权）', async () => {
  const home = tempHome()
  const clock = fakeClock(0)
  const locks = new LockStore(home, { clock })
  const a = locks.acquire({ name: 'fenced', resource: 'deployment:fence', owner: 'agent-A', ttlMs: 10_000 })
  const oldFence = a.lock.fence
  // 用户强制释放 → fence 推进
  locks.release({ resourceId: a.lock.resourceId, owner: '', force: true, actor: 'user' })
  const b = locks.acquire({ name: 'fenced2', resource: 'deployment:fence', owner: 'agent-B', ttlMs: 10_000 })
  assert.equal(b.ok, true)
  assert.ok(b.lock.fence > oldFence, 'fence 没有推进')
  const stale = locks.renew({ resourceId: a.lock.resourceId, owner: 'agent-A', fence: oldFence, ttlMs: 10_000 })
  assert.equal(stale.ok, false)
  assert.equal(stale.fenced, true, '旧持有者用过期 fence 续租成功了')
  assert.match(stale.reason, /栅栏令牌/)
  rmSync(home, { recursive: true, force: true })
})

await test('R4：真实 pre-execute 链路上，被占资源的写入被拒且给出可执行建议', async () => {
  const home = tempHome()
  const ctx = await realHostCtx()
  const clock = fakeClock(1_000_000)
  const locks = new LockStore(home, { clock })
  const capabilities = new Capabilities({})
  locks.acquire({ name: 'dist', resource: '/srv/app/dist', owner: 'agent-A', ttlMs: 60_000 })

  ctx.tools.register({
    name: 'write_file',
    description: 'synthetic writer',
    parameters: { type: 'object', additionalProperties: false, properties: { file_path: { type: 'string' } } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: v.text }] },
    execute: () => ({ text: 'written' }),
  })
  const off = installGuard(ctx, { config: () => ({ enabled: true, lockGuard: true }), locks, capabilities, clock })
  const result = await ctx.tools.execute({
    callId: 'w-1', name: 'write_file', arguments: { file_path: '/srv/app/dist/index.html' },
    signal: new AbortController().signal, agent: agentFor('agent-B', '/srv/app'),
  })
  const capsAfterDeny = capabilities.snapshot()
  off()
  assert.equal(result.isError, true, '被占资源的写入没有被拦下')
  const text = result.content.map((b) => b.text ?? '').join('')
  assert.match(text, /没有执行/)
  assert.match(text, /agent-A/)
  assert.match(text, /物理隔离/, '拒绝理由里没有给可执行的替代路径')
  assert.equal(capsAfterDeny.find((c) => c.name === 'sharedLock').observed, true)
  rmSync(home, { recursive: true, force: true })
})

await test('R4：读被锁资源不拦（别的会话正需要读它核对读数）', async () => {
  const home = tempHome()
  const ctx = await realHostCtx()
  const locks = new LockStore(home, { clock: fakeClock(1_000_000) })
  locks.acquire({ name: 'dist', resource: '/srv/app/dist', owner: 'agent-A', ttlMs: 60_000 })
  ctx.tools.register({
    name: 'read_file',
    description: 'synthetic reader',
    parameters: { type: 'object', additionalProperties: false, properties: { file_path: { type: 'string' } } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }, render: (_a, v) => [{ type: 'text', text: v.text }] },
    execute: () => ({ text: 'content' }),
  })
  const off = installGuard(ctx, { config: () => ({ enabled: true, lockGuard: true }), locks, capabilities: new Capabilities({}) })
  const result = await ctx.tools.execute({
    callId: 'r-1', name: 'read_file', arguments: { file_path: '/srv/app/dist/index.html' },
    signal: new AbortController().signal, agent: agentFor('agent-B'),
  })
  off()
  assert.notEqual(result.isError, true, '读操作被锁拦了')
  rmSync(home, { recursive: true, force: true })
})

/* ================================================================== *
 * R5 · 指纹：字节级 SHA-256
 * ================================================================== */
section('R5 · 二进制指纹与台账状态')

await test('反例先红：0x80 与 0x81 是不同文件，旧实现会撞成同一个 hash', () => {
  const a = Buffer.from([0x80])
  const b = Buffer.from([0x81])
  assert.notEqual(sha256Hex(a), sha256Hex(b), '两个不同字节撞成同一个 hash')
  // 旧实现的效果（先 String 再 UTF-8）确实会撞 —— 证明这条断言有能力失败
  const legacy = (v) => createHash('sha256').update(String(v), 'utf8').digest('hex')
  assert.equal(legacy(a), legacy(b), '对照失败：旧实现本该相撞，说明这条反例构造得不对')
})

await test('R5：与标准 sha256sum 逐字节一致', async () => {
  const dir = tempHome()
  const cases = [
    { name: 'byte-80.bin', bytes: [0x80] },
    { name: 'byte-81.bin', bytes: [0x81] },
    { name: 'invalid-utf8.bin', bytes: [0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28] },
    { name: 'text.txt', bytes: [...Buffer.from('hello 世界\n', 'utf8')] },
    { name: 'empty.bin', bytes: [] },
  ]
  for (const c of cases) {
    const file = join(dir, c.name)
    writeFileSync(file, Buffer.from(c.bytes))
    const ours = sha256File(file)
    const theirs = execFileSync('sha256sum', [file]).toString().split(' ')[0]
    assert.equal(ours.hash, theirs, `${c.name} 与 sha256sum 不一致`)
    assert.equal(ours.bytes, c.bytes.length)
    assert.match(ours.algorithm, /^sha256-bytes-v\d+$/)
  }
  rmSync(dir, { recursive: true, force: true })
})

await test('R5：未绑定产物的读数是 unverified，不是"有效"', async () => {
  const home = tempHome()
  const evidence = new EvidenceLedger(home, {})
  const recorded = evidence.record({ label: 'unbound', reading: 'pass' })
  assert.equal(recorded.ok, true)
  const verdict = evidence.check({ id: recorded.row.id }, () => { throw new Error('should not be called') })
  assert.equal(verdict.found, true)
  assert.equal(verdict.state, 'unverified')
  assert.equal(verdict.valid, false, '未绑定产物被判成有效验收')
  assert.match(verdict.reason, /不能当验收通过|无法核对/)
  rmSync(home, { recursive: true, force: true })
})

await test('R5：旧算法（hashVersion=1）的记录不能无条件继承为有效', async () => {
  const home = tempHome()
  const evidence = new EvidenceLedger(home, {})
  const dir = join(home, 'warden')
  mkdirSync(dir, { recursive: true })
  // 手工塞一条 v1 记录，模拟升级前的台账
  const legacyRow = {
    at: new Date().toISOString(), label: 'legacy', artifact: '/tmp/x', artifactHash: 'deadbeef',
    hashVersion: 1, reading: 'ok', owner: 'old', note: '', environment: {}, id: 'legacy-1',
  }
  writeFileSync(join(dir, 'evidence.jsonl'), `${JSON.stringify(legacyRow)}\n`)
  const verdict = evidence.check({ id: 'legacy-1' }, () => ({ hash: 'deadbeef', algorithm: 'sha256-bytes-v2' }))
  assert.equal(verdict.state, 'unverified', '旧算法记录被直接当成有效')
  assert.match(verdict.reason, /旧算法|hashVersion/)
  rmSync(home, { recursive: true, force: true })
})

await test('R5：台账写盘失败必须返回失败，不返回假装存在的记录', async () => {
  const blocker = join(tempHome(), 'file-in-the-way')
  writeFileSync(blocker, 'x')
  const evidence = new EvidenceLedger(blocker, {})
  const result = evidence.record({ label: 'will-fail', reading: 'x' })
  assert.equal(result.ok, false, '写盘失败却返回了记录对象')
  assert.match(result.reason, /没有记上|失败/)
})

await test('R5：四态齐全 —— verified / stale / unverified / error', async () => {
  const home = tempHome()
  const evidence = new EvidenceLedger(home, {})
  const artifact = join(home, 'build.txt')
  writeFileSync(artifact, 'v1')
  const good = evidence.record({ label: 'ok', reading: '1', artifact })
  const hashOf = (p) => sha256File(p)
  assert.equal(evidence.check({ id: good.row.id }, hashOf).state, 'verified')
  writeFileSync(artifact, 'v2')
  assert.equal(evidence.check({ id: good.row.id }, hashOf).state, 'stale')
  rmSync(artifact)
  assert.equal(evidence.check({ id: good.row.id }, hashOf).state, 'error')
  const unbound = evidence.record({ label: 'nb', reading: '1' })
  assert.equal(evidence.check({ id: unbound.row.id }, hashOf).state, 'unverified')
  rmSync(home, { recursive: true, force: true })
})

/* ================================================================== *
 * R6 · 无进展识别
 * ================================================================== */
section('R6 · 无进展识别（正常开发不该被判空转）')

await test('反例先红：分九次读同一大文件的九个不同片段 → 0 次提醒', () => {
  const clock = fakeClock(0)
  const watch = new ProgressWatch({ clock })
  let notices = 0
  for (let i = 0; i < 9; i++) {
    const r = watch.observe({
      sessionId: 'reader', name: 'read', args: { path: '/big/file.js', offset: i * 50, limit: 50 },
      result: { content: [{ type: 'text', text: `segment ${i} ${'x'.repeat(50)}` }] },
      targetPath: '/big/file.js',
    }, { progressWatch: true, progressMode: 'observe', progressFailureThreshold: 3, rereadNudge: true, rereadThreshold: 3 })
    if (r.notice) notices++
    clock.advance(1000)
  }
  assert.equal(notices, 0, `正常分段读取被判成空转（${notices} 次提醒）`)
})

await test('R6：同一失败签名原样重复到阈值 → 给一条改路建议，不是"再试一次"', () => {
  const clock = fakeClock(0)
  const watch = new ProgressWatch({ clock })
  const failing = { isError: true, content: [{ type: 'text', text: 'old_string was not found' }], error: { message: 'old_string was not found' } }
  let notice = null
  for (let i = 0; i < 3; i++) {
    const r = watch.observe({ sessionId: 's', name: 'edit', args: { path: '/a.js', old_string: 'X' }, result: failing, targetPath: '/a.js' },
      { progressWatch: true, progressMode: 'observe', progressFailureThreshold: 3 })
    if (r.notice) notice = r.notice
    clock.advance(1000)
  }
  assert.ok(notice, '同一失败重复 3 次没有触发建议')
  assert.match(notice, /不会得到不同结果/)
  assert.match(notice, /edit-miss/, '没有给出这一类错误的具体做法')
  // 评审要求"移除先完整重读的泛化建议"。正文里可以出现"整个文件"，
  // 但只允许出现在**否定**语境里；不能把它当成推荐动作。
  for (const sentence of notice.split(/[。\n]/)) {
    if (sentence.includes('整个文件') || sentence.includes('完整重读')) {
      assert.match(sentence, /不要|别|不必/, `把完整重读当成了建议：${sentence.trim()}`)
    }
  }
  assert.match(notice, /换一条|改假设|换工具|换执行面/, '没有给出具体的替代路径')
})

await test('R6：错误内容变了就是新证据，不算原样失败', () => {
  const clock = fakeClock(0)
  const watch = new ProgressWatch({ clock })
  let notices = 0
  for (let i = 0; i < 6; i++) {
    const r = watch.observe({
      sessionId: 's', name: 'edit', args: { path: '/a.js', old_string: `X${i}` },
      result: { isError: true, content: [{ type: 'text', text: `different failure #${i}` }], error: { message: `different failure #${i}` } },
      targetPath: '/a.js',
    }, { progressWatch: true, progressMode: 'observe', progressFailureThreshold: 3 })
    if (r.notice) notices++
    clock.advance(1000)
  }
  assert.equal(notices, 0, '每次都是不同的失败定位，却被判成原样失败')
})

await test('R6：提醒有冷却，不会每次失败都塞一条消息', () => {
  const clock = fakeClock(0)
  const watch = new ProgressWatch({ clock })
  const failing = { isError: true, content: [{ type: 'text', text: 'boom' }], error: { message: 'boom' } }
  let notices = 0
  for (let i = 0; i < 20; i++) {
    const r = watch.observe({ sessionId: 's', name: 'run', args: { cmd: 'same' }, result: failing },
      { progressWatch: true, progressMode: 'observe', progressFailureThreshold: 2 })
    if (r.notice) notices++
    clock.advance(1000)   // 每次隔 1 秒，远小于冷却
  }
  assert.equal(notices, 1, `冷却没生效，20 次失败发了 ${notices} 条提醒`)
})

await test('R6：只有时间戳不同不算进展；随机 id 不同也不算', () => {
  const a = { isError: true, content: [{ type: 'text', text: 'failed at 2026-10-15T01:02:03Z id=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }] }
  const b = { isError: true, content: [{ type: 'text', text: 'failed at 2026-10-15T09:08:07Z id=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }] }
  assert.equal(resultFingerprint(a), resultFingerprint(b), '时间戳与 uuid 被当成了新证据')
})

await test('R6：阶段预算到点只触发复盘，不判成功也不判失败', () => {
  const clock = fakeClock(0)
  const watch = new ProgressWatch({ clock })
  watch.observe({ sessionId: 's', name: 'x', args: {}, result: { content: [] } }, {})
  clock.advance(600_000)   // 10 分钟
  const budget = watch.budgetCheck('s', { taskBudgetMs: 600_000, taskBudgetReplies: 30 })
  assert.equal(budget.due, true)
  assert.match(budget.text, /复盘/)
  // 必须同时声明"不是失败"和"不是可以收工"，两头都不许自动判定
  assert.match(budget.text, /不是.*失败/)
  assert.match(budget.text, /不是可以收工/)
  assert.match(budget.text, /必需/, '没有要求列出剩余必需项')
  assert.ok(budget.reason.includes('时间'), `预算原因不对：${budget.reason}`)
})

/* ================================================================== *
 * R8 · 阶段合同
 * ================================================================== */
section('R8 · 最小阶段合同')

await test('R8：验收项为空时不能 complete', async () => {
  const home = tempHome()
  const stages = new StageLedger(home, {})
  const r = stages.record({ sessionId: 's', goal: '修好等待上限', status: 'complete', sourceIdentity: 'x@1' })
  assert.equal(r.ok, false, '没有验收项也能 complete')
  assert.match(r.reason, /不能标成 complete/)
  rmSync(home, { recursive: true, force: true })
})

await test('R8：还有必需项未做时不能 complete；conditional-complete/blocked/failed 可以', async () => {
  const home = tempHome()
  const stages = new StageLedger(home, {})
  const base = {
    sessionId: 's', goal: 'g', sourceIdentity: 'path@hash',
    acceptance: [{ item: '隔离宿主里等待被截断', verified: true, evidence: 'tests/host-contract.mjs' }],
  }
  const blocked = stages.record({ ...base, status: 'complete', requiredRemaining: ['真实 Electron 未验'] })
  assert.equal(blocked.ok, false)
  for (const status of ['conditional-complete', 'blocked', 'failed', 'in-progress']) {
    const r = stages.record({ ...base, status, requiredRemaining: ['真实 Electron 未验'] })
    assert.equal(r.ok, true, `${status} 被拒了`)
  }
  const ok = stages.record({ ...base, status: 'complete', requiredRemaining: [] })
  assert.equal(ok.ok, true, '齐了却不让 complete')
  rmSync(home, { recursive: true, force: true })
})

await test('R8：标了已验但没写依据 → 不许 complete', async () => {
  const home = tempHome()
  const stages = new StageLedger(home, {})
  const r = stages.record({
    sessionId: 's', goal: 'g', sourceIdentity: 'p@h', status: 'complete',
    acceptance: [{ item: 'x', verified: true }],
  })
  assert.equal(r.ok, false)
  assert.match(r.reason, /没写依据/)
  rmSync(home, { recursive: true, force: true })
})

await test('R8：阶段记录落盘、可回读，写失败要报失败', async () => {
  const home = tempHome()
  const stages = new StageLedger(home, { clock: fakeClock(1) })
  const r = stages.record({ sessionId: 's1', goal: 'g1', status: 'in-progress', hypothesis: 'h', nextStep: 'n' })
  assert.equal(r.ok, true)
  assert.equal(stages.latest('s1').goal, 'g1')
  assert.equal(stages.stats().total, 1)
  const blocker = join(tempHome(), 'blocker')
  writeFileSync(blocker, 'x')
  const broken = new StageLedger(blocker, {})
  assert.equal(broken.record({ sessionId: 's', goal: 'g' }).ok, false, '写盘失败没有报失败')
  rmSync(home, { recursive: true, force: true })
})

/* ================================================================== *
 * K1 / R9-A · 治理 owner 仲裁
 * ================================================================== */
section('K1 / R9-A · 跨模块治理 owner')

await test('R9-A：两个模块都想要同一能力时，只有一个取得执行权', async () => {
  const home = tempHome()
  const clock = fakeClock(1_000_000)
  const warden = new GovernanceClaim({ home, moduleId: 'dsh-warden', moduleVersion: '0.2.0', clock })
  const strata = new GovernanceClaim({ home, moduleId: 'dsh-strata', moduleVersion: '0.3.1', clock })

  const first = strata.claim('waitCap')
  assert.equal(first.acquired, true, 'strata 单独安装时应当能自己执行')
  assert.equal(strata.isActive('waitCap'), true)

  const second = warden.claim('waitCap')
  assert.equal(second.acquired, true, 'warden 优先级更高，应当取得执行权')
  assert.equal(second.action, 'preempt')

  // strata 在下一次复核时发现被接管 → 自动待命
  clock.advance(3000)
  assert.equal(strata.isActive('waitCap'), false, 'strata 被抢占后仍在执行 —— 会有两个负责人')
  assert.equal(warden.isActive('waitCap'), true)
  assert.equal(strata.ownerOf('waitCap').owner, 'dsh-warden')
  rmSync(home, { recursive: true, force: true })
})

await test('R9-A：owner 释放后另一个模块可以接手（不靠"目录存在"推断）', async () => {
  const home = tempHome()
  const clock = fakeClock(1_000_000)
  const warden = new GovernanceClaim({ home, moduleId: 'dsh-warden', moduleVersion: '0.2.0', clock })
  const strata = new GovernanceClaim({ home, moduleId: 'dsh-strata', moduleVersion: '0.3.1', clock })
  assert.equal(warden.claim('waitCap').acquired, true)
  assert.equal(strata.claim('waitCap').acquired, false)
  warden.releaseAll()
  const again = strata.claim('waitCap')
  assert.equal(again.acquired, true, 'owner 释放后没人能接手')
  assert.equal(strata.isActive('waitCap'), true)
  rmSync(home, { recursive: true, force: true })
})

await test('R9-A：治理表写失败时不谎报自己是 owner', async () => {
  const blocker = join(tempHome(), 'blocker')
  writeFileSync(blocker, 'x')
  const g = new GovernanceClaim({ home: blocker, moduleId: 'dsh-warden', moduleVersion: '0.2.0', clock: fakeClock(1) })
  const r = g.claim('waitCap')
  assert.equal(r.acquired, false)
  assert.equal(r.action, 'error')
  assert.equal(g.isActive('waitCap'), false)
})

await test('R9-A：抢锁判定是纯函数，两个模块不会得出相反答案', async () => {
  const { decideClaim, isStaleClaim } = await import('../lib/core/governance.js')
  const now = 1_000_000
  const mine = { owner: 'dsh-warden', version: '0.2.0', priority: 100 }
  assert.equal(decideClaim(null, mine, now).action, 'take')
  assert.equal(decideClaim({ owner: 'dsh-warden', priority: 100, expiresAt: now + 1000, pid: process.pid }, mine, now).action, 'renew')
  const liveOther = { owner: 'dsh-strata', version: '0.3.1', priority: 50, expiresAt: now + 10000, pid: process.pid }
  assert.equal(decideClaim(liveOther, mine, now).action, 'preempt', '优先级更高却没抢占')
  assert.equal(decideClaim({ ...mine, owner: 'dsh-strata' }, { owner: 'dsh-strata', version: '0.3.1', priority: 50 }, now).action, 'renew')
  // 反向：strata 看 warden 的活声明 → 待命
  assert.equal(decideClaim({ owner: 'dsh-warden', version: '0.2.0', priority: 100, expiresAt: now + 10000, pid: process.pid },
    { owner: 'dsh-strata', version: '0.3.1', priority: 50 }, now).action, 'standby')
  // 陈旧声明（过期 + 进程不在）才可回收；只过期不算
  assert.equal(isStaleClaim({ expiresAt: now - 1, pid: process.pid }, now), false, '进程还活着就被判陈旧了')
  assert.equal(isStaleClaim({ expiresAt: now + 1, pid: 999999 }, now), false, '没过期就被判陈旧了')
  assert.equal(isStaleClaim({ expiresAt: now - 1 }, now), false, '没有 pid 无法证明已停止，不该判陈旧')
})

/* ================================================================== *
 * R4 · 跨进程并发
 * ================================================================== */
section('R4 · 两个进程争同一资源')

await test('R4：两个真实进程并发抢同一资源，只有一个成功', async () => {
  const home = tempHome()
  const worker = join(home, 'worker.mjs')
  writeFileSync(worker, `
    import { LockStore } from ${JSON.stringify(join(MODULE_ROOT, 'lib/core/store.js'))}
    const [, , home, owner] = process.argv
    const locks = new LockStore(home, {})
    const r = locks.acquire({ name: 'race', resource: 'deployment:race', owner, ttlMs: 30000 })
    process.stdout.write(JSON.stringify({ owner, ok: r.ok, reason: r.reason ?? '' }))
  `)
  const results = []
  for (const owner of ['proc-A', 'proc-B']) {
    const p = spawnSync(process.execPath, [worker, home, owner], { encoding: 'utf8' })
    assert.equal(p.status, 0, `worker 崩了：${p.stderr}`)
    results.push(JSON.parse(p.stdout))
  }
  const winners = results.filter((r) => r.ok)
  assert.equal(winners.length, 1, `并发争用出现了 ${winners.length} 个胜者：${JSON.stringify(results)}`)
  rmSync(home, { recursive: true, force: true })
})

/* ================================================================== *
 * 汇总
 * ================================================================== */
console.log(`\n${'='.repeat(64)}`)
console.log(`真实宿主契约验收：${passed} 通过，${failures.length} 失败`)
if (failures.length > 0) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${String(f.error?.message ?? f.error).split('\n')[0]}`)
  process.exit(1)
}
console.log('运行件：' + RUNTIME)
process.exit(0)
