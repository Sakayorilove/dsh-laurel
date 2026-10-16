/**
 * dsh-strata · 宿主半边入口
 *
 * ── 这个插件做什么 ─────────────────────────────────────────────────────
 * 让 DSH 跨会话记住事。作用域是**三级阶梯**：
 *
 *   L0 会话    只在产生它的那个会话可见
 *   L1 工作区  同一 cwd 的全部会话可见（默认）
 *   L2 全局    所有工作区可见
 *
 * 跨工作区读取要**逐工作区授权**，授权记在一张可审计的台账里。
 * 见 `lib/core/config.js` 顶部与 `README.md`。
 *
 * ── 四条纪律（每条都有出处）─────────────────────────────────────────────
 *   1. **顶层 `inject` 留空**。cordis 的 Context 是受控代理，没写进 `inject`
 *      的服务用 `ctx.X` 访问会直接抛；用 `ctx.get(name)` + try/catch 更安全。
 *      非 Web 组合（CLI / 无头）也该能激活。
 *   2. **Web 路由走子插件 + `effect`**，让 cordis 管等待、服务重建与清理。
 *   3. **家目录只认 `DSH_HOME`**，不从 profile 目录往上推（会推到错误位置）。
 *   4. **所有 IO 都吞异常**。记忆插件坏掉，不许连带影响宿主里的任何别的东西。
 */

import { DEFAULT_CONFIG, PACKAGE_NAME, VERSION, normalizeConfig, pickKnown, pluginPaths, resolveDshHome } from './core/config.js'
import { GrantLedger, MemoryStore, appendEvent } from './core/store.js'
import { HistorySearch } from './core/history.js'
import { createTools } from './host/tools.js'
import { installInjection } from './host/inject.js'
import { installGuard } from './host/guard.js'
import { createHandler } from './host/http.js'
import { saveSettings, loadSettings } from './core/settings.js'

/** 包名。也是客户端半边 `window.__ModuleLoader__.load({ id })` 用的 id，两处必须一致。 */
export { PACKAGE_NAME, VERSION }

/** 顶层 inject 故意留空。见上文纪律 1。 */
export const inject = []

/** 取服务：拿不到返回 null，不抛。 */
function requireService(ctx, name) {
  try {
    return ctx.get?.(name) ?? null
  } catch {
    return null
  }
}

/** 三级日志。 */
function makeLogger(level = 'info') {
  const rank = { debug: 10, info: 20, warn: 30, error: 40 }
  const min = rank[level] ?? 20
  const make = (name, fn) => (...args) => {
    if (rank[name] < min) return
    try { fn('[strata]', ...args) } catch { /* 日志不许影响主流程 */ }
  }
  return {
    debug: make('debug', console.debug.bind(console)),
    info: make('info', console.info.bind(console)),
    warn: make('warn', console.warn.bind(console)),
    error: make('error', console.error.bind(console)),
  }
}

/**
 * @param {any} ctx cordis 上下文
 * @param {Record<string, unknown>} config patch 里那份 config（当默认值用）
 */
