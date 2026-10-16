/**
 * dsh-strata · 宿主半边：HTTP 数据面
 *
 * 设置页（客户端半边）通过这几个端点读写。响应统一是 `{ ok, data }` /
 * `{ ok, error }` —— 与 Laurel 同一套约定，浏览器半边只认这一种形状。
 *
 * 路由前缀 `/strata` 要三处一致：本文件、`lib/index.js`、`lib/client/index.mjs`。
 */

import { DEFAULT_CONFIG, PACKAGE_NAME, VERSION, normalizeConfig, pickKnown, pluginPaths, workspaceKey } from '../core/config.js'
import { renderInjection } from '../core/recall.js'
import { appendEvent, costLedger, discoverWorkspaces, listLiveSessions, readEvents, sessionTimeline } from '../core/store.js'
import { listHistorySessions, recallCombined } from '../core/history.js'
import { estimateTokens } from '../core/text.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 悬浮窗脚本的缓存（进程内只读一次；文件随包发布，运行期不会变）。 */
let widgetScriptCache
/**
 * 读 `lib/widget/strata-widget.js`。这个文件是**裸 script**（无构建、无依赖），
 * 直接原样发给浏览器。读不到返回 `null`，让端点回 404 —— 绝不回一段空脚本，
 * 否则页面会以为加载成功却什么都不显示。
 */
