/**
 * dsh-warden · 上下文层（`agent/pre-step` + `systemPrompt.section`）
 *
 * ── 这一层现在只做两件事 ───────────────────────────────────────────────
 *
 * ① **子代理纪律（星型拓扑 + 结论落文件）** —— 写进系统提示词的独立 section。
 *    它是**规则**不是**拦截**，跟着每一轮请求走，压缩之后也还在，
 *    比每轮塞一条消息便宜得多。
 *
 * ② **水位提醒** —— 数据来自 `host/usage.js`（官方 `contextPressure` 投影
 *    优先，退化到 `session/event` 账本，都没有就明确显示 unknown）。
 *    只提醒，不删改历史。
 *
 * ── 已经删掉的第三件事：历史"微压缩"（R3）────────────────────────────
 * 旧版在这里筛 `decision.messages` 里 `role === 'tool'` 的消息并换成占位符。
 * 实读宿主 `dsh-agent-loop` 的 `preStep()`：
 *
 *     const claimed = this.inbox.claim(target, position.turn)
 *     const decision = await this.dispatch.waterfall("agent/pre-step",
 *       { messages: claimed, ...position, signal },
 *       () => Promise.resolve({ kind: "enter",
 *                               messages: context === undefined ? claimed : [...claimed, context] }))
 *
 * `messages` 是 **inbox 待追加的那一批新消息**（外加一条 runtime context），
 * 随后 `step()` 把它 append 成新的 user/message；完整历史要到 `buildRequest()`
 * 才从 session surface 构建。**这一层通常根本没有旧工具结果。**
 * 旧单测人为往这批里塞了 20 条历史 tool 消息，于是测过了一个生产不存在的输入。
 *
 * 而且占位符写的是"请重新执行那个工具" —— 部署、写文件、发网络请求都
 * **不可重放**，把它当默认找回手段是错的。
 *
 * 所以本版：
 *   - `microCompact` 在**所有档位默认关闭**，且这一层不再裁剪历史；
 *   - 历史压缩的唯一 owner 是官方 `dsh-compaction-basic`
 *     （它挂在 `agent/pre-step` 上做压力压缩、`agent/request-error` 上做溢出重试，
 *      配置走 `modelPolicies` / `retainTokens`）。warden 不插第二个 owner；
 *   - 单条超长结果由官方 `dsh-compaction-tool-result-pruner` 处理
 *     （`thresholdChars: 8192`，head+tail）；
 *   - warden 自己那一份改成对**新产生的**大文本结果做归档 + 有界呈现，
 *     见 `host/archive.js`（挂在 `tools/post-execute`，那才是结果进入
 *     surface 之前的位置）。
 *
 * 这一层的能力状态里会明确写 `historyPruning = unsupported`，
 * **不假装可用**。
 *
 * ── 契约（实读 0.2.0-rc.2 运行件核对过）───────────────────────────────
 *   `agent/pre-step` 是 waterfall：`(payload, next) => decision`。
 *   payload = `{ messages, turn, step, signal, agent }`
 *   （`agent` 由 `dsh-agent` 的 `agentEvents().fused()` 注入，官方
 *    `dsh-compaction-basic:839` 与 `dsh-agent:193` 都是这么解构的）。
 *   - 必须 `await next()` 拿到最终批次，再在它之上改
 *   - 改写时**必须 spread**：`{ ...decision, messages }`
 *   - 只在 `decision.kind === 'enter'` 上动手
 *
 *   `systemPrompt.section({ name, order, text, interpolate?, complete? })`
 *   - `order` 必须是有限数，否则 TypeError
 *   - `text` 可以是字符串**或**函数（`assemble()` 里
 *     `typeof section.text === "function" ? section.text(context) : section.text`）
 *   - 同一层重名会抛
 *   - 返回「the exact Cordis effect disposer」—— **只有这个返回值**能证明挂上了
 */

import { randomUUID } from 'node:crypto'
import { resolveContextLoad } from './usage.js'

/** 提醒消息的 source 标记。与 `host/after.js` 用同一个 kind，便于事后筛选。 */
const NOTICE_KIND = 'warden'
const RULES_SECTION = 'warden:rules'

/**
 * section 的排序值。
 *
 * `getSectionOrder('warden:rules')` 会返回 `undefined`（`SECTION_ORDERS` 里
 * 没有这个名字，实读其实现是 `return SECTION_ORDERS[name]`，不抛），
 * 而 `section()` 要求 `order` 必须是有限数 —— 所以这里显式兜底。
 * 取 650：排在官方 `PLAN_POLICY`(500) 与 `TEAM_POLICY`(600) 之后，
 * 因为这几条纪律本来就是团队/计划层面的补充。
 */
const DEFAULT_SECTION_ORDER = 650

