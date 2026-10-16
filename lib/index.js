/**
 * Laurel-Center · 宿主半边
 *
 * ── 这个插件做什么 ─────────────────────────────────────────────────────
 * 它是个**装载机**：一个 DSH 插件，管着另外四个插件的开关。
 *
 *   packages/laurel               Laurel 通知
 *   packages/dsh-claude-parchment 羊皮纸主题
 *   packages/dsh-strata           跨会话记忆
 *   packages/dsh-loom             Loom 工作台
 *
 * 五个子插件的源码就**复制在本包目录里**，不是引用外部路径 ——
 * 整个 Laurel-Center 是自包含的一个项目，删掉原来那四个目录也照跑。
 *
 * 子插件自己被 cordis 正常加载（`cordis.patch.yml` 里为每个子插件插了一行）。
 * 本插件**不再重复挂载它们**，也不自己改 loader、不自己写配置。
 *
 * ── 开关到底谁说了算（2026-10-11 修复）──────────────────────────────────
 * 唯一真相是 **profile 的 `cordis.patch.yml`（用户层）**。写它的入口只有一个：
 * 宿主的 `pluginManager.setPluginEnabled(entryId, enabled)`。Center 只负责
 *   · 把四个稳定 id 映射到宿主 loader 行的原生身份（lib/host.js，含冲突拒绝）
 *   · 记录流水（events.log），供事后核对
 *   · 首次运行新版时，把旧 state.json 里「用户曾经点过开」的意图**迁移一次**
 * 它不再在每次开机把 state.json 同步回 loader —— 那条路会盖掉用户层。
 *
 * ── 为什么没有 HTTP 控制接口（2026-10-11 修复）──────────────────────────
 * 宿主 WebServer 会把任意注册路由分发给调用者，认证只封在原生 `/api` 通道里；
 * 注册 prefix 不继承认证。旧版裸 `POST /laurel-center/toggle` 因此能被无凭据请求
 * 改变真实开关。现在前端走 `remote.pluginManager`（原生认证 RPC），
 * 宿主半边不暴露任何写端点，也不再注册 prefix。
 *
 * ── 三条纪律（跟套件里其它插件一致）──────────────────────────────────────
 *   1. 顶层 `inject` 留空：非 Web 组合（CLI / 无头）也能激活。
 *   2. 家目录只认 `DSH_HOME`（见 store.js）。
 *   3. 所有 IO 都吞异常：装载机坏掉，不许连带影响宿主里的任何别的东西。
 */

import { PACKAGE_NAME, VERSION } from './config.js'
import { SUB_PLUGINS } from './registry.js'
import {
  getService, listNative, readOverrides, setNative, setNativeAll, profileIdentityOf,
} from './host.js'
import {
  appendEvent, centerPaths, describe, isMigrationCompleted, loadMigrations, loadState, recordMigration,
} from './store.js'
import { completionState, itemCompletion, planMigration, REASONS } from './migrate.js'
import { envelope, newOperationId } from './result.js'
import { makeIdentity } from './identity.js'

export { PACKAGE_NAME, VERSION }

/** cordis 的 Context 是受控代理：没写进 inject 的服务用 `ctx.X` 访问会直接抛。这里故意一个都不要。 */
export const inject = []

/** 三级日志。 */
function makeLogger(level = 'info') {
  const rank = { debug: 10, info: 20, warn: 30, error: 40 }
  const min = rank[level] ?? 20
  const make = (name, fn) => (...args) => {
    if ((rank[name] ?? 20) < min) return
    try { fn('[laurel-center]', ...args) } catch { /* 日志不许影响主流程 */ }
  }
  return {
    debug: make('debug', console.debug.bind(console)),
    info: make('info', console.info.bind(console)),
    warn: make('warn', console.warn.bind(console)),
    error: make('error', console.error.bind(console)),
  }
}

/** 没有宿主生命周期信号时的**有限**重试上限（不是靠延时猜，见 scheduleMigration）。 */
export const MAX_MIGRATION_ATTEMPTS = 4

