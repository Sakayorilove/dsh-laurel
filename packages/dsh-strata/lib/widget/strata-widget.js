/**
 * dsh-strata · 悬浮窗（页面侧，纯 JS，零依赖）
 *
 * ── 为什么是「裸 script」而不是 React 组件的 slot ────────────────────────
 * 设置页走 `slots.inject('settings.section')`，那需要客户端模块系统 + React。
 * 但悬浮窗要满足三个硬条件，slot 做不到：
 *   1. **始终可见**：不管当前在哪个面板/会话都要挂在右下角；
 *   2. **不依赖宿主模块表**：宿主升级、模块表变了，悬浮窗不能跟着崩；
 *   3. **桌面端也能挂**：Electron 壳的 index.html 是静态直出的，slot 通道不生效。
 * 所以照抄 `dsh-whale-widget` 已经踩过坑的通路：宿主推一行 script、本文件自建 DOM。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 *   - 拿不到数据就显示 `—`，**绝不编数**（和 costLedger 一个口径）。
 *   - 任何异常都吞掉：这是挂在用户页面上的东西，不能因为它让宿主白屏。
 *   - 不显示记忆正文、不显示绝对路径 —— 悬浮窗会被截图/被旁看。
 */
(function () {
  'use strict'
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (window.__STRATA_WIDGET__) return
  window.__STRATA_WIDGET__ = true

  var API = '/strata/live'
  var POS_KEY = 'strata.widget.pos'
  var COLLAPSE_KEY = 'strata.widget.collapsed'
  var SESSION_KEY = 'strata.widget.session'
  var POLL_MS = 2000

  var CSS = [
    // 宿主（DSH）会注入 `--dsw-alias-*` 变量，正常挂载时照用。但没有宿主变量时
    // （预览夹具、宿主改版换名、早期版本）也必须能读 —— 所以这里**先本地兜底**，
    // 并且用 `prefers-color-scheme` 区分深浅。只靠单一深色兜底会造成
    // 「浅色主题下白底 + 浅灰字」这种完全看不见的组合。
    //
    // 变量定义用 `:root` 而不是 `.strata-w`：隐藏后那个「记忆地层」把手是直接挂在
    // `document.body` 上的，不在 `.strata-w` 里，定义在 `.strata-w` 上它取不到。
    ':root{--sw-bg:var(--dsw-alias-bg-elevated,#1e1e20);',
    '--sw-fg:var(--dsw-alias-label-primary,var(--dsw-alias-text-1,#e6e6e6));',
    '--sw-bd:var(--dsw-alias-border-2,rgba(128,128,128,.34))}',
    // 浅色兜底：只在**宿主也没给变量**时生效（变量一旦被宿主定义，这一块覆盖不到它）。
    '@media (prefers-color-scheme: light){:root{',
    '--sw-bg:#ffffff;--sw-fg:#1c1c1e;--sw-bd:rgba(0,0,0,.16)}}',
    '.strata-w{',
    'position:fixed;z-index:2147482000;right:16px;bottom:16px;width:268px;',
    'font:12px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;color:var(--sw-fg);',
    'background:color-mix(in srgb,var(--sw-bg) 92%,transparent);',
    'border:1px solid var(--sw-bd);border-radius:10px;',
    'box-shadow:0 8px 28px rgba(0,0,0,.34);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);',
    'overflow:hidden;user-select:none;-webkit-user-select:none}',
    '@media (prefers-color-scheme: light){.strata-w{box-shadow:0 8px 28px rgba(0,0,0,.16)}}',
    '.strata-w *{box-sizing:border-box}',
    '.strata-w-hd{display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:move;',
    'background:color-mix(in srgb,var(--sw-bg) 96%,transparent);border-bottom:1px solid var(--sw-bd)}',
    '.strata-w-hd b{font-size:12px;font-weight:650;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.strata-w-dot{width:7px;height:7px;border-radius:50%;background:#6b7280;flex:none}',
    '.strata-w-dot.on{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18)}',
    '.strata-w-dot.off{background:#ef4444}',
    '.strata-w-btn{border:0;background:transparent;color:inherit;opacity:.6;cursor:pointer;font:inherit;',
    'padding:0 3px;line-height:1;flex:none}',
    '.strata-w-btn:hover{opacity:1}',
    '.strata-w-bd{padding:8px 10px 10px;display:grid;gap:7px;max-height:60vh;overflow:auto}',
    // 会话身份块：置顶、略微突出，回答「这屏数据是谁的」。
    '.strata-w-id{padding:6px 8px;border-radius:7px;background:rgba(128,128,128,.11);display:grid;gap:2px}',
    '.strata-w-idtop{display:flex;align-items:baseline;gap:6px}',
    '.strata-w-idtop>span:first-child{font-size:12px;flex:1;min-width:0}',
    '.strata-w-idsub{font-size:10px;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.strata-w-badge{font-size:9px;padding:1px 5px;border-radius:999px;flex:none;',
    'background:rgba(128,128,128,.2);opacity:.85;letter-spacing:.02em}',
    '.strata-w-badge.auto{background:rgba(59,130,246,.22);color:#60a5fa}',
    '.strata-w-pick{width:100%;font:11px/1.4 inherit;font-family:inherit;padding:4px 6px;border-radius:6px;',
    'border:1px solid var(--sw-bd);background:color-mix(in srgb,var(--sw-bg) 88%,transparent);',
    'color:var(--sw-fg);cursor:pointer;outline:none}',
    '.strata-w-pick:focus{border-color:#3b82f6}',
    '.strata-w-row{display:flex;justify-content:space-between;gap:8px;align-items:baseline}',
    '.strata-w-k{opacity:.62;flex:none}',
    '.strata-w-v{font-variant-numeric:tabular-nums;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.strata-w-v.hi{color:#22c55e;font-weight:650}',
    '.strata-w-v.warn{color:#f59e0b;font-weight:650}',
    '.strata-w-sec{margin-top:2px;padding-top:7px;border-top:1px dashed var(--sw-bd)}',
    '.strata-w-sec>span{opacity:.62;font-size:11px}',
    '.strata-w-bar{height:5px;border-radius:3px;background:rgba(128,128,128,.22);overflow:hidden;margin-top:3px}',
    '.strata-w-bar>i{display:block;height:100%;background:linear-gradient(90deg,#22c55e,#16a34a);width:0;transition:width .3s}',
    '.strata-w-tl{display:grid;gap:3px;max-height:132px;overflow:auto;margin-top:3px}',
    '.strata-w-ev{display:flex;gap:6px;align-items:baseline;font-size:11px;opacity:.86}',
    '.strata-w-ev em{font-style:normal;flex:none;width:34px;opacity:.6;font-variant-numeric:tabular-nums}',
    '.strata-w-ev i{font-style:normal;flex:none;width:52px}',
    '.strata-w-ev s{text-decoration:none;opacity:.72;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.strata-w-fold{padding:6px 10px;opacity:.62;font-size:11px;text-align:center}',
    '.strata-w-foot{padding:6px 10px 8px;opacity:.5;font-size:10px;line-height:1.45}',
  ].join('')

  function el(tag, style, text) {
    var n = document.createElement(tag)
    if (style) n.setAttribute('style', style)
    if (text != null) n.textContent = text
    return n
  }

  /** 取服务：拿不到返回 null。 */
  function readStored(key) {
    try { return window.localStorage.getItem(key) } catch (e) { return null }
  }
  function writeStored(key, value) {
    try { window.localStorage.setItem(key, value) } catch (e) { /* 隐私模式下写不了，无所谓 */ }
  }

  function fmtChars(n) {
    if (!Number.isFinite(n)) return '—'
    if (n < 1000) return n + ' 字'
    return (n / 1000).toFixed(n < 10000 ? 2 : 1) + ' k 字'
  }
  function fmtPct(ratio) {
    if (!Number.isFinite(ratio)) return '—'
    var pct = (1 - ratio) * 100
    if (pct < 0) pct = 0
    return pct.toFixed(1) + '%'
  }
  function fmtTime(iso) {
    if (!iso) return '—'
    var d = new Date(iso)
    if (isNaN(d.getTime())) return '—'
    var p = function (x) { return String(x).padStart(2, '0') }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  }
  function fmtNum(n) {
    if (!Number.isFinite(n)) return '—'
    return n.toLocaleString('zh-CN')
  }

  // —— DOM ——
  var style = el('style', null, CSS)
  document.head.appendChild(style)

  var root = el('div')
  root.className = 'strata-w'
  root.setAttribute('data-strata-widget', '1')

  var head = el('div')
  head.className = 'strata-w-hd'
  var dot = el('span'); dot.className = 'strata-w-dot'
  var title = el('b', null, '记忆地层')
  var foldBtn = el('button', null, '–'); foldBtn.className = 'strata-w-btn'; foldBtn.title = '折叠/展开'
  var closeBtn = el('button', null, '×'); closeBtn.className = 'strata-w-btn'; closeBtn.title = '隐藏（刷新后回来）'
  head.appendChild(dot); head.appendChild(title); head.appendChild(foldBtn); head.appendChild(closeBtn)

  var bodyEl = el('div')
  bodyEl.className = 'strata-w-bd'

  root.appendChild(head)
  root.appendChild(bodyEl)

  function mount() {
    try {
      if (document.body) document.body.appendChild(root)
      else setTimeout(mount, 100)
    } catch (e) { /* 挂不上就算了 */ }
  }

  // —— 恢复位置与折叠状态 ——
  try {
    var saved = JSON.parse(readStored(POS_KEY) || 'null')
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      root.style.left = Math.max(0, Math.min(saved.left, window.innerWidth - 60)) + 'px'
      root.style.top = Math.max(0, Math.min(saved.top, window.innerHeight - 40)) + 'px'
      root.style.right = 'auto'
      root.style.bottom = 'auto'
    }
  } catch (e) { /* 老数据坏了就用默认位置 */ }
  var collapsed = readStored(COLLAPSE_KEY) === '1'
  var hidden = false

  function applyCollapse() {
    bodyEl.style.display = collapsed ? 'none' : 'grid'
    foldBtn.textContent = collapsed ? '+' : '–'
  }
  applyCollapse()
  foldBtn.addEventListener('click', function () {
    collapsed = !collapsed
    writeStored(COLLAPSE_KEY, collapsed ? '1' : '0')
    applyCollapse()
  })
  closeBtn.addEventListener('click', function () {
    hidden = true
    root.style.display = 'none'
    // 给一个「重新打开」的小把手，别让它真的消失得找不回来。
    var reopen = el('button', 'position:fixed;z-index:2147482000;right:16px;bottom:16px;'
      + 'border:1px solid var(--sw-bd,rgba(128,128,128,.34));border-radius:999px;'
      + 'background:color-mix(in srgb,var(--sw-bg,#1e1e20) 92%,transparent);'
      + 'color:var(--sw-fg,#e6e6e6);font:11px/1 -apple-system,"Segoe UI",system-ui,sans-serif;'
      + 'padding:6px 10px;cursor:pointer;opacity:.72;backdrop-filter:blur(8px)', '记忆地层')
    reopen.addEventListener('click', function () {
      hidden = false
      root.style.display = ''
      reopen.remove()
    })
    document.body.appendChild(reopen)
  })

  // —— 拖动 ——
  ;(function drag() {
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0
    head.addEventListener('pointerdown', function (e) {
      if (e.target === foldBtn || e.target === closeBtn) return
      dragging = true
      var rect = root.getBoundingClientRect()
      sx = e.clientX; sy = e.clientY; ox = rect.left; oy = rect.top
      head.setPointerCapture && head.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    head.addEventListener('pointermove', function (e) {
      if (!dragging) return
      var left = ox + (e.clientX - sx)
      var top = oy + (e.clientY - sy)
      left = Math.max(0, Math.min(left, window.innerWidth - 60))
      top = Math.max(0, Math.min(top, window.innerHeight - 30))
      root.style.left = left + 'px'
      root.style.top = top + 'px'
      root.style.right = 'auto'
      root.style.bottom = 'auto'
    })
    head.addEventListener('pointerup', function (e) {
      if (!dragging) return
      dragging = false
      try {
        var rect = root.getBoundingClientRect()
        writeStored(POS_KEY, JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }))
      } catch (err) { /* 无所谓 */ }
      head.releasePointerCapture && head.releasePointerCapture(e.pointerId)
    })
  })()

  // —— 渲染 ——
  var lastState = null
  function row(k, v, cls) {
    var r = el('div'); r.className = 'strata-w-row'
    var keyEl = el('span', null, k)
    keyEl.className = 'strata-w-k'
    r.appendChild(keyEl)
    var val = el('span', null, v)
    val.className = 'strata-w-v' + (cls ? ' ' + cls : '')
    r.appendChild(val)
    return r
  }
  function sec(label) {
    var s = el('div'); s.className = 'strata-w-sec'
    s.appendChild(el('span', null, label))
    return s
  }

  /**
   * 会话身份。**不再猜 URL** —— DSH 桌面版页面走 `dsh-app://` 自定义协议，
   * URL 里根本没有会话参数（实测），原来那套 `?session=` / hash / data-attribute
   * 兜底在真机上永远命中不了，于是所有窗口都退化成「全库混算」，用户根本看不出
   * 自己在看谁的数据。
   *
   * 现在的口径：
   *   - 用户在悬浮窗上手动选过的会话 → 存 localStorage，优先用它（显式选择最高优先）；
   *   - 没选过 → 不发 sessionId，让 `/live` **自动落到最近活跃的会话**，
   *     并把它的身份回显出来（`scope:'auto-session'`）。
   * `sessionId` 为 `__ALL__` 表示用户显式选了「全部会话」。
   */
  function readSessionChoice() {
    try {
      var v = window.localStorage.getItem(SESSION_KEY)
      return v || null
    } catch (e) { return null }
  }
  function writeSessionChoice(v) {
    try {
      if (v) window.localStorage.setItem(SESSION_KEY, v)
      else window.localStorage.removeItem(SESSION_KEY)
    } catch (e) { /* 无所谓 */ }
  }

  /** 会话号太长的截断显示；工作区只取最后一段目录名（**不算绝对路径**，隐私）。 */
  function shortSession(id) {
    if (!id) return '—'
    var s = String(id)
    if (s === '__ALL__') return '全部会话'
    return s.length > 14 ? s.slice(0, 6) + '…' + s.slice(-5) : s
  }
  function wsLabel(ws) {
    if (!ws) return '未知工作区'
    var parts = String(ws).split(/[\\/]+/).filter(Boolean)
    return parts.length ? parts[parts.length - 1] : String(ws)
  }

  function render(data) {
    lastState = data
    var frag = document.createDocumentFragment()
    var live = data || {}
    var resident = live.resident
    var comp = live.compression || {}
    var paid = live.paid || {}
    var savings = live.savings || {}
    var total = live.total || {}

    // 状态圆点
    dot.className = 'strata-w-dot ' + (live.enabled === false ? 'off' : (data ? 'on' : ''))

    /* ── 会话身份：这一屏数据是「谁的」 ────────────────────────────────
     * 这是用户最先要回答的问题（「没有显示是根据哪个会话的数据啊」）。
     * 口径由 `/live` 的 `scope` 决定，悬浮窗如实反映，不糊弄：
     *   session      = 你手选的会话
     *   session-new  = 你手选的会话，但事件流里还没它的记录（刚建的空会话）
     *   auto-session = 没手选，自动落在最近活跃的会话
     *   workspace    = 按工作区聚合（跨会话）
     *   empty        = 事件流里一条都没有
     */
    var scope = live.scope || 'empty'
    var idBox = el('div'); idBox.className = 'strata-w-id'
    var idTop = el('div'); idTop.className = 'strata-w-idtop'
    var sid = live.sessionId
    var who = scope === 'all' ? '全部会话（合并）'
      : scope === 'workspace' ? '工作区 · ' + wsLabel(live.workspace)
        : scope === 'empty' ? '暂无数据'
          : shortSession(sid)
    idTop.appendChild(el('span', 'font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', who))
    var badgeText = scope === 'auto-session' ? '自动' : scope === 'session' ? '已选'
      : scope === 'session-new' ? '新会话' : scope === 'workspace' ? '按工作区'
        : scope === 'all' ? '合计' : '空'
    var badge = el('span', null, badgeText)
    badge.className = 'strata-w-badge' + (scope === 'auto-session' ? ' auto' : '')
    idTop.appendChild(badge)
    idBox.appendChild(idTop)
    var idSub = el('div'); idSub.className = 'strata-w-idsub'
    if (scope === 'all') idSub.textContent = fmtNum((live.sessions || []).length) + ' 个会话合计'
    else if (scope === 'workspace') idSub.textContent = fmtNum((live.sessions || []).length) + ' 个会话合计 · 未按会话细分'
    else if (scope === 'empty') idSub.textContent = '插件还没在这个工作区注入过任何东西'
    else if (scope === 'session-new') idSub.textContent = '这个会话还没有注入记录'
    else idSub.textContent = (scope === 'auto-session' ? '最近活跃 · ' : '') + wsLabel(live.workspace)
    idBox.appendChild(idSub)
    frag.appendChild(idBox)

    // —— 会话切换器：列出事件流里出现过的会话，让你能明确指定看哪个 ——
    var sessions = Array.isArray(live.sessions) ? live.sessions : []
    if (sessions.length > 0) {
      var picker = el('select'); picker.className = 'strata-w-pick'
      var autoOpt = el('option', null, '最近活跃（自动）')
      autoOpt.value = ''
      if (!readSessionChoice()) autoOpt.selected = true
      picker.appendChild(autoOpt)
      for (var si = 0; si < sessions.length; si++) {
        var s = sessions[si]
        var opt = el('option', null, shortSession(s.sessionId) + ' · ' + wsLabel(s.workspace) + ' (' + fmtNum(s.events) + ')')
        opt.value = s.sessionId
        if (readSessionChoice() === s.sessionId) opt.selected = true
        picker.appendChild(opt)
      }
      var allOpt = el('option', null, '全部会话（合并）')
      allOpt.value = '__ALL__'
      if (readSessionChoice() === '__ALL__') allOpt.selected = true
      picker.appendChild(allOpt)
      picker.addEventListener('change', function () {
        writeSessionChoice(picker.value || null)
        // 立刻重拉一次，别等下一个 2s 周期。
        poll()
      })
      frag.appendChild(picker)
    }

    frag.appendChild(row('常驻注入块', resident ? fmtChars(resident.chars) + (resident.tokens != null ? ' / ' + fmtNum(resident.tokens) + ' tok' : '') : '—'))
    frag.appendChild(row('本会话注入', fmtNum(live.injectCount) + ' 次'))
    frag.appendChild(row('首次注入', fmtTime(live.firstInjectAt)))

    // —— 压缩 ——
    var s1 = sec('压缩'); frag.appendChild(s1)
    frag.appendChild(row('开始压缩', comp.firstAt ? fmtTime(comp.firstAt) : '尚未发生'))
    frag.appendChild(row('压缩次数', fmtNum(comp.events)))
    var ratioRow = row('压缩效率', comp.ratio != null ? fmtPct(comp.ratio) + ' ↓' : '—', comp.ratio != null && comp.ratio <= 0.5 ? 'hi' : '')
    frag.appendChild(ratioRow)
    if (comp.ratio != null) {
      var bar = el('div'); bar.className = 'strata-w-bar'
      var fill = el('i'); fill.style.width = Math.max(2, Math.min(100, (1 - comp.ratio) * 100)) + '%'
      bar.appendChild(fill); frag.appendChild(bar)
    }
    frag.appendChild(row('素材 → 存下', comp.materialChars ? fmtChars(comp.materialChars) + ' → ' + fmtChars(comp.bodyChars) : '—'))
    // 版本替换：这是「常驻不膨胀」的机制点，不是压缩点，必须和压缩分开说。
    frag.appendChild(row('版本替换', live.versionReplacementAt ? fmtTime(live.versionReplacementAt) : '未启用'))

    // —— 省了多少 ——
    var s2 = sec('省下'); frag.appendChild(s2)
    frag.appendChild(row('估算省下字符', savings.chars ? fmtChars(savings.chars) : '0 字', savings.chars ? 'hi' : ''))
    frag.appendChild(row('估算省下 token', fmtNum(savings.tokens || 0), savings.tokens ? 'hi' : ''))
    frag.appendChild(row('付费模型调用', fmtNum(paid.calls || 0) + (paid.wastedCalls ? '（白花 ' + paid.wastedCalls + '）' : ''), paid.wastedCalls ? 'warn' : ''))
    if (total.paidCalls) {
      frag.appendChild(row('累计付费 in/out', fmtNum(total.paidIn) + ' / ' + fmtNum(total.paidOut)))
    } else {
      frag.appendChild(row('累计付费', '从未花过', 'hi'))
    }

    // —— 时间线 ——
    var tl = el('div'); tl.className = 'strata-w-tl'
    var events = Array.isArray(live.timeline) ? live.timeline.slice(-24).reverse() : []
    if (!events.length) {
      tl.appendChild(el('div', 'opacity:.55;font-size:11px', '本会话还没有事件'))
    } else {
      for (var i = 0; i < events.length; i++) {
        var ev = events[i]
        var line = el('div'); line.className = 'strata-w-ev'
        line.appendChild(el('em', null, fmtTime(ev.t).slice(0, 5)))
        var tag = ev.kind === 'inject' ? (ev.mode === 'replace' ? '替换' : '插入')
          : ev.kind === 'handoff' ? (ev.mode === 'compress' ? '压缩' : ev.mode === 'refused' ? '拒绝' : '交接')
          : ev.kind === 'paid' ? (ev.mode === 'kept' ? '付费✓' : '付费✗')
          : ev.kind === 'remember' ? '写入' : ev.kind === 'recall' ? '召回' : ev.kind
        line.appendChild(el('i', null, tag))
        var desc = ev.kind === 'inject' ? fmtChars(ev.chars) + ' · ' + (ev.hits || 0) + ' 条'
          : ev.material ? fmtChars(ev.material) + '→' + fmtChars(ev.body)
          : ev.mode === 'refused' ? '装不下'
          : (ev.in != null ? 'in ' + fmtNum(ev.in) : '')
        line.appendChild(el('s', null, desc))
        tl.appendChild(line)
      }
    }
    var s3 = sec('时间线'); frag.appendChild(s3)
    frag.appendChild(tl)

    var foot = el('div')
    foot.className = 'strata-w-foot'
    foot.textContent = '字符数与次数精确；token 为本插件估算（宿主无计价服务），故不报金额。'
    frag.appendChild(foot)

    bodyEl.textContent = ''
    bodyEl.appendChild(frag)
  }

  // —— 轮询 ——
  var timer = null
  var fails = 0

  function poll() {
    // 用户在切换器上的显式选择 > 自动（不发 sessionId，由 /live 落到最近活跃会话）。
    // `__ALL__` = 显式选「全部会话」，用 workspace 留空 + 一个特殊标记让端点走全库视图。
    var choice = readSessionChoice()
    var qs = ''
    if (choice === '__ALL__') qs = '?all=1'
    else if (choice) qs = '?sessionId=' + encodeURIComponent(choice)
    fetch(API + qs, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)) })
      .then(function (payload) {
        if (!payload || !payload.ok) throw new Error((payload && payload.error) || 'bad payload')
        fails = 0
        render(payload.data)
      })
      .catch(function () {
        fails++
        // 连续失败才报红，避免宿主重启瞬间闪红。
        if (fails >= 3) {
          dot.className = 'strata-w-dot off'
          if (!lastState) render({ enabled: false, injectCount: 0, timeline: [], scope: 'empty' })
        }
      })
  }

  mount()
  poll()
  timer = setInterval(poll, POLL_MS)
  window.addEventListener('beforeunload', function () { try { clearInterval(timer) } catch (e) {} })
})()