function readWidgetScript() {
  if (typeof widgetScriptCache === 'string') return widgetScriptCache
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    widgetScriptCache = readFileSync(join(here, '..', 'widget', 'strata-widget.js'), 'utf8')
    return widgetScriptCache
  } catch {
    return null
  }
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 读请求体（带上限）。不是合法 JSON 就返回 null。 */
export function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { resolve(null); req.destroy?.(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

function send(res, status, payload, method = 'GET') {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(method === 'HEAD' ? undefined : JSON.stringify(payload))
}

/**
 * 造 HTTP handler。宿主半边把它注册在
 * `webServer.register({ kind: 'prefix', path: '/strata' })`。
 *
 * @param {{home, getConfig, setConfig, store, ledger, log}} deps
 */
export function createHandler(deps) {
  const { home, getConfig, setConfig, store, ledger, log } = deps

  const sessions = () => listHistorySessions(deps, getConfig())
  const contextFor = async (body = {}) => {
    if (body.sessionId) {
      const session = (await sessions()).find((s) => s.id === body.sessionId)
      if (!session) throw new Error('当前会话尚未被宿主识别，请刷新或选择工作区')
      if (body.workspace && workspaceKey(body.workspace) !== workspaceKey(session.cwd)) throw new Error('会话和工作区不匹配')
      return { workspace: session.cwd, workspacePath: session.cwd, sessionId: session.id, lineage: [] }
    }
    return { workspace: typeof body.workspace === 'string' ? body.workspace : '', workspacePath: body.workspace ?? '', sessionId: null, lineage: [] }
  }
  const workspaceRows = () => {
    const known = new Map(discoverWorkspaces(home).map((w) => [workspaceKey(w.path), w]))
    for (const r of store.live()) if (r.workspace) known.set(workspaceKey(r.workspace), { path: r.workspacePath || r.workspace, source: 'memory' })
    for (const g of ledger.grants) if (!known.has(workspaceKey(g.workspace))) known.set(workspaceKey(g.workspace), { path: g.workspace, source: 'grant' })
    return [...known.values()]
  }

  return async function handler(req, res) {
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.replace(/^\/strata/, '').replace(/\/+$/, '') || '/'

    try {
      // 悬浮窗脚本：必须在 JSON 守卫之前处理 —— 它返回的是 JS，不是 JSON。
      if (route === '/widget.js' && (method === 'GET' || method === 'HEAD')) {
        const js = readWidgetScript()
        if (js === null) return send(res, 404, { ok: false, error: '悬浮窗脚本未随包安装' })
        if (res.headersSent) return
        res.statusCode = 200
        res.setHeader('content-type', 'application/javascript; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(method === 'HEAD' ? undefined : js)
        return
      }

      // JSON-only writes plus an origin check prevent drive-by grant creation from other web pages.
      if (method === 'POST') {
        const contentType = req.headers?.['content-type'] ?? ''
        if (!/^application\/json(?:;|$)/i.test(contentType)) return send(res, 415, { ok: false, error: '写入必须使用 application/json' })
        const origin = req.headers?.origin
        if (origin) {
          let originHost
          try { originHost = new URL(origin).host } catch { return send(res, 403, { ok: false, error: '不支持此来源' }) }
          if (originHost !== req.headers?.host) return send(res, 403, { ok: false, error: '跨来源写入已拒绝' })
        }
      }

      if (route === '/context' && (method === 'GET' || method === 'HEAD')) {
        const rows = await sessions()
        const requested = url.searchParams.get('sessionId')
        const current = rows.find((r) => r.id === requested)
        const known = new Map(workspaceRows().map((w) => [workspaceKey(w.path), w]))
        for (const r of rows) if (!known.has(workspaceKey(r.cwd))) known.set(workspaceKey(r.cwd), { path: r.cwd, source: 'session' })
        return send(res, 200, { ok: true, data: {
          context: current ? { workspace: current.cwd, sessionId: current.id } : null,
          sessions: rows.map((r) => ({ id: r.id, workspace: r.cwd })), workspaces: [...known.values()],
        } }, method)
      }

      /* ---------------- 悬浮窗实时快照 ---------------- */
      // 悬浮窗（`/strata/widget.js`）每 2 秒轮询这里。刻意只回**本机可算、无隐私**的聚合数：
      // 常驻块体积、本会话时间线、压缩效率、花销。绝不回 `home`、绝不回记忆正文 ——
      // 悬浮窗会挂在页面上，可能被截图或旁看。
      //
      // ── 「这是哪个会话的数据」────────────────────────────────────────────
      // 宿主不把「当前窗口是哪个会话」交给插件，页面 URL 又是 `dsh-app://` 自定义协议、
      // 没有可用的会话参数。所以这里做**确定性兜底**而不是把全库混在一起算：
      //   - 传了 `sessionId` → 就用它（并在响应里回显，让悬浮窗能显示"你选的这个"）；
      //   - 只传 `workspace` → 按工作区聚合；
      //   - 什么都没传 → **自动落到最近活跃的那个会话**（事件流里 `lastAt` 最大的），
      //     而不是混算全库。悬浮窗下方会列出可切换的会话清单，用户能手动改。
      // `scope` 字段明确告诉前端当前用的是哪种口径，前端据此显示不同标题。
      if (route === '/live' && (method === 'GET' || method === 'HEAD')) {
        const wantedSession = url.searchParams.get('sessionId') || null
        const wantedWorkspace = url.searchParams.get('workspace') || null
        const all = url.searchParams.get('all') === '1'
        const index = listLiveSessions(home)
        const known = new Set(index.sessions.map((s) => s.sessionId))
        // 请求的会话可能在事件流里还没出现（刚建的空会话）：仍然认它，但如实标出来。
        const sessionId = wantedSession ?? (!all && !wantedWorkspace ? index.latestSessionId : null)
        const scope = all ? 'all'
          : wantedSession ? (known.has(wantedSession) ? 'session' : 'session-new')
            : wantedWorkspace ? 'workspace'
              : sessionId ? 'auto-session' : 'empty'
        const config = getConfig()
        const cost = costLedger(home)
        const live = sessionTimeline(home, { sessionId, workspace: wantedWorkspace ?? undefined })
        // 会话身份里也要带上工作区 —— 悬浮窗标题要显示"这个会话属于哪个工作区"。
        // 显式按工作区过滤就用它；否则从会话索引里查这个会话最后活跃时所在的工作区。
        const sessionWorkspace = wantedWorkspace
          ?? (sessionId ? index.sessions.find((s) => s.sessionId === sessionId)?.workspace ?? null : null)
        return send(res, 200, {
          ok: true,
          data: {
            version: VERSION,
            now: live.now,
            sessionId: live.sessionId,
            workspace: sessionWorkspace,
            /** 'session' | 'session-new' | 'auto-session' | 'workspace' | 'all' | 'empty' */
            scope,
            /** 事件流里出现过的会话（按最近活跃排序），给悬浮窗做切换器。绝不回 home。 */
            sessions: index.sessions.map((s) => ({
              sessionId: s.sessionId, workspace: s.workspace, events: s.events, lastAt: s.lastAt,
            })),
            latestSessionId: index.latestSessionId,
            enabled: !!(config.enabled && config.injectSection),
            resident: live.resident,
            injectCount: live.injectCount,
            firstInjectAt: live.firstInjectAt,
            versionReplacementAt: live.versionReplacementAt,
            compression: live.compression,
            paid: live.paid,
            savings: live.savings,
            budgetTouched: live.budgetTouched,
            total: {
              blocks: cost.total.blocks, chars: cost.total.chars, tokens: cost.total.tokens,
              hits: cost.total.hits, stored: cost.total.stored,
              paidCalls: cost.total.paidCalls, paidIn: cost.total.paidIn,
              paidOut: cost.total.paidOut, paidKept: cost.total.paidKept,
            },
            last24h: {
              blocks: cost.last24h.blocks, chars: cost.last24h.chars,
              tokens: cost.last24h.tokens, paidCalls: cost.last24h.paidCalls,
            },
            since: cost.since,
            timeline: live.timeline.slice(-60),
            note: cost.note,
          },
        }, method)
      }

      /* ---------------- 配置 ---------------- */
      if (route === '/config' && (method === 'GET' || method === 'HEAD')) {
        const paths = pluginPaths(home)
        return send(res, 200, {
          ok: true,
          data: {
            config: getConfig(),
            defaults: pickKnown(DEFAULT_CONFIG),
            version: VERSION,
            package: PACKAGE_NAME,
            settingsPath: paths.settings,
            memoriesPath: paths.memories,
            grantsPath: paths.grants,
            eventsPath: paths.events,
            home,
          },
        }, method)
      }

      if (route === '/config' && method === 'POST') {
        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object') return send(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
        const patch = body.config && typeof body.config === 'object' ? body.config : body
        const config = setConfig(patch)
        appendEvent({ kind: 'config', detail: JSON.stringify(pickKnown(config)) }, home)
        return send(res, 200, { ok: true, data: { config } })
      }

      /* ---------------- 总览 ---------------- */
      if (route === '/status' && (method === 'GET' || method === 'HEAD')) {
        const stats = store.stats()
        const grants = ledger.active()
        const rows = readEvents(100, home)
        return send(res, 200, {
          ok: true,
          data: {
            package: PACKAGE_NAME,
            version: VERSION,
            config: getConfig(),
            stats,
            grants,
            grantCounts: {
              active: grants.length,
              total: ledger.grants.length,
              revoked: ledger.grants.filter((g) => g.revokedAt).length,
            },
            workspaces: workspaceRows(),
            events: rows.length,
            lastEvent: rows[0] ?? null,
            cost: costLedger(home),
            // 不回传 `home`（$DSH_HOME 绝对路径）：这是本轮新加的暴露面，
            // 设置页只需要 `cost`/`stats`，不需要知道用户的磁盘结构。
          },
        }, method)
      }

      /* ---------------- 记忆列表 ---------------- */
      if (route === '/memories' && (method === 'GET' || method === 'HEAD')) {
        const scope = url.searchParams.get('scope')
        const workspace = url.searchParams.get('workspace')
        const kind = url.searchParams.get('kind')
        const query = url.searchParams.get('q')
        const includeSuperseded = url.searchParams.get('superseded') === '1'
        const limit = clampNumber(url.searchParams.get('limit') ?? 200, 1, 2000, 200)

        let rows = includeSuperseded ? store.all() : store.live()
        if (scope) rows = rows.filter((r) => r.scope === scope)
        if (kind) rows = rows.filter((r) => r.kind === kind)
        if (workspace) {
          const key = workspaceKey(workspace)
          rows = rows.filter((r) => workspaceKey(r.workspace) === key)
        }
        if (query) {
          const needle = query.toLowerCase()
          rows = rows.filter((r) => r.body.toLowerCase().includes(needle)
            || r.tags.some((t) => t.toLowerCase().includes(needle))
            || r.entities.some((t) => t.toLowerCase().includes(needle)))
        }
        rows = [...rows].sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)).slice(0, limit)
        return send(res, 200, { ok: true, data: { rows, total: rows.length } }, method)
      }

      if (route === '/memories' && method === 'POST') {
        // 手动新增 / 编辑一条记忆。设置页用它，也让你能手工补记忆。
        const body = await readJsonBody(req)
        if (!body || typeof body.body !== 'string') return send(res, 400, { ok: false, error: '必须提供 body' })
        const config = getConfig()
        const context = await contextFor(body)
        const scope = body.scope ?? config.defaultScope
        if (scope === 'global' && !config.allowGlobalWrite) return send(res, 403, { ok: false, error: '请先开启允许保存全局记忆' })
        if (!context.workspace && scope !== 'global') return send(res, 400, { ok: false, error: '请先选择工作区' })
        if (scope === 'session' && !context.sessionId) return send(res, 400, { ok: false, error: '本会话记忆需要选择会话' })
        const { record, created } = store.put({
          body: body.body,
          kind: body.kind,
          scope,
          workspace: context.workspace,
          workspacePath: context.workspace,
          sessionId: context.sessionId,
          tags: body.tags,
          entities: body.entities,
          salience: body.salience,
          confidence: body.confidence,
          origin: 'settings-ui',
        })
        appendEvent({ kind: 'remember', detail: `${created ? '新增' : '刷新'} ${record.id} @${record.scope}`, workspace: record.workspace }, home)
        return send(res, 200, { ok: true, data: { record, created } })
      }

      if (route === '/forget' && method === 'POST') {
        const body = await readJsonBody(req)
        if (!body?.id) return send(res, 400, { ok: false, error: '必须提供 id' })
        const ok = store.supersede(String(body.id), 'forgotten-by-ui')
        appendEvent({ kind: 'forget', detail: `${body.id} ${ok ? '已取代' : '未找到'}` }, home)
        return send(res, 200, { ok: ok, data: { id: body.id, superseded: ok } })
      }

      /* ---------------- 授权台账 ---------------- */
      if (route === '/grants' && (method === 'GET' || method === 'HEAD')) {
        return send(res, 200, {
          ok: true,
          data: {
            grants: ledger.grants,
            active: ledger.active(),
            workspaces: workspaceRows().map((w) => ({
              ...w,
              verdict: ledger.check(w.path),
            })),
          },
        }, method)
      }

      if (route === '/grant' && method === 'POST') {
        const body = await readJsonBody(req)
        if (!body?.workspace) return send(res, 400, { ok: false, error: '必须提供 workspace' })
        const context = body.sessionId ? await contextFor({ sessionId: body.sessionId }) : { sessionId: null }
        const grant = ledger.grant(String(body.workspace), {
          duration: body.duration,
          sessionId: context.sessionId,
          maxUses: Number.isFinite(body.maxUses) ? body.maxUses : undefined,
          note: body.note,
        })
        appendEvent({ kind: 'grant', workspace: grant.workspace, detail: `${grant.id} ${grant.duration}` }, home)
        return send(res, 200, { ok: true, data: { grant } })
      }

      if (route === '/revoke' && method === 'POST') {
        const body = await readJsonBody(req)
        if (!body?.id) return send(res, 400, { ok: false, error: '必须提供 id' })
        const ok = ledger.revoke(String(body.id))
        appendEvent({ kind: 'revoke', detail: `${body.id} ${ok ? '已撤销' : '未找到'}` }, home)
        return send(res, 200, { ok: ok, data: { id: body.id, revoked: ok } })
      }

      /* ---------------- 召回测试 ---------------- */
      if (route === '/recall' && method === 'POST') {
        const body = await readJsonBody(req)
        const query = String(body?.query ?? '')
        const config = getConfig()
        const context = await contextFor(body ?? {})
        if (!context.workspace) return send(res, 400, { ok: false, error: '请先选择预览工作区' })
        const result = await recallCombined(deps, { config, query, context, deadlineMs: 3000,
          filters: { workspace: body?.targetWorkspace || undefined } })
        const injection = renderInjection(result.hits, config, result.denied)
        appendEvent({ kind: 'recall', count: result.hits.length, detail: `UI 测试召回：${query.slice(0, 120)}` }, home)
        return send(res, 200, {
          ok: true,
          data: {
            hits: result.hits.map((h) => ({
              id: h.record.id,
              body: h.record.body,
              kind: h.record.kind,
              origin: h.record.origin,
              sessionId: h.record.sessionId,
              seq: h.record.seq,
              scope: h.record.scope,
              workspace: h.record.workspacePath || h.record.workspace,
              foreign: h.foreign,
              grant: h.grant?.id ?? null,
              score: Number(h.score.toFixed(4)),
              channels: h.channels,
            })),
            denied: result.denied,
            stats: { ...result.stats, injectionTokens: injection ? estimateTokens(injection) : 0 },
            injection,
          },
        })
      }

      /* ---------------- 工作区 ---------------- */
      if (route === '/workspaces' && (method === 'GET' || method === 'HEAD')) {
        const list = workspaceRows().map((w) => ({ ...w, verdict: ledger.check(w.path) }))
        return send(res, 200, { ok: true, data: { workspaces: list } }, method)
      }

      /* ---------------- 事件日志 ---------------- */
      if (route === '/event' && method === 'POST') {
        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object') return send(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
        const record = appendEvent(body, home)
        if (record.kind === 'error' || record.kind === 'warn') log?.warn?.(`客户端回传：${record.kind} ${record.detail ?? ''}`)
        return send(res, 200, { ok: true, data: { recorded: record.t } })
      }

      if (route === '/events' && (method === 'GET' || method === 'HEAD')) {
        const limit = clampNumber(url.searchParams.get('limit') ?? 50, 1, 500, 50)
        return send(res, 200, { ok: true, data: { rows: readEvents(limit, home) } }, method)
      }

      /* ---------------- 台账清理 ---------------- */
      if (route === '/prune' && method === 'POST') {
        const removed = ledger.prune()
        return send(res, 200, { ok: true, data: { removed } })
      }

      return send(res, 404, { ok: false, error: `未知端点：${method} /strata${route}` }, method)
    } catch (error) {
      log?.error?.(`HTTP 处理出错：${error?.message ?? error}`)
      return send(res, 500, { ok: false, error: String(error?.message ?? error) }, method)
    }
  }
}

export { normalizeConfig }
