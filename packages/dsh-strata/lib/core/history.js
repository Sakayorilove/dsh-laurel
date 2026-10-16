import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readSessionHeader, readSessionLog } from './store.js'
import { pluginPaths, workspaceKey } from './config.js'
import { recall, checkVisibility } from './recall.js'
import { stripHarnessPreamble } from './text.js'

/**
 * 只收录**真人说的话**和**模型的回答**；注入内容一律不收录。
 *
 * ── 为什么必须是 source.kind 白名单（2026-10-07 实测订正）────────────────
 * 旧写法是 `if (data?.source || event?.source) return ''` —— 注释写的意图是
 * 跳过本插件自己注入的那条，但**真实宿主日志里每条消息都带 `source`**：
 *
 *   用户消息   data          = { content, source: { kind: 'user' }, role, id }
 *   助手消息   data.message  = { role, content, source: { kind: 'model', … } }
 *
 * 于是所有消息都被丢掉 → 历史检索恒为 0 条 → 自动注入与 `memory_recall`
 * 双双空转。本机实测：4 天、53 次加载、**0 次注入、0 条长期记忆**。
 *
 * `source.kind` 正是宿主标记**注入来源**的字段。12 个真实会话的普查结果：
 *   - 真内容：`user`、`model`
 *   - 注入（必须跳过）：`tool-jobs`、`compact-checkpoint`、`skill-catalog`、
 *     `runtime-context`、`time-context`、`agent-message`、`subagent-settled`、
 *     `user-approval`、`loom-draft`、`model-selection`、`goal`、`tool-goal`、
 *     `agent-instructions`、`plugin:<插件名>:<用途>`、以及本插件的 `strata-memory`
 *
 * 没有 `source` 标记的消息（旧格式、测试夹具、将来格式再变）按真内容处理：
 * **未知就收录**，免得重演一次「静默全丢」。
 */
const INDEXED_SOURCE_KINDS = new Set(['user', 'model'])

export function messageText(event) {
  // Never index tool output, system prompts or our own injected context.
  if (event?.type !== 'user/message' && event?.type !== 'assistant/message') return ''
  const data = event?.data?.message ?? event?.data ?? event?.message
  const kind = data?.source?.kind ?? event?.source?.kind
  if (kind !== undefined && !INDEXED_SOURCE_KINDS.has(kind)) return ''
  const content = data?.content
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n') : ''
  return stripHarnessPreamble(text).trim()
}

async function within(promise, ms, fallback) {
  let timer
  try {
    return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(1, ms)) })])
  } finally { clearTimeout(timer) }
}

