/**
 * dsh-strata · 子代理等待上限（guard）
 *
 * ── 这一层解决什么 ─────────────────────────────────────────────────────
 * 本机 2026-10-14 实测：一个 486 步的会话里 `wait_agent` 被调 41 次，
 * 会话跨度 6 小时而真正在算的只有 73 分钟 —— 其余时间在干等子代理。
 *
 * 根因不在模型「不听话」，而在**没有上限**：
 *   - 宿主 `wait_agent` 的超时是模型每次自己传的（默认 30 秒，允许 10 秒~1 小时）；
 *   - 宿主的 `dsh-tool-call-timeout-policy` 只对「自己声明了 timeoutMs 的工具」生效，
 *     而 `wait_agent` 没声明 —— 所以那个硬超时对它形同虚设。
 *
 * ── 旧实现为什么从来没生效过（补充评审 R9-A / 综合评审 R1）─────────────
 * 旧版挂在 `tools/pre-execute` 上直接改参数：
 *
 *     args.value.timeout_ms = cap;  writeArgs(exec, args)
 *
 * 但实读宿主 `dsh-tools` 的 `createExecution()`：
 *
 *     arguments: deepFreeze(snapshotJsonValue(exec.arguments))
 *
 * `pre-execute` 拿到的参数是**深冻结**的，赋值必抛；异常被自己的 `catch {}`
 * 吞掉后继续 `next()`，工具体照旧收到 900000ms。评审用真实 ToolRuntime
 * 复现了这一点。`pre-execute` 的决策只有 allow/deny/ask/cancel，
 * `tools.guard()` 也只能返回拒绝字符串 —— **两处都改不了参数**。
 *
 * ── 现在的做法：在 `tools/execute` 上给一个期限信号 ────────────────────
 * 官方 `dsh-tool-call-timeout-policy` 就是这么做的：临时把 `exec.signal`
 * 换成带期限的信号，`finally` 里还原。`wait_agent` 恰好把 `exec.signal`
 * 一路交给 `agentTeams.waitForChange(...)` → `TeamActivity.wait()`，
 * 那里监听 abort，所以等待会**真的**提前结束。
 *
 * 期限到了不能让它变成 isError（`TeamActivity.wait()` abort 时是 reject），
 * 否则模型会读成"子代理挂了"。所以替换成 `wait_agent` 自己的正常超时值
 * `{ timedOut: true }`，解释文字走 `additionalContexts`。
 *
 * 关键：`callerCancelled(exec)` 读的是**原始**调用方信号，不是我们替换的
 * `exec.signal`，所以用户取消与护栏截断不会互相冒充。
 *
 * ── 与 dsh-warden 的分工（R9-A）────────────────────────────────────────
 * warden 也有等待上限。两个模块同时开时**只允许一个执行**，否则会出现
 * 两份重复提醒、两个设置页互相约束。谁执行由 `core/governance.js` 的
 * 治理声明决定（warden 优先级更高，strata 单独安装时照常自己执行）。
 * 判据是"谁真的挂上了钩子并写了活声明"，**不是**"对方的目录在不在"。
 *
 * ── 两条纪律 ───────────────────────────────────────────────────────────
 *   1. **只压期限，不做别的。** 不拒绝调用、不删消息、不替模型做决定。
 *   2. **任何异常都必须吞掉。** `tools/execute` 抛出去会打断这次工具调用。
 */

import { GovernanceClaim, MODULE_PRIORITY } from '../core/governance.js'
import { systemClock } from '../core/clock.js'

/** 纳入期限管理的等待类工具。 */
const WAIT_TOOLS = new Set(['wait_agent'])

/** 宿主 `wait_agent` 自己声明的合法区间（实读其 execute）。 */
const HOST_RANGE = { min: 10_000, max: 3_600_000, fallback: 30_000 }

/** 治理声明里这项能力的名字。warden 用的是同一个名字，两边必须一致。 */
export const WAIT_CAP_CAPABILITY = 'waitCap'

/** 只读出模型请求的等待毫秒数。绝不写回冻结参数。 */
export function requestedWaitMs(exec) {
  const raw = exec?.arguments
  let args = raw
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw) } catch { return null }
  }
  if (!args || typeof args !== 'object') return null
  const value = Number(args.timeout_ms)
  return Number.isFinite(value) ? value : null
}

/**
 * 这次等待该不该被截短。
 * @returns {{effective: number, requested: number|null}|null}
 */
export function planWaitCap(exec, capMs) {
  const cap = Number(capMs)
  if (!Number.isFinite(cap) || cap <= 0) return null
  if (!WAIT_TOOLS.has(String(exec?.name ?? ''))) return null
  const requested = requestedWaitMs(exec)
  // 越界值交给宿主自己报错，我们不插手
  if (requested !== null && (!Number.isSafeInteger(requested) || requested < HOST_RANGE.min || requested > HOST_RANGE.max)) return null
  const assumed = requested ?? HOST_RANGE.fallback
  if (assumed <= cap) return null
  return { effective: cap, requested }
}

/** 这个工具的输出 schema 收不收 `{ timedOut: true }`。收不下就不替换结果。 */
export function acceptsTimedOutValue(tool) {
  const schema = tool?.output?.schema
  if (!schema || typeof schema !== 'object' || schema.type !== 'object') return false
  if (schema.properties?.timedOut?.type !== 'boolean') return false
  const required = Array.isArray(schema.required) ? schema.required : []
  return required.every((key) => key === 'timedOut')
}