/**
 * 一次性迁移：把旧 state.json 里「用户点过开」的意图写进用户层。
 *
 * 只读旧 state（不改它）；完成状态按 profile 记到 migrations.json。
 * 判不出归属 / 用户层读不了 / 原生没就绪 → 不写，也不打完成标记。
 *
 * @param {object} ctx
 * @param {object} paths
 * @param {object} log
 * @param {() => boolean} disposed 插件已卸载时返回 true，此后不得再写
 * @param {number} [attempt] 第几次尝试（0 起）
 */
export async function runMigration(ctx, paths, log, disposed = () => false, attempt = 0) {
  const saved = loadState(paths)
  const result = { attempt, savedUpdatedAt: saved.updatedAt, reason: null, items: [], writes: [], outcomes: {}, recorded: false, recordFailure: null, completed: false }

  if (saved.updatedAt === null || saved.updatedAt === undefined) {
    result.reason = REASONS.noSavedState
    return result
  }

  const migrations = loadMigrations(paths)
  const attribution = profileIdentityOf(ctx)
  // 只有 **completed** 才算「已迁移」；pending 记录不终结（第三轮 G1）。
  const alreadyDone = migrations.readOk && attribution.ok && isMigrationCompleted(migrations.profiles, attribution.key)
  if (alreadyDone) {
    result.reason = REASONS.alreadyMigrated
    result.profileKey = attribution.key
    return result
  }
  if (!migrations.readOk) log.warn('迁移完成记录读不了（%s），本次不打完成标记', migrations.reason)

  const read = readOverrides(ctx)
  const native = await listNative(ctx)
  const plan = planMigration(saved, native, {
    overrides: read.overrides,
    userLayerOk: read.ok,
    attribution,
    completed: false,
  })
  result.reason = plan.reason
  result.items = plan.items
  result.writes = plan.writes
  result.terminal = plan.terminal
  result.pending = plan.pending
  result.profileKey = attribution.key ?? null
  result.userLayer = { ok: read.ok, sources: read.sources }

  // 逐条写。卸载后立即停手 —— 不许在插件已经不在的时候继续改用户层。
  for (const id of plan.writes) {
    if (disposed()) {
      log.warn('迁移中止：插件已卸载，%s 不再写入', id)
      result.aborted = true
      break
    }
    const outcome = await setNative(ctx, id, true)
    result.outcomes[id] = { outcome: outcome.outcome, reason: outcome.reason, code: outcome.code, saved: outcome.saved }
  }

  const written = Object.keys(result.outcomes)
  const succeeded = written.filter((id) => itemCompletion(plan.items.find((i) => i.id === id)?.action, result.outcomes[id]))
  const failed = written.filter((id) => !succeeded.includes(id))

  if (succeeded.length > 0) {
    log.info('旧 state 迁移：%s', succeeded.join(', '))
    appendEvent({ kind: 'migrate', at: 'boot', attempt, migrated: succeeded, profile: attribution.key ?? null }, paths)
  }
  if (failed.length > 0) log.warn('迁移未完成：%o', failed.map((id) => ({ id, ...result.outcomes[id] })))

  // ── 完成记录与失败记录**分开**（G1）──────────────────────────────────
  // 只有每一项都确知完成（保存到目标 / 用户明确表态 / 无需处理）才写 completed；
  // 否则只写 pending —— 它**不**是终结标记，下次启动会重新核对用户层再处理。
  const state = completionState(plan, result.outcomes)
  result.completion = state
  if (state.noop) return result

  const base = {
    savedUpdatedAt: saved.updatedAt,
    userLayerSources: read.sources,
    items: plan.items,
    outcomes: result.outcomes,
  }
  if (state.complete) {
    const record = recordMigration(attribution.key, {
      ...base,
      completed: { at: new Date().toISOString(), reason: plan.reason },
      pending: null,
    }, paths)
    result.recorded = record.ok
    result.completed = record.ok
    if (!record.ok) {
      result.recordFailure = record.reason
      log.warn('迁移完成标记写入失败（%s），下次启动会重试', record.reason)
    } else {
      log.info('旧 state 迁移完成（profile=%s）', attribution.key)
    }
  } else {
    const previousAttempts = migrations.profiles?.[attribution.key]?.pending?.attempts ?? 0
    const record = recordMigration(attribution.key, {
      ...base,
      pending: {
        at: new Date().toISOString(),
        reason: plan.reason,
        attempts: previousAttempts + 1,
        incomplete: state.incomplete,
      },
    }, paths)
    result.recorded = false
    if (!record.ok) {
      result.recordFailure = record.reason
      log.warn('迁移进度记录写入失败（%s）', record.reason)
    }
    log.info('迁移本轮未完成（reason=%s incomplete=%o），下次启动重新核对用户层再处理', plan.reason, state.incomplete)
  }
  return result
}