export function apply(ctx, config = {}) {
  const home = resolveDshHome()
  /** patch 给的是默认值。 */
  const fromPatch = normalizeConfig(config, DEFAULT_CONFIG)
  const log = makeLogger(fromPatch.logLevel)

  /** 生效配置：settings.json（设置页写的）盖在 patch 默认值上。 */
  let current = (() => {
    try {
      const stored = loadSettings(home)
      return stored.config ? normalizeConfig(stored.config, fromPatch) : fromPatch
    } catch {
      return fromPatch
    }
  })()

  const getConfig = () => ({ ...current })
  const setConfig = (patch) => {
    const candidate = normalizeConfig(patch, current)
    saveSettings(candidate, home, Object.keys(DEFAULT_CONFIG))
    current = candidate
    return getConfig()
  }

  /* ---------------- 数据层 ---------------- */
  let store
  let ledger
  try {
    store = new MemoryStore(home)
    ledger = new GrantLedger(home)
  } catch (error) {
    // 数据层起不来就整个插件停用，但**不抛出去** —— 宿主必须能正常启动。
    log.error(`存储初始化失败，插件停用：${error?.message ?? error}`)
    return { status: () => ({ ok: false, data: { error: String(error?.message ?? error) } }) }
  }

  /** 宿主服务一律惰性取 —— apply 时它们可能还没就绪。 */
  const sessionQuery = () => requireService(ctx, 'sessionQuery')
  /**
   * 模型服务。**只在 `memory_handoff` 的付费档（`summarize: true`）用到**，
   * 而且拿不到就退回免费档 —— 所以这里照样走 `ctx.get`，不写进顶层 `inject`
   * （纪律 1：没声明的服务用 `ctx.X` 会直接抛，非 Web 组合还得能激活）。
   */
  const llm = () => requireService(ctx, 'llm')
  const deps = { store, ledger, config: getConfig, home, sessionQuery, llm, log }
  deps.history = new HistorySearch(deps)

  /* ---------------- 工具 ---------------- */
  const registerTools = (toolCtx) => {
    const tools = requireService(toolCtx, 'tools')
    if (!tools?.register) return
    let registered = 0
    for (const definition of createTools(deps)) {
      try {
        tools.register(definition)
        registered++
      } catch (error) {
        // 单个工具注册失败不该拖垮其余工具。
        log.warn(`工具 ${definition.name} 注册失败：${error?.message ?? error}`)
      }
    }
    log.info(`已注册 ${registered} 个工具`)
  }

  /* ---------------- 注入 ---------------- */
  let uninstallInjection = null
  try {
    if (typeof ctx.on === 'function') uninstallInjection = installInjection(ctx, deps)
  } catch (error) {
    log.warn(`注入监听挂载失败（记忆不会自动进上下文，工具仍可用）：${error?.message ?? error}`)
  }

  /* ---------------- 子代理守卫 ---------------- */
  /**
   * 给 `wait_agent` 的等待时间套上限。见 `lib/host/guard.js` 顶部。
   * 独立于注入：用户把记忆注入整个关掉，这条仍然该生效（它是效率问题，不是记忆问题）。
   */
  let uninstallGuard = null
  try {
    uninstallGuard = installGuard(ctx, deps)
  } catch (error) {
    log.warn(`子代理守卫挂载失败（等待上限不生效，其余功能正常）：${error?.message ?? error}`)
  }

  /* ---------------- HTTP ---------------- */
  /**
   * 悬浮窗的注入行（桌面端唯一通道）。
   *
   * ── 为什么是内联 script 而不是 `script-src` 行（抄 whale-widget 的坑，issue #154）
   * 桌面壳（Electron）的 index.html 是从安装包静态 dist 直出的，`tapIndex` 那种
   * 「函数变换 HTML」的通道**永远过不去**；唯一生效的是 `webserver/index-inject`
   * 推的结构化行。而页面侧解释器对两种 script 行处理**不对称**：
   *   - `kind:'script'`（内联文本）→ createElement + textContent，没有 await，**不可能失败**；
   *   - `kind:'script-src'` → `await loadScript(src)`，失败即 reject，而那个 reject 会
   *     reject 掉 `__DSH_BOOT_READY__` ⇒ **整个应用起不来**。
   * 再加上外壳把注入表在宿主启动时**只收集一次**且无刷新路径，插件运行期被关掉时
   * 路由已注销 ⇒ script-src 行会 404 ⇒ 应用白屏。
   * 所以用内联行：由我们自建 `<script>` 并**吞掉 onerror**，路由在就正常，路由不在就静默失败。
   */
  const WIDGET_ROW_TEXT =
    '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
    + 'var s=document.createElement("script");s.src="/strata/widget.js";'
    + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()'
  const WIDGET_TAG = '<script defer src="/strata/widget.js"></script>'

  /** 桌面端注入行：**尽早注册**，不等任何服务（表的收集是启动时一次性的）。 */
  try {
    if (typeof ctx.on === 'function') {
      ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script-src' && row.src === '/strata/widget.js') return
            if (row.kind === 'script' && typeof row.text === 'string' && row.text.includes('/strata/widget.js')) return
          }
          table.push({ kind: 'script', placement: 'body', text: WIDGET_ROW_TEXT })
        } catch { /* 推不进去不影响宿主 */ }
      }), 'strata.widget.row')
    }
  } catch (error) {
    log.warn(`悬浮窗注入行注册失败：${error?.message ?? error}`)
  }

  const mountRoutes = (routeCtx) => {
    const webServer = requireService(routeCtx, 'webServer')
    if (!webServer?.register) return
    const disposers = []
    disposers.push(webServer.register({
      kind: 'prefix',
      path: '/strata',
      handler: createHandler({ ...deps, getConfig, setConfig }),
    }))
    // Web 形态：往 index.html 里插一行 script。桌面端走上面的 index-inject，两条并存、各自去重。
    try {
      if (typeof webServer.tapIndex === 'function') {
        disposers.push(webServer.tapIndex((html) => {
          if (typeof html !== 'string' || html.includes('/strata/widget.js')) return html
          return html.includes('</body>') ? html.replace('</body>', WIDGET_TAG + '</body>') : html + WIDGET_TAG
        }))
      }
    } catch (error) {
      log.warn(`悬浮窗 index 注入失败（悬浮窗不显示，其余功能正常）：${error?.message ?? error}`)
    }
    return routeCtx.effect(() => () => {
      for (const dispose of disposers) { try { dispose?.() } catch { /* 清理失败无所谓 */ } }
    }, 'strata.routes')
  }

  try {
    ctx.inject(['tools'], registerTools)
    ctx.inject(['webServer'], mountRoutes)
  } catch (error) {
    log.warn(`服务订阅失败：${error?.message ?? error}`)
  }

  const paths = pluginPaths(home)
  const stats = store.stats()
  appendEvent({ kind: 'ready', detail: `host ${VERSION} · ${stats.live} 条记忆 · ${ledger.active().length} 条有效授权` }, home)

  log.info(`已挂载：记忆 ${stats.live} 条（${JSON.stringify(stats.byScope)}）`
    + ` 注入=${current.injectSection ? `开(${current.recallLimit}条/最低分${current.minScore})` : '关'}`
    + ` 默认作用域=${current.defaultScope} 跨工作区=${current.crossWorkspace}`
    + ` 有效授权=${ledger.active().length} 配置=${paths.settings}`)

  return {
    /** 给宿主/测试看的只读快照。 */
    status: () => ({
      ok: true,
      data: {
        package: PACKAGE_NAME,
        version: VERSION,
        home,
        config: getConfig(),
        stats: store.stats(),
        grants: ledger.active(),
        paths,
        defaults: pickKnown(DEFAULT_CONFIG),
      },
    }),
    dispose: () => {
      try { uninstallInjection?.() } catch { /* 无所谓 */ }
      try { uninstallGuard?.() } catch { /* 无所谓 */ }
    },
  }
}
