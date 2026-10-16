/**
 * dsh-strata · 宿主半边：把召回到的记忆注入上下文
 *
 * ── 走的是哪条路，为什么 ───────────────────────────────────────────────
 * 注入的是**一条 durable 的 user message**，走 `agent/pre-step` 的返回批次，
 * 而不是往系统提示词里塞一段字符串。
 *
 * 这条路是抄 `@deepseek-ai/dsh-agent-instructions` 的做法（它是官方包，
 * 也是这个机制唯一的权威样例，实现见 `lib/index.js` 第 1271-1287 行）。
 * 好处是这条消息就是**普通的会话内容**：
 *   - 会照常 replay、compact、resume —— 模型可见状态永远能从会话日志重建；
 *   - 在会话记录里**看得见**，你事后能核对「它当时到底看到了什么」；
 *   - 走 `source` 打标，不会被误当成用户真说的话。
 *
 * 往系统提示词里塞字符串的写法看起来更省事，但它不在会话日志里，
 * 出问题时你无法回答「这一轮它到底看到没看到那条记忆」——
 * 对记忆插件来说，这个可观测性比省几行代码重要得多。
 *
 * ── 硬约束 ─────────────────────────────────────────────────────────────
 * 注入是**每轮请求的组装路径**。这里任何异常都不许冒泡出去 ——
 * 记忆插件坏掉，绝不能让对话本身出错。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from '../core/atomic.js'
import { commitRecall, packInjection, recall } from '../core/recall.js'
import { estimateTokens, stripHarnessPreamble } from '../core/text.js'
import { recallCombined } from '../core/history.js'
import { appendEvent } from '../core/store.js'
import { NUDGE_SOURCE_KIND, barrierLabels, growthDecision, renderNudge } from '../core/pilot.js'
import { countHumanMessages, latestHumanText } from '../core/human.js'
import { GovernanceClaim, MODULE_PRIORITY } from '../core/governance.js'
import { VERSION as STRATA_VERSION } from '../core/config.js'
import { verifiedLabels } from '../core/verified.js'
import { contextOf, lineageOf } from './tools.js'

/** 注入消息的 source 标记。用于识别「这条是我们塞的」，避免重复注入。 */
const SOURCE_KIND = 'strata-memory'
/**
 * 治理声明里"上下文水位提醒"这项能力的名字。
 * ⚠ 必须与 dsh-warden 用的字符串完全一致，否则两边会各自执行、重复提醒（R9-A）。
 */
const WATER_LEVEL_CAPABILITY = 'waterLevelNudge'
/** 会话内粘性集合的上限。超过就丢最不新鲜的（LRU）。 */
const PIN_LIMIT = 8
/** 粘性状态最多记多少个会话（跨重启用，不是权威数据）。 */
const PIN_SESSIONS = 64

/**
 * 注入路径翻历史对话的时间预算（毫秒）。
 *
 * 为什么不沿用 `HistorySearch.search` 的默认 1500（2026-10-14 实测）：
 * 宿主冷启动时读会话日志要现解压 zstd，1.5 秒只够扫完 17 个会话就被截断
 * → `bounded=true`、本轮 0 命中；而同一句话用 `memory_recall` 工具能返回 6 条。
 * 工具路径本来就给 3000（见 `host/tools.js`），这里给 6000 是为了让冷启动
 * 那一次也扫得完。代价只有一个：每个会话的首轮请求最多多等几秒，
 * 而且整个检索在 try/catch 里 fail-open，超时也不会影响这一轮对话。
 */
const HISTORY_DEADLINE_MS = 6000

/**
 * 造一条 durable 的 user message。
 *
 * 形状与 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 一致：
 * `deepFreeze(structuredClone({ ...input, id: randomUUID() }))`。
 * 这里手写而不是 import，理由与 tools.js 相同 —— 宿主半边零非内置依赖。
 */
function createInjectionMessage(body) {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: body,
    }],
    source: { kind: SOURCE_KIND, form: 'recall' },
  }
  try {
    return deepFreeze(structuredClone(message))
  } catch {
    return message
  }
}