/**
 * 星型拓扑 + 结论落文件的规则正文。
 *
 * 写得短是刻意的：这段会跟着**每一轮请求**走，多一个字就是多一分常驻成本。
 */
export function rulesText(config = {}) {
  const parts = []
  if (config.starTopology !== false) {
    parts.push(
      '## 子代理纪律（星型拓扑）\n'
      + '- 默认走星型：子代理**向主控汇报**，由主控转达。需要协作时把请求发给主控。\n'
      + '- **不要私自**给其他子代理发消息、也不要回复它们的私聊，更不要互相"更正（请以这条为准）"——'
      + '两个子代理互相纠错时，读数会互相污染，最后谁都说不清哪个数是谁测的。\n'
      + '- 例外：**经调度的**结构化协调是合法的。如果规划模块（Loom）已经批准了计划、'
      + '给出了成员白名单和轮数上限，并由运行时转发跨组消息，那就按它的要求返回结构化协调请求，'
      + '不要因为这条纪律而拒绝输出。判据是"有没有经过批准与转发"，不是"有没有跟别人说话"。\n'
      + '- 派活给子代理时，必须写清三件事：**目标、输出格式、边界**（哪些不做）。'
      + '边界不写，子代理就会重复劳动或留空。',
    )
  }
  if (config.resultsToFile !== false) {
    parts.push(
      '## 子代理结论落文件\n'
      + '- 子代理的结论**写进文件**（例如 `probe/<角色名>.md`），只把**文件路径 + 一行摘要**回给主控。\n'
      + '- 不要把大段结论直接贴进对话 —— 那会让主控的上下文迅速膨胀，而且每次转述都会失真。',
    )
  }
  if (config.lockGuard !== false) {
    parts.push(
      '## 共享资源\n'
      + '- 动手写一个"大家都会用"的资源之前，先用 `acquire_lock` 取得执行权；拿不到会告诉你现在是谁占着。\n'
      + '- 能**物理隔离**就隔离（各自一个独立目录/分支），比排队等锁省时间得多。\n'
      + '- 隔离不了的资源（桌面、显示模式、部署目标、端口、数据库、全局开关）才用锁。\n'
      + '- 锁**只覆盖护栏认得的写入路径**；任意 shell 命令里看不出来的写入不在覆盖范围内，别把它当成全局强制。',
    )
  }
  if (config.evidenceLedger !== false) {
    parts.push(
      '## 读数要能归属\n'
      + '- 记录任何测量结果时，**同时绑定当时产物的指纹**（sha256）。\n'
      + '- 复核时先比指纹：对不上就**直接判这条读数作废**，不要事后人工排查"这是哪一版的数"。\n'
      + '- 没绑定产物、产物读不到、环境未知的读数一律是 `unverified`，**不是** `verified`。',
    )
  }
  if (config.archiveToolResults !== false) {
    parts.push(
      '## 大输出会被归档\n'
      + '- 很长的工具输出会被自动落盘，你只看到有界摘要 + 文件路径 + 指纹。\n'
      + '- 需要原文时**按路径和行区间去读**（宿主自带的读取工具就能读），不要重新执行那个工具 —— '
      + '写入、部署、网络请求这类操作重跑一次就有副作用。',
    )
  }
  if (parts.length === 0) return ''
  return `<!-- warden -->\n${parts.join('\n\n')}\n`
}

/**
 * 水位提醒正文。
 *
 * `load` 是 `resolveContextLoad()` 的结果 —— 一定带上 `basis`，
 * 拿不到窗口大小时**明确说不知道占比**，不编一个百分比。
 */
export function waterLevelText(load, growth) {
  const k = (n) => `${Math.round(Number(n) / 1000)}k`
  const head = load.ratio !== null && load.ratio !== undefined
    ? `[warden] 当前上下文压力约 ${k(load.pressureTokens)} token，占窗口 ${Math.round(load.ratio * 100)}%`
      + `（窗口 ${k(load.contextWindow)}）`
    : `[warden] 当前上下文压力约 ${k(load.pressureTokens)} token（读不到窗口大小，占比未知）`
  const growthPart = Number.isFinite(growth) && growth > 0 ? `，比上次提醒又长了 ${k(growth)}` : ''
  const basisNote = load.basis === 'session-event:last-usage'
    ? '\n（这个数取自最近一次请求上报的 usage，不是宿主的实时投影；宿主的压缩看不到它。）'
    : ''
  return `${head}${growthPart}。${basisNote}\n`
    + `继续硬撑下去，后面每一步都会更慢、更贵，而且模型更容易忘掉前面说过的话。\n`
    + `建议现在做一件事：把已经确定下来的结论/决定写进文件或长期记忆，然后\n`
    + `① 收尾当前这一件事，开一个新会话继续；或者 ② 用 \`/compact\` 主动压缩。\n`
    + `**不要**在上下文已经很满的时候再开一批新子代理。`
}

