/**
 * dsh-warden · 宿主半边入口
 *
 * ── 这个插件做什么 ─────────────────────────────────────────────────────
 * 给 agent 装一副「缰绳」。它治的不是"模型不聪明"，而是**内耗**：
 *
 *   1. 子代理等待没有上限        → 干等几小时
 *   2. 子代理互相直接对话        → 读数互相污染，谁也说不清哪个数是谁测的
 *   3. 同一个文件改 31 次        → 返工吃掉大部分 token
 *   4. 上下文只涨不降            → 大输出直接进上下文，压缩阈值一次都没触发
 *   5. 几个子代理共用一个部署目录 → 「读数无法归属」
 *   6. 改文件匹配失败就原地重试  → 8 次 `old_string was not found`
 *   7. 护栏自己坏了却显示"已启用" → 用户无从判断到底生效没有
 *
 * ── 边界：warden 只做这些，不做另一套编排 ──────────────────────────────
 *   warden          观察 usage/进展、资源执行权、验收收据、可见状态、有理由的局部阻断
 *   官方 Basic+pruner  **唯一**的历史压缩 owner（warden 不裁历史）
 *   Strata          跨会话记忆召回（与 warden 的 evidence 台账不是一回事）
 *   Loom            计划、阶段依赖与批准（warden 的阶段记录只补"验收齐不齐"）
 *   Laurel          通知与呈现
 *
 * 等待上限与水位提醒在套件里有两个模块都实现了（warden 与 strata）。
 * 谁执行由 `core/governance.js` 的**治理声明**决定，不看"目录在不在"。
 *
 * ── 五条纪律（每条都是踩过的）──────────────────────────────────────────
 *   1. **顶层 `inject` 留空**。cordis 的 Context 是受控代理，没写进 `inject`
 *      的服务用 `ctx.X` 访问会直接抛；用 `ctx.get(name)` + try/catch 更安全，
 *      非 Web 组合（CLI / 无头）也才能激活。
 *   2. **Web 路由走 `ctx.inject` + `effect`**，让 cordis 管等待、重建与清理。
 *   3. **家目录只认 `DSH_HOME`**，不从 profile 目录往上推（会推到错误位置）。
 *   4. **所有 IO 与钩子都吞异常，但降级必须可见**。护栏坏掉不许连带影响宿主里
 *      任何别的东西 —— 它在**每一次工具调用**的路径上；同时它**不许伪造
 *      自己的操作成功**，所以每次吞异常都要写进能力台账（R7）。
 *   5. **关掉总开关 = 全部钩子卸载 + 治理声明释放**，不留半个还在跑的监听器，
 *      也不留一条让别人误以为"warden 还在管"的声明。
 */

import {
  DEFAULT_CONFIG, PACKAGE_NAME, VERSION, normalizeConfig, pickKnown, pluginPaths, resolveDshHome,
} from './core/config.js'
import { Capabilities } from './core/capability.js'
import { systemClock } from './core/clock.js'
import { GovernanceClaim } from './core/governance.js'
import { ProgressWatch, StageLedger } from './core/progress.js'
import { Counters, EvidenceLedger, LockStore, appendEvent } from './core/store.js'
import { loadSettings, saveSettings, verifyPersisted } from './core/settings.js'
import { UsageLedger, installUsageSampling } from './host/usage.js'
import { installWaitCap } from './host/wait.js'
import { installGuard } from './host/guard.js'
import { installAfter } from './host/after.js'
import { installInjection } from './host/inject.js'
import { createTools } from './host/tools.js'
import { createHandler } from './host/http.js'

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
    try { fn('[warden]', ...args) } catch { /* 日志不许影响主流程 */ }
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
 * @param {{clock?: any}} [options] 测试用：注入时钟
 */
