/**
 * dsh-strata · 客户端半边（由 scripts/build-client.mjs 生成，不要直接改这个文件）
 *
 * 改源码请改：
 *   - lib/client-kit.js
 *   - lib/client/index.mjs
 * 然后跑 `npm run build`。
 */

window.__ModuleLoader__.load({
  id: "dsh-strata",
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    /* ===== 以下为内联源码。kit 与插件代码共享同一个作用域， ===== */
    /* ===== 所以 kit 导出的符号在插件代码里可以直接用。      ===== */

    /* ---------- lib/client-kit.js ---------- */






























    const CLIENT_KIT_VERSION = 1














    async function requestJSON(api, path, options = {}) {
      const method = options.method ?? 'GET'
      const init = { method, headers: {} }
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      if (controller) init.signal = controller.signal
      const timer = controller
        ? setTimeout(() => controller.abort(), options.timeoutMs ?? 8000)
        : null
      try {
        const response = await fetch(`${api}${path}`, init)
        const payload = await response.json().catch(() => null)
        if (!payload || payload.ok !== true) {
          throw new Error(payload?.error ? String(payload.error) : `HTTP ${response.status}`)
        }
        return payload.data
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }





    async function loadConfig(api, log) {
      try {
        const data = await requestJSON(api, '/config')
        return data?.config ?? null
      } catch (error) {
        log?.('config-load-failed', error?.message ?? String(error))
        return null
      }
    }





    async function reportEvent(api, event, log) {
      try {
        await requestJSON(api, '/event', { method: 'POST', body: event })
        return true
      } catch (error) {
        log?.('event-report-failed', error?.message ?? String(error))
        return false
      }
    }









    function probeEnvironment(NotificationCtor) {
      const origin = (() => {
        try { return typeof location !== 'undefined' ? String(location.origin) : null } catch { return null }
      })()
      const supported = typeof NotificationCtor === 'function'
      let permission = null
      try { permission = supported ? String(NotificationCtor.permission) : null } catch {  }
      let visibility = null
      let focused = null
      try {
        if (typeof document !== 'undefined') {
          visibility = String(document.visibilityState ?? '')
          focused = typeof document.hasFocus === 'function' ? document.hasFocus() : null
        }
      } catch {  }
      return { origin, supported, permission, visibility, focused }
    }






    async function ensurePermission(NotificationCtor) {
      try {
        if (typeof NotificationCtor !== 'function') return 'unsupported'
        if (NotificationCtor.permission === 'granted') return 'granted'
        if (typeof NotificationCtor.requestPermission !== 'function') return NotificationCtor.permission
        return String(await NotificationCtor.requestPermission())
      } catch {
        return 'error'
      }
    }















    function createThrottle(now, throttleSeconds, globalFloorMs = 2000) {
      const lastPerKey = new Map()
      let lastAny = -Infinity
      return {
        



        check(key) {
          const t = now()
          const since = t - lastAny
          if (since < globalFloorMs) {
            return { allowed: false, reason: 'global', retryInMs: globalFloorMs - since }
          }
          const prev = lastPerKey.get(key)
          const gap = (throttleSeconds > 0 ? throttleSeconds : 0) * 1000
          if (prev !== undefined && t - prev < gap) {
            return { allowed: false, reason: 'per-key', retryInMs: gap - (t - prev) }
          }
          return { allowed: true }
        },
        
        mark(key) {
          const t = now()
          lastPerKey.set(key, t)
          lastAny = t
        },
        reset() {
          lastPerKey.clear()
          lastAny = -Infinity
        },
      }
    }












    function pickText(table, language) {
      if (language === 'zh') return table.zh
      if (language === 'en') return table.en
      let langs = []
      try {
        langs = [navigator.language, ...(navigator.languages ?? [])]
      } catch {  }
      const isZh = langs.some((tag) => typeof tag === 'string' && tag.toLowerCase().startsWith('zh'))
      return isZh ? table.zh : table.en
    }





    function truncateBody(text, maxChars) {
      const s = typeof text === 'string' ? text : ''
      const max = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 140
      if (s.length <= max) return s
      if (max <= 1) return s.slice(0, max)
      return `${s.slice(0, max - 1)}…`
    }
























    function toMap(value) {
      if (value === null || value === undefined) return new Map()
      
      
      if (typeof value.get === 'function' && typeof value.forEach === 'function' && typeof value.size === 'number') {
        return value
      }
      
      if (typeof value === 'object') return new Map(Object.entries(value))
      return new Map()
    }










































    function registerSettingsSection(ctx, options) {
      const { id, order = 50, label, component, slots, slot, children } = options
      if (!slots?.inject || !slots?.register) {
        throw new Error(`laurel-kit: 拿不到 slots 服务，无法注册设置页（${id}）`)
      }

      
      const GROUP = 'laurel-center.module'
      const extra = children === undefined ? {} : { children }
      const put = (name) => slots.register({ name, id, order, label, ...extra }, component)

      
      if (slot !== undefined) {
        return ctx.effect(() => slots.inject(slot, () => put(slot)), `${id}.settings-section`)
      }

      
      return ctx.effect(() => {
        let grouped = null
        let standalone = null
        
        const offGroup = slots.inject(GROUP, () => {
          if (grouped) return () => {}
          if (standalone) { standalone(); standalone = null }
          grouped = put(GROUP)
          return () => { grouped?.(); grouped = null }
        })
        
        const offStandalone = slots.inject('settings.section', () => {
          if (grouped) return () => {}   
          if (standalone) return () => {}
          standalone = put('settings.section')
          return () => { standalone?.(); standalone = null }
        })
        
        
        
        return () => { offGroup?.(); offStandalone?.() }
      }, `${id}.settings-section`)
    }


    /* ---------- lib/client/index.mjs ---------- */

    const API = '/strata'
    const inject = ['slots', 'uiSession']
    const FALLBACK = {
      enabled: true, injectSection: true, readScope: 'workspace', readGlobal: true,
      searchHistory: true, recallLimit: 6, maxInjectChars: 1600, minScore: 0.12, writePrompt: 'conservative',
      defaultScope: 'workspace', allowGlobalWrite: false, crossWorkspace: 'ask',
      maxForeignWorkspaces: 3, historySessions: 30, associationHops: 1,
      halfLifeDays: 45, perSessionQuota: 2,
      contextNudge: true, contextNudgeGrowthTokens: 50000, contextNudgeMinTokens: 20000,
      verifiedLedger: true,
    }

    function apply(ctx) {
      const React = require('react')
      const h = React.createElement
      const source = ctx.uiSession?.adapter?.current
      const emptySnapshot = { key: undefined }
      const getBinding = source?.getSnapshot ?? (() => emptySnapshot)
      const subscribeBinding = source?.subscribe ?? (() => () => {})
      const state = {
        config: { ...FALLBACK }, ready: false, busy: false, problem: '', notice: '',
        tab: 'scope', context: { workspace: '', sessionId: null }, follow: true,
        workspaces: [], sessions: [], grants: [], memories: [], stats: null, cost: null,
        duration: {}, query: '', targetWorkspace: '', newBody: '', filterQuery: '', filterScope: '', recall: null,
      }
      let bump = () => {}
      const update = () => bump((n) => n + 1)
      const key = (path) => {
        const value = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
        return new RegExp('^[a-z]:/', 'i').test(value) || value.startsWith('//') ? value.toLowerCase() : value
      }
      const tail = (path) => String(path ?? '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '—'
      const isEn = () => /^en\b/i.test(typeof navigator === 'undefined' ? '' : navigator.language)
      const t = (zh, en) => isEn() ? en : zh
      const scopes = () => [['session', t('仅本会话', 'This session')], ['workspace', t('同工作区跨会话', 'This workspace')], ['global', t('全局记忆', 'Global memory')]]
      const hintStyle = { fontSize: 12, lineHeight: 1.6, marginTop: 5 }
      const rowStyle = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }
      const inputStyle = { font: 'inherit', padding: '7px 9px', boxSizing: 'border-box', minWidth: 0, maxWidth: '100%' }
      const border = '1px solid rgba(128,128,128,.3)'
      const contextBody = () => ({ workspace: state.context.workspace, sessionId: state.context.sessionId })

      const refresh = async (sessionId) => {
        const results = await Promise.all([
          requestJSON(API, '/status'),
          requestJSON(API, `/context${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
        ])
        const [status, metadata] = results
        state.loadedSession = sessionId
        state.config = { ...FALLBACK, ...status.config }
        state.stats = status.stats
        state.cost = status.cost ?? null
        state.grants = status.grants ?? []
        state.sessions = metadata.sessions ?? []
        state.workspaces = metadata.workspaces ?? []
        if (state.follow) state.context = metadata.context ?? { workspace: '', sessionId: null }
        state.ready = true
      }
      const loadMemories = async () => {
        const params = new URLSearchParams({ limit: '200' })
        if (state.filterQuery) params.set('q', state.filterQuery)
        if (state.filterScope) params.set('scope', state.filterScope)
        const result = await requestJSON(API, `/memories?${params}`)
        state.memories = result.rows ?? []
      }
      const run = async (fn, message = '') => {
        if (state.busy) return
        state.busy = true; state.problem = ''; state.notice = ''; update()
        try { await fn(); state.notice = message }
        catch (error) { state.problem = error?.message ?? String(error) }
        finally {
          if (state.refreshPending) {
            state.refreshPending = false
            try { await refresh(state.activeSession) } catch (error) { state.problem = error.message }
          }
          state.busy = false; update()
        }
      }
      const save = (patch) => run(async () => {
        const result = await requestJSON(API, '/config', { method: 'POST', body: { config: patch } })
        state.config = { ...FALLBACK, ...result.config }
        state.recall = null
      }, t('设置已保存，立即生效。', 'Settings saved and applied.'))

      const Button = (label, onClick, disabled = false, extra = {}) => h('button', {
        type: 'button', onClick, disabled: state.busy || disabled,
        style: { ...inputStyle, cursor: 'pointer', ...extra.style }, ...extra,
      }, label)
      const Section = (title, children, hint) => h('section', { style: { marginTop: 20 } },
        h('h3', { style: { fontSize: 14, margin: '0 0 10px' } }, title),
        hint ? h('p', { style: hintStyle }, hint) : null, children)
      const Toggle = (label, value, onChange, hint, disabled = false) => h('div', { className: 'lc-setting-row', style: { margin: '10px 0' } },
        h('label', { style: { ...rowStyle, cursor: 'pointer' } },
          h('input', { type: 'checkbox', role: 'switch', className: 'lc-toggle-input', 'aria-label': label, checked: !!value, disabled: state.busy || !state.ready || disabled, onChange: (e) => onChange(e.target.checked) }), h('span', null, label)),
        hint ? h('div', { className: 'lc-setting-hint', style: { ...hintStyle, paddingLeft: 24 } }, hint) : null)
      const Select = (label, value, options, onChange, disabled = false) => h('label', { style: { display: 'grid', gap: 6, margin: '12px 0' } },
        h('span', null, label), h('select', { 'aria-label': label, value, disabled: state.busy || disabled, onChange: (e) => onChange(e.target.value), style: inputStyle },
          options.map(([v, text]) => h('option', { key: v, value: v }, text))))
      const NumberField = (label, name, min, max, step = 1) => h('label', { style: { ...rowStyle, margin: '12px 0' } },
        h('span', { style: { flex: '1 1 230px' } }, label), h('input', {
          type: 'number', 'aria-label': label, defaultValue: state.config[name], key: `${name}:${state.config[name]}`, min, max, step,
          disabled: state.busy || !state.ready, style: { ...inputStyle, width: 108 },
          onBlur: (e) => { if (e.target.value !== '' && Number(e.target.value) !== state.config[name]) save({ [name]: Number(e.target.value) }) },
          onKeyDown: (e) => { if (e.key === 'Enter') e.target.blur() },
        }))

      function Settings() {
        const [, setTick] = React.useState(0)
        bump = setTick
        const binding = React.useSyncExternalStore(subscribeBinding, getBinding, getBinding)
        const selectedSession = binding?.key
        state.activeSession = selectedSession
        React.useEffect(() => {
          if (state.busy) { state.refreshPending = true; return }
          run(async () => { await refresh(selectedSession); await loadMemories() })
        }, [selectedSession])
        const config = state.config
        const current = state.context
        const durationOptions = [['once', t('仅一次召回（5 分钟内）', 'One recall (within 5 min)')], ['session', t('仅此会话（最长 12 小时）', 'This session (up to 12 h)')], ['persistent', t('长期保留', 'Persistent')]]
        const activeGrant = (path) => state.grants.find((g) => key(g.workspace) === key(path)
          && (g.duration === 'persistent' || !g.sessionId || g.sessionId === current.sessionId))
        const selectWorkspace = (workspace) => { state.follow = false; state.context = { workspace, sessionId: null }; state.recall = null; update() }
        const chooseSession = (id) => {
          const s = state.sessions.find((r) => r.id === id)
          state.follow = false; state.context = { workspace: s?.workspace ?? current.workspace, sessionId: s?.id ?? null }; state.recall = null; update()
        }
        const toggleWorkspace = (path, checked) => run(async () => {
          if (checked) {
            await requestJSON(API, '/grant', { method: 'POST', body: {
              workspace: path, duration: state.duration[key(path)] ?? 'persistent', sessionId: current.sessionId,
            } })
          } else {
            
            for (const grant of state.grants.filter((g) => key(g.workspace) === key(path))) {
              await requestJSON(API, '/revoke', { method: 'POST', body: { id: grant.id } })
            }
          }
          state.recall = null
          await refresh(selectedSession)
        }, t('跨工作区选择已保存。', 'Workspace selection saved.'))
        const preview = () => run(async () => {
          state.recall = await requestJSON(API, '/recall', { method: 'POST', body: { query: state.query, ...contextBody(), targetWorkspace: state.targetWorkspace } })
        })
        const addMemory = () => run(async () => {
          await requestJSON(API, '/memories', { method: 'POST', body: { body: state.newBody, scope: config.defaultScope, kind: 'fact', ...contextBody() } })
          state.newBody = ''; await refresh(selectedSession); await loadMemories()
        }, t('记忆已保存。', 'Memory saved.'))

        const tabs = [['scope', t('范围与授权', 'Scope & access')], ['context', t('上下文力度', 'Context budget')], ['guard', t('子代理与压缩', 'Subagents & compaction')], ['memories', t('记忆管理', 'Memories')], ['preview', t('召回预览', 'Preview')]]
        return h('div', { 'data-laurel-module': '', style: { padding: '4px 2px 28px', fontSize: 13, lineHeight: 1.5, maxWidth: 780, color: 'inherit' } },
          h('h2', { className: 'lc-embedded-heading', style: { fontSize: 18, margin: '0 0 6px' } }, t('记忆与上下文', 'Memory and context')),
          h('p', { className: 'lc-embedded-description', style: { margin: '0 0 14px' } }, t('延续同工作区的工作；其他工作区由你逐个勾选。', 'Continue work across sessions; select other workspaces individually.')),
          h('div', { className: state.ready && !state.problem && !state.busy && !state.notice ? 'lc-idle-status' : undefined, role: state.problem ? 'alert' : 'status', 'aria-live': 'polite', style: { minHeight: 24, marginBottom: 8 } },
            state.problem ? `${t('操作未完成：', 'Action failed: ')}${state.problem}` : state.busy ? t('正在保存或读取…', 'Saving or loading…') : state.notice || (state.ready ? t('已连接宿主', 'Connected') : t('正在连接宿主…', 'Connecting…'))),
          h('div', { style: { padding: 12, border, borderRadius: 6 } },
            h('strong', null, t('保存与预览的来源', 'Source for writes and previews')),
            h('div', { style: { overflowWrap: 'anywhere', marginTop: 5 } }, current.workspace || t('尚未选择', 'Not selected')),
            h('div', { style: hintStyle }, state.follow ? t('跟随当前会话', 'Following current session') : t('已手工选择来源', 'Manually selected source')),
            h('details', { style: { marginTop: 8 } },
              h('summary', { style: { cursor: 'pointer' } }, t('调整手工保存与预览来源', 'Change manual write and preview source')),
            Select(t('工作区', 'Workspace'), current.workspace, [['', t('请选择工作区', 'Choose a workspace')], ...state.workspaces.map((w) => [w.path, w.path])], selectWorkspace),
            Select(t('会话（保存本会话记忆时需要）', 'Session (required for session memory)'), current.sessionId ?? '',
              [['', t('不绑定会话', 'No session')], ...state.sessions.filter((s) => key(s.workspace) === key(current.workspace)).map((s) => [s.id, s.id])], chooseSession, !current.workspace),
            h('div', { style: rowStyle }, Button(t('跟随当前会话', 'Follow current session'), () => run(async () => { state.follow = true; await refresh(selectedSession) })),
              Button(t('刷新连接', 'Refresh connection'), () => run(async () => { await refresh(selectedSession); await loadMemories() }))),
            h('p', { style: hintStyle }, t('此处选择用于手工保存和预览。自动召回始终使用正在工作的真实会话；模型不能修改跨工作区授权。', 'This selection is for manual writes and previews. Automatic recall uses the actual working session; the model cannot create grants.')))),
          h('nav', { 'aria-label': t('记忆设置菜单', 'Memory settings menu'), style: { ...rowStyle, gap: 6, margin: '18px 0 8px', borderBottom: border, paddingBottom: 10 } },
            tabs.map(([id, label]) => h('button', { key: id, type: 'button', 'aria-pressed': state.tab === id,
              onClick: () => { state.tab = id; update() }, style: { ...inputStyle, fontWeight: state.tab === id ? 700 : 400, textDecoration: state.tab === id ? 'underline' : 'none' } }, label))),

          state.tab === 'scope' ? h('div', null,
            Section(t('自动读取哪些内容', 'Automatic reading scope'), h('div', null,
              Toggle(t('自动关联记忆', 'Automatic recall'), config.enabled && config.injectSection, (v) => save({ enabled: v, injectSection: v }), t('关闭后可继续手工搜索和保存记忆。', 'Manual search and writes remain available while disabled.')),
              Select(t('会话范围', 'Session scope'), config.readScope, [['session', t('仅当前会话', 'Only the current session')], ['workspace', t('同工作区的其他会话', 'Other sessions in the same workspace')]], (v) => save({ readScope: v }), !state.ready),
              Toggle(t('读取全局记忆', 'Read global memories'), config.readGlobal, (v) => save({ readGlobal: v }), t('只读取明确保存为全局的记忆，不会因此开放其他工作区的会话。', 'Reads explicitly global memories without opening other workspace histories.')),
              Toggle(t('检索历史会话片段', 'Search past session excerpts'), config.searchHistory, (v) => save({ searchHistory: v }), t('相关片段保留会话出处；不会自动当作事实写入长期记忆。', 'Relevant excerpts keep their session source and are not automatically stored as facts.')))),
            Section(t('勾选允许读取的其他工作区', 'Select other workspaces to read'), h('div', null,
              Toggle(t('启用已勾选的跨工作区读取', 'Enable selected workspace access'), config.crossWorkspace === 'ask', (v) => save({ crossWorkspace: v ? 'ask' : 'deny' })),
              config.readScope === 'session' ? h('p', { style: hintStyle }, t('当前仅会话模式会暂时停止读取其他工作区；勾选保留。', 'Session-only mode pauses other workspace reads and keeps your selections.')) : null,
              state.workspaces.filter((w) => key(w.path) !== key(current.workspace)).map((w) => {
                const grant = activeGrant(w.path)
                const duration = state.duration[key(w.path)] ?? grant?.duration ?? 'persistent'
                return h('div', { key: w.path, style: { borderTop: border, padding: '12px 0' } },
                  h('label', { style: { ...rowStyle, cursor: 'pointer', alignItems: 'flex-start' } },
                    h('input', { type: 'checkbox', 'aria-label': `${t('允许读取工作区', 'Allow workspace')}: ${w.path}`, checked: !!grant, disabled: state.busy || !state.ready || !current.workspace,
                      onChange: (e) => toggleWorkspace(w.path, e.target.checked) }),
                    h('span', { style: { flex: 1, minWidth: 0 } }, h('strong', null, tail(w.path)), h('span', { style: { display: 'block', overflowWrap: 'anywhere', fontSize: 12 } }, w.path))),
                  h('div', { style: { paddingLeft: 24 } },
                    Select(t('授权有效期', 'Grant duration'), duration, durationOptions.filter(([v]) => current.sessionId || v === 'persistent' || v === 'once'), (v) => {
                      state.duration[key(w.path)] = v; update()
                      if (grant) toggleWorkspace(w.path, true)
                    }),
                    h('div', { style: hintStyle }, grant ? `${t('已勾选', 'Selected')} · ${durationOptions.find(([v]) => v === grant.duration)?.[1] ?? grant.duration}${grant.maxUses != null ? ` · ${t('剩余', 'Remaining')} ${Math.max(0, grant.maxUses - grant.uses)}` : ''}` : t('未勾选，模型无法读取。', 'Not selected; the model cannot read it.'))))
              }),
              state.workspaces.length === 0 ? h('p', null, t('暂无工作区。先在宿主创建会话，再刷新连接。', 'No workspaces yet. Create a host session and refresh.')) : null),
              t('授权仅允许读取。取消勾选会阻止后续读取；已经进入会话的内容会留在该会话历史中。', 'Grants allow reads only. Revoking blocks future reads; content already delivered remains in the session history.')),
            Section(t('新记忆保存在哪里', 'Where new memories are saved'), h('div', null,
              Select(t('默认保存范围', 'Default write scope'), config.defaultScope, scopes(), (v) => save({ defaultScope: v }), !state.ready),
              Toggle(t('允许保存全局记忆', 'Allow global writes'), config.allowGlobalWrite, (v) => save({ allowGlobalWrite: v }), t('全局适合个人偏好；项目决定通常保存在工作区。', 'Use global memory for personal preferences and workspace memory for project decisions.'))))) : null,

          state.tab === 'context' ? h('div', null,
            Section(t('上下文力度', 'Context budget'), h('div', null,
              h('div', { style: rowStyle }, [
                [t('轻量', 'Light'), { recallLimit: 3, maxInjectChars: 800, maxForeignWorkspaces: 1, historySessions: 12 }],
                [t('均衡', 'Balanced'), { recallLimit: 6, maxInjectChars: 1600, maxForeignWorkspaces: 3, historySessions: 30 }],
                [t('深入', 'Deep'), { recallLimit: 10, maxInjectChars: 3200, maxForeignWorkspaces: 5, historySessions: 60 }],
              ].map(([label, patch]) => Button(label, () => save(patch), !state.ready, { key: label }))),
              NumberField(t('每次最多关联几条', 'Maximum excerpts per recall'), 'recallLimit', 0, 40),
              NumberField(t('自动注入字符上限（含出处）', 'Injection character cap (including sources)'), 'maxInjectChars', 200, 20000),
              NumberField(t('一次最多涉及其他工作区', 'Maximum other workspaces per recall'), 'maxForeignWorkspaces', 0, 50),
              NumberField(t('历史会话扫描上限', 'Maximum sessions scanned'), 'historySessions', 1, 100),
              Select(t('注入写入提示', 'Write-prompt in injection'), config.writePrompt, [
                ['off', t('关（只注入资料）', 'Off (excerpts only)')],
                ['conservative', t('克制（默认）', 'Conservative (default)')],
                ['balanced', t('均衡', 'Balanced')],
                ['eager', t('积极（更容易攒噪声）', 'Eager (noisier)')],
              ], (v) => save({ writePrompt: v }), !state.ready),
              h('p', { style: hintStyle }, t('这段规则随注入块一起给模型，说明什么时候值得记。记忆库为空时也会注入——否则模型不知道这里可以记东西，会一直不写。选“关”则只注入资料。', 'This rule rides along with the injection block and tells the model when something is worth saving. It is also injected while the memory store is empty; otherwise the model never learns it can save. Choose off to inject excerpts only.'))),
              t('预设只调整数量和预算，不会增加任何工作区授权。', 'Presets change volume and budget without granting workspace access.')),
            h('details', { style: { marginTop: 18 } }, h('summary', { style: { cursor: 'pointer' } }, t('高级检索设置', 'Advanced retrieval settings')),
              NumberField(t('最低相关分', 'Minimum relevance score'), 'minScore', 0, 1, .01),
              NumberField(t('每个来源会话的条数上限', 'Per-source-session quota'), 'perSessionQuota', 1, 20),
              NumberField(t('关联跳数', 'Association hops'), 'associationHops', 0, 4),
              NumberField(t('时间衰减半衰期（天）', 'Recency half-life (days)'), 'halfLifeDays', 1, 3650)),
            Section(t('上下文领航', 'Context pilot'), h('div', null,
              Toggle(t('增长式上下文提醒', 'Growth-based context nudge'), config.contextNudge, (v) => save({ contextNudge: v }), t('宿主的自动压缩只在窗口到 80% 时才动手（1M 窗口 = 80 万 token），长会话常常到不了。这里改成：上下文每长大一定量就温和提醒一次，与窗口大小无关。只提醒，不删改任何历史。', 'The host compacts only near 80% of the window (800k on a 1M window), which many long sessions never reach. This nudges on growth instead, independent of window size. Nudge only — never deletes or rewrites history.')),
              NumberField(t('每长大多少 token 提醒一次', 'Nudge after this much growth (tokens)'), 'contextNudgeGrowthTokens', 2000, 500000),
              NumberField(t('低于多少 token 不提醒', 'Do not nudge below this size (tokens)'), 'contextNudgeMinTokens', 0, 500000),
              Toggle(t('记录已核实文件（减少重复读）', 'Track verified files (fewer re-reads)'), config.verifiedLedger, (v) => save({ verifiedLedger: v }), t('模型读完并确认过某个文件后可以记一笔；文件一被改动就自动失效。目的是减少"反复整文件重读/重写"——实测那部分占过一次长会话总消耗的 25.9%。', 'After the model reads and confirms a file it can record it; an edited file stops counting automatically. Aims at repeated whole-file re-reads/writes, which measured 25.9% of one long session.')),
              h('p', { style: hintStyle }, t('水位数取自宿主上报的用量，拿不到就不提醒——本插件自己的估算只用于显示，不会拿来记账。', 'The watermark comes from host-reported usage. If the host reports nothing, no nudge is sent; this plugin never substitutes its own estimate for accounting.'))))) : null,

          state.tab === 'guard' ? h('div', null,
            Section(t('子代理等待上限', 'Subagent wait cap'), h('div', null,
              NumberField(t('wait_agent 单次等待上限（毫秒，0 = 不干预）', 'wait_agent cap (ms, 0 = off)'), 'subagentWaitCapMs', 0, 3600000, 1000),
              h('p', { style: hintStyle }, t('宿主的 wait_agent 等待时间由模型每次自己传：默认 30 秒，允许 10 秒到 1 小时。而宿主的工具超时策略只对「自己声明了 timeoutMs 的工具」生效，wait_agent 没声明，所以那个硬超时对它无效。实测一个会话里它被调 41 次、会话跨度 6 小时而真正在算的只有 73 分钟。这里在工具执行前把参数压到上限以内：只改这一个数字，不改语义、不拦截调用。', 'wait_agent takes its timeout from the model on every call (default 30 s, range 10 s to 1 h). The host tool-timeout policy only covers tools that declare timeoutMs, and wait_agent does not — so no hard limit applies. Measured: one session called it 41 times, spanning 6 h while only 73 min were spent computing. This clamps the argument before execution: one number, no semantics changed, no call blocked.')))),
            Section(t('子代理协作纪律', 'Subagent discipline'), h('div', null,
              Toggle(t('子代理只对主控汇报、彼此不互发', 'Subagents report to the lead only'), config.subagentStarTopology, (v) => save({ subagentStarTopology: v }), t('实测一个会话里 98 条团队消息全是子代理之间直接对话、互相「更正（请以这条为准）」，读数互相污染。业界做法（Supervisor 模式）是星型拓扑：worker 只回主控、彼此不通信。这条只注入一段短规则，不拦截任何工具。', 'Measured: 98 team messages in one session were subagents talking to each other and issuing corrections, polluting each other readings. The established pattern (Supervisor) is a star topology: workers report to the lead only. This injects one short rule and intercepts nothing.')),
              Toggle(t('重复工具调用提醒', 'Repeated tool-call nudge'), config.repeatToolNudge, (v) => save({ repeatToolNudge: v }), t('实测一个会话里 shell 调用 1006 次、改文件 831 次——典型的「改了又试、试了又改」。同一条工具连续重复超过阈值就温和提醒一次，不阻止调用（阻止会误伤正常的重试）。', 'Measured: 1006 shell calls and 831 file writes in one session. When the same tool repeats past the threshold, one gentle nudge is added. Calls are never blocked, since that would break legitimate retries.')),
              NumberField(t('连续重复几次开始提醒', 'Repeat threshold'), 'repeatToolThreshold', 2, 50))),
            Section(t('上下文压缩（宿主内置，此处只读）', 'Host compaction (read-only here)'), h('div', null,
              h('p', { style: hintStyle }, t('宿主内置的两个压缩插件参数偏保守：工具结果裁剪要「单条超过 8192 字符」才动手，裁完还留 5120；自动压缩要窗口用到 80% 才触发（1M 窗口 = 80 万 token），实测长会话最高只到 42 万，一次都没触发过。这两个值属于宿主，要改得写 profile 的 cordis.patch.yml，不在本插件的界面里。本插件能做的替代是上面的「增长式上下文提醒」——它按增长量提醒，与窗口大小无关。', 'Two built-in host compactors are conservative: tool-result pruning waits until a single result exceeds 8192 chars and still keeps 5120; automatic compaction fires only near 80% of the window (800k on a 1M window), which measured long sessions never reached. Those values belong to the host and live in the profile cordis.patch.yml, not in this UI. The substitute this plugin offers is the growth-based nudge above, which is independent of window size.'))))) : null,

          state.tab === 'memories' ? h('div', null,
            Section(t('手工保存记忆', 'Save a memory'), h('div', null,
              h('p', { style: hintStyle }, `${t('保存到', 'Save to')}: ${scopes().find(([v]) => v === config.defaultScope)?.[1]} · ${current.workspace || '—'}`),
              config.defaultScope === 'global' && !config.allowGlobalWrite ? h('p', { style: hintStyle }, t('请先在范围与授权中开启允许保存全局记忆。', 'Enable global writes in Scope & access first.')) : null,
              config.defaultScope === 'session' && !current.sessionId ? h('p', { style: hintStyle }, t('请先展开上方来源设置并绑定会话。', 'Expand the source settings above and choose a session first.')) : null,
              h('label', { style: { display: 'grid', gap: 6 } }, t('要记住的内容', 'Memory text'), h('textarea', { 'aria-label': t('要记住的内容', 'Memory text'), value: state.newBody, rows: 3, maxLength: 2000, style: { ...inputStyle, width: '100%', resize: 'vertical' },
                onChange: (e) => { state.newBody = e.target.value; update() } })),
              h('div', { style: { marginTop: 10 } }, Button(t('保存记忆', 'Save memory'), addMemory, !state.ready || !state.newBody.trim() || !current.workspace || (config.defaultScope === 'session' && !current.sessionId) || (config.defaultScope === 'global' && !config.allowGlobalWrite))))),
            Section(t('全部长期记忆（管理视图）', 'All durable memories (management view)'), h('div', null,
              h('p', { style: hintStyle }, t('管理列表可查看全部记忆，自动注入仍按授权过滤。', 'This management list shows all memories; automatic injection still follows access rules.')),
              Select(t('筛选保存范围', 'Filter by scope'), state.filterScope, [['', t('全部', 'All')], ...scopes()], (v) => { state.filterScope = v; run(loadMemories) }),
              h('label', { style: rowStyle }, t('搜索记忆', 'Search memories'), h('input', { type: 'search', 'aria-label': t('搜索记忆', 'Search memories'), value: state.filterQuery, style: { ...inputStyle, flex: '1 1 180px' }, onChange: (e) => { state.filterQuery = e.target.value; update() }, onKeyDown: (e) => { if (e.key === 'Enter') run(loadMemories) } }), Button(t('搜索', 'Search'), () => run(loadMemories))),
              state.memories.length ? state.memories.map((m) => h('article', { key: m.id, style: { borderTop: border, padding: '12px 0', marginTop: 10 } },
                h('div', { style: { overflowWrap: 'anywhere' } }, m.body), h('div', { style: { ...hintStyle, overflowWrap: 'anywhere' } }, `${m.scope} · ${m.workspacePath || m.workspace || 'global'} · ${m.sessionId ?? '—'} · ${m.id}`),
                Button(t('遗忘', 'Forget'), () => run(async () => { await requestJSON(API, '/forget', { method: 'POST', body: { id: m.id } }); await loadMemories(); await refresh(selectedSession) })))) : h('p', null, t('还没有长期记忆。可以手工保存，或让模型记住一个决定。', 'No durable memories yet. Save one here or ask the model to remember a decision.'))))) : null,

          state.tab === 'preview' ? Section(t('检查实际注入内容', 'Inspect recalled context'), h('div', null,
            h('p', { style: hintStyle }, t('预览不消耗一次性授权，也不增加记忆使用次数。', 'Preview does not consume one-time grants or memory usage.')),
            h('label', { style: { display: 'grid', gap: 6 } }, t('查询内容', 'Query'), h('input', { type: 'text', 'aria-label': t('查询内容', 'Query'), value: state.query, style: inputStyle, onChange: (e) => { state.query = e.target.value; update() }, onKeyDown: (e) => { if (e.key === 'Enter' && state.query.trim() && current.workspace) preview() } })),
            Select(t('限定来源工作区', 'Narrow to a source workspace'), state.targetWorkspace, [['', t('全部可读取来源', 'All accessible sources')], ...state.workspaces.map((w) => [w.path, w.path])], (v) => { state.targetWorkspace = v; state.recall = null; update() }),
            Button(t('运行预览', 'Preview'), preview, !state.ready || !state.query.trim() || !current.workspace),
            state.recall ? h('div', { style: { marginTop: 14 } },
              h('p', null, `${t('匹配', 'Matches')} ${state.recall.hits.length} · ${t('实际注入字符', 'Injected chars')} ${state.recall.injection?.length ?? 0} / ${config.maxInjectChars}`),
              state.recall.hits.map((hit) => h('article', { key: hit.id, style: { borderTop: border, padding: '10px 0' } },
                h('div', { style: { overflowWrap: 'anywhere' } }, hit.body), h('div', { style: { ...hintStyle, overflowWrap: 'anywhere' } }, `${hit.origin === 'history' ? t('历史片段', 'History excerpt') : t('长期记忆', 'Durable memory')} · ${hit.workspace} · ${hit.sessionId ?? '—'} · ${hit.id} · ${hit.score}`))),
              state.recall.injection ? h('pre', { style: { fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', border, borderRadius: 6, padding: 12 } }, state.recall.injection) : h('p', null, t('没有相关且可读取的内容。若要查其他工作区，请先勾选。', 'No relevant accessible content. Select another workspace to read it.')),
              state.recall.stats?.history?.bounded ? h('p', { style: hintStyle }, t('已达到本次扫描上限，可提高力度后再试。', 'This scan reached its limit. Increase the budget and try again.')) : null) : null)) : null,

          h('details', { style: { marginTop: 24 } }, h('summary', null, t('存储与运行信息', 'Storage and runtime details')),
            h('p', { style: { ...hintStyle, overflowWrap: 'anywhere' } }, state.stats?.path ?? '—'),
            h('p', { style: hintStyle }, `${t('有效长期记忆', 'Live durable memories')}: ${state.stats?.live ?? 0} · ${t('授权', 'Grants')}: ${state.grants.length}`),
            
            state.cost ? h('p', { style: hintStyle }, `${t('常驻注入块', 'Resident block')}: ${state.cost.resident?.chars ?? 0}${state.cost.resident?.tokens != null ? ` / ${state.cost.resident.tokens} tok` : ''} ${t('字符（每轮都要重发）', 'chars (re-sent every turn)')} · ${t('近 24 小时注入', 'Injected in 24h')}: ${state.cost.last24h?.blocks ?? 0} · ${t('付费模型调用', 'Paid model calls')}: ${state.cost.total?.paidCalls ?? 0}${state.cost.paidEver ? ` (${t('入', 'in')} ${state.cost.total.paidIn} / ${t('出', 'out')} ${state.cost.total.paidOut})` : ` — ${t('从未花过模型钱', 'never spent a model call')}`}`) : null,
            state.cost ? h('p', { style: hintStyle }, t('字符数是精确的；token 是本插件自己的估算，宿主没有金额服务。累计注入字符会把同一个常驻块重复计入。', 'Char counts are exact; token counts are estimated locally by this plugin — the host has no price service. Cumulative chars re-count the same resident block.')) : null))
      }

      registerSettingsSection(ctx, { id: 'strata', order: 57, label: () => t('记忆与上下文', 'Memory and context'), component: Settings, slots: ctx.slots })
    }


    module.exports.apply = apply
    if (typeof inject !== 'undefined') module.exports.inject = inject

    return module.exports
  },
})
