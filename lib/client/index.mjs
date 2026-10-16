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

export function apply(ctx) {
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
