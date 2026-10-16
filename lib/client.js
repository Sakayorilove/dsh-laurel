/**
 * laurel-center · 客户端半边（由 scripts/build-client.mjs 生成，不要直接改这个文件）
 *
 * 改源码请改：
 *   - lib/client-kit.js
 *   - lib/change-result.js
 *   - lib/registry.js
 *   - lib/client/control-center.css
 *   - lib/client/control-center.mjs
 *   - lib/client/index.mjs
 * 然后跑 `npm run build`。
 */

window.__ModuleLoader__.load({
  id: "laurel-center",
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const CLIENT_BUNDLE_VERSION = "1.2.0"

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


    /* ---------- lib/change-result.js ---------- */
    /**

     * Laurel-Center · 原生 ChangeResult 的唯一解释器（宿主与客户端共用）

     *

     * ── 为什么单独一个文件（第二轮 F2）────────────────────────────────────────

     * 第一轮里「宿主半边」和「客户端半边」**各自**把原生 `application` 字符串翻成

     * 自己的 outcome。两套翻译必然漂移，实测已经漂了三处：

     *   · 四项都 restart-required、逐项记 partial，bulk 却只看 failure → 整体变 success

     *   · 写盘成功但 reload 失败（application:failed / changed:true）→ 被当成 saved:false

     *   · native 返回 undefined（协议缺字段）→ application:unknown，却给 ok/saved:true

     * 所以解释只写一遍：本文件是**纯函数、零依赖**，被

     *   · `lib/host.js`（宿主半边）直接 import

     *   · `lib/client/index.mjs`（客户端半边）经 `scripts/build-client.mjs` 内联

     * 同时引用。两个通道因此拿到同一份结果矩阵。

     *

     * ── 保存与应用是两件事 ────────────────────────────────────────────────────

     * 宿主 `pluginManager.setPluginEnabled` 的合同是「先写 profile 的

     * cordis.patch.yml（用户层），再 reload/HMR」。所以：

     *   saved   —— 用户层配置**确实**写成了我们要的目标值（要能核对，不能靠猜）

     *   applied —— 宿主在**本进程内**已经把它应用上（HMR 可用且 reload 成功）

     * `changed:true` 只说明宿主改过文件，**不等于**目标值就是我们要的；

     * 真正的确认是回读当前 patch 的目标值（见 `confirmTarget`）。

     *

     * ── 未知不是成功 ──────────────────────────────────────────────────────────

     * application 不认识（协议缺字段 / 未来新增值）时，`outcome` 是 `unknown`，

     * `saved` 是 `null`（未知）而不是 `true`。宁可让用户看到「未确认」，

     * 也不许把「没读懂」伪装成「保存好了」。

     *

     * 产物形状：`window.__ModuleLoader__.load({ id, factory })` 的 CJS 闭包。

     * 所以本文件**不能**出现顶层 `import`，`export` 会被构建脚本剥掉。

     */

    /** 宿主可能给出的 application 值（本机 asar 实测）。 */
    const APPLICATIONS = ['applied', 'restart-required', 'overridden', 'failed', 'cancelled']

    /** 逐项 outcome。`unknown` 不是 `success`，也不许折成 `success`。 */
    const OUTCOMES = ['success', 'partial', 'failure', 'unknown']

    /**

     * 归一化原生 application：不认识的一律 `unknown`（不是 applied）。

     * @param {unknown} value

     * @returns {'applied'|'restart-required'|'overridden'|'failed'|'cancelled'|'unknown'}

     */
    function normalizeApplication(value) {
      return typeof value === 'string' && APPLICATIONS.indexOf(value) >= 0 ? value : 'unknown'
    }

    /** 逐项结果里「为什么不是干脆的成功」的稳定原因码。 */
    const REASONS = {
      applied: 'applied',
      restartRequired: 'restart-required',
      overridden: 'overridden',
      reloadFailed: 'reload-failed',
      writeFailed: 'write-failed',
      cancelled: 'cancelled',
      applicationUnknown: 'application-unknown',
      unconfirmed: 'unconfirmed',
      nativeError: 'native-error',
      // 原生调用**没在限期内回执**（宿主被安装/重载占住）。见 interpretRpcTimeout。

      hostBusy: 'host-busy',
      // 因为前一项就没回执，这一项**根本没执行**。不许当成失败，也不许当成成功。

      notAttempted: 'not-attempted',
    }

    /**

     * 解释一次原生调用结果。

     *

     * @param {any} raw 原生返回值（可能是 undefined / 缺字段 / 抛异常后的占位）

     * @param {{

     *   requested?: boolean,

     *   confirmTarget?: boolean | null,

     *   transportError?: string | null,

     * }} [options]

     *   `confirmTarget` —— 操作后**回读当前 patch 的目标值**是否等于 requested：

     *     true  = 回读确认目标值就是我们要的

     *     false = 回读确认目标值不是我们要的

     *     null  = 回读不了（文件读不到 / 没有用户层可读）→ 不当作确认

     *   `transportError` —— 连原生调用都没送达（服务不可用、抛异常）

     * @returns {{

     *   application: string, outcome: 'success'|'partial'|'failure'|'unknown',

     *   saved: boolean | null, applied: boolean, changed: boolean,

     *   reason: string, code: string, restartHelps: boolean, diagnostic: string | null,

     * }}

     */
    function interpretChangeResult(raw, options = {}) {
      const application = normalizeApplication(raw?.application)
      const changed = raw?.changed === true
      const requested = options.requested
      const confirmTarget = options.confirmTarget === true ? true : options.confirmTarget === false ? false : null
      const diagnostic = stringOrNull(raw?.error?.diagnostic ?? raw?.error?.message ?? options.transportError)
      const nativeCode = typeof raw?.error?.code === 'string' ? raw.error.code : null

      const base = { application, changed, restartHelps: false, diagnostic }

      // 1) 连原生通道都没走到（服务不可用 / 抛异常）：什么都没保存。

      if (options.transportError !== undefined && options.transportError !== null) {
        return { ...base, outcome: 'failure', saved: false, applied: false, reason: REASONS.nativeError, code: nativeCode ?? 'transport-error' }
      }

      // 2) 明确失败 / 取消：默认没保存；只有「回读确认目标值已到位」才认保存成功。

      if (application === 'failed' || application === 'cancelled') {
        if (application === 'failed' && confirmTarget === true) {
          // 实测场景：patch 已写成 disabled:false，随后 reload 抛错 → application:failed。

          // 保存是真的，应用失败也是真的，两个事实都要留下。

          return { ...base, outcome: 'partial', saved: true, applied: false, reason: REASONS.reloadFailed, code: nativeCode ?? 'reload-failed' }
        }
        return {
          ...base,
          outcome: 'failure',
          saved: false,
          applied: false,
          reason: application === 'cancelled' ? REASONS.cancelled : REASONS.writeFailed,
          code: nativeCode ?? application,
        }
      }

      // 3) applied：保存 + 本进程应用，都成立。

      if (application === 'applied') {
        return { ...base, outcome: 'success', saved: true, applied: true, reason: REASONS.applied, code: 'ok' }
      }

      // 4) restart-required：配置写下去了，本进程没应用（要重启才生效）。

      if (application === 'restart-required') {
        return { ...base, outcome: 'partial', saved: true, applied: false, reason: REASONS.restartRequired, code: 'ok', restartHelps: true }
      }

      // 5) overridden：有更高层覆盖压着。重启**不保证**解决，不能给「重启后生效」。

      if (application === 'overridden') {
        return { ...base, outcome: 'partial', saved: true, applied: false, reason: REASONS.overridden, code: 'overridden', restartHelps: false }
      }

      // 6) 协议缺字段 / 不认识的值。不许当成功。

      if (confirmTarget === true) {
        // 目标值确实到位了，但应用结果没读懂 → 保存成立、应用未确认。

        return { ...base, outcome: 'partial', saved: true, applied: false, reason: REASONS.applicationUnknown, code: 'application-unknown' }
      }
      return {
        ...base,
        outcome: 'unknown',
        saved: confirmTarget === false ? false : null,
        applied: false,
        reason: confirmTarget === false ? REASONS.writeFailed : REASONS.unconfirmed,
        code: 'application-unknown',
      }
    }

    /** 回读断线 / 操作后读不回来时的统一结论：操作回执收到了，当前状态没确认。 */
    function interpretReadbackFailure(raw, options = {}) {
      const application = normalizeApplication(raw?.application)
      const changed = raw?.changed === true
      const diagnostic = stringOrNull(raw?.error?.diagnostic ?? raw?.error?.message ?? options.transportError)
      const known = application === 'failed' || application === 'cancelled'
      return {
        application,
        outcome: known ? 'failure' : 'unknown',
        saved: known ? false : null,
        applied: false,
        changed,
        reason: known ? REASONS.writeFailed : REASONS.unconfirmed,
        code: known ? (typeof raw?.error?.code === 'string' ? raw.error.code : application) : 'unconfirmed',
        restartHelps: false,
        diagnostic,
      }
    }

    /**

     * 原生调用**没在限期内回执**时的结论。

     *

     * ── 为什么需要它（2026-10-12 实测的真事故）─────────────────────────────────

     * 宿主 `pluginManager.setPluginEnabled` 第一件事是拿 profile 的写锁

     * （`withFileLock(<profile>/package.json, { waitMs: 120000 })`），而**任何**插件安装

     * （`installBundle`）整个 pnpm 运行都握着同一把锁。安装不结束，开关一个回执都拿不到。

     * 更糟的是 pnpm 11.x 有已知缺陷：打完 `Done in Xs` 之后进程**不退出**

     * （上游 pnpm/pnpm#12297、#13617），宿主只能靠 10 分钟空闲看门狗兜底强杀 ——

     * 这段窗口里同样是死等。用户看到的症状就是「点开关就卡死」。

     *

     * 停止等待**不等于**操作失败：调用只是没等到回执，宿主可能仍在执行。

     * 所以 saved 是 null（未知）、outcome 是 unknown、reason 单列 host-busy，

     * 让界面说「结果未确认」，绝不编一个成功或失败出来。

     *

     * @param {{ waitedMs?: number, diagnostic?: string }} [options]

     */
    function interpretRpcTimeout(options = {}) {
      const waited = Number.isFinite(options.waitedMs) ? Math.round(options.waitedMs / 1000) : null
      return {
        application: 'unknown',
        outcome: 'unknown',
        saved: null,
        applied: false,
        changed: false,
        reason: REASONS.hostBusy,
        code: 'host-busy',
        restartHelps: false,
        diagnostic: stringOrNull(options.diagnostic)
          ?? (waited === null ? 'native call did not answer before the deadline' : `native call did not answer within ${waited}s`),
      }
    }

    /**

     * 因为**前一项就没拿到回执**而根本没执行的那几项。

     * 既不是失败（没试过），也不是成功（没发生），所以 outcome 是 unknown。

     */
    function interpretNotAttempted() {
      return {
        application: 'unknown',
        outcome: 'unknown',
        saved: null,
        applied: false,
        changed: false,
        reason: REASONS.notAttempted,
        code: 'not-attempted',
        restartHelps: false,
        diagnostic: null,
      }
    }

    /** 逐项汇总：任何 partial/unknown 都不许被折成 success（F2 的第 1 条）。 */
    function summarizeChange(items) {
      const list = Array.isArray(items) ? items : []
      const counts = { success: 0, partial: 0, failure: 0, unknown: 0 }
      for (const item of list) {
        const outcome = itemOutcome(item)
        counts[outcome] += 1
      }
      let outcome = 'success'
      if (list.length === 0) outcome = 'success'
      else if (counts.failure === list.length) outcome = 'failure'
      else if (counts.failure > 0) outcome = 'partial'
      else if (counts.unknown > 0) outcome = 'partial'
      else if (counts.partial > 0) outcome = 'partial'
      return { outcome, total: list.length, succeeded: counts.success, partial: counts.partial, failed: counts.failure, unknown: counts.unknown }
    }

    /** 逐项 outcome。已经解释过的直接用；裸 item 按 ok/hostApplied 兼容旧形状。 */
    function itemOutcome(item) {
      if (item && OUTCOMES.indexOf(item.outcome) >= 0) return item.outcome
      if (!item?.ok) return 'failure'
      return item.hostApplied ? 'success' : 'partial'
    }

    /** 逐项结果 → 展示用的稳定原因码（客户端文案按它选）。 */
    function reasonOf(item) {
      if (typeof item?.reason === 'string' && item.reason.length > 0) return item.reason
      return itemOutcome(item)
    }

    /** 原因码 → locale key。键名用驼峰，原因码用连字符，所以必须显式映射，不能拼字符串。 */
    const REASON_TEXT_KEY = {
      'restart-required': 'reason.restartRequired',
      'overridden': 'reason.overridden',
      'reload-failed': 'reason.reloadFailed',
      'application-unknown': 'reason.applicationUnknown',
      'unconfirmed': 'reason.unconfirmed',
      'write-failed': 'reason.writeFailed',
      'cancelled': 'reason.cancelled',
      'unaddressable': 'reason.unaddressable',
      'host-busy': 'reason.hostBusy',
      'not-attempted': 'reason.notAttempted',
    }

    /** 一条逐项结果 → 用户可读的一句话。取不到翻译就退回机器码（不编造）。 */
    function reasonTextOf(item, t) {
      const reason = reasonOf(item)
      const key = REASON_TEXT_KEY[reason]
      if (key !== undefined) {
        const text = t(key)
        if (text !== key) return text
      }
      return item?.code ?? reason
    }

    /**

     * 把一次操作的 notice 渲染成**可见文案**。

     *

     * 这是纯函数，放在共用文件里是为了让「界面显示什么」可被离线检查：

     * 客户端半边调它，检查脚本也调**同一份**，不用在探针里重写一遍渲染逻辑

     * （重写就会掩盖键名对不上这类错误 —— 第一轮就踩过 reason 连字符 vs 驼峰）。

     *

     * @param {object} notice

     * @param {(key: string, params?: object) => string} t locale 绑定

     */
    function formatNotice(notice, t) {
      if (!notice) return null
      // 还在等：界面没有进度条，等久了必须有一行字，否则看起来就是死了。

      if (notice.pending === true) return t('notice.busyWaiting')
      // **连回执都没拿到**（宿主被安装/重载占住）：最优先，且绝不能说成「已生效」。

      // 注意顺序必须在 readbackOk 之前 —— 超时时我们连读回执都没做，

      // 走 readbackOk 分支会误报成「回执已收到」。

      if (notice.hostBusy === true) {
        const items = notice.items ?? []
        // 「未执行」的项单独说 —— 它们既没成功也没失败，混进主语里会让人以为试过了。

        const attempted = items.filter((i) => i.reason !== REASONS.notAttempted)
        const skipped = items.filter((i) => i.reason === REASONS.notAttempted)
        const names = attempted.map((i) => t('plugin.' + i.id)).join('、') || t('section.title')
        const base = t('notice.hostBusy', { names, seconds: notice.waitedSeconds ?? 0 })
        if (skipped.length === 0) return base
        return `${base} ${t('notice.notAttempted', { names: skipped.map((i) => t('plugin.' + i.id)).join('、') })}`
      }
      // 回读失败：回执收到了，但当前状态没确认 —— 绝不追加「已生效」。

      if (notice.readbackOk === false) {
        const failed = (notice.items ?? []).filter((i) => i.outcome === 'failure')
        const head = t('notice.unconfirmed')
        if (failed.length === 0) return head
        return `${head} ${t('notice.failure', { detail: failed.map((f) => failureDetailOf(f, t)).join('；') })}`
      }
      if (notice.outcome === 'success') return t('notice.success')
      if (notice.outcome === 'failure') {
        const detail = (notice.items ?? []).map((i) => failureDetailOf(i, t)).join('；')
        return t('notice.failure', { detail })
      }
      // partial / unknown：逐项说清「为什么不是干脆的成功」

      const notable = (notice.items ?? []).filter((i) => i.outcome !== 'success')
      if (notable.length === 0) return t('notice.partial')
      return `${t('notice.partialHeader')}${notable.map((i) => `${t('plugin.' + i.id)}：${reasonTextOf(i, t)}`).join('；')}`
    }

    function stringOrNull(value) {
      if (value === null || value === undefined) return null
      const text = String(value)
      return text.length > 0 ? text : null
    }

    /** 压成一行 + 限长（诊断里常有换行、路径和长栈）。 */
    function oneLine(value, max = 200) {
      if (value === null || value === undefined) return null
      const text = String(value).replace(/\s+/g, ' ').trim()
      if (text.length === 0) return null
      return text.length > max ? text.slice(0, max - 1) + '…' : text
    }

    /**

     * 稳定 code → locale key。**只给 Laurel 自己产的 code 用。**

     *

     * 宿主产的码（`operation-error` / `unknown-plugin` / `incompatible-version` …）

     * 一律**不进这张表** —— 它们的文案是宿主自己管的，我们不该替它翻译；

     * 而且它们真正的信息在 `diagnostic` 里（见 failureDetailOf）。

     */
    const CODE_TEXT_KEY = {
      'package-missing': 'code.packageMissing',
    }

    /**

     * 一项失败 → 给用户看的短句。**必须带上 diagnostic。**

     *

     * ── 为什么（2026-10-15 实测的真事故）───────────────────────────────────────

     * 宿主 `pluginManager` 把**任何非它自己预期的异常**都兜底成 `code: 'operation-error'`

     * （asar 里 `managementError()`：`if (!(error instanceof ManagementFailure)) return

     * { code: 'operation-error', diagnostic: messageOf(error) }`），真实原因**只**放在

     * `error.diagnostic` 里。

     *

     * 只显示 code 的话，用户看到的是「操作未成功：内耗护栏:operation-error」——

     * 一个字的原因都没有，只能来问人。实测那次的原因其实写得很清楚：

     * 那个包还没装进 profile，loader 解析不到它，reload 就抛了。

     *

     * 所以：Laurel 自己的码给一句人话（CODE_TEXT_KEY），宿主的码把它给的

     * diagnostic 附在括号里。diagnostic 可能带路径和栈，压成一行并截断，

     * 免得把那一行提示撑破（界面上它只是一行文字，没有折叠）。

     */
    function failureDetailOf(item, t) {
      const head = `${t('plugin.' + item.id)}:${item.code}`
      const parts = []
      const key = CODE_TEXT_KEY[item?.code]
      if (key !== undefined) {
        const text = t(key)
        if (text !== key) parts.push(text)
      }
      const diagnostic = oneLine(item?.diagnostic)
      if (diagnostic !== null) parts.push(diagnostic)
      return parts.length === 0 ? head : `${head}（${parts.join('；')}）`
    }


    /* ---------- lib/registry.js ---------- */
    /**

     * Laurel-Center · 子插件注册表

     *

     * 这里是装载机认识的全部子插件。每一条都指向**本包内**的一份源码副本

     * （`packages/<dir>/`），不引用任何外部目录 —— 整个装载机是自包含的。

     *

     * ── 三个字段的约定 ──────────────────────────────────────────────────────

     *   id        loader 行 id，同时是总控台 UI 里那一行开关的键。

     *             必须是稳定的字符串：profile 的 patch 靠它定位要禁用的行。

     *   dir       packages/ 下的目录名。

     *   entry     loader 行的 name —— **必须是纯包名**（laurel / dsh-strata / ...）。

     *             ⚠ 不能写成 `laurel-center/packages/laurel`：DSH 的 client-modules

     *             用 `exactPackageSpecifier` 判包名，带斜杠的非 scope 包名既不是

     *             合法包名、也不是 path-like（不以 `.`/`file:`/绝对路径开头），

     *             `resolveMeta` 会**直接返回 null**，那一行就不产出 boot graph row，

     *             前端永远加载不到 —— 而且全程不报错，只是「什么都不发生」。

     *             所以五个子包各自要在 profile 的 node_modules 里有一个链接

     *             指向本包内的 `packages/<dir>`（安装步骤见 README）。

     *   clientId  子插件 client bundle 里 `__ModuleLoader__.load({ id })` 用的 id，

     *             也就是子包 package.json 的 name。三处必须一致，这里显式写出来

     *             是为了让「哪个子包出问题了」一眼可查。

     *   label     总控台里显示的名字。

     *   desc      一句话说明它干嘛。

     *   defaultOn 首次加载（还没有 state.json）时的默认开关。

     *   settingsId 该模块设置页在客户端插槽里的条目 id —— 也就是它自己调

     *             `registerSettingsSection({ id })` 时写的那个值。

     *             ⚠ 它跟上面的 id **在五个模块里都是同值**，但它不是 id 的别名：它描述的是

     *             子包**客户端文件**里那一行 `slots.register({ id })` 实际写的东西。两者

     *             漂开过一次（laurel 的示例产物用 `laurel-sample`、真正加载的 `lib/client.js`

     *             用 `laurel`），而漂开的症状是「卡片能展开、里面是空的」，不报错。

     *             改任一处的设置页 id 时，必须同时改这里。

     *             总控台要把「某个模块的设置内容」渲染进「某个模块的卡片」里，就得

     *             靠这个字段对上号；手抄一份映射表到客户端正是这一层要避免的事

     *             （见 lib/client/index.mjs 顶上那段注释）。改模块的设置页 id 时，

     *             必须同时改这里，否则总控台里那张卡片会空着。

     *

     * ── 顺序有意义 ──────────────────────────────────────────────────────────

     *   clientModules 按 loader 扫描顺序组 boot graph，但会用模块图拓扑排序修正

     *   依赖顺序。这里的顺序只影响总控台的显示次序。

     */

    /** @typedef {{ id: string, dir: string, entry: string, clientId: string, label: string, desc: string, defaultOn: boolean, settingsId: string }} SubPlugin */

    /** @type {SubPlugin[]} */
    const SUB_PLUGINS = [
      {
        id: 'laurel',
        dir: 'laurel',
        entry: 'laurel',
        clientId: 'laurel',
        settingsId: 'laurel',
        label: '通知',
        desc: 'agent 提问、等你批准、干完活时弹一条 Windows 通知并响一声，不看窗口也不会错过。',
        defaultOn: false,
      },
      {
        id: 'claude-parchment',
        dir: 'dsh-claude-parchment',
        entry: 'dsh-claude-parchment',
        clientId: 'dsh-claude-parchment',
        settingsId: 'claude-parchment',
        label: 'Claude主题',
        desc: 'Claude 风格的米色/深色主题与会话字体排版，带冲突保护。',
        defaultOn: false,
      },
      {
        id: 'strata',
        dir: 'dsh-strata',
        entry: 'dsh-strata',
        clientId: 'dsh-strata',
        settingsId: 'strata',
        label: '记忆与上下文',
        desc: '让 DSH 跨会话记住事：本会话 → 本工作区 → 全局三级作用域，跨工作区读取逐次授权。',
        defaultOn: false,
      },
      {
        id: 'warden',
        dir: 'dsh-warden',
        entry: 'dsh-warden',
        clientId: 'dsh-warden',
        settingsId: 'warden',
        label: '内耗护栏',
        desc: '给子代理套上等待上限、把结论赶去写文件、按文件计返工次数、给上下文加水位提醒、给共享目录加锁。',
        defaultOn: false,
      },
      {
        id: 'loom',
        dir: 'dsh-loom',
        entry: 'dsh-loom',
        clientId: 'dsh-loom',
        settingsId: 'loom',
        label: '可视化规划模式',
        desc: '把项目拆成可编辑的节点图，再编译成可并行执行的批次脚本。体积大，默认关闭。',
        defaultOn: false,
      },
    ];

    /** 按 id 取一条。 */
    function subPlugin(id) {
      return SUB_PLUGINS.find((p) => p.id === id) ?? null;
    }

    /** 全部 id。 */
    const SUB_IDS = SUB_PLUGINS.map((p) => p.id);

    /** 首次加载时的默认开关表。 */
    function defaultEnabled() {
      return Object.fromEntries(SUB_PLUGINS.map((p) => [p.id, p.defaultOn]));
    }

    /** 把任意输入规整成完整、布尔化的开关表。 */
    function normalizeEnabled(input) {
      const out = defaultEnabled();
      if (input && typeof input === 'object') {
        for (const p of SUB_PLUGINS) {
          if (typeof input[p.id] === 'boolean') out[p.id] = input[p.id];
        }
      }
      return out;
    }


    /* ---------- lib/client/control-center.css ---------- */
    const CONTROL_CENTER_CSS = ".lc-backdrop,.lc-settings-entry,.lc-launch{--lc-bg:var(--dsw-alias-bg-layer-1,#fff);--lc-sidebar:var(--dsw-alias-bg-layer-2,#f5f6f5);--lc-text:var(--dsw-alias-label-primary,#252a27);--lc-muted:var(--dsw-alias-label-secondary,#626c65);--lc-border:var(--dsw-alias-border-l2,#e3e8e4);--lc-accent:#36745a;--lc-selected:color-mix(in srgb,var(--lc-accent) 11%,var(--lc-bg));--lc-danger:var(--dsw-alias-state-error-primary,#b63737);color:var(--lc-text);font-family:system-ui,-apple-system,\"Segoe UI\",\"Microsoft YaHei\",sans-serif;font-size:14px;line-height:1.55;letter-spacing:normal}\n.lc-backdrop{position:fixed;inset:var(--dsh-frame-chrome-top,var(--dsh-frame-top-clearance,0px)) 0 0;z-index:1400;background:rgb(25 36 29 / 20%);pointer-events:auto;isolation:isolate;container-type:inline-size;caret-color:var(--lc-accent);-webkit-app-region:no-drag}\n.lc-backdrop *,.lc-settings-entry *{box-sizing:border-box}\n.lc-backdrop ::selection{background:var(--lc-selected);color:var(--lc-text)}\n.lc-window{position:absolute;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--lc-bg);border-radius:14px;box-shadow:0 18px 65px rgb(20 33 25 / 24%);overflow:hidden;container-type:inline-size;cursor:var(--lc-gesture-cursor,auto)}\n.lc-window[data-maximized]{border-radius:0}\n.lc-backdrop button,.lc-settings-entry button{font:inherit;color:inherit;cursor:pointer}\n.lc-backdrop button:disabled{opacity:.5;cursor:not-allowed}\n.lc-backdrop :focus-visible,.lc-settings-entry :focus-visible,.lc-launch:focus-visible{outline:2px solid var(--lc-accent);outline-offset:3px}\n.lc-backdrop button,.lc-backdrop input,.lc-backdrop select,.lc-backdrop textarea{accent-color:var(--lc-accent)}\n.lc-backdrop :is(input,textarea,select){font:inherit;color:var(--lc-text);background:var(--lc-bg);border:1px solid var(--lc-border);border-radius:7px;padding:7px 10px;max-width:100%;min-width:0}\n.lc-backdrop input::placeholder,.lc-backdrop textarea::placeholder{color:var(--lc-muted);opacity:1}\n.lc-titlebar{height:76px;flex:none;display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid var(--lc-border);touch-action:none;user-select:none;cursor:grab}\n.lc-brand{display:flex;gap:16px;align-items:center;min-width:0}\n.lc-brand>svg{color:var(--lc-accent);flex:none}\n.lc-brand strong{display:block;font-size:19px;font-weight:650;color:var(--lc-text)}\n.lc-brand span{display:block;font-size:12px;color:var(--lc-muted);margin-top:1px}\n.lc-window-actions{display:flex;gap:8px}\n.lc-icon-button{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border:0;border-radius:7px;background:transparent;padding:0;flex:none}\n.lc-icon-button:hover{background:var(--lc-selected)}\n.lc-layout{flex:1;min-height:0;display:grid;grid-template-columns:235px minmax(0,1fr)}\n.lc-sidebar{background:var(--lc-sidebar);border-right:1px solid var(--lc-border);padding:24px 14px 18px;display:flex;flex-direction:column;gap:20px;min-width:0;min-height:0;overflow:auto}\n.lc-search{position:relative;display:flex;gap:9px;align-items:center;background:var(--lc-bg);border:1px solid var(--lc-border);border-radius:8px;padding:0 10px;min-height:39px;color:var(--lc-muted)}\n.lc-search input{border:0;padding:7px 0;background:transparent;width:100%;font-size:13px;outline-offset:1px!important}\n.lc-navigation{display:flex;flex-direction:column;gap:6px}\n.lc-nav{display:flex;align-items:center;gap:14px;padding:11px 13px;min-height:46px;border:0;border-radius:8px;text-align:left;background:transparent;font-weight:500;flex:none;width:100%;white-space:normal}\n.lc-nav svg{flex:none}\n.lc-nav:hover{background:color-mix(in srgb,var(--lc-text) 5%,transparent)}\n.lc-nav[aria-current=page]{background:var(--lc-selected);color:var(--lc-accent);font-weight:650}\n.lc-sidebar-bottom{margin-top:auto;border-top:1px solid var(--lc-border);padding-top:12px;display:flex;flex-direction:column;gap:4px}\n.lc-sidebar-bottom small{color:var(--lc-muted);font-size:11px;padding:12px 13px 0}\n.lc-content{padding:26px 32px 16px;overflow:auto;min-height:0;min-width:0;scrollbar-gutter:stable;scrollbar-color:var(--lc-border) transparent;font-variant-numeric:tabular-nums}\n.lc-page-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}\n.lc-page-heading h1{font-size:26px;line-height:1.3;font-weight:650;margin:0 0 7px;letter-spacing:-.02em}\n.lc-page-heading p{font-size:13px;line-height:1.6;color:var(--lc-muted);margin:0;max-width:65ch}\n.lc-module-enable{display:flex;align-items:center;gap:12px;flex:none;padding-top:3px;font-size:13px}\n.lc-switch{position:relative;width:44px;height:25px;min-width:44px;flex:none;border:0;border-radius:999px;padding:0;background:color-mix(in srgb,var(--lc-muted) 45%,var(--lc-bg));transition:background .16s}\n.lc-switch>span{position:absolute;top:3px;left:3px;width:19px;height:19px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgb(0 0 0 / 14%);transition:transform .16s}\n.lc-switch[aria-checked=true]{background:var(--lc-accent)}\n.lc-switch[aria-checked=true]>span{transform:translateX(19px)}\n.lc-status{display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--lc-muted);margin:10px 0 14px}\n.lc-status span{display:inline-flex;align-items:center;gap:6px}\n.lc-status span:before{content:\"\";width:6px;height:6px;border-radius:50%;background:var(--lc-muted)}\n.lc-status [data-tone=success]:before{background:var(--lc-accent)}\n.lc-feedback:empty{display:none}\n.lc-feedback p{padding:9px 12px;border-radius:6px;margin:10px 0;font-size:12px;overflow-wrap:anywhere}\n.lc-error{color:var(--lc-danger);background:color-mix(in srgb,var(--lc-danger) 8%,var(--lc-bg))}\n.lc-notice{color:var(--lc-text);background:var(--lc-selected)}\n.lc-no-results,.lc-loading{font-size:13px;color:var(--lc-muted);padding:10px}\n.lc-overview{margin-top:28px}\n.lc-overview-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--lc-border);font-size:12px}\n.lc-overview-tools>span{margin-right:auto;color:var(--lc-muted)}\n.lc-overview-tools button,.lc-empty button{background:var(--lc-bg);border:1px solid var(--lc-border);border-radius:7px;padding:7px 11px}\n.lc-overview-tools button:hover,.lc-empty button:hover{background:var(--lc-selected)}\n.lc-overview-row{display:flex;align-items:center;gap:18px;padding:23px 0;border-bottom:1px solid var(--lc-border)}\n.lc-overview-row>svg{color:var(--lc-muted);flex:none}\n.lc-module-link{border:0;background:transparent;text-align:left;padding:0;flex:1;min-width:0}\n.lc-module-link strong{display:block;font-size:15px;font-weight:600}\n.lc-module-link>span{display:block;font-size:12px;color:var(--lc-muted);margin-top:5px}\n.lc-module-link .lc-status{margin-bottom:0}\n.lc-empty{padding:48px 20px;text-align:center;color:var(--lc-muted);border-top:1px solid var(--lc-border)}\n.lc-empty svg{margin:auto;color:var(--lc-accent)}\n.lc-empty h2{font-size:18px;margin:16px 0 6px;color:var(--lc-text)}\n.lc-empty p{font-size:13px;margin-bottom:18px}\n.lc-content-footer{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:30px;padding:13px 0 4px;border-top:1px solid var(--lc-border);font-size:11px;color:var(--lc-muted)}\n.lc-content-footer span{overflow-wrap:anywhere}\n.lc-about{margin-top:32px;max-width:65ch}\n.lc-about h2{font-size:17px;margin-bottom:14px}\n.lc-about p{font-size:14px;line-height:1.8;color:var(--lc-muted)}\n.lc-about dl{display:flex;gap:24px;font-size:13px;border-block:1px solid var(--lc-border);padding:14px 0}\n.lc-about dd{margin:0}\n.lc-launch{display:inline-flex;align-items:center;justify-content:flex-start;gap:10px;background:transparent;border:0;border-radius:7px;padding:8px 12px;max-width:100%;font-size:13px;cursor:pointer;text-align:left;min-height:36px}\n.lc-launch:hover{background:var(--lc-selected)}\n.lc-launch svg{flex:none;color:var(--lc-accent)}\n.lc-settings-entry{padding:28px 12px;max-width:600px}\n.lc-settings-entry>svg{color:var(--lc-accent)}\n.lc-settings-entry h2{font-size:21px;margin:16px 0 10px}\n.lc-settings-entry p{color:var(--lc-muted);font-size:13px;line-height:1.8}\n.lc-settings-entry .lc-launch{background:var(--lc-selected);margin:14px 0;font-weight:600}\n.lc-settings-entry .lc-entry-note{font-size:12px}\n.lc-resize{position:absolute;touch-action:none;z-index:4}\n.lc-resize-n,.lc-resize-s{left:12px;right:12px;height:6px;cursor:ns-resize}\n.lc-resize-n{top:0}.lc-resize-s{bottom:0}\n.lc-resize-e,.lc-resize-w{top:12px;bottom:12px;width:6px;cursor:ew-resize}\n.lc-resize-e{right:0}.lc-resize-w{left:0}\n.lc-resize-ne,.lc-resize-nw,.lc-resize-se,.lc-resize-sw{width:13px;height:13px}\n.lc-resize-ne{top:0;right:0;cursor:nesw-resize}.lc-resize-nw{top:0;left:0;cursor:nwse-resize}.lc-resize-se{bottom:0;right:0;cursor:nwse-resize}.lc-resize-sw{bottom:0;left:0;cursor:nesw-resize}\n.lc-resize-keyboard{position:absolute;right:3px;bottom:3px;display:flex;padding:3px;background:var(--lc-bg);border:0;color:var(--lc-muted)!important;z-index:5;touch-action:none;cursor:nwse-resize!important}\n/* Shared module surface: only descendants of this plugin-owned window. */\n.lc-module{margin-top:10px;min-width:0;--dsw-text-primary:var(--lc-text);--dsw-text-secondary:var(--lc-muted);--dsw-text-tertiary:var(--lc-muted);--dsw-bg-subtle:var(--lc-sidebar);--dsw-border-subtle:var(--lc-border)}\n.lc-module[hidden]{display:none}\nbody[data-ds-dark-theme] .lc-backdrop,body[data-ds-dark-theme] .lc-launch,body[data-ds-dark-theme] .lc-settings-entry{--lc-accent:#87bca1}\n.lc-module [data-laurel-module]{max-width:none!important;padding:0!important;font-size:14px!important;line-height:1.6!important;color:var(--lc-text)!important}\n.lc-module .lc-embedded-heading,.lc-module .lc-embedded-description{display:none!important}\n.lc-module .lc-idle-status{display:none}\n.lc-module h3{font-size:16px!important;font-weight:600!important;line-height:1.5;margin:24px 0 12px!important;color:var(--lc-text)}\n.lc-module h4{font-size:14px}\n.lc-module :is(button,select,input,textarea){font-family:inherit!important;font-size:13px!important;color:var(--lc-text)!important;accent-color:var(--lc-accent)}\n.lc-module button:not([role=switch]){border:1px solid var(--lc-border);border-radius:7px;background:var(--lc-bg);padding:7px 12px;line-height:1.5}\n.lc-module button:not([role=switch]):hover{border-color:var(--lc-accent);background:var(--lc-selected)}\n.lc-module button[aria-pressed=true]:not([role=switch]){color:var(--lc-accent)!important;background:var(--lc-selected)!important;border-color:var(--lc-accent)!important}\n.lc-module nav{display:flex!important;align-items:center;gap:20px!important;flex-wrap:wrap;border-bottom:1px solid var(--lc-border)!important;margin:10px 0 20px!important;padding-bottom:0!important}\n.lc-module nav>button{border:0!important;border-radius:0!important;border-bottom:2px solid transparent!important;padding:10px 0!important;background:transparent!important;white-space:normal;text-decoration:none!important;color:var(--lc-muted)!important;font-weight:500!important}\n.lc-module nav>button[aria-pressed=true]{border-bottom-color:var(--lc-accent)!important;color:var(--lc-accent)!important;font-weight:650!important;background:transparent!important}\n.lc-module :is(input:not([type=checkbox]):not([type=radio]),select,textarea){padding:8px 10px!important;border:1px solid var(--lc-border)!important;border-radius:7px!important;background:var(--lc-bg)!important;color:var(--lc-text)!important}\n.lc-module :is(input[type=checkbox],input[type=radio]){accent-color:var(--lc-accent);flex:none}\n.lc-module input[type=checkbox].lc-toggle-input{appearance:none;width:42px;height:24px;border:0!important;border-radius:99px!important;background:color-mix(in srgb,var(--lc-muted) 45%,var(--lc-bg))!important;padding:3px!important;position:relative;cursor:pointer}\n.lc-module input[type=checkbox].lc-toggle-input:before{content:\"\";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:white;transition:transform .16s}\n.lc-module input[type=checkbox].lc-toggle-input:checked{background:var(--lc-accent)!important}\n.lc-module input[type=checkbox].lc-toggle-input:checked:before{transform:translateX(18px)}\n.lc-module input[type=checkbox].lc-toggle-input:disabled{opacity:.5;cursor:not-allowed}\n.lc-module .lc-setting-row{display:grid!important;grid-template-columns:minmax(0,1fr) auto;gap:6px 20px!important;padding:15px 0;border-bottom:1px solid var(--lc-border);margin:0!important}\n.lc-module .lc-setting-row>label{display:contents!important}\n.lc-module .lc-setting-row>label>input{grid-column:2;grid-row:1;align-self:center}\n.lc-module .lc-setting-row>label>span{grid-column:1;grid-row:1;font-weight:500}\n.lc-module .lc-setting-row>.lc-setting-hint{grid-column:1;margin:0!important;padding:0!important;color:var(--lc-muted);font-size:12px;line-height:1.6}\n.lc-module details{border-block-start:1px solid var(--lc-border);padding-top:12px;margin-top:20px}\n.lc-module summary{cursor:pointer;font-weight:500;padding:6px 0;font-size:13px;list-style-position:inside}\n.lc-module [data-lc-presets]{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:0!important;overflow:hidden;border:1px solid var(--lc-border);border-radius:8px}\n.lc-module [data-lc-presets]>button{border:0!important;border-radius:0!important;border-right:1px solid var(--lc-border)!important;padding:14px 18px!important;min-height:76px;display:flex!important;align-items:center;gap:12px!important}\n.lc-module [data-lc-presets]>button:last-child{border-right:0!important}\n.lc-module [data-lc-presets]>button [data-lc-radio]{width:18px;height:18px;flex:none;border:1.5px solid var(--lc-muted);border-radius:50%}\n.lc-module [data-lc-presets]>button[aria-pressed=true] [data-lc-radio]{border:5px solid var(--lc-accent)}\n.lc-module .lc-preset-copy strong{display:block;font-size:14px;font-weight:600}\n.lc-module .lc-preset-copy small{display:block;font-size:12px;font-weight:400;color:var(--lc-muted);margin-top:3px}\n.lc-module .lc-guard-info{padding:10px 13px;background:var(--lc-selected);border-radius:6px;color:var(--lc-muted);font-size:12px}\n.lc-module .lc-setting-unit{color:var(--lc-muted);font-size:12px}\n.lc-module [data-lc-notification-block]{border:0!important;border-radius:0!important;background:transparent!important;padding:16px 0!important;margin:0!important;border-bottom:1px solid var(--lc-border)!important}\n.lc-module [data-lc-notification-block]>div:first-child{font-size:16px!important;font-weight:600}\n.lc-module .lc-notify-effect{background:var(--lc-selected)!important;border:0!important;padding:11px 14px!important;margin:14px 0 8px!important;border-radius:6px!important}\n.lc-module .lc-notify-effect>div:first-child{display:none}\n.lc-module .lc-notify-effect>div{font-size:13px!important;color:var(--lc-text)!important}\n.lc-module .lc-notify-matrix input[role=switch]{width:39px;height:22px;appearance:none;border:0;border-radius:99px;background:color-mix(in srgb,var(--lc-muted) 45%,var(--lc-bg));position:relative;cursor:pointer}\n.lc-module .lc-notify-matrix input[role=switch]:before{content:\"\";position:absolute;top:3px;left:3px;width:16px;height:16px;background:#fff;border-radius:50%;transition:transform .16s}\n.lc-module .lc-notify-matrix input[role=switch]:checked{background:var(--lc-accent)}\n.lc-module .lc-notify-matrix input[role=switch]:checked:before{transform:translateX(17px)}\n.lc-module .lc-notify-matrix input[role=switch]:disabled{opacity:.5}\n.lc-module .lc-notify-matrix{border:0!important}\n.lc-module .lc-notify-matrix{grid-template-columns:minmax(0,1fr) 125px 125px!important;row-gap:0}\n.lc-module .lc-notify-matrix>div[style*='grid-column: 1']{padding:13px 0!important}\n.lc-module .lc-notify-matrix>div:nth-child(-n+3){background:var(--lc-sidebar);padding-block:10px!important}\n.lc-module .lc-notify-matrix button.lc-matrix-switch{position:relative;width:42px!important;height:24px!important;border:0!important;border-radius:99px!important;padding:0!important;font-size:0!important;background:color-mix(in srgb,var(--lc-muted) 45%,var(--lc-bg))!important}\n.lc-module .lc-notify-matrix button.lc-matrix-switch:after{content:\"\";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .16s}\n.lc-module .lc-notify-matrix button.lc-matrix-switch[aria-pressed=true]{background:var(--lc-accent)!important}\n.lc-module .lc-notify-matrix button.lc-matrix-switch[aria-pressed=true]:after{transform:translateX(18px)}\n.lc-module [data-cp-settings]{padding:0!important;max-width:none!important}\n.lc-module [data-cp-settings] .cp-heading,.lc-module [data-cp-settings]>.cp-description{display:none}\n.lc-module [data-cp-settings] .cp-theme-option{min-height:75px}\n.lc-module [data-cp-settings] .cp-theme-option[data-selected]{color:var(--lc-accent)}\n.lc-module [data-cp-settings] .cp-theme-option input{accent-color:var(--lc-accent)}\n.lc-module [data-cp-settings] .cp-themes{border:0;margin:24px 0 0;padding:0;min-width:0}\n.lc-module [data-cp-settings] .cp-themes legend{font-size:16px;font-weight:600;margin-bottom:12px}\n.lc-module [data-cp-settings] .cp-theme-option{display:flex;align-items:center;gap:14px;padding:14px 2px;border-top:1px solid var(--lc-border);cursor:pointer}\n.lc-module [data-cp-settings] .cp-theme-copy{flex:1;min-width:0}\n.lc-module [data-cp-settings] .cp-theme-name{display:block;font-size:14px;font-weight:600}\n.lc-module [data-cp-settings] .cp-theme-detail{display:block;font-size:12px;color:var(--lc-muted);margin-top:3px}\n.lc-module [data-cp-settings] .cp-theme-colors{display:flex;overflow:hidden;border-radius:4px;flex:none}\n.lc-module [data-cp-settings] .cp-theme-colors span{width:16px;height:24px}\n.lc-module [data-cp-settings] .cp-toggle{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:20px 0;padding:14px 0;border-block:1px solid var(--lc-border)}\n.lc-module [data-cp-settings] .cp-update{border-top:1px solid var(--lc-border);margin-top:24px;padding-top:16px}\n.lc-module [data-cp-settings] .cp-versions{display:grid;grid-template-columns:1fr auto;gap:8px;font-size:12px}.lc-module [data-cp-settings] .cp-versions dd{margin:0}\n.lc-module [data-cp-settings] .cp-actions{display:flex;gap:10px;margin:12px 0;flex-wrap:wrap}\n.lc-module [data-cp-settings] .cp-update-form{display:grid;gap:10px}.lc-module [data-cp-settings] .cp-update-error{white-space:pre-wrap;overflow-wrap:anywhere}\n.lc-module [data-loom-surface=settings]>.lc-embedded-heading,.lc-module [data-loom-surface=settings]>.lc-embedded-description{display:none}\n.lc-module [data-loom-surface=settings] .loom-settings-fields{gap:0!important}\n.lc-module [data-loom-surface=settings] .loom-settings-fields>label{display:flex;gap:16px;justify-content:space-between;align-items:center;flex-wrap:wrap;padding:15px 0;border-bottom:1px solid var(--lc-border)}\n.lc-module [data-loom-surface=settings] .loom-settings-fields>label:has(input[type=checkbox]){flex-direction:row-reverse;text-align:left}\n.lc-module :is(.cp-toggle input[role=switch],[data-loom-surface=settings] input[type=checkbox]){appearance:none;width:42px!important;height:24px!important;border:0!important;border-radius:99px!important;position:relative;padding:0!important;cursor:pointer;background:color-mix(in srgb,var(--lc-muted) 45%,var(--lc-bg))!important;flex:none}\n.lc-module :is(.cp-toggle input[role=switch],[data-loom-surface=settings] input[type=checkbox]):before{content:\"\";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .16s}\n.lc-module :is(.cp-toggle input[role=switch],[data-loom-surface=settings] input[type=checkbox]):checked{background:var(--lc-accent)!important}\n.lc-module :is(.cp-toggle input[role=switch],[data-loom-surface=settings] input[type=checkbox]):checked:before{transform:translateX(18px)}\n@container (max-width:850px){.lc-layout{grid-template-columns:190px minmax(0,1fr)}.lc-sidebar{padding-inline:10px}.lc-content{padding:24px 22px 14px}.lc-nav{gap:10px;padding-inline:10px}.lc-module [data-lc-presets]>button{padding:12px!important;align-items:flex-start}.lc-module .lc-preset-copy small{font-size:11px}.lc-page-heading{flex-wrap:wrap}.lc-status{gap:10px}}\n@container (max-width:620px){.lc-layout{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.lc-sidebar{border-right:0;border-bottom:1px solid var(--lc-border);padding:10px 14px;display:grid;grid-template-columns:1fr;gap:8px;overflow:visible}.lc-navigation{flex-direction:row;overflow-x:auto;scrollbar-width:thin;padding-bottom:4px;gap:4px}.lc-nav{width:auto;min-height:36px;white-space:nowrap;font-size:12px;padding:7px 10px;gap:6px}.lc-nav svg{width:17px;height:17px}.lc-sidebar-bottom{display:none}.lc-titlebar{height:64px;padding:10px 15px}.lc-brand{gap:10px}.lc-brand strong{font-size:17px}.lc-brand span{font-size:10px}.lc-brand>svg{width:27px;height:27px}.lc-content{padding:20px 18px 14px}.lc-page-heading h1{font-size:22px}.lc-module-enable{font-size:12px}.lc-module [data-lc-presets]{grid-template-columns:1fr!important}.lc-module [data-lc-presets]>button{border-right:0!important;border-bottom:1px solid var(--lc-border)!important;min-height:60px}.lc-module [data-lc-presets]>button:last-child{border-bottom:0!important}.lc-module .lc-preset-copy small{font-size:12px}.lc-overview-row{gap:10px;padding:20px 0}.lc-overview-row>.lc-icon-button{display:none}.lc-overview-row>svg{width:21px}.lc-content-footer{font-size:10px}.lc-module nav{gap:14px!important}.lc-module .lc-setting-row{gap:6px 12px!important}.lc-overview-tools>span{flex-basis:100%}.lc-window-actions{gap:2px}.lc-icon-button{width:31px;height:31px}}\n@media(prefers-reduced-motion:reduce){.lc-backdrop *{transition:none!important;scroll-behavior:auto!important}}\n"


    /* ---------- lib/client/control-center.mjs ---------- */
    // UI only. Module lifecycle and configuration remain owned by the native host.

    function createControlCenterUI({ React, ctx, t, controllerFactory, windowState, phaseKey, formatNotice }) {
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


    /* ---------- lib/client/index.mjs ---------- */
    // Classic CJS factory source. Only React is supplied by the host module table.

    //

    // Laurel-Center · 客户端半边（Laurel 总控）

    //

    // 设置页里一条「Laurel总控」：列出五个子插件，每个一个开关 + 它的可调选项。

    // 五个模块的设置页**不再各自占一条设置页导航** —— 它们注册进本页声明的聚合插槽

    // `laurel-center.module`（见 lib/client-kit.js 的 registerSettingsSection），

    // 由这里渲染进对应的那张模块卡片。

    //

    // 聚合插槽是本页注册 `settings.section` 时**顺带声明**的。插槽系统里「声明即独占

    // 渲染权」：只有声明某个 key 的条目能渲染它 —— 所以这个声明只能在这里做，而且

    // 少一次声明，五个模块的设置内容就整块看不见（模块那边有兜底，见 kit 注释）。

    //

    // ── 2026-10-11 重写要点 ────────────────────────────────────────────────

    //   R2 不再走裸 HTTP。开关和状态全部走宿主**原生认证 RPC**：

    //        ctx.remote.pluginManager.listPlugins() / setPluginEnabled()

    //        ctx.remote.pluginInventory.list()

    //        ctx.remote.$on('plugin-manager/changed', …)

    //      旧版 `POST /laurel-center/toggle` 无凭据也能改真实开关，已随宿主半边一起删除。

    //   R3 分三层显示：**设置意图 / 宿主运行状态 / 本窗口加载状态**。宿主状态来自

    //      fiberPhase；本窗口拿不到公共诊断接口时显示「未确认」，不拿 graph 里有条目冒充已挂载。

    //   R9 每个组件实例自带 controller（不再共用一个模块级 bump）；请求带 generation 与

    //      AbortController，旧响应不覆盖新操作；不做无界轮询，靠宿主事件刷新；

    //      刷新失败会撤销过期可操作态；不成功就不追加「已生效」；文案走宿主 locale。

    //   R10 不再向宿主 set 一个并不存在的服务；宿主半边改用真正的 provide。

    //   R11（2026-10-12）原生 RPC 全部带等待上限。宿主 `setPluginEnabled` 要先拿 profile

    //      的写锁，而任何插件安装都握着同一把锁（pnpm 11.x 还有「装完不退出」的已知缺陷，

    //      宿主靠 10 分钟空闲看门狗兜底）→ 那段时间里开关一个回执都拿不到，界面只会一直

    //      busy，用户说「打开就卡死」。现在到点就停止等待并**如实**报「结果未确认」。

    //

    // ── 为什么是 React 而不是别的 ──────────────────────────────────────────

    // DSH 客户端模块的 platform seed 表里只有 React（以及静态 UI 库）。见

    // docs/PLUGIN-CONTRACT.md §3.2。


    const NS = 'laurel-center'

    /**

     * 本窗口客户端 bundle 的版本。由 `scripts/build-client.mjs` 在打包时从 package.json

     * 注入（构建期常量），不靠人手抄一份 —— 手抄的那份必然会漂（Loom 的前端版本就是这样

     * 卡在 0.8.5 的，见第二轮 F6）。

     */
    const BUNDLE_VERSION = typeof CLIENT_BUNDLE_VERSION === 'string' ? CLIENT_BUNDLE_VERSION : 'unknown'

    // ── 这份 inject 是「服务名」，不是「包名」，而且必须真的存在 ──────────────

    // 对应 package.json 里 dsh.client.inject 的**另一半**：

    //   • package.json  dsh.client.inject → 包名，只影响 boot graph 的加载先后

    //   • 本文件        exports.inject    → 服务名，是这一行 fiber 的**等待依赖**

    // 名单里只要有一个 ctx 里 provide 不出来的名字，这一行就永远停在 pending，

    // 整个 web boot 直接失败：`web boot: 1 entry did not activate`。

    //

    // 这五个都是官方客户端插件实际在用的服务名：

    //   slots / locale           —— dsh-client-locale、dsh-client-ui-slots

    //   remote                   —— dsh-api-remotes

    //   remote.pluginManager     —— dsh-plugin-manager（宿主的原生插件管理通道）

    //   remote.pluginInventory   —— dsh-host-plugin-inventory（fiber 相位）

    // 曾经误写过 `uiSettings`（那是**包名** dsh-client-ui-settings 的误抄），

    // 客户端上下文里没有这个服务名，于是整台前端起不来。别再犯。

    const inject = ['slots', 'locale', 'remote', 'remote.pluginManager', 'remote.pluginInventory']

    /**

     * 客户端那份模块清单 —— **不在这里手抄**。

     *

     * `SUB_PLUGINS` 来自 `lib/registry.js`（宿主注册表，唯一真相），由

     * `scripts/build-client.mjs` 在打包时把那个文件内联进本 bundle。

     * 这里曾经是第二份手写副本：加一个模块要改注册表、patch、locale，还有这里；

     * 漏了这处就是「界面少一行、开关点了没反应」，而且**不报任何错**。

     * id 与宿主 cordis.patch.yml 里的 patch id 是同一个值，同源才保证一致。

     */
    // settingsId 是「这个模块的设置页在聚合插槽里的条目 id」，同样来自注册表（唯一真相），

    // 客户端**不**另抄一份映射表。它跟 id / clientId 都不是一个值（laurel 的设置页 id 是

    // 'laurel-sample'），手抄必然漂；漂了的症状是「卡片能展开、里面却空的」，不报错。

    const PLUGINS = SUB_PLUGINS.map(({ id, entry, clientId, settingsId }) => ({ id, entry, clientId, settingsId }))

    /** 本页声明的聚合插槽：五个模块的设置页注册到这里，由本页渲染。 */
    const MODULE_SLOT = 'laurel-center.module'

    /** 宿主 fiber 相位 → 显示键。 */
    const PHASE_KEY = {
      pending: 'phase.pending',
      loading: 'phase.loading',
      active: 'phase.active',
      failed: 'phase.failed',
      unloading: 'phase.unloading',
    }

    /**

     * 原生 RPC 的返回是**结果封套** `{ ok, value }`（失败时是 `{ ok:false, error }`），

     * 不是裸值。官方客户端也是这么解包（见 dsh-client-ui-plugin-manager/lib/client.js）。

     * 这里统一解包，失败抛出带原文的 Error。

     */
    function unwrap(answer, what) {
      if (answer && answer.ok === true) return answer.value
      const detail = answer?.error?.message ?? answer?.error?.code ?? answer?.error
      throw new Error(`${what} failed${detail === undefined ? '' : ': ' + String(detail)}`)
    }

    // ── 原生 RPC 的等待上限（2026-10-12 实测的真事故）─────────────────────────

    // 宿主 `setPluginEnabled` 第一件事是拿 profile 的写锁：

    //     withFileLock(<profile>/package.json, { waitMs: 120000 })

    // 而**任何**插件安装（installBundle）整个 pnpm 运行都握着同一把锁。安装不结束，

    // 开关一个回执都拿不到。更糟的是 pnpm 11.x 有已知缺陷：打完 `Done in Xs` 之后

    // 进程**不退出**（上游 pnpm/pnpm#12297、#13617），宿主只能靠 10 分钟空闲看门狗

    // 兜底强杀 —— 这段窗口里同样是死等。

    //

    // 实测症状：点开关 → 界面一直 busy、一个字都不变 → 用户说「打开就卡死」。

    //

    // 所以每个原生 RPC 都带上限，并分两档：

    //   RPC_SLOW_MS    到了先报「可能正忙…仍在等待回执」（证明界面没死）

    //   RPC_TIMEOUT_MS 到了就**停止等待**，如实报「结果未确认」

    // 两档措辞必须一眼能分开：等待档是**推测**（「可能正忙」），

    // 终态档才是**确认**（「宿主正忙」+ 等了多久 + 未确认）。别把两者写成同一句。

    // 停止等待 ≠ 操作失败：宿主可能仍在执行，它忙完会发 plugin-manager/changed，

    // 面板自己会刷新。绝不把「没等到」写成「成功了」或「失败了」。

    const RPC_SLOW_MS = 6000
    const RPC_TIMEOUT_MS = 30000
    // 读状态走的是 listPlugins，**它是无锁的**（宿主源码实测），正常毫秒级返回；

    // 超过这个时间基本就说明宿主被安装/重载占住了，继续等没有意义。

    const REFRESH_TIMEOUT_MS = 10000

    /**

     * 给一个 promise 加等待上限。超时抛 `code === 'rpc-timeout'` 的 Error。

     * 超时后原 promise 仍会 settle，所以额外挂一个空 catch，免得留下未处理拒绝。

     */
    function withDeadline(promise, ms, what) {
      if (!(ms > 0)) return promise
      let timer = null
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${what} 超过 ${Math.round(ms / 1000)} 秒没有回执`)
          error.code = 'rpc-timeout'
          error.waitedMs = ms
          reject(error)
        }, ms)
      })
      promise.catch(() => { /* 已经不等它了，但拒绝事件仍会发生 */ })
      return Promise.race([promise, timeout]).finally(() => { if (timer !== null) clearTimeout(timer) })
    }

    function createController(ctx) {
      let state = {
        ready: false,
        busy: false,
        problem: null,       // { text, at }

        notice: null,        // { outcome, text, at }

        rows: [],
        confirmedAt: null,
        windowId: null,
      }
      const listeners = new Set()
      let generation = 0
      let inflight = null
      let disposed = false

      const emit = () => { for (const l of [...listeners]) l(state) }
      const set = (patch) => { state = { ...state, ...patch }; emit() }

      /** 把原生 listPlugins 的行映射成 UI 行。规则与宿主半边一致：只用 patchId 精确匹配。 */
      const mapRows = (nativeRows) => PLUGINS.map((spec) => {
        const matches = (nativeRows ?? []).filter((r) => r && r.patchId === spec.id)
        if (matches.length === 0) return { ...spec, state: 'missing' }
        if (matches.length > 1) return { ...spec, state: 'ambiguous', count: matches.length }
        const row = matches[0]
        if (row.moduleName !== spec.entry) return { ...spec, state: 'name-mismatch', actual: row.moduleName }
        if (row.readOnlyReason) return { ...spec, state: 'read-only', reason: row.readOnlyReason }
        return {
          ...spec,
          state: 'ready',
          entryId: row.entryId === undefined ? undefined : String(row.entryId),
          enabled: row.enabled === true,
          fiberPhase: row.fiberPhase ?? null,
        }
      })

      /**

       * 本窗口是否真的挂上了这个子插件的客户端半边。

       * 客户端**没有**公共的 modules/HMR 诊断服务时返回 'unknown' ——

       * 不把「宿主 graph 里有条目」当成「本窗口已加载」（R3）。

       */
      const windowState = (spec) => {
        try {
          const mods = ctx.get?.('modules')
          const graph = mods?.graph?.()
          if (graph && Array.isArray(graph.entries)) {
            return graph.entries.some((e) => e && e.id === spec.clientId) ? 'loaded' : 'not-loaded'
          }
        } catch { /* 拿不到就说不知道 */ }
        return 'unknown'
      }

      const refresh = async () => {
        if (disposed) return null
        const g = ++generation
        try { inflight?.abort?.() } catch { /* 旧请求取消失败不影响新请求 */ }
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        inflight = controller
        try {
          const rows = unwrap(
            await withDeadline(ctx.remote.pluginManager.listPlugins(), REFRESH_TIMEOUT_MS, 'listPlugins'),
            'listPlugins',
          )
          if (g !== generation || disposed) return null   // 旧响应不许覆盖新操作

          set({
            ready: true,
            problem: null,
            rows: mapRows(rows),
            confirmedAt: new Date().toISOString(),
            windowId: state.windowId ?? Math.random().toString(36).slice(2, 10),
          })
          return rows
        } catch (error) {
          if (g !== generation || disposed) return null
          // 刷新失败 → 撤销过期可操作态：ready 置回 false，开关不可点（R9）

          // kind 交给界面选文案（控制器不碰 locale）；超时要和「读失败」分开说。

          set({
            ready: false,
            problem: {
              kind: error?.code === 'rpc-timeout' ? 'host-busy' : 'read-failed',
              text: String(error?.message ?? error),
              at: new Date().toISOString(),
            },
          })
          return null
        } finally {
          if (inflight === controller) inflight = null
        }
      }

      const run = async (fn) => {
        if (state.busy || disposed) return null
        set({ busy: true, notice: null })
        // 界面没有进度条也没有转圈：等久了必须给一行字，否则看起来就是死了（实测反馈）。

        const slow = setTimeout(() => {
          if (!disposed) set({ notice: { pending: true, at: new Date().toISOString() } })
        }, RPC_SLOW_MS)
        try {
          return await fn()
        } catch (error) {
          set({ problem: { kind: 'operation-failed', text: String(error?.message ?? error), at: new Date().toISOString() } })
          return null
        } finally {
          clearTimeout(slow)
          if (!disposed) set({ busy: false })
        }
      }

      /**

       * 操作之后的回读。**失败不等于操作没发生** —— 回执已经收到了。

       * 返回 true 表示当前状态确认过；false 表示只能报「未确认」。

       */
      const refreshAfterOperation = async () => {
        const rows = await refresh()
        return rows !== null
      }

      /** 把共用解释器（lib/change-result.js，已内联）的结果裁成 UI 逐项形状。 */
      const pick = (interpreted) => ({
        outcome: interpreted.outcome,
        reason: interpreted.reason,
        saved: interpreted.saved,
        applied: interpreted.applied,
        application: interpreted.application,
        changed: interpreted.changed,
        restartHelps: interpreted.restartHelps,
        code: interpreted.code,
        diagnostic: interpreted.diagnostic,
      })

      /** 走原生通道开/关一项；返回逐项结果（不回读）。 */
      const callNative = async (spec, on) => {
        const row = state.rows.find((r) => r.id === spec.id)
        if (!row || row.state !== 'ready') {
          return { id: spec.id, outcome: 'failure', reason: 'unaddressable', saved: false, applied: false, application: 'unknown', changed: false, restartHelps: false, code: row?.state ?? 'missing', diagnostic: null }
        }
        let answer = null
        let transportError = null
        try {
          answer = unwrap(
            await withDeadline(ctx.remote.pluginManager.setPluginEnabled(row.entryId, on === true), RPC_TIMEOUT_MS, 'setPluginEnabled'),
            'setPluginEnabled',
          )
        } catch (error) {
          // 没等到回执 ≠ 操作失败：宿主可能仍在执行（安装/重载把它占住了）。

          // 如实报「未确认」，并带上 host-busy 让界面说清楚是在等宿主。

          if (error?.code === 'rpc-timeout') {
            return { id: spec.id, ...pick(interpretRpcTimeout({ waitedMs: error.waitedMs })) }
          }
          transportError = String(error?.message ?? error)
        }
        // 客户端读不到宿主磁盘上的 patch，所以不做「目标值回读」；

        // 拿不到确认时解释器会如实给 unknown，而不是冒充保存成功。

        return { id: spec.id, ...pick(interpretChangeResult(answer, { requested: on === true, transportError })) }
      }

      /**

       * 落一条 notice。**任何一项 partial/unknown 都不许折成 success**（F2 第 1 条）；

       * `hostBusy` 时 outcome 固定 unknown —— 连回执都没拿到，不能编结果。

       */
      const publish = (items, { hostBusy = false, readbackOk = false } = {}) => {
        const summary = summarizeChange(items)
        set({
          notice: {
            hostBusy,
            outcome: hostBusy || !readbackOk ? 'unknown' : summary.outcome,
            items,
            summary,
            readbackOk: hostBusy ? false : readbackOk,
            waitedSeconds: Math.round(RPC_TIMEOUT_MS / 1000),
            at: new Date().toISOString(),
          },
        })
      }

      return {
        getSnapshot: () => state,
        clearNotice: () => set({ notice: null }),
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
        start() {
          disposed = false
          void refresh()
          const disposers = []
          try {
            disposers.push(ctx.remote.$on('plugin-manager/changed', () => { void refresh() }))
            disposers.push(ctx.remote.$on('connection/reset', () => { void refresh() }))
          } catch { /* 事件不可用就只靠手动刷新 */ }
          return () => { for (const d of disposers) { try { d?.() } catch { /* ignore */ } } }
        },
        stop() {
          disposed = true
          generation += 1
          try { inflight?.abort?.() } catch { /* ignore */ }
          inflight = null
          listeners.clear()
        },
        refresh: () => run(refresh),
        toggle: (id, on) => run(async () => {
          const spec = PLUGINS.find((p) => p.id === id)
          const item = await callNative(spec ?? { id }, on)
          // 宿主被占住时不做回读：读回来也是旧值，还白白把等待时间翻倍。

          if (item.code === 'host-busy') return publish([item], { hostBusy: true })
          publish([item], { readbackOk: await refreshAfterOperation() })
        }),
        bulk: (on) => run(async () => {
          const items = []
          // 逐项串行调用原生能力：一个失败不影响其余，逐项原因照实回传

          for (const spec of PLUGINS) {
            const item = await callNative(spec, on)
            items.push(item)
            // 第一项就没拿到回执 → 宿主被占住了，后面每一项都会一样地等到超时。

            // 不把总等待翻 4 倍；剩下的如实标成「未执行」（既不是失败也不是成功）。

            if (item.code === 'host-busy') {
              for (const rest of PLUGINS.slice(items.length)) items.push({ id: rest.id, ...pick(interpretNotAttempted()) })
              break
            }
          }
          if (items.some((i) => i.code === 'host-busy')) return publish(items, { hostBusy: true })
          publish(items, { readbackOk: await refreshAfterOperation() })
        }),
      }
    }

    function apply(ctx) {
      const React = require('react')
      const h = React.createElement

      ctx.effect(() => ctx.locale.register(NS, {
        zh: {
          'section.title': 'Laurel 控制中心',
          'plugin.laurel': '通知',
          'plugin.claude-parchment': '主题与外观',
          'plugin.strata': '记忆与上下文',
          'plugin.warden': '内耗护栏',
          'plugin.loom': '可视化规划',
          'plugin.laurel.desc': '提醒提问、审批和完成事件。',
          'plugin.claude-parchment.desc': '调整会话配色、字体和排版。',
          'plugin.strata.desc': '管理记忆、上下文注入和跨工作区读取权限。',
          'plugin.warden.desc': '减少无效等待、重复返工与上下文堆积。',
          'plugin.loom.desc': '用流程图规划任务，审核后再执行。',
          'intro': '装载机把这五个插件连同源码装在一个项目里。每个模块的开关和它自己的选项都收在这一页；开关走宿主原生插件管理，改的是 profile 的用户层配置，重启后保持。',
          'options': '选项',
          'optionsHide': '收起选项',
          'optionsEmpty': '这个模块当前没有可调选项（可能还没开启）。',
          'summary': '设置开启 {on}/{total} · 运行确认 {running}/{total} · 需处理 {issues}',
          'enableAll': '一键全部打开',
          'disableAll': '一键全部关闭',
          'refresh': '刷新状态',
          'loading': '正在读取状态…',
          'off': '已关闭',
          'phase.pending': '等待依赖',
          'phase.loading': '启动中',
          'phase.active': '运行中',
          'phase.failed': '启动失败',
          'phase.unloading': '停止中',
          'phase.idle': '未运行',
          'win.loaded': '本窗口已加载',
          'win.notLoaded': '本窗口未加载',
          'win.unknown': '本窗口：未确认',
          'bundleVersion': '本窗口客户端 v{v}',
          'problemPrefix': '状态读取失败',
          'confirmed': '状态确认于 {time}',
          'notice.success': '已生效。',
          'notice.partial': '配置已保存，宿主尚未应用（重启后生效）。',
          'notice.partialHeader': '部分完成：',
          'notice.failure': '操作未成功：{detail}',
          'notice.unconfirmed': '操作回执已收到，当前状态未确认（读取失败）。',
          // 宿主把**任何非预期异常**都兜底成 operation-error，真实原因只放在 diagnostic 里

          // （上面那行已经把它带出来了）。这一条是「怎么办」—— 实测里它 100% 是同一个原因。

          'notice.operationErrorHint': '宿主在执行这一步时报错了（原因见上面括号）。如果这个模块是刚加进套件的，多半是它还没装进 profile —— 先完全退出 DSH（右下角托盘也退掉），在套件目录跑一次安装事务，再重启。',
          'code.packageMissing': '这个包还没装进 profile —— 先完全退出 DSH，在套件目录跑一次安装事务，再重启',
          'notice.busyWaiting': '宿主可能正忙（正在安装或重载插件），仍在等待回执…',
          'notice.hostBusy': '宿主正忙（可能正在安装或重载插件）：等了 {seconds} 秒仍没有回执，{names}的结果未确认。宿主忙完会自动刷新。',
          'notice.notAttempted': '（{names} 未执行）',
          'problem.hostBusy': '状态读取超时（宿主正忙）',
          'reason.hostBusy': '宿主正忙，结果未确认',
          'reason.notAttempted': '未执行（前一项就没拿到回执）',
          'notice.bulkPartial': '完成，但 {n} 项未成功：{ids}',
          'reason.restartRequired': '配置已保存，宿主尚未应用（重启后生效）',
          'reason.overridden': '配置已保存，但有更高优先级的覆盖压着它；重启不保证生效',
          'reason.reloadFailed': '配置已保存，但宿主重新加载失败，本次没有生效',
          'reason.applicationUnknown': '配置已保存，但宿主的应用结果无法确认',
          'reason.unconfirmed': '结果无法确认',
          'reason.writeFailed': '没有保存成功',
          'reason.cancelled': '被取消',
          'reason.unaddressable': '在插件树里定位不到',
          'missingHint': '{names} 当前在插件树里定位不到（patch 行缺失或重复），开关不会生效。',
          'issue': '需处理',
        },
        en: {
          'section.title': 'Laurel control center',
          'plugin.laurel': 'Notifications',
          'plugin.claude-parchment': 'Appearance',
          'plugin.strata': 'Memory and context',
          'plugin.warden': 'Friction guard',
          'plugin.loom': 'Visual planning mode',
          'plugin.laurel.desc': 'Get reminders for questions, approvals, and completed work.',
          'plugin.claude-parchment.desc': 'Adjust conversation colors, fonts, and layout.',
          'plugin.strata.desc': 'Manage memory, context injection, and cross-workspace access.',
          'plugin.warden.desc': 'Subagent wait caps, results to files, rework nudges, context watermark, shared-directory locks.',
          'plugin.loom.desc': 'Plan tasks on a diagram and review them before execution.',
          'intro': 'The launcher carries these five plugins (sources included) in one project. Each module\'s switch and its own options live on this page; switches go through the host plugin manager and write the profile user layer, so they survive restarts.',
          'options': 'Options',
          'optionsHide': 'Hide options',
          'optionsEmpty': 'This module has no options right now (it may be off).',
          'summary': '{on}/{total} enabled · {running}/{total} running · {issues} need attention',
          'enableAll': 'Enable all',
          'disableAll': 'Disable all',
          'refresh': 'Refresh',
          'loading': 'Loading…',
          'off': 'off',
          'phase.pending': 'waiting for deps',
          'phase.loading': 'starting',
          'phase.active': 'running',
          'phase.failed': 'failed',
          'phase.unloading': 'stopping',
          'phase.idle': 'not running',
          'win.loaded': 'loaded in this window',
          'win.notLoaded': 'not loaded in this window',
          'win.unknown': 'this window: unconfirmed',
          'bundleVersion': 'client bundle v{v}',
          'problemPrefix': 'Cannot read status',
          'confirmed': 'Confirmed at {time}',
          'notice.success': 'Applied.',
          'notice.partial': 'Saved; the host has not applied it yet (takes effect after restart).',
          'notice.partialHeader': 'Partly done:',
          'notice.failure': 'Did not succeed: {detail}',
          'notice.unconfirmed': 'The operation was acknowledged, but the current state is unconfirmed (readback failed).',
          'notice.operationErrorHint': 'The host errored while running this step (reason in the parentheses above). If this module was just added to the suite, it is most likely not installed in the profile yet — quit DSH completely (including the tray icon), run the suite install transaction in the suite directory, then restart.',
          'code.packageMissing': 'this package is not installed in the profile — quit DSH completely, run the suite install transaction, then restart',
          'notice.busyWaiting': 'The host may be busy (installing or reloading a plugin); still waiting…',
          'notice.hostBusy': 'The host is busy (installing or reloading a plugin): no answer after {seconds}s, so the result for {names} is unconfirmed. The panel refreshes once it is done.',
          'notice.notAttempted': '({names} not attempted)',
          'problem.hostBusy': 'Timed out reading status (the host is busy)',
          'reason.hostBusy': 'the host is busy, so the result is unconfirmed',
          'reason.notAttempted': 'not attempted (the previous item got no answer)',
          'notice.bulkPartial': 'Done, but {n} item(s) failed: {ids}',
          'reason.restartRequired': 'saved; the host has not applied it yet (takes effect after restart)',
          'reason.overridden': 'saved, but a higher-priority override is in force; a restart does not guarantee it',
          'reason.reloadFailed': 'saved, but the host reload failed, so it is not in effect',
          'reason.applicationUnknown': 'saved, but the host\'s application result cannot be confirmed',
          'reason.unconfirmed': 'the result cannot be confirmed',
          'reason.writeFailed': 'not saved',
          'reason.cancelled': 'cancelled',
          'reason.unaddressable': 'not locatable in the plugin tree',
          'missingHint': '{names} cannot be located in the plugin tree (missing or duplicated patch rows); toggling will not work.',
          'issue': 'needs attention',
        },
      }), NS + ': dictionaries')

      const t = ctx.locale.bind(NS)

      const views = createControlCenterUI({
        React, ctx, t,
        controllerFactory: () => createController(ctx),
        windowState: windowStateSafe,
        phaseKey: row => PHASE_KEY[row.fiberPhase] ?? 'phase.idle',
        formatNotice,
      })
      ctx.effect(() => {
        if (typeof document === 'undefined') return
        const style = document.createElement('style')
        style.dataset.laurelControlCenterStyle = ''
        style.textContent = CONTROL_CENTER_CSS
        document.head.appendChild(style)
        return () => { views.dispose(); style.remove() }
      }, 'laurel-center.styles')
      // Only this overlay owns the aggregation slot. Declaring it twice is rejected

      // by SlotCore. The slot remains declared even while the panel is closed.

      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'laurel-center-window', order: 85,
        children: { [MODULE_SLOT]: { kind: 'list', scope: 'root' } },
      }, views.Panel)), 'laurel-center.window')
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action', id: 'laurel-center-launcher', order: 25,
      }, views.Launcher)), 'laurel-center.launcher')
      registerSettingsSection(ctx, {
        id: 'laurel-center', order: 15, label: () => t('section.title'),
        component: views.SettingsLauncher, slots: ctx.slots, slot: 'settings.section',
      })
    }

    /** 本窗口加载状态：拿不到客户端诊断接口就返回 'unknown'，不冒充已加载。 */
    function windowStateSafe(ctx, spec) {
      try {
        const mods = ctx.get?.('modules')
        const graph = mods?.graph?.()
        if (graph && Array.isArray(graph.entries)) {
          return graph.entries.some((e) => e && e.id === spec.clientId) ? 'loaded' : 'not-loaded'
        }
      } catch { /* ignore */ }
      return 'unknown'
    }


    module.exports.apply = apply
    if (typeof inject !== 'undefined') module.exports.inject = inject

    return module.exports
  },
})