export function apply(ctx, config = {}, options = {}) {
  const home = resolveDshHome()
  const fromPatch = normalizeConfig(config, DEFAULT_CONFIG)
  const log = makeLogger(fromPatch.logLevel)
  const clock = options.clock ?? systemClock()

  const onEvent = (event) => {
    try { appendEvent(event, home, clock) } catch { /* 记账失败无所谓 */ }
  }

  /** 能力台账：supported / mounted / observed / degraded / standby（R7）。 */
  const capabilities = new Capabilities({ log, onEvent, clock })
  for (const [name, label] of Object.entries({
    waitCap: '子代理等待上限',
    sharedLock: '共享资源执行权',
    lockCoverageGap: '护栏覆盖不到的写入（明确记录）',
    usageSampling: '用量采样（session/event）',
    contextPressure: '当前上下文压力',
    waterLevelNudge: '水位提醒',
    rulesSection: '系统提示词规则段',
    rulesFallback: '规则消息注入兜底',
    archiveToolResults: '大输出归档与有界呈现',
    historyPruning: '历史压缩（warden 不做）',
    progressWatch: '无进展识别',
    capabilityPrecheck: '工具失败分型',
    evidenceLedger: '读数指纹台账',
    stageContract: '最小阶段合同',
    settingsPersistence: '设置持久化',
    httpRoutes: '设置页数据面',
    clientUi: '设置界面',
  })) capabilities.define(name, label)

  /** 生效配置：settings.json（设置页写的）盖在 patch 默认值上。 */
  let current = (() => {
    try {
      const stored = loadSettings(home)
      return stored.config ? normalizeConfig(stored.config, fromPatch) : fromPatch
    } catch {
      return fromPatch
    }
  })()

  /** 持久化状态。界面必须能区分"内存已生效"与"已落盘"（R7）。 */
  let persistence = { persisted: null, reason: '尚未写过设置', at: null }

  const getConfig = () => ({ ...current })

  /**
   * 改配置。
   *
   * @returns {{config: object, persisted: boolean|null, reason: string}}
   *   `persisted:false` 时内存里已经生效但**重启会丢**，界面必须照实说。
   */
  const setConfig = (patch) => {
    const candidate = normalizeConfig(patch, current)
    const saved = saveSettings(candidate, home, Object.keys(DEFAULT_CONFIG))
    if (saved.ok) {
      persistence = { persisted: true, reason: '已落盘', at: new Date(clock.now()).toISOString(), file: saved.file }
      capabilities.markObserved('settingsPersistence', `${saved.bytes} 字节 @${saved.file}`)
    } else {
      persistence = { persisted: false, reason: saved.reason, at: null }
      capabilities.markDegraded('settingsPersistence', `写盘失败：${saved.reason}`)
      log.warn(`配置写盘失败（内存里已生效，但重启会丢）：${saved.reason}`)
      onEvent({ kind: 'settings-save-failed', detail: saved.reason })
    }
    current = candidate
    // 总开关是热生效的：装上/卸下钩子，而不是等重启。
    reconcileHooks()
    return { config: getConfig(), persisted: persistence.persisted, reason: persistence.reason }
  }

  /* ---------------- 数据层 ---------------- */
  const locks = new LockStore(home, { clock, log, onEvent, capabilities })
  const evidence = new EvidenceLedger(home, { clock, log, onEvent, capabilities })
  const counters = new Counters()
  const progress = new ProgressWatch({ clock, capabilities, onEvent, log })
  const stages = new StageLedger(home, { clock, log, capabilities, onEvent })
  const usageLedger = new UsageLedger({ clock })
  const governance = new GovernanceClaim({
    home,
    moduleId: PACKAGE_NAME,
    moduleVersion: VERSION,
    clock,
    log,
    onEvent,
  })
  const toolsRegistry = () => requireService(ctx, 'tools')

  const deps = {
    home,
    config: getConfig,
    locks,
    evidence,
    counters,
    progress,
    stages,
    ledger: usageLedger,
    governance,
    capabilities,
    clock,
    tools: toolsRegistry,
    log,
    onEvent,
  }

  /* ---------------- 钩子链 ---------------- */
  /** @type {Array<{name: string, off: () => void, stats?: object}>} */
  const mounted = []
  let heartbeatStop = null

  /**
   * 这项治理能力该不该由 warden 执行。
   *
   * 判据是**一条活着的治理声明**，不是"strata 的目录在不在"（K1 / R9-A）。
   * 抢不到就明确标 standby，界面上会说清"由 dsh-strata 执行"。
   */
  function claimGovernance(capability) {
    const result = governance.claim(capability)
    if (result.acquired) return { run: true, reason: result.reason }
    capabilities.markStandby(capability, result.owner, result.reason)
    return { run: false, reason: result.reason, owner: result.owner }
  }

  function mountHooks() {
    for (const [name, install] of [
      ['waitCap', () => {
        const claim = claimGovernance('waitCap')
        if (!claim.run) {
          log.info(`等待上限由 ${claim.owner ?? '其他模块'} 执行，warden 待命（${claim.reason}）`)
          return null
        }
        return installWaitCap(ctx, deps)
      }],
      ['sharedLock', () => installGuard(ctx, deps)],
      ['after', () => installAfter(ctx, deps)],
      ['usageSampling', () => installUsageSampling(ctx, deps)],
      ['inject', () => {
        // 水位提醒也走治理仲裁；规则 section 不仲裁（它不与 strata 重叠）。
        const claim = claimGovernance('waterLevelNudge')
        const off = installInjection(ctx, deps)
        if (!claim.run && off) {
          // section 照常挂，但水位提醒要在配置层关掉，避免两个模块都提醒。
          off.setWaterLevelOwned?.(false)
          log.info(`水位提醒由 ${claim.owner ?? '其他模块'} 执行，warden 待命（${claim.reason}）`)
        }
        return off
      }],
    ]) {
      try {
        const off = install()
        if (typeof off === 'function') mounted.push({ name, off, stats: off.stats })
      } catch (error) {
        capabilities.markDegraded(name, `挂载异常：${error?.message ?? error}`)
        log.warn(`${name} 挂载失败：${error?.message ?? error}`)
      }
    }
    heartbeatStop = governance.startHeartbeat()
    return mounted.length
  }

  function unmountHooks() {
    while (mounted.length > 0) {
      const entry = mounted.pop()
      try { entry.off?.() } catch { /* 清理失败无所谓 */ }
    }
    heartbeatStop?.()
    heartbeatStop = null
    // 纪律 5：停用时要释放治理声明，否则别的模块会一直待命。
    governance.releaseAll()
  }

  /** 按总开关决定钩子在不在。改配置时会被调一次。 */
  function reconcileHooks() {
    const wanted = current.enabled !== false
    if (wanted && mounted.length === 0) {
      const count = mountHooks()
      log.info(`护栏已启用（挂上 ${count} 条钩子链）`)
    } else if (wanted && mounted.length > 0) {
      // 已经在跑：不重复挂载（R7 要求"总开关/重载不重复挂载"）。
      return
    } else if (!wanted && mounted.length > 0) {
      unmountHooks()
      log.info('护栏已停用（钩子已全部卸载，治理声明已释放）')
    }
  }

  reconcileHooks()

  /* ---------------- 工具 ---------------- */
  let toolsRegistered = 0
  const registerTools = (toolCtx) => {
    const tools = requireService(toolCtx, 'tools')
    if (!tools?.register) {
      capabilities.markUnsupported('clientUi', '取不到 tools 服务，无法注册模型侧工具')
      return
    }
    let registered = 0
    for (const definition of createTools(deps)) {
      try {
        tools.register(definition)
        registered++
      } catch (error) {
        // 单个工具注册失败不该拖垮其余工具，但要报出来。
        capabilities.markDegraded('clientUi', `工具 ${definition.name} 注册失败：${error?.message ?? error}`)
        log.warn(`工具 ${definition.name} 注册失败：${error?.message ?? error}`)
      }
    }
    toolsRegistered = registered
    capabilities.markSupported('clientUi', `已注册 ${registered} 个模型侧工具`)
    log.info(`已注册 ${registered} 个工具`)
  }

  /* ---------------- HTTP ---------------- */
  const mountRoutes = (routeCtx) => {
    const webServer = requireService(routeCtx, 'webServer')
    if (!webServer?.register) {
      capabilities.markUnsupported('httpRoutes', '宿主没有 webServer 服务（非 Web 组合）')
      return
    }
    const disposers = []
    try {
      disposers.push(webServer.register({
        kind: 'prefix',
        path: '/warden',
        handler: createHandler({
          home,
          getConfig,
          setConfig,
          getPersistence: () => ({ ...persistence }),
          verifyPersisted: () => verifyPersisted(current, home, Object.keys(DEFAULT_CONFIG)),
          locks,
          evidence,
          counters,
          progress,
          stages,
          ledger: usageLedger,
          governance,
          capabilities,
          clock,
          stats: () => mounted.map((entry) => ({ name: entry.name, stats: { ...(entry.stats ?? {}) } })),
          log,
        }),
      }))
      capabilities.markMounted('httpRoutes', disposers[disposers.length - 1], '/warden')
    } catch (error) {
      capabilities.markDegraded('httpRoutes', `路由注册失败：${error?.message ?? error}`)
      log.warn(`HTTP 路由挂载失败（设置页数据面不可用）：${error?.message ?? error}`)
    }
    return routeCtx.effect(() => () => {
      for (const dispose of disposers) { try { dispose?.() } catch { /* 清理失败无所谓 */ } }
      capabilities.markUnmounted('httpRoutes', '已卸载')
    }, 'warden.routes')
  }

  try {
    ctx.inject(['tools'], registerTools)
    ctx.inject(['webServer'], mountRoutes)
  } catch (error) {
    capabilities.markDegraded('httpRoutes', `服务订阅失败：${error?.message ?? error}`)
    log.warn(`服务订阅失败：${error?.message ?? error}`)
  }

  const paths = pluginPaths(home)
  const lockCount = Object.keys(locks.list(clock.now())).length
  const evidenceStats = evidence.stats()
  const degraded = capabilities.snapshot().filter((c) => c.state === 'degraded' || c.state === 'unsupported')
  appendEvent({
    kind: 'ready',
    detail: `host ${VERSION} · 档位=${current.preset} · 钩子=${mounted.length}`
      + ` · 锁=${lockCount} · 读数=${evidenceStats.total}`
      + ` · 降级=${degraded.length}${degraded.length > 0 ? `（${degraded.map((c) => c.name).join('、')}）` : ''}`,
  }, home, clock)

  log.info(`已挂载：档位=${current.preset}（${current.enabled ? '启用' : '停用'}）`
    + ` 等待上限=${current.waitCapMs > 0 ? `${current.waitCapMs}ms` : '不干预'}`
    + ` 归档=${current.archiveToolResults ? `≥${current.archiveThresholdChars}字符` : '关'}`
    + ` 星型=${current.starTopology} 无进展识别=${current.progressWatch}(${current.progressMode})`
    + ` 水位=${current.waterLevelNudge} 共享锁=${current.lockGuard} 读数台账=${current.evidenceLedger}`
    + ` 配置=${paths.settings}`)
  if (degraded.length > 0) {
    log.warn(`有 ${degraded.length} 项能力降级/不支持：${capabilities.summaryLine()}`)
  }

  return {
    /** 给宿主/测试看的只读快照。 */
    status: () => ({
      ok: true,
      data: {
        package: PACKAGE_NAME,
        version: VERSION,
        home,
        config: getConfig(),
        persistence: { ...persistence },
        capabilities: capabilities.snapshot(),
        governance: governance.snapshot(),
        locks: Object.values(locks.list(clock.now())),
        lockStats: locks.snapshot(),
        evidence: evidence.stats(),
        stages: stages.stats(),
        progress: progress.snapshot(),
        usage: usageLedger.list(),
        stats: mounted.map((entry) => ({ name: entry.name, stats: { ...(entry.stats ?? {}) } })),
        toolsRegistered,
        paths,
        defaults: pickKnown(DEFAULT_CONFIG),
      },
    }),
    /** 测试与隔离验收用的内部句柄。 */
    internals: {
      capabilities,
      governance,
      locks,
      evidence,
      counters,
      progress,
      stages,
      ledger: usageLedger,
      clock,
      setConfig,
      reconcileHooks,
    },
    dispose: () => {
      unmountHooks()
    },
  }
}
