// UI only. Module lifecycle and configuration remain owned by the native host.
export function createControlCenterUI({ React, ctx, t, controllerFactory, windowState, phaseKey, formatNotice }) {
  const h = React.createElement
  const ui = { open: false, selected: 'overview', listeners: new Set(), returnFocus: null }
  const notify = () => { for (const fn of ui.listeners) fn(n => n + 1) }
  const text = (zh, en) => /^en\b/i.test(typeof navigator === 'undefined' ? '' : navigator.language) ? en : zh
  const titles = () => ({ overview: text('模块总览', 'Modules'), about: text('关于 Laurel', 'About Laurel') })
  const icons = {
    leaf: ['M20 3C7 3 3 8 5 15c6 4 13 0 15-12Z', 'M3 21 16 8'],
    overview: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
    laurel: ['M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9', 'M10 21h4'],
    'claude-parchment': ['M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-4 2 2 0 0 1 1-4h2a4 4 0 0 0 4-4c0-4-5-6-9-6Z', 'M7 9h.01M10 6h.01M16 7h.01M6 13h.01'],
    strata: ['M5 3h14v18H5z', 'M8 7h8M8 11h8M8 15h5'],
    warden: ['M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7Z', 'm8 12 3 3 5-6'],
    loom: ['m4 18 5-12 6 12 5-12', 'M3 18h2M8 6h2M14 18h2M19 6h2'],
    search: ['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14', 'm15 15 6 6'],
    about: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 11v6M12 7v.01'],
    close: ['m6 6 12 12M18 6 6 18'], maximize: ['M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5'],
    restore: ['M8 8h13v13H8zM3 16V3h13'], back: ['M20 12H4m6-6-6 6 6 6'],
    refresh: ['M20 7a9 9 0 1 0 1 8', 'M20 2v6h-6'], chevron: ['m9 5 7 7-7 7'],
  }
  const Icon = ({ name, size = 21 }) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, (icons[name] || icons.overview).map((d, i) => h('path', { d, key: i })))
  const open = (id) => { if (id) ui.selected = id; if (!ui.open) ui.returnFocus = document.activeElement; ui.open = true; notify() }
  const close = () => { ui.open = false; notify(); requestAnimationFrame(() => { if (ui.returnFocus?.isConnected) ui.returnFocus.focus?.(); else document.querySelector('.lc-launch')?.focus() }) }
  const STORAGE = 'laurel-center.window.v1'
  const readWindow = () => { try { return JSON.parse(localStorage.getItem(STORAGE)) || {} } catch { return {} } }
  const writeWindow = value => { try { localStorage.setItem(STORAGE, JSON.stringify(value)) } catch { /* Layout persistence is optional, module saves are not. */ } }
  const constrain = (value, area) => {
    const num = (n, fallback) => typeof n === 'number' && Number.isFinite(n) ? n : fallback
    const w = Math.min(Math.max(560, num(value.w, Math.min(1280, area.w - 64))), area.w)
    const ht = Math.min(Math.max(360, num(value.h, area.h - 64)), area.h)
    return { w, h: ht, x: Math.max(0, Math.min(num(value.x, (area.w - w) / 2), area.w - w)), y: Math.max(0, Math.min(num(value.y, (area.h - ht) / 2), area.h - ht)) }
  }
  function Launcher({ wide = true, beforeOpen }) {
    return h('button', { type: 'button', className: 'lc-launch', onClick: () => { beforeOpen?.(); open() }, title: text('打开 Laurel 控制中心', 'Open Laurel control center'), 'aria-label': text('打开 Laurel 控制中心', 'Open Laurel control center') }, h(Icon, { name: 'leaf' }), wide ? h('span', null, text('Laurel 控制中心', 'Laurel control center')) : null)
  }
  function SettingsLauncher({ close: closeSettings } = {}) {
    return h('div', { className: 'lc-settings-entry' },
      h(Icon, { name: 'leaf', size: 36 }), h('h2', null, text('Laurel 控制中心', 'Laurel control center')),
      h('p', null, text('在可调整大小的面板里管理通知、主题、记忆、护栏和可视化规划。', 'Manage notifications, appearance, memory, safeguards and visual planning in a resizable panel.')),
      h(Launcher, { beforeOpen: closeSettings }), h('p', { className: 'lc-entry-note' }, text('也可从侧栏底部打开。拖动标题栏移动面板，拖动边缘调整大小，双击标题栏最大化。', 'Also available at the foot of the sidebar. Drag the title bar to move, resize from the edges, or double-click the title bar to maximize.')))
  }
  function Toggle({ row, state, ctrl }) {
    return h('button', { type: 'button', role: 'switch', 'aria-checked': row.enabled === true, 'aria-label': t('plugin.' + row.id), disabled: state.busy || !state.ready || row.state !== 'ready', onClick: () => ctrl.toggle(row.id, !row.enabled), className: 'lc-switch' }, h('span'))
  }
  function Status({ row }) {
    const win = row.state === 'ready' ? windowState(ctx, row) : 'unknown'
    return h('div', { className: 'lc-status' },
      h('span', { 'data-tone': row.fiberPhase === 'active' ? 'success' : 'neutral' }, text('宿主：', 'Host: '), row.state === 'ready' ? t(phaseKey(row)) : row.state),
      h('span', null, t(win === 'loaded' ? 'win.loaded' : win === 'not-loaded' ? 'win.notLoaded' : 'win.unknown')))
  }
  function Panel({ renderSlot }) {
    const [, rerender] = React.useState(0)
    const [ctrl] = React.useState(controllerFactory)
    const [state, setState] = React.useState(ctrl.getSnapshot())
    const [query, setQuery] = React.useState('')
    const [selection, setSelection] = React.useState(ui.selected)
    const [visited, setVisited] = React.useState(() => new Set([ui.selected]))
    const [geometry, setGeometry] = React.useState(() => readWindow())
    const [maximized, setMaximized] = React.useState(false)
    const [area, setArea] = React.useState({ w: 1280, h: 800 })
    const shade = React.useRef(null), box = React.useRef(null), content = React.useRef(null), gesture = React.useRef(null)
    const openNow = ui.open
    React.useEffect(() => { ui.listeners.add(rerender); return () => { ui.listeners.delete(rerender) } }, [])
    React.useEffect(() => { if (openNow) { setSelection(ui.selected); const off = ctrl.subscribe(setState); const stop = ctrl.start(); return () => { off(); stop?.(); ctrl.stop() } } }, [openNow, ctrl])
    React.useEffect(() => {
      if (!openNow) return
      const resize = () => { const r = shade.current?.getBoundingClientRect(); if (r && r.width > 0 && r.height > 0) setArea({ w: r.width, h: r.height }) }
      resize(); window.addEventListener('resize', resize)
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null
      if (shade.current) observer?.observe(shade.current)
      return () => { window.removeEventListener('resize', resize); observer?.disconnect() }
    }, [openNow])
    React.useEffect(() => { if (openNow) box.current?.querySelector('[data-lc-close]')?.focus() }, [openNow])
    React.useEffect(() => {
      if (!openNow) return
      const keys = event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return }
        if (event.key !== 'Tab') return
        const els = [...(box.current?.querySelectorAll('button, input, select, textarea, summary, a[href], [tabindex="0"]') || [])].filter(el => !el.disabled && el.checkVisibility() && el.tabIndex >= 0)
        if (!els.length) return
        if (!box.current?.contains(document.activeElement) || event.shiftKey && document.activeElement === els[0] || !event.shiftKey && document.activeElement === els.at(-1)) { event.preventDefault(); (event.shiftKey ? els.at(-1) : els[0]).focus() }
      }
      const move = event => {
        const g = gesture.current
        if (!g) return
        const dx = event.clientX - g.x, dy = event.clientY - g.y
        const v = { ...g.rect }
        if (g.mode === 'move') { v.x += dx; v.y += dy }
        else { if (g.mode.includes('e')) v.w += dx; if (g.mode.includes('s')) v.h += dy; if (g.mode.includes('w')) { const w = Math.max(Math.min(560, area.w), g.rect.w - dx); v.x += g.rect.w - w; v.w = w } if (g.mode.includes('n')) { const ht = Math.max(Math.min(360, area.h), g.rect.h - dy); v.y += g.rect.h - ht; v.h = ht } }
        setGeometry(constrain(v, area))
      }
      const end = () => { if (gesture.current) { gesture.current = null; document.documentElement.style.removeProperty('--lc-gesture-cursor'); setGeometry(g => { writeWindow(g); return g }) } }
      document.addEventListener('keydown', keys, true)
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end); window.addEventListener('blur', end)
      return () => { document.removeEventListener('keydown', keys, true); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); window.removeEventListener('blur', end); end() }
    }, [openNow, area])
    if (!openNow) return null
    const rect = constrain(geometry, area)
    const choose = id => { ui.selected = id; setSelection(id); setVisited(ids => new Set([...ids, id])); setQuery(''); ctrl.clearNotice(); if (content.current) content.current.scrollTop = 0 }
    const begin = (event, mode) => { if (maximized || event.button !== 0 || event.target.closest('button,input,select,textarea,a')) return; event.preventDefault(); gesture.current = { mode, x: event.clientX, y: event.clientY, rect }; event.currentTarget.setPointerCapture?.(event.pointerId); document.documentElement.style.setProperty('--lc-gesture-cursor', mode === 'move' ? 'grabbing' : mode + '-resize') }
    const queryText = query.trim().toLocaleLowerCase()
    const rows = PLUGINS.map(p => state.rows.find(r => r.id === p.id) || { ...p, state: 'loading' })
    const visible = rows.filter(row => [t('plugin.' + row.id), t('plugin.' + row.id + '.desc')].join(' ').toLocaleLowerCase().includes(queryText))
    const current = rows.find(r => r.id === selection)
    const title = titles()[selection] || (current ? t('plugin.' + current.id) : titles().overview)
    const action = (name, label, click, extra = {}) => h('button', { type: 'button', className: 'lc-icon-button', title: label, 'aria-label': label, onClick: click, ...extra }, h(Icon, { name }))
    const navigation = (id, label) => h('button', { key: id, type: 'button', className: 'lc-nav', 'aria-current': selection === id ? 'page' : undefined, onClick: () => choose(id) }, h(Icon, { name: id }), h('span', null, label))
    const notice = formatNotice(state.notice, t)
    const problems = h('div', { className: 'lc-feedback', 'aria-live': 'polite' },
      state.problem ? h('p', { role: 'alert', className: 'lc-error' }, t('problemPrefix'), '：', state.problem.text) : null,
      notice ? h('p', { role: state.notice.outcome === 'failure' ? 'alert' : 'status', className: state.notice.outcome === 'failure' ? 'lc-error' : 'lc-notice' }, notice) : null,
      (state.notice?.items || []).some(item => item.code === 'operation-error') ? h('p', { className: 'lc-notice' }, t('notice.operationErrorHint')) : null)
    return h('div', { ref: shade, className: 'lc-backdrop', 'data-laurel-center': '' },
      h('section', { ref: box, role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'lc-window-title', className: 'lc-window', 'data-maximized': maximized || area.w < 680 ? '' : undefined, style: maximized || area.w < 680 ? { inset: 0, width: '100%', height: '100%' } : { left: rect.x, top: rect.y, width: rect.w, height: rect.h } },
        h('header', { className: 'lc-titlebar', onPointerDown: e => begin(e, 'move'), onDoubleClick: e => { if (!e.target.closest('button')) setMaximized(v => !v) } },
          h('div', { className: 'lc-brand' }, h(Icon, { name: 'leaf', size: 35 }), h('div', null, h('strong', { id: 'lc-window-title' }, text('Laurel 控制中心', 'Laurel control center')), h('span', null, text('DeepSeek Harness 插件套件', 'Plugin suite for DeepSeek Harness')))),
          h('div', { className: 'lc-window-actions' }, action(maximized ? 'restore' : 'maximize', text(maximized ? '还原窗口' : '最大化', maximized ? 'Restore' : 'Maximize'), () => setMaximized(v => !v)), action('close', text('关闭控制中心', 'Close control center'), close, { 'data-lc-close': '' }))),
        h('div', { className: 'lc-layout' },
          h('aside', { className: 'lc-sidebar' },
            h('label', { className: 'lc-search' }, h(Icon, { name: 'search', size: 18 }), h('input', { type: 'search', value: query, placeholder: text('搜索模块', 'Search modules'), 'aria-label': text('搜索模块', 'Search modules'), onChange: e => setQuery(e.target.value) })),
            h('nav', { 'aria-label': text('Laurel 模块', 'Laurel modules'), className: 'lc-navigation' },
              !queryText ? navigation('overview', titles().overview) : null,
              visible.map(row => navigation(row.id, t('plugin.' + row.id))),
              !visible.length ? h('p', { className: 'lc-no-results' }, text('没有匹配的模块', 'No matching modules')) : null),
            h('div', { className: 'lc-sidebar-bottom' }, navigation('about', titles().about), h('button', { type: 'button', className: 'lc-nav', onClick: close }, h(Icon, { name: 'back' }), text('返回 DSH', 'Return to DSH')), h('small', null, 'Laurel · v', BUNDLE_VERSION))),
          h('main', { ref: content, className: 'lc-content', 'aria-label': title },
            h('div', { className: 'lc-page-heading' },
              h('div', null, h('h1', null, title), h('p', null, current ? t('plugin.' + current.id + '.desc') : selection === 'about' ? text('统一管理，沿用 DSH 的插件与配置能力。', 'One place to manage the suite, backed by DSH plugins and configuration.') : text('选择一个模块，调整它的行为与外观。', 'Choose a module to adjust its behavior and appearance.'))),
              current ? h('div', { className: 'lc-module-enable' }, h('span', null, text('启用模块', 'Enable module')), h(Toggle, { row: current, state, ctrl })) : action('refresh', t('refresh'), () => ctrl.refresh(), { disabled: state.busy })),
            current ? h(Status, { row: current }) : null,
            problems,
            selection === 'about' ? h('section', { className: 'lc-about' }, h('h2', null, text('关于这个控制中心', 'About this control center')), h('p', null, text('Laurel 运行在 DeepSeek Harness 内。模块开关通过宿主原生插件管理保存，各模块继续使用自己的配置与运行状态。', 'Laurel runs inside DeepSeek Harness. Native plugin management saves module switches; each module retains its own configuration and runtime status.')), h('dl', null, h('dt', null, text('客户端版本', 'Client version')), h('dd', null, BUNDLE_VERSION)), h('p', null, text('启用模块与模块内部的行为开关分别生效。宿主启动状态、本窗口加载状态以及实际能力命中情况分别展示；尚未确认时不会显示为成功。', 'Module activation and internal behavior switches are separate. Host lifecycle, this-window loading and observed capabilities are reported separately; unconfirmed states are never reported as success.'))) :
            null,
            rows.filter(row => row.id === current?.id || visited.has(row.id)).map(current => h('div', { className: 'lc-module', key: current.id, hidden: current.id !== selection },
              renderSlot ? renderSlot(MODULE_SLOT, { controlCenter: true }, { only: current.settingsId, fallback: h('div', { className: 'lc-empty' }, h(Icon, { name: current.id, size: 32 }), h('h2', null, current.enabled ? text('等待模块设置加载', 'Waiting for module settings') : text('模块已关闭', 'Module is off')), h('p', null, current.enabled ? text('模块尚未向本窗口提供设置。刷新状态，或检查宿主是否需要重新加载。', 'The module has not provided settings in this window yet. Refresh status or check whether the host needs reloading.') : text('开启右上方的模块开关后，可在这里调整选项。', 'Enable the module above to adjust its options here.')), h('button', { type: 'button', onClick: () => ctrl.refresh(), disabled: state.busy }, t('refresh'))) }) : h('p', { role: 'alert' }, text('模块插槽不可用，请重新加载客户端。', 'The module slot is unavailable. Reload the client.')))),
            selection === 'overview' ? h('section', { className: 'lc-overview' },
              h('div', { className: 'lc-overview-tools' }, h('span', null, t('summary', { on: rows.filter(r => r.enabled).length, total: rows.length, running: rows.filter(r => r.fiberPhase === 'active').length, issues: rows.filter(r => r.state !== 'ready' && r.state !== 'loading').length })), h('button', { type: 'button', onClick: () => ctrl.bulk(true), disabled: state.busy || !state.ready }, t('enableAll')), h('button', { type: 'button', onClick: () => ctrl.bulk(false), disabled: state.busy || !state.ready }, t('disableAll'))),
              rows.map(row => h('div', { key: row.id, className: 'lc-overview-row' }, h(Icon, { name: row.id, size: 26 }), h('button', { type: 'button', className: 'lc-module-link', onClick: () => choose(row.id) }, h('strong', null, t('plugin.' + row.id)), h('span', null, t('plugin.' + row.id + '.desc')), h(Status, { row })), h(Toggle, { row, state, ctrl }), action('chevron', text('打开', 'Open') + ' ' + t('plugin.' + row.id), () => choose(row.id))))) : null,
            !state.ready && !state.problem ? h('p', { role: 'status', className: 'lc-loading' }, t('loading')) : null,
            h('footer', { className: 'lc-content-footer' }, h('span', null, text('选项修改后由各模块保存；保存失败会显示原因。', 'Each module saves its own changes and reports save failures.')), state.confirmedAt ? h('span', null, t('confirmed', { time: state.confirmedAt })) : null))),
        !maximized && area.w >= 680 ? ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'].map(mode => h('div', { key: mode, className: 'lc-resize lc-resize-' + mode, onPointerDown: e => begin(e, mode), 'aria-hidden': true })) : null,
        !maximized && area.w >= 680 ? h('button', { type: 'button', className: 'lc-resize-keyboard', 'aria-label': text('调整面板大小（方向键，Shift 加速）', 'Resize panel (arrow keys, Shift for larger steps)'), title: text('拖动调整大小；聚焦后用方向键调整', 'Drag to resize, or focus and use arrow keys'), onPointerDown: e => { e.stopPropagation(); if (e.button === 0) { e.currentTarget.focus(); e.preventDefault(); gesture.current = { mode: 'se', x: e.clientX, y: e.clientY, rect }; e.currentTarget.setPointerCapture?.(e.pointerId) } }, onKeyDown: e => { const d = e.shiftKey ? 40 : 10; const delta = { ArrowRight: [d, 0], ArrowLeft: [-d, 0], ArrowDown: [0, d], ArrowUp: [0, -d] }[e.key]; if (delta) { e.preventDefault(); const next = constrain({ ...rect, w: rect.w + delta[0], h: rect.h + delta[1] }, area); setGeometry(next); writeWindow(next) } } }, h('svg', { width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', 'aria-hidden': true }, h('path', { d: 'm4 15 11-11m-5 11 5-5' }))) : null))
  }
  return { Panel, SettingsLauncher, Launcher, dispose: () => { ui.open = false; ui.listeners.clear(); document.documentElement.style.removeProperty('--lc-gesture-cursor') } }
}