/**
 * 造一条**只追加、永不撤换**的提醒消息。
 *
 * ── 为什么必须与记忆块分家 ─────────────────────────────────────────────
 * 记忆块是"版本替换"的（每轮撤旧插新）；提醒如果混在同一个 kind 里，下一轮的
 * `stripInjected` 会把提醒一起撤掉 —— 那正好把前缀缓存打掉，省下的又赔回去。
 * 所以提醒用**独立的 source kind**，只增不改，常驻体积是 O(提醒次数)。
 *
 * @param {string} body 提醒正文（必须短，它会被后续每一步重发）
 */
function createNudgeMessage(body) {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: body }],
    source: { kind: NUDGE_SOURCE_KIND, form: 'nudge' },
  }
  try {
    return deepFreeze(structuredClone(message))
  } catch {
    return message
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * 从一批消息里取最后一条**真人**消息的纯文本，作为召回查询。
 *
 * ⚠ 判据在 `core/human.js`（`source.kind === 'user'`），不是黑名单。
 * 旧写法只排除 `strata-memory` / `strata-nudge`，于是别的插件注入的
 * `role:'user'` 消息会被当成"用户新提问"：补充评审已复现两条反例 ——
 * 同批次「真人问题 → warden 提醒」时选中的是 warden 提醒，
 * 换成 `loom-draft` 时选中的是 Loom 规划快照（R9-B，P1）。
 *
 * 后果不只是召回变脏：query 还会参与跨工作区授权判断，
 * 拿插件文案去提授权是必须堵住的。
 */
function latestUserText(messages) {
  return latestHumanText(messages)
}

/** 一条消息里的纯文本。注入块的幂等判据比对的就是它。 */
function injectedText(message) {
  return (message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n')
}

/** 撤掉本次可见面里**全部**注入块。版本替换的前提：旧块一律不留。 */
function stripInjected(list) {
  return list.filter((message) => message?.source?.kind !== SOURCE_KIND)
}

/**
 * 会话内「已交付」粘性集合（手册 P0-1b）。
 *
 * 为什么要它：安静轮次召回不到东西，`packInjection` 就只剩规则块 —— 若直接
 * 版本替换，上一次带资料的块会被规则块顶掉，**模型把刚记住的东西丢了**。
 * 把上次交付过的 id 传进 `filters.pinned`，它们就继续留在本轮结果里，
 * 正文与上一轮一字不差 ⇒ 命中「无变化」⇒ 一个字都不注入。
 *
 * 为什么要落盘：粘性只活在单次进程里的话，**宿主重启后第一次安静轮次**
 * 就会把资料块顶成规则块。落盘只是为了跨重启，读不到就当空的，不许冒泡。
 * 注：粘性只做「加」，不做「减」；真正约束模型可见面的仍是消息窗口本身。
 */
function createPinStore(home) {
  const dir = typeof home === 'string' && home.length > 0 ? join(home, 'strata') : null
  const file = dir ? join(dir, 'delivered.json') : null
  let state = null
  const load = () => {
    if (state) return state
    state = {}
    if (!file) return state
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      for (const [sessionId, value] of Object.entries(parsed ?? {})) {
        if (!Array.isArray(value?.ids)) continue
        state[sessionId] = { ids: value.ids.filter((id) => typeof id === 'string').slice(-PIN_LIMIT), at: Number(value.at) || 0 }
      }
    } catch { /* 没有这份文件就是没有粘性 */ }
    return state
  }
  const persist = () => {
    const kept = Object.entries(state).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, PIN_SESSIONS)
    state = Object.fromEntries(kept)
    if (!file) return
    try { mkdirSync(dir, { recursive: true }); atomicWrite(file, `${JSON.stringify(state)}\n`) } catch { /* 落盘失败只影响跨重启粘性 */ }
  }
  return {
    get(sessionId) { return sessionId ? load()[sessionId]?.ids ?? [] : [] },
    set(sessionId, ids) {
      if (!sessionId) return
      load()[sessionId] = { ids: [...new Set(ids)].slice(-PIN_LIMIT), at: Date.now() }
      persist()
    },
    clear(sessionId) {
      if (!sessionId || !load()[sessionId]) return
      delete state[sessionId]
      persist()
    },
  }
}

