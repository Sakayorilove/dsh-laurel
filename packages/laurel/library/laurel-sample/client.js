/**
 * laurel-sample · 客户端半边（由 scripts/build-client.mjs 生成，不要直接改这个文件）
 *
 * 改源码请改：
 *   - lib/client-kit.js
 *   - lib/client/index.mjs
 * 然后跑 `npm run build`。
 */

window.__ModuleLoader__.load({
  id: "laurel-sample",
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    /* ===== 以下为内联源码。kit 与插件代码共享同一个作用域， ===== */
    /* ===== 所以 kit 导出的符号在插件代码里可以直接用。      ===== */

    /* ---------- lib/client-kit.js ---------- */
    /**

     * Laurel 系列 · 浏览器半边 kit（源码，不是产物）

     *

     * ── 为什么这个文件是 ESM，而不是直接就是 bundle ──────────────────────────

     * 客户端半边**不能** `require` 任意包。官方模块系统的解析顺序写死了：

     *

     *   platform seed 表（React / Cordis / 静态 UI 库）

     *   → 已物化的模块 → boot graph 的行 → 已注册的 factory

     *   其余一律抛 `require("x") missed the module table`。

     *

     * （出处：`@deepseek-ai/dsh-client-modules` 的 README「Sharing modules」与

     *  `lib/client.js` 的 resolution 实现。）

     *

     * 所以客户端代码**没法靠 npm 依赖共享**，只能在打包时把 kit **内联**进各自的

     * bundle。这就是本文件存在的理由：它是源码，由 `scripts/build-client.mjs`

     * 拼进 `lib/client.js`，运行时零依赖、跨包零依赖。

     *

     * ── kit 里为什么一个顶层 import 都没有 ──────────────────────────────────

     * 拼接出来的产物必须是一个自包含的 CJS factory 闭包，不能出现 ESM 语法

     * （`import`/`export` 会被当成 ESM 解析而崩）。所以：

     *   - 本文件用 ESM 写只是为了给编辑器/Node 看；

     *   - 它 export 的每个函数都**只讲闭包内可见的东西**（不 import 任何模块）；

     *   - 构建脚本会把 `export ` 关键字剥掉再拼进 factory。

     * 这个约定靠 `tests/verify-plugin.mjs` 的「kit 无顶层 import」断言守住。

     */

    /**

     * kit 的版本。产物里会带一行注释，出问题时一眼能看出用的是哪版 kit。

     * 改 kit 就动这里，方便事后对版本。

     */
    const CLIENT_KIT_VERSION = 1

    /* ------------------------------------------------------------------ *

     * 1. 与宿主数据面通讯

     * ------------------------------------------------------------------ */

    /**

     * 调宿主端点。**统一处理 `{ ok, data }` / `{ ok, error }` 形状**，

     * 失败时抛出真正的 Error（带上后端给的 error 文本），而不是让调用方

     * 自己去判断 `res.ok` —— 那是每个插件都会写错一次的地方。

     *

     * @param {string} api 端点前缀，例如 '/laurel'

     * @param {string} path 子路径，例如 '/config'

     * @param {{ method?: string, body?: unknown, timeoutMs?: number }} [options]

     */
    async function requestJSON(api, path, options = {}) {
      const method = options.method ?? 'GET'
      const init = { method, headers: {} }
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      // 超时是必须的：宿主端点不通时不要把这个 Promise 永远挂着。

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

    /**

     * 读一次生效配置。读不到**不抛**，返回 null，让调用方退回内置默认值继续工作。

     * 通知这类插件"配置读不到就整个哑掉"是最糟的失败模式。

     */
    async function loadConfig(api, log) {
      try {
        const data = await requestJSON(api, '/config')
        return data?.config ?? null
      } catch (error) {
        log?.('config-load-failed', error?.message ?? String(error))
        return null
      }
    }

    /**

     * 落一条事件到宿主。**永不抛** —— 记日志失败不许影响插件主流程。

     * @returns {Promise<boolean>} 是否成功送达

     */
    async function reportEvent(api, event, log) {
      try {
        await requestJSON(api, '/event', { method: 'POST', body: event })
        return true
      } catch (error) {
        log?.('event-report-failed', error?.message ?? String(error))
        return false
      }
    }

    /* ------------------------------------------------------------------ *

     * 2. 运行环境探测（设置页的「运行状态」那一块全靠它）

     * ------------------------------------------------------------------ */

    /**

     * 探测当前环境能力。设置页要显示"页面来源 / 通知权限 / 订阅挂上没"，

     * 排错时这几项是最先要看的 —— 所以做成一个现成的快照函数。

     */
    function probeEnvironment(NotificationCtor) {
      const origin = (() => {
        try { return typeof location !== 'undefined' ? String(location.origin) : null } catch { return null }
      })()
      const supported = typeof NotificationCtor === 'function'
      let permission = null
      try { permission = supported ? String(NotificationCtor.permission) : null } catch { /* 拿不到就算了 */ }
      let visibility = null
      let focused = null
      try {
        if (typeof document !== 'undefined') {
          visibility = String(document.visibilityState ?? '')
          focused = typeof document.hasFocus === 'function' ? document.hasFocus() : null
        }
      } catch { /* 拿不到就算了 */ }
      return { origin, supported, permission, visibility, focused }
    }

    /**

     * 申请通知权限。**必须由一次真实用户手势触发**，浏览器才认

     * （权限默认是 'default'，程序主动申请会被拒）。

     * 桌面壳一律放行，不用管。

     */
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

    /* ------------------------------------------------------------------ *

     * 3. 小工具：节流（通知类插件一定会用到）

     * ------------------------------------------------------------------ */

    /**

     * 造一个"每个 key 各自计时"的节流闸门。

     *

     * 除了每条 key 的最小间隔，还叠了一条**全局底线**：防止一串不同会话

     * 的事件在同一瞬间连着响成一片。两者都要满足才放行。

     *

     * @param {() => number} now 取当前时间（毫秒）。注入进来是为了测试能控制时间。

     * @param {number} throttleSeconds 每个 key 的最小间隔（秒）

     * @param {number} globalFloorMs 全局底线（毫秒）

     */
    function createThrottle(now, throttleSeconds, globalFloorMs = 2000) {
      const lastPerKey = new Map()
      let lastAny = -Infinity
      return {
        /**

         * @param {string} key 节流键（会话 id）

         * @returns {{ allowed: true } | { allowed: false, reason: string, retryInMs: number }}

         */
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
        /** 放行之后调用，记账。 */
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

    /* ------------------------------------------------------------------ *

     * 4. 文案（双语的最小骨架）

     * ------------------------------------------------------------------ */

    /**

     * 挑一份文案。`language: 'auto'` 时看浏览器语言，**中文才算 zh**，

     * 其它一律落到 en —— 比"猜一门最像的"更好predictable。

     *

     * @param {{ zh: object, en: object }} table

     * @param {string} language 'auto' | 'zh' | 'en'

     */
    function pickText(table, language) {
      if (language === 'zh') return table.zh
      if (language === 'en') return table.en
      let langs = []
      try {
        langs = [navigator.language, ...(navigator.languages ?? [])]
      } catch { /* 非浏览器环境 */ }
      const isZh = langs.some((tag) => typeof tag === 'string' && tag.toLowerCase().startsWith('zh'))
      return isZh ? table.zh : table.en
    }

    /**

     * 正文截断。先按字符数砍，再补省略号 —— 且**省略号算在长度里**，

     * 免得"限 140 字"最后出来 141 个字。

     */
    function truncateBody(text, maxChars) {
      const s = typeof text === 'string' ? text : ''
      const max = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 140
      if (s.length <= max) return s
      if (max <= 1) return s.slice(0, max)
      return `${s.slice(0, max - 1)}…`
    }

    /* ------------------------------------------------------------------ *

     * 4.5 跨 realm 安全的容器读取（这是个真踩过的坑，别删）

     * ------------------------------------------------------------------ */

    /**

     * 把「一个 Map 或者一个普通对象」统一读成 Map。

     *

     * ── 为什么不能用 `x instanceof Map` ─────────────────────────────────────

     * 客户端 bundle 与宿主跑在**不同的 realm**（iframe / vm / 不同 window），

     * 跨 realm 拿到的 Map `instanceof Map` 是 **false**：

     *

     *     Object.prototype.toString.call(m) === '[object Map]'   // 真的

     *     m.size === 3                                          // 真的

     *     m instanceof Map                                      // false ← 陷阱

     *

     * 于是 `snapshot instanceof Map ? snapshot : new Map(Object.entries(snapshot))`

     * 会走进 else 分支，把**一个有内容的 Map 换成空 Map** —— 不报错，

     * 只是永远什么都不发生。这类"安静地不工作"最难查。

     *

     * 好在这个坑有安全的探测方式：Map 的 `forEach` 回调签名是 `(value, key, map)`，

     * 而普通对象的 `forEach` 来自 Array.prototype，签名是 `(value, index, array)`。

     * 两者靠 `arguments.length` 区分不可靠，但**鸭子类型 + toString 标签**很可靠。

     */
    function toMap(value) {
      if (value === null || value === undefined) return new Map()
      // 同 realm、以及大部分跨 realm 的 Map 都走这条快路：

      // Map 的实例方法（get/size/forEach）在跨 realm 时仍然可用，只是 instanceof 失效。

      if (typeof value.get === 'function' && typeof value.forEach === 'function' && typeof value.size === 'number') {
        return value
      }
      // 只剩一种可能：普通对象（形如 { sessionId: status }）。

      if (typeof value === 'object') return new Map(Object.entries(value))
      return new Map()
    }

    /* ------------------------------------------------------------------ *

     * 5. 设置页

     * ------------------------------------------------------------------ */

    /**

     * 注册一块设置区。

     *

     * 设置页是**插槽**，不是独立路由 —— 这是 DSH 客户端的约定。

     * 用 `ctx.effect` 包起来，这样插件被停用时这块 UI 会跟着干净地撤掉。

     *

     * ── 两路注册（2026-10-13 起）────────────────────────────────────────────

     * 默认是「先聚合、再兜底」：

     *   • 装载机在  → 注册进 `laurel-center.module`。设置内容出现在「Laurel总控」

     *                 里对应的那张模块卡片下，不再单独占一条设置页导航；

     *   • 装载机不在 → 照旧注册进 `settings.section`，自己单独一条，行为跟以前一样。

     *

     * 为什么必须两路都在：插槽系统里「声明即独占渲染权」—— 只有声明某个 key 的

     * 条目才能渲染它。聚合插槽是**装载机**声明的，所以只要用户没装装载机（比如

     * 只单独装了 loom），聚合那条路永远等不到声明；只留它，设置页就整块消失。

     *

     * 为什么不用「等几百毫秒看看父级在不在」那种定时器：装载机和模块谁先加载是

     * 宿主决定的，猜时间必然有一头是错的。这里两个 `inject` 同时挂着 —— 谁先成立

     * 谁生效，聚合一旦成立就把独立那份**撤掉**（否则会同时出现在两处）。

     * 于是加载顺序怎么排都收敛到同一个结果。

     *

     * 依赖的客户端服务必须同时在 `package.json` 的 `dsh.client.inject` 里声明

     * （至少要有 `@deepseek-ai/dsh-client-ui-settings`），否则 boot graph 里

     * 没有顺序边，插槽可能还没注册就被调用。

     *

     * @param {object} ctx cordis 客户端上下文

     * @param {object} options

     * @param {string} options.id 设置页条目 id（模块自己定的那个，如 'loom'）

     * @param {number} [options.order] 同一插槽内的排序

     * @param {() => string} options.label 标题；函数形式，这样能跟着当前语言走

     * @param {any} options.component 设置页组件

     * @param {any} options.slots `ctx.slots`

     * @param {string} [options.slot] 显式指定注册到哪个插槽。给了就**只走这一路**，

     *        不做聚合/兜底的自动选择 —— 装载机自己用它注册到 `settings.section`。

     * @param {object} [options.children] 注册时一并声明的子插槽表。

     *        只有插槽的**声明者**用得上（装载机用它把 `laurel-center.module` 声明出来）。

     */
    function registerSettingsSection(ctx, options) {
      const { id, order = 50, label, component, slots, slot, children } = options
      if (!slots?.inject || !slots?.register) {
        throw new Error(`laurel-kit: 拿不到 slots 服务，无法注册设置页（${id}）`)
      }

      /** 聚合插槽名。由装载机声明；模块注册进来后，总控台负责渲染。 */
      const GROUP = 'laurel-center.module'
      const extra = children === undefined ? {} : { children }
      const put = (name) => slots.register({ name, id, order, label, ...extra }, component)

      // 显式指定了插槽：单路注册，不猜。

      if (slot !== undefined) {
        return ctx.effect(() => slots.inject(slot, () => put(slot)), `${id}.settings-section`)
      }

      // 默认：优先聚合进「Laurel总控」，父级不在就退回独立设置页。

      return ctx.effect(() => {
        let grouped = null
        let standalone = null
        // 装载机声明了聚合插槽 → 收进去，并把独立那份撤掉（否则会同时出现在两处）。

        const offGroup = slots.inject(GROUP, () => {
          if (grouped) return () => {}
          if (standalone) { standalone(); standalone = null }
          grouped = put(GROUP)
          return () => { grouped?.(); grouped = null }
        })
        // 兜底：没有装载机时，照旧自己占一条设置页导航。

        const offStandalone = slots.inject('settings.section', () => {
          if (grouped) return () => {}   // 已经聚合了，别再占一条

          if (standalone) return () => {}
          standalone = put('settings.section')
          return () => { standalone?.(); standalone = null }
        })
        // `?.()`：`slots.inject` 的契约是返回一个 disposer，但测试替身和更早的宿主

        // 未必给。卸载时抛一句「offGroup is not a function」会把整个卸载流程带塌，

        // 而这里本来就没有必须成功的副作用。

        return () => { offGroup?.(); offStandalone?.() }
      }, `${id}.settings-section`)
    }


    /* ---------- lib/client/index.mjs ---------- */
    /**

     * laurel-sample · 客户端半边入口（骨架示例）

     *

     * ── 这个文件是什么 ──────────────────────────────────────────────────────

     * 它是**下一个 Laurel 系列插件的起手模板**，也是这套 kit 的活证明：

     * 从这里开始写，打包出来的 bundle 就是一个能装、能注册设置页、能订阅

     * 会话状态、能落事件日志的完整客户端插件。

     *

     * ── 写客户端插件的四条硬约束（踩一条就白屏）────────────────────────────

     *   1. 不许 `import` / `export default` / 动态 `import()`。

     *      产物是 classic script 里的 CJS factory，出现 ESM 语法会被当 ESM 解析而崩。

     *      （`export function` 这种命名导出可以写 —— 打包器会剥掉修饰符。）

     *   2. 只能 `require('react')` 这类 **platform seed 表**里的东西。

     *      想用别的包 → 只能**打包时内联**（kit 就是这么进来的），或在

     *      `dsh.client.external` 里点名、由另一个 client 插件行提供。

     *   3. 必须 `export function apply(ctx)`。没有它插件不会被激活。

     *   4. `exports.inject` 里写的服务名，其**供给方包**要同时在 package.json 的

     *      `dsh.client.inject` 里声明，否则 boot graph 里没有顺序边

     *      —— 插槽可能还没注册你就去用了（这是"设置页有时不出现"的根因）。

     *

     * ── kit 提供的符号（同作用域，直接用）──────────────────────────────────

     *   requestJSON / loadConfig / reportEvent

     *   probeEnvironment / ensurePermission

     *   createThrottle / pickText / truncateBody / toMap

     *   registerSettingsSection

     */

    /** 宿主半边注册的端点前缀。要和 cordis.patch.yml、lib/index.js 三处一致。 */
    const API = '/laurel-sample'

    /** 需要哪些客户端服务。它们的供给方要写进 package.json 的 dsh.client.inject。 */
    const inject = ['slots', 'uiSession']

    /** 内置默认值。没连上宿主时也照常工作，不能因为读不到配置就整个哑掉。 */
    const FALLBACK = { enabled: true, throttleSeconds: 30, language: 'auto' }

    const TEXT = {
      zh: {
        label: '示例',
        heading: 'Laurel 示例插件',
        intro: '这是一块由 kit 渲染出来的设置区。改 lib/client/index.mjs 即可。',
        enabled: '启用',
        enabledHint: '关掉之后不再做任何事（但仍然能打开这个设置页）。',
        throttle: '同一会话最小间隔（秒）',
        test: '打个招呼',
        statusHeading: '运行状态',
        origin: '页面来源',
        supported: '通知 API',
        permission: '通知权限',
        sessions: '会话数',
      },
      en: {
        label: 'Sample',
        heading: 'Laurel sample plugin',
        intro: 'A settings block rendered by the kit. Edit lib/client/index.mjs to change it.',
        enabled: 'Enabled',
        enabledHint: 'Nothing happens while off (this settings page still works).',
        throttle: 'Per-session minimum interval (s)',
        test: 'Say hello',
        statusHeading: 'Runtime status',
        origin: 'Page origin',
        supported: 'Notification API',
        permission: 'Permission',
        sessions: 'Sessions',
      },
    }

    /**

     * 订阅会话状态并做点事。

     *

     * ── 关键：`uiSession.sessionStatus` 是**可观察对象**，不是 Map ────────────

     * 官方 `ui-conversation` 的用法（vendor/dsh/ui-conversation/lib/client.js）：

     *

     *     uiSession.sessionStatus.getSnapshot().get(sessionId)?.pendingInteraction

     *     uiSession.sessionStatus.subscribe(changed)

     *

     * 它**不是** Map，也**没有** `uiSession/session-status` 这种事件名。

     * 早期版本按 Map + 事件名写，结果是"永远不触发"——

     * 而且不报错，只是安静地什么都不做，最难查。

     *

     * 两代快照要做 diff，才能分出新出现的交互；对每个新交互再叠一层节流。

     */
    function watchSessions(ctx, state) {
      // 第三个参数是全局下限：多个会话同时冒出来时也只放行一次。

      const throttle = createThrottle(() => Date.now(), 30, 2000)

      function install() {
        const source = ctx.uiSession?.sessionStatus
        if (!source || typeof source.getSnapshot !== 'function') return () => {}

        let previous = new Map()
        const react = () => {
          // 必须用 kit 的 toMap，**不能**写 `snapshot instanceof Map` ——

          // bundle 与宿主跨 realm 时 instanceof 恒为 false，会把有内容的

          // Map 换成空 Map，然后安静地什么都不做（这个坑真踩过，

          // tests/kit-client.mjs 里有它的回归测试）。

          const current = toMap(source.getSnapshot())
          state.sessions = current.size

          for (const [sessionId, value] of current) {
            const pendingNow = value?.pendingInteraction != null
            // 只在"从没有变成有"的那一刻动手，而不是每次快照都动。

            if (pendingNow && !previous.get(sessionId)?.pendingInteraction) {
              const verdict = throttle.check(sessionId)
              if (verdict.allowed) {
                throttle.mark(sessionId)
                reportEvent(API, {
                  kind: 'fire',
                  sessionId,
                  title: value?.title ?? null,
                  detail: '示例插件：检测到等待中的交互',
                  ...probeEnvironment(typeof Notification !== 'undefined' ? Notification : null),
                })
              } else {
                reportEvent(API, { kind: 'warn', sessionId, detail: `示例插件：被节流挡住（${verdict.reason}）` })
              }
            }
          }
          previous = current
        }

        react()
        const stop = typeof source.subscribe === 'function' ? source.subscribe(react) : null
        return () => { if (typeof stop === 'function') stop() }
      }

      // cordis 的写法：effect 的回调返回清理函数，而且**惰性**——服务推迟就绪也跟得上。

      if (typeof ctx.effect === 'function') return ctx.effect(install, 'laurel-sample.watch')
      return install()
    }

    /**

     * 插件入口。DSH 客户端 boot 时会调用它。

     * @param {object} ctx cordis 客户端上下文

     */
    function apply(ctx) {
      const React = require('react')
      const h = React.createElement

      const state = {
        config: { ...FALLBACK },
        sessions: 0,
        environment: probeEnvironment(typeof Notification !== 'undefined' ? Notification : null),
        problem: null,
      }

      // 先按内置默认值把界面立起来，再去读宿主配置 —— 宿主不通也不该是一片空白。

      loadConfig(API, (kind, message) => reportEvent(API, { kind: 'error', detail: `${kind}: ${message}` }))
        .then((config) => { if (config) state.config = { ...FALLBACK, ...config } })

      watchSessions(ctx, state)

      /** 一行"标签 + 值"，设置页里反复用。 */
      const Row = (label, value) => h('div',
        { style: { display: 'flex', gap: '12px', padding: '3px 0', fontSize: 12, opacity: 0.85 } },
        h('span', { style: { minWidth: 96, opacity: 0.7 } }, label),
        h('span', { style: { wordBreak: 'break-all' } }, String(value ?? '—')))

      /** 一个开关。 */
      const Toggle = (label, checked, onChange, hint) => h('label',
        { style: { display: 'block', padding: '6px 0', cursor: 'pointer' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) }),
          h('span', null, label)),
        hint ? h('div', { style: { fontSize: 11, opacity: 0.6, paddingLeft: 22 } }, hint) : null)

      /** 设置区组件。 */
      function SampleSettings() {
        const config = state.config
        const t = pickText(TEXT, config.language)
        const [, bump] = React.useState(0)
        const refresh = () => bump((n) => n + 1)

        const save = (patch) => {
          state.config = { ...state.config, ...patch }
          refresh()
          // 写失败不该把界面卡住：本地先生效，落盘失败由事件日志留痕。

          requestJSON(API, '/config', { method: 'POST', body: { config: patch } })
            .catch((error) => reportEvent(API, { kind: 'error', detail: `保存失败：${error.message}` }))
        }

        return h('div', { style: { padding: '4px 2px 24px', fontSize: 13 } },
          h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, t.heading),
          h('div', { style: { opacity: 0.7, marginBottom: 12 } }, t.intro),

          Toggle(t.enabled, config.enabled !== false, (v) => save({ enabled: v }), t.enabledHint),

          h('div', { style: { padding: '6px 0' } },
            h('div', null, t.throttle),
            h('input', {
              type: 'number',
              min: 0,
              max: 3600,
              value: Number(config.throttleSeconds ?? 30),
              onChange: (e) => save({ throttleSeconds: Number(e.target.value) }),
              style: { width: 90, marginTop: 4 },
            })),

          h('button', {
            type: 'button',
            onClick: async () => {
              // 「测试」类按钮必须直接调一次真实动作，而不是只改状态 ——

              // 顺便也是一次真实用户手势，可用于申请通知权限。

              const permission = await ensurePermission(typeof Notification !== 'undefined' ? Notification : null)
              state.environment = { ...probeEnvironment(typeof Notification !== 'undefined' ? Notification : null), permission }
              refresh()
              reportEvent(API, { kind: 'test', detail: '示例插件：测试按钮被点', permission })
            },
            style: { marginTop: 4, padding: '4px 12px', cursor: 'pointer' },
          }, t.test),

          h('div', { style: { marginTop: 20, fontSize: 13, fontWeight: 600 } }, t.statusHeading),
          Row(t.origin, state.environment.origin),
          Row(t.supported, state.environment.supported ? 'yes' : 'no'),
          Row(t.permission, state.environment.permission),
          Row(t.sessions, state.sessions),
        )
      }

      try {
        registerSettingsSection(ctx, {
          id: 'laurel-sample',
          order: 56,
          label: () => pickText(TEXT, state.config.language).label,
          component: SampleSettings,
          slots: ctx.slots,
        })
      } catch (error) {
        // 设置页注册失败**不影响**插件的实际功能 —— 降级成装不上 UI，而不是整个哑掉。

        reportEvent(API, { kind: 'error', detail: `设置页注册失败：${error?.message ?? error}` })
      }
    }


    module.exports.apply = apply
    if (typeof inject !== 'undefined') module.exports.inject = inject

    return module.exports
  },
})