/** 造一条提醒消息。 */
export function createNotice(text, summary) {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: NOTICE_KIND, form: 'notice', summary: String(summary ?? '').slice(0, 60) },
  }
  try { return structuredClone(message) } catch { return message }
}

/** 取服务：拿不到返回 null，不抛。 */
function requireService(ctx, name) {
  try { return ctx.get?.(name) ?? null } catch { return null }
}

/**
 * 把规则挂进系统提示词。
 *
 * @returns {{dispose: () => void}|null} 只有拿到**这次注册返回的确切句柄**才返回非 null。
 */
function installRulesSection(ctx, deps) {
  const systemPrompt = requireService(ctx, 'systemPrompt')
  if (!systemPrompt?.section) {
    deps.capabilities?.markUnsupported?.('rulesSection', '宿主没有 systemPrompt.section')
    return null
  }
  deps.capabilities?.markSupported?.('rulesSection', 'systemPrompt.section 可用')
  try {
    const order = (() => {
      const value = systemPrompt.getSectionOrder?.(RULES_SECTION)
      return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_SECTION_ORDER
    })()
    const disposer = systemPrompt.section({
      name: RULES_SECTION,
      order,
      text: () => rulesText(deps.config?.() ?? {}),
    })
    if (typeof disposer !== 'function') {
      deps.capabilities?.markDegraded?.('rulesSection', 'section() 没有返回卸载句柄')
      return null
    }
    deps.capabilities?.markMounted?.('rulesSection', disposer, `order=${order}`)
    return { dispose: disposer }
  } catch (error) {
    // 重名（重载时上一份没卸干净）也走到这里 —— 明确报出来，不静默。
    deps.capabilities?.markDegraded?.('rulesSection', `section 注册失败：${error?.message ?? error}`)
    deps.log?.warn?.(`系统提示词 section 挂载失败（改用消息注入兜底）：${error?.message ?? error}`)
    return null
  }
}

/**
 * 挂上上下文层。返回卸载函数。
 *
 * @param {any} ctx cordis 上下文
 * @param {{config: () => any, home: string, log?: any, capabilities?: any,
 *          ledger?: any, onEvent?: (e: object) => void}} deps
 */