/**
 * 挂上注入监听。
 *
 * @param {object} ctx cordis 上下文
 * @param {{store, ledger, config: () => object, home, sessionQuery: () => any, log}} deps
 * @returns {() => void} 卸载函数
 */
export function installInjection(ctx, deps) {
  const log = deps.log
  /** 会话内已交付的粘性集合（手册 P0-1b）。 */
  const pins = createPinStore(deps.home)
  /** 每个会话上次注入时的「真实用户消息条数」，用来做到一回合至多一次。 */
  const lastUserCount = new Map()

  /**
   * 治理仲裁（补充评审 R9-A）。
   *
   * 水位提醒在套件里有两个实现（strata 的 `contextNudge` 与 warden 的
   * `waterLevelNudge`）。同时开时**只允许一个执行**，否则用户会收到两份
   * 内容相近的提醒、两个设置页显示不同的"生效值"。
   *
   * 判据是 `core/governance.js` 里一条**活着的声明**（谁真的挂上了钩子谁写、
   * 并持续心跳），不是"对方的目录在不在"。warden 优先级更高；
   * strata 单独安装时照常自己执行。这里拿不到声明就只跳过水位提醒，
   * **记忆召回与注入照常工作** —— 那部分不与任何模块重叠。
   */
  let nudgeGovernance = deps.governance ?? null
  let ownsNudgeGovernance = false
  if (!nudgeGovernance && deps.home) {
    try {
      nudgeGovernance = new GovernanceClaim({
        home: deps.home,
        moduleId: 'dsh-strata',
        moduleVersion: STRATA_VERSION,
        priority: MODULE_PRIORITY['dsh-strata'],
        log,
      })
      ownsNudgeGovernance = true
    } catch { nudgeGovernance = null }
  }
  let nudgeOwned = true
  if (nudgeGovernance) {
    try {
      const claim = nudgeGovernance.claim(WATER_LEVEL_CAPABILITY)
      nudgeOwned = claim.acquired
      if (!claim.acquired) {
        log?.info?.(`[strata] 水位提醒由 ${claim.owner || '其他模块'} 执行，strata 待命（${claim.reason}）`)
      }
    } catch { nudgeOwned = true }
  }
  /**
   * **本会话最近一次模型调用的缓存命中量与上下文压力**（token）。
   *
   * 为什么在这里收：手册 §2.4 那个"注入不破前缀缓存、命中 99.9%"是在旧的**追加**设计下测的，
   * 而现在是**每轮撤旧块、尾部重插**。这笔账必须实测 —— 若宿主按位置缓存，
   * 每轮替换会让后续全部 miss，那净损失比本插件全部收益都大。
   *
   * ── 数据源换掉了（综合评审 R2 / 补充评审 R9-A）───────────────────────
   * 旧版挂在 `llm/stream` 上、从**回调入参**里找 usage：
   *
   *     const usage = payload?.usage ?? payload?.chunk?.usage
   *
   * 但实读宿主 `dsh-llm`：
   *
   *     streamWithRegistration(options, prepared) {
   *       return this.ctx.waterfall(this, "llm/stream", options,
   *                                 () => this.adapterStream(options, prepared))
   *     }
   *
   * `options` 是**请求**，usage 只存在于 `next()` 返回的那个
   * `AsyncIterable<StreamChunk>` 里。旧回调看了一眼入参就 `return next()`，
   * **一个 usage 也没采到** —— 评审探针（100500 token 的流）证实提醒从未触发。
   *
   * 改成读 `session/event`：usage 会随 assistant 事件**持久化**，
   * 读事件不消费任何流，天然不重不漏、不会破坏取消语义，还能拿到 turn/step 去重。
   * 提取口径照抄官方 `dsh-token-meter` 的 `usageOf()`，不自创。
   *
   * 三条纪律：① 只订阅公开事件；② 整个回调 try/catch，拿不到就什么都不写
   * （fail-open）；③ 只存数字，**不存 prompt 内容**。
   */
  const cacheSeen = new Map()

  /** 从一个持久化会话事件里取 usage。判定顺序与官方 `usageOf()` 一致。 */
  function usageOfEvent(event) {
    if (!event || typeof event !== 'object') return undefined
    if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
    const stream = event.data?.stream
    if (!Array.isArray(stream)) return undefined
    for (let i = stream.length - 1; i >= 0; i--) {
      if (stream[i]?.type === 'usage' && stream[i].usage) return stream[i].usage
    }
    return undefined
  }

  const rememberUsage = (session, event) => {
    try {
      const sessionId = session?.id
      if (sessionId === undefined || sessionId === null) return
      const usage = usageOfEvent(event)
      if (!usage) return
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
      const read = num(usage.cacheReadTokens)
      const write = num(usage.cacheWriteTokens)
      const fresh = num(usage.inputTokens)
      const out = num(usage.outputTokens)
      // ⚠ 只有**真的出现用量字段**时才更新采样。形状对不上的事件绝不能
      // 覆盖上一次的好样本 —— 尤其不能把「拿不到」伪造成 0。
      if (read === null && write === null && fresh === null && out === null) return
      const previous = cacheSeen.get(String(sessionId))
      const turn = event.data?.turn ?? null
      const step = event.data?.step ?? null
      // 同一 (turn, step) 的重复上报按**替换**处理，与官方 tokenUsage 投影同口径
      const same = previous && previous.turn === turn && previous.step === step
      // ⚠ 缓存字段缺失时**保留上一次已知值**，既不覆盖成 null、也不伪造成 0。
      // 这是 regression.mjs 的 M-AC 钉死的契约：宁可显示"上次报的数"，
      // 也不能把"这次没报"说成"这次命中 0"。
      const keepRead = read !== null ? read : (previous?.read ?? null)
      const keepWrite = write !== null ? write : (previous?.write ?? null)
      cacheSeen.set(String(sessionId), {
        read: keepRead,
        write: keepWrite,
        fresh,
        out,
        // 上下文压力是 **prompt 侧**，不含输出（官方 pressureFrom 同口径）。
        // 旧版把含输出的 totalTokens 当水位，会把"模型刚说了多少"算进"上下文有多满"。
        pressure: (fresh ?? 0) + (keepRead ?? 0) + (keepWrite ?? 0),
        // 累计口径单独保留，供成本观察用；**不拿它当当前上下文**。
        total: Number.isFinite(Number(usage.totalTokens))
          ? Number(usage.totalTokens)
          : (fresh ?? 0) + (keepRead ?? 0) + (keepWrite ?? 0) + (out ?? 0),
        cumulative: same && previous.cumulative
          ? previous.cumulative
          : (previous?.cumulative ?? 0) + (fresh ?? 0) + (keepRead ?? 0) + (keepWrite ?? 0) + (out ?? 0),
        turn,
        step,
        at: Date.now(),
      })
    } catch { /* 采样失败绝不影响主流程（C3） */ }
  }
  if (typeof ctx.on === 'function') {
    try { ctx.on('session/event', rememberUsage) } catch { /* 事件名对不上就是拿不到，不影响注入 */ }
  }

  /** 每个会话「上次提醒时的上下文大小」与「上次提醒时的真实用户消息条数」。 */
  const lastNudgeTokens = new Map()
  const lastNudgeUserCount = new Map()

  /** 给工具层用的会话级缓存/用量采样。拿不到返回 null，绝不编数。 */
  const cacheSample = (sessionId) => (sessionId ? cacheSeen.get(String(sessionId)) ?? null : null)
  // 工具层要能读到（deps 是我们自己的对象，按引用共享）。
  try { deps.cacheSample = cacheSample } catch { /* 只读 deps 就算了 */ }

  /**
   * 增长式上下文提醒。**只追加一条短消息，从不删改任何历史。**
   *
   * 与宿主压缩的分工：宿主管"别把窗口撑爆"（80% 才动），这里管"别让它一直胖"
   * （每长 N token 提醒一次，与窗口无关）。只提醒，决定权在模型。
   *
   * 拿不到宿主上报的用量就**什么都不做**——绝不用自己的估算假装知道。
   */
  const withNudge = (decision, payload, config, context) => {
    try {
      if (config.contextNudge === false) return decision
      // 治理仲裁（R9-A）：warden 也在做水位提醒，两个模块同时开时只一个执行。
      // 挂载时就没抢到声明 → 直接跳过；抢到了也要限频复核，被接管后立刻停手。
      if (!nudgeOwned) return decision
      if (nudgeGovernance && !nudgeGovernance.isActive(WATER_LEVEL_CAPABILITY)) return decision
      const sessionId = context?.sessionId
      if (!sessionId) return decision
      const sample = cacheSample(sessionId)
      // ⚠ 用 **prompt 侧压力**，不是含输出的 total —— 后者会把"模型刚说了多少"
      // 算进"上下文有多满"，导致输出越长越早就提醒（综合评审 R2）。
      const used = Number(sample?.pressure)
      if (!Number.isFinite(used) || used <= 0) return decision
      const verdict = growthDecision(used, lastNudgeTokens.get(sessionId) ?? 0, config)
      if (!verdict.due) {
        // 上下文变小了（宿主压缩过 / 会话被截断）⇒ 重新起算，不拿旧水位比。
        if (verdict.reason === 'reset') lastNudgeTokens.set(sessionId, used)
        return decision
      }
      const list = Array.isArray(decision.messages) ? decision.messages : []
      // 一回合至多一次：判据与记忆块一致（**真人**消息条数），提醒本身不算。
      const userCount = countHumanMessages(list)
      if (lastNudgeUserCount.get(sessionId) === userCount) return decision

      const barriers = barrierLabels(list)
      const verified = config.verifiedLedger === false ? [] : verifiedLabels(deps.home, context.workspace)
      const body = renderNudge({ usedTokens: used, growthTokens: verdict.growth, barriers, verified, frame: true })
      appendEvent({
        kind: 'nudge',
        workspace: context.workspace,
        sessionId,
        count: 1,
        detail: `used=${used}; growth=${verdict.growth}; chars=${body.length}; tokens=${estimateTokens(body)}`
          + `; barriers=${barriers.length}; verified=${verified.length}`
          + `; cacheRead=${sample?.read ?? '-'}; cacheWrite=${sample?.write ?? '-'}`,
      }, deps.home)

      const message = createNudgeMessage(body)
      lastNudgeTokens.set(sessionId, used)
      lastNudgeUserCount.set(sessionId, userCount)
      // 与记忆块同一个位置：插在本轮已认领消息之后。**尾部追加，前缀不动。**
      const lastClaimed = list.findLastIndex((m) => payload?.messages?.includes(m))
      const at = lastClaimed === -1 ? list.length : lastClaimed + 1
      const next = typeof list.toSpliced === 'function'
        ? list.toSpliced(at, 0, message)
        : [...list.slice(0, at), message, ...list.slice(at)]
      return { ...decision, messages: next }
    } catch {
      // 提醒失败不影响这一轮，更不影响记忆注入。
      return decision
    }
  }

  const handler = async (payload, next) => {
    // 先把控制权交出去，拿到这一轮的最终批次。
    // 用 `let`：下面的上下文提醒是**在决策之上追加**一条消息，后面的早退分支
    // 返回的必须是追加后的那一份（否则提醒会被静默丢掉）。
    let decision = await next()
    try {
      const config = deps.config()
      // 只在 `kind === 'enter'` 这一种决策上注入。
      // 依据：宿主的两个官方样例（`dsh-tool-jobs` 与 `subagent-in-process-driver`）
      // 都写成 `if (decision.kind !== 'enter') return decision`。
      // 反过来只挡 `'reject'` 是不严的 —— 遇到别的 kind 就会去改 messages，白改甚至出错。
      if (decision?.kind !== 'enter') return decision

      const agent = payload?.agent
      if (!agent?.session) return decision

      // ── 上下文领航：**独立的一层**，与记忆注入共用一个入口但互不依赖 ──
      // 刻意放在 `injectSection` 判断**之前**：用户把记忆注入关掉，
      // 不代表他不要"上下文别一直胖"的提醒。两者是两件事。
      // `withNudge` 内部自己吞异常，这里不再包一层。
      decision = withNudge(decision, payload, config, contextOf({ agent }, {}))

      // 记忆注入的开关只影响下面这一段。
      if (!config.enabled || !config.injectSection || config.recallLimit <= 0) return decision

      const messages = Array.isArray(decision.messages) ? decision.messages : []
      // 第一步没有新消息（会话刚起）时不注入 —— 那时候还没有可召回的查询。
      if (messages.length === 0 && payload?.step === 1) return decision

      const query = stripHarnessPreamble(latestUserText(messages))
      if (query.length < 2) return decision

      const context = contextOf({ agent }, {})

      // ⚠️ 上面可能刚刚追加过一条提醒，所以从这里开始**必须重新取一次 messages**，
      // 不能再沿用早先那个绑定，否则后面的整段逻辑会基于旧列表，
      // 最终返回时把刚追加的提醒丢掉（这个坑在本文件里踩过一次）。
      const visible = Array.isArray(decision.messages) ? decision.messages : []

      // 本次请求真正会送出去的**可见面**里的注入块。幂等与替换都基于它，
      // 而不是「宿主给的窗口里还看不看得见上一块」（那正是 D1 的根因）。
      const sent = visible.filter((message) => message?.source?.kind === SOURCE_KIND)
      // 一回合至多一次（手册 P0-2）：判据用**真实用户消息条数**，不用宿主的
      // `turn` 字段 —— 那个字段没有公开契约，猜错会让整段会话再也不注入。
      // 只有当上一块已经不在可见面里时才会真的重复追加，所以只在那时启用闸门。
      // 提醒消息（strata-nudge）不算「真实用户消息」，否则每加一条提醒就顶掉一次闸门。
      // 判据统一走 core/human.js：宿主的 source.kind === 'user' 才是真人（R9-B）。
      const userCount = countHumanMessages(visible)
      if (sent.length === 0 && lastUserCount.get(context.sessionId) === userCount) return decision

      try {
        context.lineage = await lineageOf(deps.sessionQuery(), context.sessionId, deps.home)
      } catch { /* 谱系拿不到就当没有 */ }

      // 压缩把块卷走了（或这是本会话第一次）：粘性作废，本轮按查询重建。
      if (sent.length === 0) pins.clear(context.sessionId)
      const pinned = pins.get(context.sessionId)

      const result = await recallCombined(deps, {
        store: deps.store,
        ledger: deps.ledger,
        config,
        query,
        context,
        filters: { pinned },
        // 冷启动时 1500 不够读完会话日志；见文件顶部 HISTORY_DEADLINE_MS 的说明。
        deadlineMs: HISTORY_DEADLINE_MS,
      })
      const latest = deps.config()
      if (!latest.enabled || !latest.injectSection) return decision
      const refreshed = recall({ store: { live: () => result.hits.filter((h) => latest.searchHistory || h.record.origin !== 'history').map((h) => h.record.origin === 'history' ? h.record : deps.store.get(h.record.id)).filter((r) => r && !r.supersededBy) }, ledger: deps.ledger, config: latest, query, context, filters: { pinned } })
      // 上次交接的索引行：新会话的第一句话常常跟交接没有词面重合，
      // 光靠召回阈值它永远出不来，那 memory_handoff 就白存了。
      // 拿不到就算了 —— 注入路径上任何异常都不许冒泡（C3）。
      let handoff = null
      try {
        if (latest.readScope !== 'session') {
          const found = deps.store?.latestHandoff?.(context.workspace)
          if (found && (found.scope !== 'global' || latest.readGlobal)) handoff = found
        }
      } catch { handoff = null }
      const packed = packInjection(refreshed.hits, latest, { handoff })
      const body = packed.body

      // ① 无变化：可见面里只有一块、内容一字不差 → 一个字都不动（也省 KV 缓存）。
      if (body && sent.length === 1 && injectedText(sent[0]) === body) return decision
      // ② 没有内容要交付 → 把旧块撤下来，不留空壳。
      //    注意用 `visible` 而不是最初的 `messages`：提醒是追加过的，不能丢。
      if (!body) return sent.length === 0 ? decision : { ...decision, messages: stripInjected(visible) }

      // ③ 版本替换：先撤掉全部旧块，再插且只插这一块。
      //    常驻体积因此是 O(1) 而不是 O(轮数)。
      //    `stripInjected` 只撤本插件的记忆块；提醒块不受影响（它不在 SOURCE_KIND 里）。
      const withoutOld = stripInjected(visible)
      if (!commitRecall(packed.hits, { ...deps, context, config: latest })) return decision
      pins.set(context.sessionId, packed.hits.map((hit) => hit.record.id))
      lastUserCount.set(context.sessionId, userCount)
      const desired = createInjectionMessage(body)
      // 诊断字段：只记数量与长度，**不记用户原话** —— events.log 是本机审计文件，
      // 但没必要把提问正文也落进去。2026-10-07 那次「重启后第一次注入 0 命中」
      // 就是因为缺这几个数而只能靠猜，所以补上。
      const historyStats = result.stats?.history
      const cache = cacheSeen.get(String(context.sessionId))
      appendEvent({ kind: 'inject', workspace: context.workspace, sessionId: context.sessionId,
        count: packed.hits.length,
        detail: `mode=${sent.length === 0 ? 'insert' : 'replace'}; chars=${body.length}; tokens=${estimateTokens(body)}; history=${packed.hits.filter((h) => h.record.origin === 'history').length}`
          + `; pinned=${pinned.length}; queryLen=${query.length}; searchHistory=${latest.searchHistory}`
          + `; candidates=${historyStats?.candidates ?? '-'}; scanned=${historyStats?.scanned ?? '-'}`
          + `; tookMs=${historyStats?.tookMs ?? '-'}; bounded=${historyStats?.bounded ?? '-'}`
          // 前缀缓存的现场证据：宿主上一次调用的命中量。拿不到就写 `-`，绝不编数。
          + `; cacheRead=${cache?.read ?? '-'}; cacheWrite=${cache?.write ?? '-'}` }, deps.home)

      // 插在「这一轮已经认领的消息」之后 —— 与 agent-instructions 同样的位置
      // （尾部插入实测命中前缀缓存 99.9%，**不许**挪到系统提示词或会话开头）。
      const lastClaimed = withoutOld.findLastIndex((message) => payload.messages?.includes(message))
      const at = lastClaimed === -1 ? withoutOld.length : lastClaimed + 1
      const entered = typeof withoutOld.toSpliced === 'function'
        ? withoutOld.toSpliced(at, 0, desired)
        : [...withoutOld.slice(0, at), desired, ...withoutOld.slice(at)]

      log?.debug?.(`注入 ${result.hits.length} 条记忆（${estimateTokens(body)} tokens，耗时 ${result.stats.tookMs}ms`
        + `${result.stats.foreignHits > 0 ? `，其中 ${result.stats.foreignHits} 条来自其他工作区` : ''}）`)
      return { ...decision, messages: entered }
    } catch (error) {
      // 注入失败绝不影响这一轮对话。
      log?.warn?.(`注入失败（本轮跳过记忆）：${error?.message ?? error}`)
      return decision
    }
  }

  // 用返回的确切句柄卸载；拿不到句柄就说明没挂上，不能假装挂了（R7 同类问题）。
  const offPreStep = ctx.on('agent/pre-step', handler)
  return () => {
    try {
      if (typeof offPreStep === 'function') offPreStep()
      else ctx.off?.('agent/pre-step', handler)
    } catch { /* 卸载失败无所谓 */ }
    // 释放治理声明，否则另一个模块会一直待命、水位提醒彻底没人做。
    if (nudgeGovernance && ownsNudgeGovernance) {
      try { nudgeGovernance.releaseAll() } catch { /* 释放失败不影响卸载 */ }
    }
    nudgeOwned = false
  }
}
