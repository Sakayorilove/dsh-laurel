/**
 * dsh-strata · 存储层：记忆本体 + 授权台账 + 事件日志
 *
 * ── 为什么不用宿主官方的 `ctx.storageDomain` ─────────────────────────────
 * 诚实说明取舍。官方 domain 要求 zod 记录 schema（`domainTable(schema)` 的
 * `valueSchema` 必须是 zod）。而 zod 在当前 profile 里只是别的插件的**传递依赖**，
 * 不保证存在；`defineDomain` / `domainTable` 本身只是校验与恒等包装，抄过来不难，
 * 但 valueSchema 换不掉。
 *
 * 换成 `$DSH_HOME/strata/` 下的**追加式 JSONL**，代价是失去 domain/changed 事件
 * 与 schema 校验；换来的是：只用 node 内置模块、零依赖、可手工编辑、可 diff、
 * 可 git 管、坏一条不影响其余 —— 这正是 Laurel 在同一台机器上验证过的路子。
 * 对「记忆」这种要长期留存、要能事后审计的数据，追加式日志比 KV 域更合适：
 * 遗忘是**追加一条 supersede**，不是删行，所以永远查得到「它曾经是什么」。
 */

import { openSync, fstatSync, readSync, closeSync, appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { atomicWrite } from './atomic.js'
import { createHash } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { KINDS, SCOPE_RANK, SCOPES, pluginPaths, workspaceKey } from './config.js'
import { normalizeBody, stripHarnessPreamble } from './text.js'

/** 记忆日志的格式版本。将来改结构时用它做迁移判定。 */
const LOG_VERSION = 1

/** 事件日志上限。超过就只留最后 200 行。 */
const EVENT_LOG_MAX_BYTES = 512 * 1024
const EVENT_DETAIL_MAX_CHARS = 400
/**
 * 允许的事件类型。**不在这个集合里的一律被记成 `error`** —— 所以新增
 * 一类事件时必须同步加到这里，否则审计日志里会凭空多出一堆假 error
 * （2026-10-14 加上下文提醒时就踩了一次，被 tests/context-pilot.mjs 抓到）。
 */
const EVENT_KINDS = new Set(['ready', 'recall', 'remember', 'forget', 'link', 'promote', 'grant', 'revoke', 'deny', 'error', 'warn', 'config', 'backfill', 'scan', 'inject', 'handoff', 'nudge', 'verified'])

/**
 * 内容寻址 id：同一句话（归一化后）在同一作用域、同一工作区里恒等。
 *
 * 这样「重复记住同一件事」天然幂等，而不是堆出一串近义记忆。
 * 跨作用域刻意算成不同 id —— L1 的工作区记忆和 L2 的全局记忆
 * 是两条独立的东西，提升是**改写**（追加一条 promote），不是改 id。
 */
export function memoryId(body, scope, workspace, sessionId = null) {
  const key = `${normalizeBody(body)}|${scope}|${workspaceKey(workspace)}${scope === 'session' ? `|${sessionId ?? ''}` : ''}`
  return createHash('sha1').update(key).digest('hex').slice(0, 16)
}

function clamp01(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

/* ------------------------------------------------------------------ *
 * 事件日志
 * ------------------------------------------------------------------ */

/** 追加一条事件。日志是「事后能核对」的地基，所以任何 IO 失败都吞掉。 */
export function appendEvent(event, home) {
  const paths = pluginPaths(home)
  const record = {
    t: new Date().toISOString(),
    kind: EVENT_KINDS.has(event?.kind) ? event.kind : 'error',
    workspace: typeof event?.workspace === 'string' ? event.workspace.slice(0, 200) : null,
    sessionId: typeof event?.sessionId === 'string' ? event.sessionId.slice(0, 80) : null,
    count: Number.isFinite(event?.count) ? event.count : null,
    detail: typeof event?.detail === 'string' ? event.detail.slice(0, EVENT_DETAIL_MAX_CHARS) : null,
  }
  try {
    mkdirSync(paths.dir, { recursive: true })
    try {
      if (existsSync(paths.events) && statSync(paths.events).size > EVENT_LOG_MAX_BYTES) {
        const kept = readFileSync(paths.events, 'utf8').split('\n').filter(Boolean).slice(-200)
        writeFileSync(paths.events, `${kept.join('\n')}\n`, 'utf8')
      }
    } catch { /* 截断失败就继续追加 */ }
    appendFileSync(paths.events, `${JSON.stringify(record)}\n`, 'utf8')
  } catch { /* 日志失败不影响主流程 */ }
  return record
}

/** 读最近 limit 条事件（倒序）。 */
export function readEvents(limit = 50, home) {
  const paths = pluginPaths(home)
  try {
    if (!existsSync(paths.events)) return []
    const lines = readFileSync(paths.events, 'utf8').split('\n').filter(Boolean)
    const rows = []
    for (const line of lines.slice(-Math.max(1, Math.min(500, limit)))) {
      try { rows.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
    }
    return rows.reverse()
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ *
 * 本地账本（手册 §7.5 差异化 #1：唯一一个能自证花销的记忆插件）
 * ------------------------------------------------------------------ */

/** 从 detail 字符串里取一个整数；取不到给 null（不猜、不补 0）。 */
const detailNumber = (text, key) => {
  const matched = new RegExp(`(?:^|[;\\s])${key}=(-?\\d+)`).exec(text ?? '')
  return matched ? Number(matched[1]) : null
}

/**
 * 读 `events.log` 算出「这个插件到底往上下文里塞了多少、有没有真花过模型钱」。
 * 纯本地：不联网、不调模型。
 *
 * ⚠ **两个数别搞混，这是这张表最容易读错的地方**：
 *   - `resident*` —— 当前**常驻块**的体积，也就是接下来每一轮都要重付的那一份。
 *   - `blocks`/`chars` —— **累计写入**：注入块每被替换一次就再记一遍，同一份内容会被数很多次。
 *     拿它当"花了多少钱"会**严重高估**（手册 §2.1 那个 0.054% 是按 token×步数 加权的）。
 *
 * token 数**取自注入时算好的 `tokens=` 字段**，不在这里从字符数反推：
 * `estimateTokens` 是中文约 1 字 ≈ 1 token、英文约 4 字符 ≈ 1 token，用 `'x'.repeat(chars)`
 * 反推会**低估**：纯中文实测低估 3.6 倍（100 个中文字 = 91 token，100 个 `x` 只算 25），
 * 真实注入块是中英混排（边界、JSON 转义都是 ASCII），实测低估 2.24 倍（1522 字符 = 853 token，
 * 反推只给 381）。比例随内容变，所以更不能反推。
 * 老日志没这个字段就计入 `tokenless` 如实报缺，不编数。
 *
 * 两条诚实的限制，都写进返回值里：
 *   1. 宿主**没有金额/计价服务**（已查过声明，见 docs/0.4.0-P1落地记录与交接.md §6），
 *      所以这里只有字符与 token 估算，不是账单；
 *   2. 日志会自我截断（超过 512KB 只留最近 200 条）⇒ `since` 是**日志里最早的一条**，
 *      不是"从安装至今"。
 *
 * @param {string} home
 * @param {{limit?: number, now?: number, windowMs?: number}} [options]
 */
export function costLedger(home, options = {}) {
  const rows = readEvents(options.limit ?? 500, home)
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : 86400000
  const bucket = () => ({ blocks: 0, chars: 0, tokens: 0, hits: 0, tokenless: 0, stored: 0, bodyChars: 0, materialChars: 0, paidCalls: 0, paidIn: 0, paidOut: 0, paidKept: 0 })
  const total = bucket()
  const day = bucket()
  let resident = null
  for (const row of rows) {
    if (!row || typeof row.detail !== 'string') continue
    const at = Date.parse(row.t)
    const fresh = Number.isFinite(at) && at >= now - windowMs
    // 同一条事件既进累计也进窗口，用循环写一遍，别再出现「只加到 total 忘了 day」那种漂移。
    const targets = fresh ? [total, day] : [total]
    if (row.kind === 'inject') {
      const chars = detailNumber(row.detail, 'chars') ?? 0
      const tokens = detailNumber(row.detail, 'tokens')
      const hits = Number.isFinite(row.count) ? row.count : 0
      for (const target of targets) {
        target.blocks++; target.chars += chars; target.hits += hits
        if (tokens === null) target.tokenless++; else target.tokens += tokens
      }
      // 当前常驻块 = **时间最新的**那条 inject。不能取"文件里第一条"：
      // `readEvents` 按文件行序返回，而日志可能被外部工具追加/整理过，行序≠时间序。
      // 缺失/坏 `t` 的行按"最旧"处理（-Infinity），只在没有更好的时候才被选中。
      const atMs = Number.isFinite(at) ? at : -Infinity
      if (!resident || atMs > resident.atMs) {
        resident = { chars, tokens, hits, mode: /mode=(\w+)/.exec(row.detail)?.[1] ?? null, pinned: detailNumber(row.detail, 'pinned'), at: row.t, atMs,
          // 宿主上一次调用的缓存命中量（注入路径采样来的；老记录没有就是 null）。
          cacheRead: detailNumber(row.detail, 'cacheRead'), cacheWrite: detailNumber(row.detail, 'cacheWrite') }
      }
    } else if (row.kind === 'handoff') {
      if (row.detail.startsWith('material=')) {
        const body = detailNumber(row.detail, 'body') ?? 0
        const material = detailNumber(row.detail, 'material') ?? 0
        for (const target of targets) { target.stored++; target.bodyChars += body; target.materialChars += material }
      } else if (row.detail.startsWith('summarize=1')) {
        // 付费档的**每一次尝试**都算，白花的、失败的也算 —— 「花掉的钱要能看见」不看结果。
        const inTokens = detailNumber(row.detail, 'in') ?? 0
        const outTokens = detailNumber(row.detail, 'out') ?? 0
        const kept = (detailNumber(row.detail, 'kept') ?? 0) === 1
        for (const target of targets) {
          target.paidCalls++; target.paidIn += inTokens; target.paidOut += outTokens
          if (kept) target.paidKept++
        }
      }
    }
  }
  // `since` = 日志里**时间最早**的一条（不是文件最末行 —— 行序≠时间序）。
  let earliest = null
  for (const row of rows) {
    const ms = Date.parse(row?.t)
    if (!Number.isFinite(ms)) continue
    if (!earliest || ms < earliest.ms) earliest = { ms, t: row.t }
  }
  // `atMs` 是内部排序键，不外泄。
  const { atMs: _ignore, ...residentOut } = resident ?? {}
  return {
    currency: 'estimated-tokens',
    note: '宿主没有金额服务；token 是注入时按内容算好的估算，不是账单。chars/tokens 累计会把同一个常驻块重复计入。',
    windowMs,
    now: new Date(now).toISOString(),
    since: earliest?.t ?? null,
    events: rows.length,
    truncated: rows.length > 200,
    resident: resident ? residentOut : null,
    residentTokens: resident ? resident.tokens : null,
    last24h: day,
    total,
    paidEver: total.paidCalls > 0,
  }
}

/**
 * 悬浮窗用的**单会话时间线**：把 `events.log` 里属于某个会话的事件按时间排出来，
 * 并算出「常驻块什么时候从 insert 转成 replace」「压缩效率」「省了多少」。
 *
 * 纯本地、不联网、不调模型；数据全部来自已有的 `events.log`，不新增埋点。
 *
 * ── 三个诚实的口径（读这张表最容易误读的地方）─────────────────────────
 *   1. **「压缩」在这里指两件不同的事，别混为一谈**：
 *      - `handoff`：把一整段会话素材压成一条交接（真正的压缩，有 material→body 比）。
 *      - `inject` 的 `mode=replace`：注入块的版本替换，**不是压缩**，是 O(1) 常驻。
 *        它只是让常驻体积不随轮数增长，本身不"节省"任何东西。
 *   2. **`savedChars` 是「相对不装插件」的估算**：把「若不注入、模型得重新索取的素材量」
 *      减去「实际注入的常驻量」。它是一个**上界估算**，不是账单 —— 模型未必真会去问。
 *   3. 宿主没有金额服务。`estimatedSavedTokens` 是 token 估算；`estimatedSavedMoney` 只在
 *      配置里给了单价时才给，否则为 `null`（**绝不编数**）。
 *
 * @param {string} home
 * @param {{sessionId?: string, now?: number, timelineLimit?: number}} [options]
 */
export function sessionTimeline(home, options = {}) {
  const sessionId = typeof options.sessionId === 'string' && options.sessionId ? options.sessionId : null
  // 工作区过滤：悬浮窗可能只想知道「这个工作区」而不是「这一个会话」。
  // 两者可以叠加（会话是工作区的子集），但都不给时 = 全库视图。
  const workspaceFilter = typeof options.workspace === 'string' && options.workspace
    ? workspaceKey(options.workspace)
    : null
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const limit = Number.isFinite(options.timelineLimit) ? options.timelineLimit : 400
  const rows = readEvents(limit, home)
  // 按时间升序（readEvents 给的是倒序，且行序≠时间序，所以要显式排）。
  // ⚠️ 排序必须**以文件行序为主、时间为辅**，不能只按时间。
  // 2026-10-07 实测：同一毫秒内连写两条事件（`appendEvent` 走的是 `new Date()`，分辨率 1ms），
  // 时间戳完全相同 → 只按 `ms` 排序时两者顺序不稳定，`resident` 可能取到**较旧**的那条。
  // 日志是 append-only 的，文件里的先后**就是**真实的先后，所以行序才是权威信号。
  //
  // `readEvents` 返回的是**倒序**（最新在前），所以行序在数组里是「越靠前越新」：
  // 时间相同时要用 `index` **降序**当 tiebreaker，才能让同毫秒内**旧的在前、新的在后**，
  // 循环正向走完后 `resident` 才落在真正最新的那条上。
  // （2026-10-07 二次修正：原来写成升序，方向反了 → 同毫秒时 `resident` 取到最旧的一条，
  //   表现为 regression 里 300/520 的**随机**失败。）
  const sorted = rows
    .map((row, index) => ({ row, index, ms: Date.parse(row?.t) }))
    .filter((x) => x.row && typeof x.row.detail === 'string')
    .sort((a, b) => {
      const at = Number.isFinite(a.ms) ? a.ms : -Infinity
      const bt = Number.isFinite(b.ms) ? b.ms : -Infinity
      if (at !== bt) return at - bt
      return b.index - a.index // 同毫秒：行序倒着排，旧的在前 → 循环走完 resident = 最新
    })

  const isMine = (row) => {
    if (sessionId && row.sessionId !== sessionId) return false
    if (workspaceFilter && workspaceKey(row.workspace ?? '') !== workspaceFilter) return false
    return true
  }
  const timeline = []
  let firstInjectAt = null
  let firstReplaceAt = null
  let injectCount = 0
  let resident = null
  let lastResidentChars = null
  // 压缩台账：handoff 的 material→body 才是真正的压缩。
  let handoffStored = 0
  let handoffMaterial = 0
  let handoffBody = 0
  let handoffPaidCalls = 0
  let handoffPaidIn = 0
  let handoffPaidOut = 0
  let handoffPaidKept = 0
  // 被硬预算砍掉的条数（注入时 hits 与 candidates 的对比不做，只看 recallLimit 的取舍：
  // 用 `chars` 触顶次数近似）。
  let budgetTouched = 0

  for (const item of sorted) {
    const row = item.row
    if (!isMine(row)) continue
    if (row.kind === 'inject') {
      const chars = detailNumber(row.detail, 'chars') ?? 0
      const tokens = detailNumber(row.detail, 'tokens')
      const mode = /mode=(\w+)/.exec(row.detail)?.[1] ?? null
      const hits = Number.isFinite(row.count) ? row.count : 0
      injectCount++
      if (firstInjectAt === null) firstInjectAt = row.t
      if (mode === 'replace' && firstReplaceAt === null) firstReplaceAt = row.t
      // 常驻块 = 时间最新的那条 inject。
      resident = { chars, tokens, hits, mode, at: row.t }
      // 判定「预算被顶到」：replace 且 hits 比上一轮少、或 chars 连续贴住上限。
      if (lastResidentChars !== null && mode === 'replace' && chars >= lastResidentChars * 0.95 && hits < (resident.hits ?? 0) + 1) budgetTouched++
      lastResidentChars = chars
      timeline.push({ t: row.t, kind: 'inject', mode, chars, tokens, hits,
        detail: `mode=${mode}; chars=${chars}; hits=${hits}` })
    } else if (row.kind === 'handoff') {
      if (row.detail.startsWith('material=')) {
        const body = detailNumber(row.detail, 'body') ?? 0
        const material = detailNumber(row.detail, 'material') ?? 0
        handoffStored++; handoffMaterial += material; handoffBody += body
        timeline.push({ t: row.t, kind: 'handoff', mode: 'compress', material, body,
          ratio: material > 0 ? Number((body / material).toFixed(4)) : null,
          detail: `material=${material}; body=${body}` })
      } else if (row.detail.startsWith('summarize=1')) {
        const inTokens = detailNumber(row.detail, 'in') ?? 0
        const outTokens = detailNumber(row.detail, 'out') ?? 0
        const kept = (detailNumber(row.detail, 'kept') ?? 0) === 1
        handoffPaidCalls++; handoffPaidIn += inTokens; handoffPaidOut += outTokens
        if (kept) handoffPaidKept++
        timeline.push({ t: row.t, kind: 'paid', mode: kept ? 'kept' : 'discarded', in: inTokens, out: outTokens,
          detail: `summarize=1; in=${inTokens}; out=${outTokens}; kept=${kept ? 1 : 0}` })
      } else {
        timeline.push({ t: row.t, kind: 'handoff', mode: 'refused', detail: row.detail })
      }
    } else if (row.kind === 'recall') {
      timeline.push({ t: row.t, kind: 'recall', hits: Number.isFinite(row.count) ? row.count : 0, detail: row.detail })
    } else if (row.kind === 'remember') {
      timeline.push({ t: row.t, kind: 'remember', detail: row.detail })
    }
  }

  // —— 压缩效率：交接把多少素材压成了多大 ——
  const compressionRatio = handoffMaterial > 0 ? Number((handoffBody / handoffMaterial).toFixed(4)) : null
  const compressionSavedChars = handoffMaterial > handoffBody ? handoffMaterial - handoffBody : 0

  // —— 省了多少：相对「不装插件」的估算 ——
  // 若不装插件，模型要拿回同样的信息，得靠检索/重问，素材量近似为 handoff 的 material 之和。
  // 实际注入的常驻量是 residentChars（每轮重付一份，但它是 O(1)，不随轮数涨）。
  const residentChars = resident?.chars ?? 0
  const residentTokens = resident?.tokens ?? null
  // 真实省下的输入 token ≈ (累计会被重放的素材 − 常驻块) 的下界。
  // 用「每轮省」的口径更稳：若不装插件，第 N 轮之后旧信息已经沉在历史里，
  // 模型不会重读；所以这里只报**压缩**省下的部分（有明确 material→body 依据的）。
  const estimatedSavedChars = compressionSavedChars
  const estimatedSavedTokens = estimatedSavedChars > 0 ? Math.round(estimatedSavedChars * (residentTokens && residentChars ? residentTokens / residentChars : 0.5)) : 0

  return {
    sessionId,
    workspace: options.workspace ?? null,
    now: new Date(now).toISOString(),
    timeline,
    resident,
    injectCount,
    firstInjectAt,
    firstReplaceAt,
    /** 常驻块从「插入」转为「替换」的时刻 = 版本替换起效点（不是压缩点）。 */
    versionReplacementAt: firstReplaceAt,
    compression: {
      events: handoffStored,
      materialChars: handoffMaterial,
      bodyChars: handoffBody,
      ratio: compressionRatio,
      savedChars: compressionSavedChars,
      /** 真正的「开始压缩」= 第一次 handoff。 */
      firstAt: timeline.find((x) => x.kind === 'handoff' && x.mode === 'compress')?.t ?? null,
    },
    paid: {
      calls: handoffPaidCalls,
      inTokens: handoffPaidIn,
      outTokens: handoffPaidOut,
      kept: handoffPaidKept,
      /** 白花 = 调了付费档但没被采纳。 */
      wastedCalls: handoffPaidCalls - handoffPaidKept,
    },
    savings: {
      /** 字符估算（有 material→body 依据的部分）。 */
      chars: estimatedSavedChars,
      /** token 估算 —— 宿主没有金额服务，这是估算不是账单。 */
      tokens: estimatedSavedTokens,
      /** 只有当 config.savedTokensPriceGiven 时才有值，否则 null（不编数）。 */
      money: null,
      currency: 'estimated-tokens',
      note: 'chars 来自交接的 material→body 真实差值；tokens 由本插件按内容估算；宿主机没有计价服务，所以这里不报金额。',
    },
    budgetTouched,
  }
}

/**
 * 列出 `events.log` 里出现过的会话，按**最近活跃**排序。
 *
 * 悬浮窗要回答「我现在看的是哪个会话」—— 但宿主不把「当前窗口是哪个会话」告诉插件，
 * 页面 URL 也是 `dsh-app://` 自定义协议、没有可用的会话参数。所以这里给两个东西：
 *   1. `sessions` —— 事件流里真实出现过的会话清单（含工作区名、事件数、最近时刻）；
 *   2. 最近活跃的那一条，让 `/live` 在没拿到明确 sessionId 时**有个确定的默认**，
 *      而不是把全库混在一起算（那正是「看不出这是谁的数」的根源）。
 *
 * ⚠️ 这是**事件流视角**，不是宿主会话列表：只有真正被插件碰过的会话才会出现。
 * 一个刚建、还没触发注入的会话不在里面 —— 这是诚实的，不假装知道。
 *
 * @param {string} home
 * @param {{limit?: number}} [options]
 */
export function listLiveSessions(home, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 1000
  const rows = readEvents(limit, home)
  const byId = new Map()
  for (const row of rows) {
    const id = typeof row?.sessionId === 'string' && row.sessionId ? row.sessionId : null
    if (!id) continue
    const at = Date.parse(row.t)
    const key = workspaceKey(row.workspace ?? '')
    const prev = byId.get(id)
    if (!prev) {
      byId.set(id, {
        sessionId: id,
        workspace: row.workspace ?? null,
        workspaceKey: key,
        firstAt: Number.isFinite(at) ? at : null,
        lastAt: Number.isFinite(at) ? at : null,
        events: 1,
      })
    } else {
      prev.events++
      if (Number.isFinite(at)) {
        if (prev.firstAt === null || at < prev.firstAt) prev.firstAt = at
        if (prev.lastAt === null || at > prev.lastAt) prev.lastAt = at
      }
      // 工作区以最近一条为准（同一会话理论上不会换工作区，但日志可能残缺）。
      if (Number.isFinite(at) && at >= (prev.lastAt ?? -Infinity)) {
        prev.workspace = row.workspace ?? prev.workspace
        prev.workspaceKey = key
      }
    }
  }
  const sessions = [...byId.values()]
    .sort((a, b) => (b.lastAt ?? -Infinity) - (a.lastAt ?? -Infinity))
  return {
    sessions: sessions.map((s) => ({
      ...s,
      firstAt: s.firstAt === null ? null : new Date(s.firstAt).toISOString(),
      lastAt: s.lastAt === null ? null : new Date(s.lastAt).toISOString(),
    })),
    /** 最近活跃的会话 id（没有任何事件时为 null）。 */
    latestSessionId: sessions[0]?.sessionId ?? null,
  }
}

/* ------------------------------------------------------------------ *
 * 记忆本体
 * ------------------------------------------------------------------ */

/** 把一行日志折进索引。返回是否发生了改变（用于统计）。 */
function foldLine(state, entry) {
  if (!entry || typeof entry !== 'object') return false
  const op = entry.op
  if (op === 'put') {
    const existing = state.get(entry.id)
    if (existing) {
      // 同 id 再写 = 提升显著度 / 刷新时间，不新增一条。
      state.set(entry.id, {
        ...existing,
        ...entry.record,
        createdAt: existing.createdAt,
        useCount: existing.useCount,
      })
    } else {
      state.set(entry.id, { ...entry.record, useCount: 0, supersededBy: null })
    }
    return true
  }
  const target = state.get(entry.id)
  if (!target) return false
  if (op === 'supersede') {
    state.set(entry.id, { ...target, supersededBy: entry.by ?? 'forgotten' })
    return true
  }
  if (op === 'use') {
    state.set(entry.id, {
      ...target,
      useCount: target.useCount + 1,
      lastUsedAt: entry.at ?? Date.now(),
    })
    return true
  }
  if (op === 'link') {
    const links = target.links.filter((l) => l.id !== entry.to)
    links.push({ id: entry.to, weight: clamp01(entry.weight, 0.5) })
    state.set(entry.id, { ...target, links })
    // 关联是**双向**的。
    //
    // 这一条是抄 dsh-memory-loom 的教训：它原先只沿出边传播，线上因为用的
    // 是对称边所以表现正常，但**只在单向边上失效的排序器失效时不会有任何报错**，
    // 只是召回悄悄变差。是离线测试用手工构造的单向边把它抓出来的。
    const reverse = state.get(entry.to)
    if (reverse) {
      const back = reverse.links.filter((l) => l.id !== entry.id)
      back.push({ id: entry.id, weight: clamp01(entry.weight, 0.5) })
      state.set(entry.to, { ...reverse, links: back })
    }
    return true
  }
  if (op === 'promote') {
    state.set(entry.id, { ...target, scope: entry.scope, promotedAt: entry.at ?? Date.now() })
    return true
  }
  if (op === 'touch') {
    state.set(entry.id, { ...target, ...entry.patch })
    return true
  }
  return false
}

/**
 * 记忆库。构造时从磁盘折出全量索引；之后所有读走内存、所有写**先追加日志**。
 *
 * 索引是内存里的权威副本，磁盘日志是可重放的持久投影 ——
 * 与宿主 `dsh-storage-domain` 的「内存权威、介质是投影」是同一种取舍，
 * 只是这里用追加日志而不是 KV 快照。
 */
export class MemoryStore {
  constructor(home) {
    this.home = home
    this.paths = pluginPaths(home)
    this.records = new Map()
    this.loadedAt = 0
    this.lineCount = 0
    /** 上次重放时的 `memories.jsonl` mtime（毫秒）。0 = 视为已过期，下次读必然重放。 */
    this.mtimeMs = 0
    /**
     * 上次重放时的文件字节数。
     *
     * ⚠️ **光靠 mtime 不够** —— 这是 2026-10-07 实机测出来的：
     * Windows 的 NTFS（以及一些挂载文件系统）`mtime` 分辨率约 1ms，而同一进程内
     * **连续几次 append 极可能落在同一毫秒**。于是「实例 B 追加 3 条 → mtime 没变 →
     * 实例 A 判定'没变化'直接跳过重放」，A 永远看不到 B 的那 3 条。
     * 表现就是 `M-AF` 那条断言：盘上 8 行，A 只认得 5 行。
     * 加**文件字节数**当第二信号：追加必然让 size 变大，size 变了就重放。
     * 两者都没变才算真没变（这一步代价只是多一次 `statSync`，可忽略）。
     */
    this.sizeBytes = -1
    this.reload()
  }

  /**
   * 从磁盘重放日志。文件不存在就是空库，不是错误。
   *
   * 顺带记下文件的 `mtimeMs` 与 `sizeBytes` —— `syncFromDisk()` 靠它们判断
   * "别的进程/窗口有没有追加过"。
   */
  reload() {
    this.records = new Map()
    this.lineCount = 0
    try {
      if (!existsSync(this.paths.memories)) { this.loadedAt = Date.now(); this.mtimeMs = 0; this.sizeBytes = -1; return 0 }
      const text = readFileSync(this.paths.memories, 'utf8')
      for (const line of text.split('\n')) {
        if (line.length === 0) continue
        this.lineCount++
        try { foldLine(this.records, JSON.parse(line)) } catch { /* 跳过坏行，不让一行毁掉整个库 */ }
      }
      try {
        const st = statSync(this.paths.memories)
        this.mtimeMs = st.mtimeMs
        this.sizeBytes = st.size
      } catch { this.mtimeMs = 0; this.sizeBytes = -1 }
    } catch { /* 读不到就是空库 */ }
    this.loadedAt = Date.now()
    return this.records.size
  }

  /**
   * 读路径前的惰性同步：**别的 store 实例（另一个窗口/会话）追加过就整库重放一次**。
   *
   * 为什么必须有它：内存 Map 是权威副本，但同机的其它实例各持一份、各自 append
   * 同一个文件 —— 没有这个检查，窗口 A 写的记忆窗口 B 到重启前都看不见（实测：
   * 两实例各写 50 条，磁盘 100 行，实例1 只认得自己的 50 条）。
   *
   * 代价只有每读一次一次 `statSync`；mtime 与 size 都没变就不动，正常轮次零重放。
   * 任何 IO 异常都吞掉：读不到时**保守地重放一次**（宁可多读，不可少读）。
   */
  syncFromDisk() {
    try {
      if (!existsSync(this.paths.memories)) {
        // 文件被删了（或从来没建过）：只有当本地以为有数据时才需要重放。
        if (this.mtimeMs !== 0 || this.sizeBytes !== -1) this.reload()
        return
      }
      const st = statSync(this.paths.memories)
      // mtime 与 size **都**没变才算没变。见构造函数里 sizeBytes 的注释：
      // 同一毫秒内的连续追加会让 mtime 相同，只看 mtime 会漏掉别的实例写的数据。
      if (st.mtimeMs === this.mtimeMs && st.size === this.sizeBytes) return
    } catch { /* stat 失败：落到下面重放一次 */ }
    this.reload()
  }

  /** 追加一行日志。失败时抛——写入失败必须让调用方知道。 */
  append(entry) {
    const line = `${JSON.stringify({ v: LOG_VERSION, at: Date.now(), ...entry })}\n`
    mkdirSync(this.paths.dir, { recursive: true })
    appendFileSync(this.paths.memories, line, 'utf8')
    this.lineCount++
    foldLine(this.records, entry)
    // 自己写的也要刷新 mtime 与 size，否则下一次 syncFromDisk 会因为"新值 ≠ 旧值"白重放一遍。
    try {
      const st = statSync(this.paths.memories)
      this.mtimeMs = st.mtimeMs
      this.sizeBytes = st.size
    } catch { this.mtimeMs = 0; this.sizeBytes = -1 }
  }

  /** 全部记录（含已被取代的）。读前先跟磁盘对齐（多窗口/多实例）。 */
  all() {
    this.syncFromDisk()
    return [...this.records.values()]
  }

  /** 仍然有效的记录（没被取代）。 */
  live() {
    return this.all().filter((r) => !r.supersededBy)
  }

  get(id) {
    this.syncFromDisk()
    return this.records.get(id) ?? null
  }

  /**
   * 写入一条记忆。同 id 重复写入是幂等的（提升显著度、刷新时间）。
   *
   * @returns {{record: object, created: boolean}}
   */
  put(input) {
    const body = stripHarnessPreamble(String(input.body ?? '')).trim()
    if (body.length === 0) throw new Error('记忆正文不能为空')
    const scope = SCOPES.includes(input.scope) ? input.scope : 'workspace'
    const kind = KINDS.includes(input.kind) ? input.kind : 'fact'
    const workspace = workspaceKey(input.workspace)
    if (scope !== 'global' && !workspace) throw new Error('请先选择工作区')
    if (scope === 'session' && !input.sessionId) throw new Error('本会话记忆必须绑定会话')
    const id = input.id ?? memoryId(body, scope, workspace, input.sessionId)
    // 写前先对齐：别的实例可能已经写过同 id 的记录，不重放会把它当成新条目
    // （`existing` 判空 ⇒ `created` 报 true、links 被覆盖）。
    this.syncFromDisk()
    const existing = this.records.get(id)
    const now = Date.now()

    const record = {
      id,
      body: body.slice(0, 2000),
      kind,
      scope,
      workspace,
      workspacePath: input.workspacePath ?? input.workspace ?? '',
      sessionId: input.sessionId ?? null,
      lineage: Array.isArray(input.lineage) ? input.lineage.slice(0, 20) : [],
      tags: Array.isArray(input.tags) ? input.tags.filter((t) => typeof t === 'string').slice(0, 16) : [],
      entities: Array.isArray(input.entities) ? input.entities.filter((t) => typeof t === 'string').slice(0, 16) : [],
      links: existing?.links ?? [],
      salience: clamp01(input.salience, 0.5),
      confidence: clamp01(input.confidence, 0.6),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      supersededBy: null,
      quote: typeof input.quote === 'string' ? input.quote.slice(0, 400) : null,
      seq: Number.isFinite(input.seq) ? input.seq : null,
      origin: typeof input.origin === 'string' ? input.origin.slice(0, 40) : 'tool',
      // 交接主题的**权威字段**（`latestHandoff` 优先读它，再回落到 tags 反解）。
      // 只在提供了非空字符串时写入，避免给普通记忆平白多一个 `null` 字段。
      ...(typeof input.topic === 'string' && input.topic.length > 0 ? { topic: input.topic.slice(0, 120) } : {}),
    }
    this.append({ op: 'put', id, record })
    return { record: this.records.get(id), created: !existing }
  }

  /**
   * 本工作区（或全局）最近一条**交接记忆**，给注入块当索引行用。
   *
   * 为什么不能只靠召回：新会话的第一句话往往跟上次交接没有词面重合
   * （「继续昨天的活」），而最低分闸门要求 lexical/graph 命中 ⇒ 交接永远出不来，
   * 那 `memory_handoff` 就白存了。所以这里无条件给一行指路（正文仍走 memory_recall）。
   *
   * 只扫已在内存里的记录，**不读盘、不排序全表**，每轮 O(记录数)。
   * 14 天是写死的：加配置键就得同步改设置页并重建 `lib/client.js`，
   * 而"多久之内的交接还值得主动提"并不值得一个旋钮。
   *
   * @param {string} workspace 当前工作区
   * @param {number} maxAgeDays 超过这个天数的交接不再主动提
   * @returns {{id: string, topic: string, at: number, scope: string}|null}
   */
  latestHandoff(workspace, maxAgeDays = 14) {
    const key = workspaceKey(workspace)
    const until = Date.now() - Math.max(0, maxAgeDays) * 86400000
    let best = null
    let bestAt = -1
    this.syncFromDisk()
    for (const record of this.records.values()) {
      if (record.supersededBy || record.origin !== 'handoff') continue
      if (record.scope !== 'global' && record.workspace !== key) continue
      const at = record.updatedAt ?? 0
      if (at < until) continue
      // `>=`：`updatedAt` 同毫秒时由**后写入的**胜出（Map 是插入序，也就是日志追加序）。
      if (at >= bestAt) { best = record; bestAt = at }
    }
    if (!best) return null
    // topic 的权威来源是**独立字段 `topic`**（新写入路径由 memory_handoff 提供）。
    // 老记录（本字段引入之前）没有它，回落到旧的 tags 反解：取第一个不是 `'handoff'`
    // 的 tag。原先只写这一条回落路径时，topic 恰好等于 'handoff' 会让索引行**静默消失**，
    // 所以新写入一律带 `topic` 字段。
    const topic = typeof best.topic === 'string' && best.topic.length > 0
      ? best.topic
      : (best.tags ?? []).find((tag) => tag !== 'handoff') ?? ''
    if (topic.length === 0) return null
    return { id: best.id, topic, at: bestAt, scope: best.scope }
  }

  /** 遗忘。默认是**取代**而不是物理删除，保留可审计的痕迹与关联图结构。 */
  supersede(id, by = 'forgotten') {
    if (!this.records.has(id)) return false
    this.append({ op: 'supersede', id, by })
    return true
  }

  /** 建立关联（自动双向）。 */
  link(from, to, weight = 0.5) {
    if (!this.records.has(from) || !this.records.has(to) || from === to) return false
    this.append({ op: 'link', id: from, to, weight })
    return true
  }

  /** 标记被使用过。用于频次通道。 */
  markUsed(ids) {
    for (const id of ids) if (this.records.has(id)) this.append({ op: 'use', id })
  }

  /** 提升作用域。L0 → L1 → L2 只能往上爬，不能往回降。 */
  promote(id, scope) {
    const record = this.records.get(id)
    if (!record) return false
    if (!SCOPES.includes(scope)) return false
    if (SCOPE_RANK[scope] <= SCOPE_RANK[record.scope]) return false
    this.append({ op: 'promote', id, scope })
    return true
  }

  /**
   * 超出上限时按 `显著度 × 置信度 × 新鲜度` 淘汰最弱的。
   * 淘汰 = 取代，不是删行。返回被淘汰的条数。
   */
  evictIfNeeded(maxRecords, halfLifeDays) {
    const live = this.live()
    if (live.length <= maxRecords) return 0
    const now = Date.now()
    const halfLifeMs = Math.max(1, halfLifeDays) * 86400000
    const strength = (r) => r.salience * r.confidence * Math.pow(0.5, (now - (r.updatedAt ?? r.createdAt)) / halfLifeMs)
    const sorted = [...live].sort((a, b) => strength(a) - strength(b))
    const excess = live.length - maxRecords
    let evicted = 0
    for (let i = 0; i < excess; i++) {
      if (this.supersede(sorted[i].id, 'evicted')) evicted++
    }
    return evicted
  }

  /** 统计。给工具与设置页用。 */
  stats() {
    const live = this.live()
    const byScope = {}
    const byKind = {}
    const byWorkspace = {}
    let links = 0
    for (const record of live) {
      byScope[record.scope] = (byScope[record.scope] ?? 0) + 1
      byKind[record.kind] = (byKind[record.kind] ?? 0) + 1
      const label = record.workspacePath || record.workspace || '(未知)'
      byWorkspace[label] = (byWorkspace[label] ?? 0) + 1
      links += record.links.length
    }
    return {
      total: this.records.size,
      live: live.length,
      superseded: this.records.size - live.length,
      links: Math.round(links / 2),
      byScope,
      byKind,
      byWorkspace,
      logLines: this.lineCount,
      path: this.paths.memories,
    }
  }
}

/* ------------------------------------------------------------------ *
 * 授权台账
 * ------------------------------------------------------------------ */

/** 授权有效期换算成毫秒。`session` 由调用方按会话结束时间处理。 */
const DURATION_MS = {
  once: 5 * 60 * 1000,
  session: 12 * 60 * 60 * 1000,
  persistent: null,
}

/** 用户设置创建的只读授权。全局写入开关不授权跨工作区修改。 */
export class GrantLedger {
  constructor(home) {
    this.home = home
    this.paths = pluginPaths(home)
    this.grants = []
    this.load()
  }

  load() {
    try {
      if (!existsSync(this.paths.grants)) { this.grants = []; return }
      const parsed = JSON.parse(readFileSync(this.paths.grants, 'utf8'))
      this.grants = Array.isArray(parsed?.grants) ? parsed.grants : []
    } catch {
      // 坏掉的台账按「无授权」处理 —— 宁可少查，不可多查。
      this.grants = []
    }
  }

  /** 原子写：先写临时文件再改名，避免设置页写一半时宿主读到半个 JSON。 */
  save() {
    mkdirSync(this.paths.dir, { recursive: true })
    const payload = `${JSON.stringify({ version: 1, grants: this.grants }, null, 2)}\n`
    atomicWrite(this.paths.grants, payload)
  }

  /** 当前有效的授权（未撤销、未过期、还有剩余次数）。 */
  active(now = Date.now()) {
    return this.grants.filter((g) => this.isActive(g, now))
  }

  isActive(grant, now = Date.now(), context = null) {
    if (grant?.duration === 'session' && (!grant.sessionId || (context && grant.sessionId !== context.sessionId))) return false
    if (grant?.duration === 'once' && grant.sessionId && context && grant.sessionId !== context.sessionId) return false
    if (!grant || grant.revokedAt) return false
    if (grant.expiresAt != null && now > grant.expiresAt) return false
    if (grant.maxUses != null && (grant.uses ?? 0) >= grant.maxUses) return false
    return true
  }

  /** 查某个工作区有没有读授权。 */
  check(workspace, now = Date.now(), context = null) {
    const key = workspaceKey(workspace)
    const grant = this.grants.find((g) => workspaceKey(g.workspace) === key && this.isActive(g, now, context))
    if (grant) return { allowed: true, grant }
    const expired = this.grants.find((g) => workspaceKey(g.workspace) === key && !g.revokedAt)
    return {
      allowed: false,
      grant: null,
      reason: expired ? (expired.maxUses != null && (expired.uses ?? 0) >= expired.maxUses ? 'uses-exhausted' : 'expired') : 'never-granted',
    }
  }

  /**
   * 开一条授权。同一个工作区重复授权会**刷新**已有那条，而不是堆一串。
   *
   * @param {string} workspace 工作区路径（原始大小写）
   * @param {{duration?: string, maxUses?: number|null, note?: string}} options
   */
  grant(workspace, options = {}) {
    const key = workspaceKey(workspace)
    if (key.length === 0) throw new Error('授权必须指明工作区')
    const duration = Object.hasOwn(DURATION_MS, options.duration) ? options.duration : 'persistent'
    if (duration === 'session' && !options.sessionId) throw new Error('本会话授权需要选择会话')
    const ms = DURATION_MS[duration]
    const now = Date.now()
    const existing = this.grants.find((g) => workspaceKey(g.workspace) === key && !g.revokedAt)
    const next = {
      id: existing?.id ?? `g${now.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
      workspace: String(workspace),
      workspaceLabel: String(workspace).replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? String(workspace),
      scope: 'read',
      sessionId: duration === 'persistent' ? null : options.sessionId ?? null,
      duration,
      grantedAt: existing?.grantedAt ?? now,
      refreshedAt: now,
      expiresAt: ms == null ? null : now + ms,
      maxUses: duration === 'once' ? (Number.isFinite(options.maxUses) ? Math.max(1, Math.min(10000, Math.round(options.maxUses))) : 1) : (Number.isFinite(options.maxUses) ? Math.max(1, Math.min(10000, Math.round(options.maxUses))) : null),
      uses: 0,
      note: typeof options.note === 'string' ? options.note.slice(0, 200) : (existing?.note ?? ''),
      revokedAt: null,
    }
    const previous = this.grants
    if (existing) this.grants = this.grants.map((g) => (g.id === existing.id ? next : g))
    else this.grants.push(next)
    try { this.save() } catch (error) { this.grants = previous; throw error }
    return next
  }

  /** 撤销。保留记录（可审计），只打撤销时间戳。 */
  revoke(id) {
    const target = this.grants.find((g) => g.id === id)
    if (!target) return false
    const previous = target.revokedAt
    target.revokedAt = Date.now()
    try { this.save() } catch (error) { target.revokedAt = previous; throw error }
    return true
  }

  /** 记一次使用。台账的「还剩几次」就靠这个。 */
  consumeMany(ids) {
    const targets = [...new Set(ids)].map((id) => this.grants.find((g) => g.id === id))
    if (targets.some((g) => !this.isActive(g))) throw new Error('授权已过期或用尽')
    const previous = targets.map((g) => ({ uses: g.uses, lastUsedAt: g.lastUsedAt }))
    for (const g of targets) { g.uses = (g.uses ?? 0) + 1; g.lastUsedAt = Date.now() }
    try { if (targets.length) this.save() } catch (error) {
      targets.forEach((g, i) => Object.assign(g, previous[i]))
      throw error
    }
    return targets
  }

  consume(id) {
    if (!this.grants.some((g) => g.id === id)) return null
    return this.consumeMany([id])[0]
  }

  /** 清理：撤销所有已过期/已用尽的授权，让台账不无限长。返回清掉几条。 */
  prune(now = Date.now()) {
    const before = this.grants.length
    const previous = this.grants
    this.grants = this.grants.filter((g) => !(g.revokedAt || (g.expiresAt != null && now > g.expiresAt) || (g.maxUses != null && (g.uses ?? 0) >= g.maxUses)))
    try { if (this.grants.length !== before) this.save() } catch (error) { this.grants = previous; throw error }
    return before - this.grants.length
  }
}

/* ------------------------------------------------------------------ *
 * 工作区发现
 * ------------------------------------------------------------------ */

/**
 * 从宿主自己的 storage 里读出工作区清单。
 *
 * `$DSH_HOME/storages/workspace.json` 的 `tables.workspaces` 是权威来源
 * （它是宿主 `dsh-workspace` 的 domain 数据）；读不到就退回扫会话目录。
 *
 * ⚠️ 刻意**不去解码会话目录名**。`--<盘符>-<转义路径>-...--`
 * 这种编码里 `-` 既是分隔符又是目录名的一部分（`ai-workspace` 是一个目录），
 * 解码必然产生歧义。改从会话文件头部的 `cwd` 字段读，那是真值。
 */
export function discoverWorkspaces(home) {
  const paths = pluginPaths(home)
  const found = new Map()

  // 1) 权威来源：storage 里的 workspace 表。
  try {
    const raw = JSON.parse(readFileSync(join(paths.storages, 'workspace.json'), 'utf8'))
    const table = raw?.tables?.workspaces
    if (table && typeof table === 'object') {
      for (const [id, value] of Object.entries(table)) {
        if (typeof value?.path !== 'string') continue
        found.set(workspaceKey(value.path), { id, path: value.path, source: 'storage' })
      }
    }
  } catch { /* 读不到就走会话目录 */ }

  // 2) 兜底：扫会话目录，从任意一个会话的头部拿 cwd。
  if (found.size === 0) {
    try {
      for (const entry of readdirSync(paths.sessions, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const dir = join(paths.sessions, entry.name)
        let sessions = []
        try { sessions = readdirSync(dir) } catch { continue }
        for (const sessionId of sessions.slice(0, 3)) {
          const header = readSessionHeader(join(dir, sessionId), home)
          if (header?.cwd) {
            found.set(workspaceKey(header.cwd), { id: null, path: header.cwd, source: 'session-header' })
            break
          }
        }
      }
    } catch { /* 没有 sessions 目录就是没有 */ }
  }
  return [...found.values()]
}

/**
 * 读一个会话的头部。会话文件是**追加式多帧 zstd**，
 * 单帧解压只能拿到最前面那一帧（实测：1.6MB 的文件第一帧只有 205 字节），
 * 所以必须按 zstd 魔数切帧逐帧解压。
 *
 * @param {string} sessionDir 会话目录
 * @returns {{id: string, cwd: string, parentSession?: string, delegationDepth?: number}|null}
 */
export function readSessionHeader(sessionDir, home) {
  const file = join(sessionDir, 'session.v4.jsonl.zstd')
  try {
    if (!existsSync(file)) return null
    const text = readZstdFrames(file, 256 * 1024, true)
    const firstLine = text.split('\n').find((l) => l.length > 0)
    if (!firstLine) return null
    const parsed = JSON.parse(firstLine)
    return parsed?.type === 'session' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 按 zstd 魔数切帧，逐帧解压，拼回完整文本。
 *
 * 会话是**边跑边追加**的，每次追加是一个独立的 zstd 帧。
 * Node 24 的 `zstdDecompressSync` 只解第一帧就返回，不会自动续帧，
 * 所以这里自己扫魔数（0x28 0xB5 0x2F 0xFD）切分。
 *
 * @param {string} file
 * @param {number} maxBytes 解压后字节上限，超了就截断（防巨型会话拖垮回填）
 */
export function readZstdFrames(file, maxBytes = 32 * 1024 * 1024, headerOnly = false) {
  const compressedCap = headerOnly ? 256 * 1024 : Math.max(1024 * 1024, maxBytes)
  if (!headerOnly && statSync(file).size > compressedCap) return ''
  let buffer
  if (headerOnly) {
    const fd = openSync(file, 'r')
    try {
      buffer = Buffer.alloc(Math.min(compressedCap, fstatSync(fd).size))
      const size = readSync(fd, buffer, 0, buffer.length, 0)
      buffer = buffer.subarray(0, size)
    } finally { closeSync(fd) }
  } else buffer = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i++) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) starts.push(i)
  }
  if (starts.length === 0) return ''
  const parts = []
  let total = 0
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buffer.length
    try {
      const chunk = zstdDecompressSync(buffer.subarray(starts[k], end), { maxOutputLength: Math.max(1, maxBytes - total) })
      parts.push(chunk)
      total += chunk.length
      if (total >= maxBytes || headerOnly) break
    } catch { /* 最后一帧可能还在写，跳过 */ }
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * 会话读取的统一入口：优先走宿主的 `sessionQuery`（它懂格式、懂实时会话），
 * 拿不到才自己切帧。这样既吃到了官方的正确性，又不会因为服务缺失而整个哑掉。
 *
 * @param {object|null} sessionQuery 宿主服务（可能为 null）
 * @param {string} sessionId
 * @param {{dir?: string, home: string, maxBytes?: number}} fallback
 */
export async function readSessionLog(sessionQuery, sessionId, fallback) {
  if (sessionQuery && typeof sessionQuery.readSession === 'function') {
    try {
      const log = await sessionQuery.readSession(sessionId)
      if (Array.isArray(log)) return log
      if (Array.isArray(log?.events)) {
        const header = log.session ?? log.header
        return header ? [{ type: 'session', ...header }, ...log.events] : log.events
      }
    } catch { /* 落到自读 */ }
  }
  if (!fallback?.dir) return []
  try {
    const text = readZstdFrames(join(fallback.dir, 'session.v4.jsonl.zstd'), fallback.maxBytes)
    const events = []
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      try { events.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
    }
    return events
  } catch {
    return []
  }
}