export function installInjection(ctx, deps) {
  if (typeof ctx?.on !== 'function') {
    deps.capabilities?.markUnsupported?.('waterLevelNudge', '拿不到 ctx.on')
    return null
  }
  const disposers = []
  const stats = { nudge: 0, ruleFallback: 0, steps: 0, loadUnknown: 0 }

  // 历史压缩：明确标不支持，不假装可用（R3）。
  deps.capabilities?.markUnsupported?.(
    'historyPruning',
    'warden 不裁剪历史；唯一 owner 是官方 dsh-compaction-basic（+ tool-result-pruner 治单条超长）',
  )

  /* ---------- ① 系统提示词里的规则（主通道） ---------- */
  // ⚠ 这个句柄必须**单独**记。旧版把它和 llm/stream、pre-step 的监听器
  // 一起塞进同一个 disposers 数组，然后用 `disposers.length > 0` 判断
  // "section 挂上了" —— section 注册抛错时那个判断依然为真，兜底永远不触发。
  let sectionHandle = null
  try {
    sectionHandle = installRulesSection(ctx, deps)
    if (sectionHandle) disposers.push(sectionHandle.dispose)
  } catch (error) {
    deps.capabilities?.markDegraded?.('rulesSection', `规则 section 挂载异常：${error?.message ?? error}`)
  }

  /* ---------- ② 每步：水位提醒 + 规则兜底 ---------- */
  const lastNudgeTokens = new Map()
  const ruleInjected = new Set()
  // 治理仲裁（K1 / R9-A）：水位提醒在套件里有两个实现，
  // 判给别人时这里置 false，section 规则照常下发，但不再发水位提醒。
  let waterLevelOwned = true

  const handler = async (payload, next) => {
    let decision = await next()
    try {
      const config = deps.config?.() ?? {}
      if (config.enabled === false) return decision
      if (decision?.kind !== 'enter') return decision

      const agent = payload?.agent
      const session = agent?.session
      if (!session) return decision
      const sessionId = String(session.id ?? '')
      if (!sessionId) return decision
      const workspace = session.header?.cwd ?? ''
      stats.steps++

      // ── ②a 规则兜底：只有在 section **确实没挂上**时才注入 ──
      if (sectionHandle === null && !ruleInjected.has(sessionId)) {
        const text = rulesText(config)
        if (text.length > 0) {
          const list = Array.isArray(decision.messages) ? decision.messages : []
          decision = { ...decision, messages: [...list, createNotice(text, 'warden rules')] }
          ruleInjected.add(sessionId)
          stats.ruleFallback++
          deps.capabilities?.markObserved?.('rulesFallback', `section 不可用，已注入消息 @${sessionId}`)
          deps.onEvent?.({ kind: 'rules-fallback', workspace, sessionId, detail: 'systemPrompt.section 未挂上，改用一次性消息注入' })
        }
      } else if (sectionHandle !== null) {
        deps.capabilities?.markObserved?.('rulesSection', `section 随请求下发 @${sessionId}`)
      }

      // ── ②b 水位提醒 ──
      if (config.waterLevelNudge !== false && waterLevelOwned) {
        const load = resolveContextLoad(ctx, session, sessionId, deps.ledger)
        if (!load.known) {
          // 读不到就是读不到：记一次 unknown，不发提醒、不编数字。
          stats.loadUnknown++
          deps.capabilities?.markDegraded?.('contextPressure', `会话 ${sessionId} 读不到上下文压力（basis=unknown）`)
        } else {
          deps.capabilities?.markObserved?.('contextPressure', `basis=${load.basis} pressure=${load.pressureTokens}`)
          const used = load.pressureTokens
          const step = Number(config.waterLevelStep) || 50000
          const ratio = Number(config.waterLevelRatio) || 0
          const ratioTarget = ratio > 0 && load.contextWindow ? load.contextWindow * ratio : null
          const previous = lastNudgeTokens.get(sessionId) ?? 0
          const byStep = used - previous >= step
          const byRatio = ratioTarget !== null && used >= ratioTarget && previous < ratioTarget

          if (used < previous) {
            // 压力变小了（官方 Basic 压缩过 / 会话被截断）⇒ 重新起算，不提醒。
            lastNudgeTokens.set(sessionId, used)
          } else if (byStep || byRatio) {
            const list = Array.isArray(decision.messages) ? decision.messages : []
            decision = {
              ...decision,
              messages: [...list, createNotice(waterLevelText(load, used - previous), 'context level')],
            }
            lastNudgeTokens.set(sessionId, used)
            stats.nudge++
            deps.capabilities?.markObserved?.('waterLevelNudge', `used=${used} basis=${load.basis}`)
            deps.onEvent?.({
              kind: 'water-level',
              workspace,
              sessionId,
              detail: `pressure=${used}; basis=${load.basis}; step=${step}`
                + `${load.contextWindow ? `; window=${load.contextWindow}` : '; window=unknown'}`,
            })
          }
        }
      }
    } catch (error) {
      // 上下文层失败绝不能影响这一轮对话，但要限频报出来。
      deps.capabilities?.markDegraded?.('waterLevelNudge', `pre-step 处理异常：${error?.message ?? error}`)
      deps.log?.warn?.(`上下文层失败（本轮跳过）：${error?.message ?? error}`)
    }
    return decision
  }

  let off = null
  try {
    off = ctx.on('agent/pre-step', handler)
  } catch (error) {
    deps.capabilities?.markDegraded?.('waterLevelNudge', `pre-step 挂载失败：${error?.message ?? error}`)
    deps.log?.warn?.(`pre-step 挂载失败：${error?.message ?? error}`)
  }
  if (typeof off === 'function') {
    disposers.push(off)
    deps.capabilities?.markMounted?.('waterLevelNudge', off, 'agent/pre-step')
    deps.capabilities?.markSupported?.('rulesFallback', '消息注入兜底通道')
  } else {
    deps.capabilities?.markDegraded?.('waterLevelNudge', 'agent/pre-step 注册没有返回卸载句柄')
  }

  const dispose = () => {
    for (const d of disposers) {
      try { d() } catch { /* 清理失败无所谓 */ }
    }
    disposers.length = 0
    sectionHandle = null
    deps.capabilities?.markUnmounted?.('waterLevelNudge', '已卸载')
    deps.capabilities?.markUnmounted?.('rulesSection', '已卸载')
  }
  dispose.stats = stats
  dispose.handle = off
  dispose.sectionMounted = () => sectionHandle !== null
  /**
   * 治理仲裁开关（K1 / R9-A）。
   *
   * `false` = 水位提醒的执行权判给了套件里另一个模块，本模块只保留
   * 规则 section，不再发水位提醒 —— 保证"每次只有一份治理提醒"。
   * 被抢占后重新取得执行权时再置回 `true`。
   */
  dispose.setWaterLevelOwned = (owned) => {
    waterLevelOwned = owned !== false
    if (!waterLevelOwned) {
      deps.capabilities?.markStandby?.('waterLevelNudge', '', '治理声明判给了其他模块，本模块不发水位提醒')
      lastNudgeTokens.clear()
    }
    return waterLevelOwned
  }
  dispose.waterLevelOwned = () => waterLevelOwned
  return dispose
}