/**
 * 挑一个「原生真的可用了」的时机跑迁移。
 *
 * 主路径是宿主自己的生命周期：`appReady.onReady()` —— 它在 loader 树挂载完成后
 * 才 commit（见 asar 里 `dsh/lib/profile-boot` 的 `createAppReady`：**已 commit 后
 * 再订阅会立刻回调**，所以插件被 HMR 重挂后照样能跑）。
 * 没有这个服务时退到**有限**重试，且次数很小：宁可留给下次启动重试，
 * 也不要靠不断加长延时去猜。
 *
 * @param {{ last: object, attempts?: object[] }} sink 每次尝试都留档，供只读诊断
 * @returns {() => void} 取消函数
 */
export function scheduleMigration(ctx, paths, log, disposed, sink = { last: { reason: 'not-run' }, attempts: [] }) {
  let cancelled = false
  let timer = null
  const attempt = async (round) => {
    if (cancelled || disposed()) return
    try {
      const result = await runMigration(ctx, paths, log, disposed, round)
      sink.last = result
      if (Array.isArray(sink.attempts)) sink.attempts.push({ round, reason: result.reason, aborted: result.aborted === true, recorded: result.recorded, completed: result.completed === true, outcomes: result.outcomes })
      // 只在「原生还没就绪」时在同一次启动里重试；**写入失败不在这里重试**
      // （不无限重试），留给下次启动或显式重试 —— 那时会重新核对用户层。
      if (!cancelled && !result.aborted && (result.pending?.length ?? 0) > 0 && round + 1 < MAX_MIGRATION_ATTEMPTS) {
        timer = setTimeout(() => { void attempt(round + 1) }, 300 * (round + 1))
      }
    } catch (error) {
      log.warn('迁移异常：%o', error)
      sink.last = { attempt: round, error: String(error?.message ?? error) }
      if (Array.isArray(sink.attempts)) sink.attempts.push({ round, error: String(error?.message ?? error) })
    }
  }

  const ready = getService(ctx, 'appReady')
  if (ready && typeof ready.onReady === 'function') {
    let cancelReady = null
    try {
      cancelReady = ready.onReady(() => { void attempt(0) })
    } catch (error) {
      log.warn('订阅 appReady 失败，退回有限重试：%o', error)
      void attempt(0)
    }
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
      try { cancelReady?.() } catch { /* ignore */ }
    }
  }

  log.debug('宿主没有 appReady，用有限重试触发迁移')
  void attempt(0)
  return () => {
    cancelled = true
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * @param {any} ctx cordis 上下文
 * @param {Record<string, unknown>} config patch 里那份 config（仅用于 logLevel）
 */
export function apply(ctx, config = {}) {
  const paths = centerPaths()
  const log = makeLogger(typeof config.logLevel === 'string' ? config.logLevel : 'info')
  const identity = makeIdentity()
  let disposed = false

  // 卸载后异步工作不得继续写入：这是迁移的唯一写权限开关。
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => { disposed = true }, 'laurel-center: dispose guard')
    }
  } catch { /* effect 不可用就靠 cancelled 标志 */ }

  // ── 启动时只做一次性迁移（异步，不挡住激活）───────────────────────────
  const migrationSink = { last: { reason: 'not-run' }, attempts: [] }
  let cancelMigration = () => {}
  try {
    cancelMigration = scheduleMigration(ctx, paths, log, () => disposed, migrationSink)
  } catch (error) {
    log.warn('调度迁移失败：%o', error)
  }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => () => cancelMigration(), 'laurel-center: migration schedule')
  } catch { /* ignore */ }

  // ── 流水：宿主自己的变更事件就是最好的审计来源 ─────────────────────────
  try {
    ctx.on?.('plugin-manager/changed', (payload) => {
      appendEvent({ kind: 'host-change', reason: payload?.reason ?? null }, paths)
    })
  } catch { /* 事件订阅不可用就算了，流水不是核心功能 */ }

  // ── 宿主侧的只读诊断（给测试和其它插件用；前端走原生 RPC）──────────────
  const service = {
    /** 五个子插件的清单。 */
    list: () => SUB_PLUGINS.map((p) => ({ ...p })),
    /** 原生状态（含 entryId / fiberPhase / 冲突原因）。 */
    status: () => listNative(ctx),
    /** 原生诊断信息。 */
    describe: () => describe(paths),
    /** 当前运行实例的身份：version / buildHash / builtAt / startAt / instanceId（F7）。 */
    identity: () => ({ ...identity }),
    /** 最近一次迁移的结论（只读，供诊断核对）。 */
    migration: () => ({ last: { ...migrationSink.last }, attempts: [...(migrationSink.attempts ?? [])] }),
    /**
     * 显式重试一次迁移（G1：失败不终结，可以重来）。
     * 会**重新核对用户层**：期间用户明确关闭的项一律不迁。卸载后不写。
     */
    retryMigration: async () => {
      if (disposed) return { skipped: 'disposed' }
      const result = await runMigration(ctx, paths, log, () => disposed, migrationSink.last?.attempt ?? 0)
      migrationSink.last = result
      if (Array.isArray(migrationSink.attempts)) {
        migrationSink.attempts.push({ round: result.attempt, reason: result.reason, aborted: result.aborted === true, recorded: result.recorded, completed: result.completed === true, outcomes: result.outcomes, explicitRetry: true })
      }
      return result
    },
    /** 用户层显式条目（诊断用；不改任何东西）。 */
    overrides: () => readOverrides(ctx),
    /**
     * 供测试/内部使用的开关入口：走的就是原生通道，和前端同一条路。
     * 返回统一结果合同（F2）。
     */
    setOne: async (id, enabled) => {
      const operationId = newOperationId('op')
      const item = await setNative(ctx, id, enabled)
      const answer = envelope(operationId, [item])
      appendEvent({ kind: 'switch', source: 'service', operationId, id, enabled: enabled === true, outcome: answer.outcome, reason: item.reason }, paths)
      return answer
    },
    /** 一键全开/全关：逐项串行，逐项结果。 */
    setAll: async (enabled) => {
      const operationId = newOperationId('bulk')
      const items = await setNativeAll(ctx, enabled)
      const answer = envelope(operationId, items)
      appendEvent({ kind: 'switch-bulk', source: 'service', operationId, enabled: enabled === true, outcome: answer.outcome, failed: answer.failed, partial: answer.partial, unknown: answer.unknown }, paths)
      return answer
    },
  }

  // ── R10：真实的 provide，而不是 ctx.set 一个不存在的服务 ────────────────
  // 旧版用 `ctx.set('laurelCenter', …)`，而 ctx.set 只能**更新已被 provide 的服务**，
  // 于是真实 Cordis 里 get('laurelCenter') 永远是 undefined，异常还被吞掉。
  // 现在用 ctx.provide 真正注册，并由 effect 在停用时清理。
  try {
    if (typeof ctx.provide === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const dispose = ctx.provide('laurelCenter', service)
        return () => { if (typeof dispose === 'function') dispose() }
      }, 'laurel-center: service')
    }
  } catch (error) {
    log.warn('注册 laurelCenter 服务失败：%o', error)
  }

  log.debug('已激活 v%s build=%s，数据目录 %s', identity.version, identity.buildHash ?? '(未确认)', paths.dir)
}

export { getService, listNative, setNative, setNativeAll, planMigration }