/** 期限到了之后给模型看的那句话。 */
export function waitCapNotice(capMs, requested) {
  const capSec = Math.round(Number(capMs) / 1000)
  const wantSec = Number.isFinite(Number(requested)) ? Math.round(Number(requested) / 1000) : null
  return `[strata] \`wait_agent\` 的等待在 ${capSec} 秒处被截断`
    + `${wantSec !== null ? `（你请求的是 ${wantSec} 秒）` : '（你没有指定时长，用的是宿主默认值）'}。\n`
    + `这**不代表子任务失败了** —— 它可能还在跑。等待超时和子任务失败是两件事。\n`
    + `现在该做的：① \`list_agents\` 看各成员真实状态；② 必需成员是 inactive 就先用 \`send_message\` 叫醒它；`
    + `③ 同时推进不依赖它的独立工作。不要用更长的 timeout_ms 原地重试。`
}

/**
 * 挂上等待上限。返回卸载函数；拿不到钩子或治理判给别人时返回 null。
 *
 * @param {any} ctx cordis 上下文
 * @param {{config: () => any, home: string, log?: any, clock?: any,
 *          governance?: any, onGovernance?: (info: object) => void}} deps
 */
export function installGuard(ctx, deps) {
  if (typeof ctx?.on !== 'function') return null

  /* ---- 治理仲裁：同一能力全套件只一个执行者 ---- */
  let governance = deps.governance
  let ownsGovernance = false
  if (!governance) {
    governance = new GovernanceClaim({
      home: deps.home,
      moduleId: 'dsh-strata',
      moduleVersion: 'strata',
      priority: MODULE_PRIORITY['dsh-strata'],
      clock: deps.clock ?? systemClock(),
      log: deps.log,
    })
    ownsGovernance = true
  }
  const claim = governance.claim(WAIT_CAP_CAPABILITY)
  if (!claim.acquired) {
    deps.log?.info?.(`[strata] 等待上限由 ${claim.owner || '其他模块'} 执行，strata 待命（${claim.reason}）`)
    deps.onGovernance?.({ capability: WAIT_CAP_CAPABILITY, active: false, owner: claim.owner, reason: claim.reason })
    return null
  }
  deps.onGovernance?.({ capability: WAIT_CAP_CAPABILITY, active: true, owner: 'dsh-strata', reason: claim.reason })

  const clock = deps.clock ?? systemClock()
  const stats = { armed: 0, capped: 0 }
  const disposers = []

  try {
    const off = ctx.on('tools/execute', async (exec, next) => {
      // 每次动手前复核一次：被 warden 接管后要立刻停手（最多一个心跳的延迟）
      if (!governance.isActive(WAIT_CAP_CAPABILITY)) {
        deps.log?.warn?.('[strata] 等待上限执行权已被接管，本模块停止介入')
        deps.onGovernance?.({ capability: WAIT_CAP_CAPABILITY, active: false, owner: governance.ownerOf(WAIT_CAP_CAPABILITY).owner, reason: '运行中被接管' })
        return next()
      }

      let plan = null
      try {
        const config = deps.config?.() ?? {}
        if (config.enabled === false) return await next()
        plan = planWaitCap(exec, config.subagentWaitCapMs)
      } catch { plan = null }
      if (!plan) return await next()

      const upstream = exec.signal
      const controller = new AbortController()
      let fired = false
      const onUpstreamAbort = () => controller.abort(upstream?.reason)
      if (upstream?.aborted) controller.abort(upstream.reason)
      else upstream?.addEventListener?.('abort', onUpstreamAbort, { once: true })
      const timer = clock.setTimeout(() => { fired = true; controller.abort(new Error('STRATA_WAIT_CAP')) }, plan.effective)

      stats.armed++
      exec.signal = controller.signal
      try {
        const result = await next()
        if (!fired) return result
        stats.capped++
        deps.log?.info?.(`[strata] wait_agent 等待已截断到 ${plan.effective}ms（累计 ${stats.capped} 次）`)
        const notice = {
          id: `strata-waitcap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          content: [{ type: 'text', text: waitCapNotice(plan.effective, plan.requested) }],
          // 带上 source.kind，让别的插件不会把它当成真人提问（R9-B）
          source: { kind: 'strata-nudge', form: 'notice', summary: `wait cap ${plan.effective}ms` },
        }
        let canSubstitute = false
        try { canSubstitute = acceptsTimedOutValue(ctx.get?.('tools')?.get?.(exec.name, exec.agent)) } catch { canSubstitute = false }
        const extra = [...(result?.additionalContexts ?? []), notice]
        if (canSubstitute && !upstream?.aborted) return { isError: false, value: { timedOut: true }, additionalContexts: extra }
        return result && typeof result === 'object' ? { ...result, additionalContexts: extra } : result
      } finally {
        clock.clearTimeout(timer)
        upstream?.removeEventListener?.('abort', onUpstreamAbort)
        exec.signal = upstream
      }
    })
    if (typeof off === 'function') disposers.push(off)
    else {
      deps.log?.warn?.('[strata] tools/execute 注册没有返回卸载句柄，等待上限未生效')
      if (ownsGovernance) governance.releaseAll()
      return null
    }
  } catch (error) {
    deps.log?.warn?.(`[strata] 等待上限钩子挂载失败：${error?.message ?? error}`)
    if (ownsGovernance) governance.releaseAll()
    return null
  }

  const dispose = () => {
    for (const d of disposers) { try { d() } catch { /* 清理失败无所谓 */ } }
    disposers.length = 0
    if (ownsGovernance) governance.releaseAll()
  }
  dispose.stats = stats
  dispose.governance = governance
  return dispose
}