export async function listHistorySessions(deps, config) {
  const until = Date.now() + 1000
  let inspected = 0
  let rows = []
  try {
    const service = deps.sessionQuery?.()
    if (service?.listSessions) {
      const values = await within(service.listSessions(AbortSignal.timeout(800)), 800, [])
      rows = (Array.isArray(values) ? values : []).map((r) => {
        const h = r.header ?? r.session ?? r
        return { id: h.id ?? h.sessionId, cwd: h.cwd, createdAt: typeof h.createdAt === 'number' ? h.createdAt : Date.parse(h.createdAt ?? '') || 0 }
      }).filter((r) => r.id && r.cwd)
    }
  } catch { /* cold storage fallback */ }
  // Merge explicitly selected backup roots as well as live persistence.
  if (rows.length === 0 || config.extraSessionRoots.length) {
    const roots = [...(rows.length ? [] : [pluginPaths(deps.home).sessions]), ...config.extraSessionRoots]
    for (const root of roots) {
      let dirs = []
      try { dirs = readdirSync(root, { withFileTypes: true }).filter((r) => r.isDirectory()) } catch { continue }
      for (const ws of dirs.slice(0, 200)) {
        if (Date.now() > until || inspected >= 2000) break
        let ids = []
        const wsDir = join(root, ws.name)
        try { ids = readdirSync(wsDir, { withFileTypes: true }).filter((r) => r.isDirectory()) } catch { continue }
        for (const id of ids.slice(-1000)) {
          if (Date.now() > until || inspected++ >= 2000) break
          const dir = join(wsDir, id.name)
          const header = readSessionHeader(dir, deps.home)
          if (!header?.cwd) continue
          let mtime = 0
          try { mtime = statSync(join(dir, 'session.v4.jsonl.zstd')).mtimeMs } catch { continue }
          rows.push({ id: header.id ?? id.name, cwd: header.cwd, createdAt: typeof header.createdAt === 'number' ? header.createdAt : Date.parse(header.createdAt ?? '') || mtime, mtime, dir })
        }
      }
    }
  }
  const byId = new Map()
  for (const row of rows) if (!byId.has(row.id) || (row.mtime ?? 0) > (byId.get(row.id).mtime ?? 0)) byId.set(row.id, row)
  return [...byId.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
}

export class HistorySearch {
  constructor(deps) { this.deps = deps; this.cache = new Map(); this.listCache = null; this.pending = new Map() }

  async search({ query, context, config, filters = {}, deadlineMs = 1500 }) {
    const started = Date.now()
    if (!config.searchHistory || !workspaceKey(context.workspace)) return { hits: [], stats: { scanned: 0, tookMs: 0 } }
    const signature = JSON.stringify(config.extraSessionRoots)
    if (!this.listCache || Date.now() - this.listCache.at > 5000 || this.listCache.signature !== signature) {
      this.listCache = { at: Date.now(), signature, rows: await listHistorySessions(this.deps, config) }
    }
    const sessions = this.listCache.rows
    // Authorization and narrowing happen before opening any session body.
    const allowed = sessions.filter((s) => {
      if (s.id === context.sessionId) return false
      if (filters.workspace && workspaceKey(s.cwd) !== workspaceKey(filters.workspace)) return false
      const verdict = checkVisibility({ scope: 'workspace', workspace: s.cwd, sessionId: s.id }, context, config, this.deps.ledger)
      return verdict.visible && !(filters.includeForeign === false && verdict.foreign)
    })
    // Local sessions get scan slots first, then selected foreign workspaces round-robin.
    const groups = new Map()
    for (const s of allowed) {
      const key = workspaceKey(s.cwd)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(s)
    }
    const own = workspaceKey(context.workspace)
    const keys = [...groups.keys()].sort((a, b) => a === own ? -1 : b === own ? 1 : 0)
    const selectedKeys = keys.filter((k) => k === own).concat(keys.filter((k) => k !== own).slice(0, config.maxForeignWorkspaces))
    const selected = []
    while (selected.length < config.historySessions) {
      let added = false
      for (const k of selectedKeys) {
        const next = groups.get(k).shift()
        if (next) { selected.push(next); added = true }
        if (selected.length >= config.historySessions) break
      }
      if (!added) break
    }
    let scanned = 0
    const records = []
    for (const session of selected) {
      if (Date.now() - started >= deadlineMs) break
      const cacheKey = `${session.id}|${workspaceKey(session.cwd)}|${session.mtime ?? ''}|${config.historyMaxChars}|${config.maxSessionBytes}`
      let cached = this.cache.get(cacheKey)
      if (!cached || Date.now() - cached.at > 10000) {
        let pending = this.pending.get(cacheKey)
        if (!pending) {
          if (this.pending.size >= 32) break
          pending = readSessionLog(this.deps.sessionQuery?.(), session.id, {
            home: this.deps.home, dir: session.dir, maxBytes: config.maxSessionBytes,
          })
          this.pending.set(cacheKey, pending)
          pending.finally(() => this.pending.delete(cacheKey)).catch(() => {})
        }
        const events = await within(pending, Math.min(500, deadlineMs - (Date.now() - started)), null)
        // 一个会话读不出来（宿主冷启动、挂起、超时）**不该让这一轮彻底没有历史**。
        // 2026-10-07 实机：重启后第一次注入拿到 0 条命中，而同一查询离线能拿 6 条 ——
        // 冷启动下第一个会话读取超 500ms 就会命中这里。改成跳过它继续读后面的；
        // 总预算由循环顶部的 deadline 检查兜住，不会无限拖。
        if (!events) continue
        // Fail closed if a host observation no longer belongs to its listed workspace.
        const header = events.find((e) => e?.type === 'session')
        if (header && ((header.cwd && workspaceKey(header.cwd) !== workspaceKey(session.cwd)) || (header.id && header.id !== session.id))) continue
        const chunks = []
        let size = 0
        // Newest material first; never extract these quotations into durable facts.
        for (let i = events.length - 1; i >= 0 && size < config.historyMaxChars; i--) {
          const event = events[i]
          const text = messageText(event)
          if (!text) continue
          // Spread slots across a long message instead of indexing only its beginning.
          for (let offset = 0; offset < text.length && size < config.historyMaxChars; offset += 700) {
            const body = text.slice(offset, offset + Math.min(700, config.historyMaxChars - size))
            size += body.length
            chunks.push({
              id: 'h' + createHash('sha1').update(`${session.id}|${event.seq ?? i}|${offset}`).digest('hex').slice(0, 16),
              body, scope: 'workspace', kind: 'fact', origin: 'history',
              workspace: workspaceKey(session.cwd), workspacePath: session.cwd, sessionId: session.id,
              seq: event.seq ?? i, role: event.type === 'user/message' ? 'user' : 'assistant',
              createdAt: session.createdAt, updatedAt: session.createdAt,
              tags: [], entities: [], links: [], salience: 0.4, confidence: 0.4,
            })
          }
        }
        cached = { at: Date.now(), records: chunks }
        this.cache.set(cacheKey, cached)
        while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value)
      }
      records.push(...cached.records)
      scanned++
    }
    const result = recall({ store: { live: () => records }, ledger: this.deps.ledger, config, query, context, filters })
    result.stats.scanned = scanned
    result.stats.tookMs = Date.now() - started
    result.stats.bounded = scanned < selected.length
    return result
  }
}

export async function recallCombined(deps, options) {
  const durable = recall({ store: deps.store, ledger: deps.ledger, ...options })
  const history = deps.history ? await deps.history.search(options) : { hits: [], stats: {} }
  // Rank the two kinds in a single pass so one source cannot monopolize the quota.
  const records = [...durable.hits, ...history.hits].map((h) => h.record)
  const combined = recall({ store: { live: () => records }, ledger: deps.ledger, ...options })
  return { ...combined, denied: durable.denied, stats: { ...combined.stats, durableCandidates: durable.stats.candidates, history: history.stats } }
}
