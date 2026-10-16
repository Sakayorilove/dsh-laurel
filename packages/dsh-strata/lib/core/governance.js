/**
 * 套件治理声明表（Laurel 套件内 warden / strata **共用同一份协议**）
 *
 * ── 它治的是什么（补充评审 R9-A）──────────────────────────────────────
 * Warden 有 `waitCapMs` + `waterLevelNudge`，Strata 也有 `subagentWaitCapMs`
 * + `contextNudge`。两个插件挂的是同一批宿主 waterfall，于是同一件事有两个
 * 负责人：两份提醒可能重复投递、两个设置页可能互相约束、界面可能显示不同的
 * "生效值"，而用户无从判断到底谁在管事。
 *
 * ── 为什么不能靠"目录/包存在"推断 ─────────────────────────────────────
 * 补充评审明确要求：**不靠某个目录或包存在推断已启用**。装上了 ≠ 开着，
 * 开着 ≠ 挂载成功，挂载成功 ≠ 真的命中过。所以这里的判据是
 * **一条活着的声明**：谁真的把钩子挂上了，谁才写声明、才续心跳。
 *
 * ── 协议 ───────────────────────────────────────────────────────────────
 * 一个共享文件 `$DSH_HOME/laurel-suite/governance.json`：
 *
 *     { "protocol": 1,
 *       "claims": { "<capability>": { owner, version, priority, pid,
 *                                     claimedAt, heartbeatAt, expiresAt } } }
 *
 * 抢声明的判定顺序（`decideClaim`，纯函数，两边必须一致）：
 *   1. 没人声明            → 取得
 *   2. 声明者就是自己      → 续期
 *   3. 声明已陈旧          → 回收后取得（**过期 + 持有者进程确实不在**，二者都要）
 *   4. 我的 priority 更高  → 抢占（确定性，避免两边反复互抢）
 *   5. 其余                → 待命（standby），不执行这项能力
 *
 * 被抢占的一方不会立刻知道，它在**下一次心跳**发现自己的声明没了就自动待命。
 * 心跳间隔 2 秒，所以交接期最坏有 2 秒两边都在执行 —— 这个窗口是明确记录的，
 * 不假装是原子的。两边都通过 `isActive()` 在每次真正动手前做一次限频复核。
 *
 * ── 三条纪律 ───────────────────────────────────────────────────────────
 *   1. **不改对方的设置文件。** 待命是运行期状态，绝不偷偷去关用户的开关。
 *   2. **读写都走独占文件锁。** `rename` 不是读改写事务（见 `filelock.js`）。
 *   3. **失败要可见。** 抢不到锁、写不进文件，一律返回失败原因并标降级，
 *      不假装"我已经是 owner 了"。
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { systemClock } from './clock.js'
import { atomicWriteFile, pidAlive, withFileLock } from './filelock.js'

/** 协议版本。两边不一致时以**较小**的一方为准并标降级，不静默按新版写。 */
export const GOVERNANCE_PROTOCOL_VERSION = 1

/** 共享文件位置：放在 `$DSH_HOME/laurel-suite/`，不属于任何单个插件。 */
export const GOVERNANCE_DIR = 'laurel-suite'
export const GOVERNANCE_FILE = 'governance.json'

/** 心跳与陈旧判定。 */
export const GOVERNANCE_HEARTBEAT_MS = 2000
export const GOVERNANCE_TTL_MS = 15000

/**
 * 需要"全套件只有一个执行者"的治理能力。
 *
 * `priority` 是**模块**的属性不是能力的属性：warden 是专职治理模块，
 * 同开时由它执行；strata 单独安装时照常自己执行。
 */
export const GOVERNANCE_CAPABILITIES = {
  waitCap: { label: '子代理等待上限' },
  waterLevelNudge: { label: '上下文水位提醒' },
}

/** 各模块的优先级。数值大的赢。 */
export const MODULE_PRIORITY = {
  'dsh-warden': 100,
  'dsh-strata': 50,
}

function governancePaths(home) {
  const dir = join(home, GOVERNANCE_DIR)
  return { dir, file: join(dir, GOVERNANCE_FILE), lock: join(dir, `${GOVERNANCE_FILE}.lock`) }
}

function readTable(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return { protocol: GOVERNANCE_PROTOCOL_VERSION, claims: {} }
    return {
      protocol: Number(parsed.protocol) || GOVERNANCE_PROTOCOL_VERSION,
      claims: parsed.claims && typeof parsed.claims === 'object' ? parsed.claims : {},
    }
  } catch {
    return { protocol: GOVERNANCE_PROTOCOL_VERSION, claims: {} }
  }
}

/** 一条声明是不是陈旧的。**过期与持有者已死必须同时成立**。 */
export function isStaleClaim(claim, now) {
  if (!claim || typeof claim !== 'object') return true
  const expiresAt = Number(claim.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt > now) return false
  if (claim.pid === undefined || claim.pid === null) return false
  return !pidAlive(claim.pid)
}

/**
 * 抢声明的判定。纯函数 —— 两个模块必须得到同样的答案，所以单测直接盯它。
 *
 * @param {object|null} existing 现有声明
 * @param {{owner: string, version: string, priority: number}} mine
 * @param {number} now
 * @returns {{action: 'take'|'renew'|'reclaim'|'preempt'|'standby', reason: string}}
 */
export function decideClaim(existing, mine, now) {
  if (!existing || typeof existing !== 'object' || !existing.owner) {
    return { action: 'take', reason: '当前没有声明者' }
  }
  if (existing.owner === mine.owner) {
    return { action: 'renew', reason: '本来就是自己声明的' }
  }
  if (isStaleClaim(existing, now)) {
    return { action: 'reclaim', reason: `原声明者 ${existing.owner} 已过期且进程不在（pid=${existing.pid}）` }
  }
  const theirs = Number(existing.priority) || 0
  if (mine.priority > theirs) {
    return { action: 'preempt', reason: `优先级 ${mine.priority} > ${existing.owner} 的 ${theirs}` }
  }
  return {
    action: 'standby',
    reason: `由 ${existing.owner}@${existing.version ?? '?'} 执行（优先级 ${theirs} ≥ ${mine.priority}）`,
  }
}

/**
 * 一个模块的治理声明句柄。
 *
 * @param {{home: string, moduleId: string, moduleVersion: string, priority?: number,
 *          clock?: any, log?: any, onEvent?: (e: object) => void}} options
 */
export class GovernanceClaim {
  constructor(options) {
    this.home = options.home
    this.moduleId = String(options.moduleId)
    this.moduleVersion = String(options.moduleVersion ?? '0.0.0')
    this.priority = Number(options.priority ?? MODULE_PRIORITY[this.moduleId] ?? 0)
    this.clock = options.clock ?? systemClock()
    this.log = options.log ?? null
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null
    this.paths = governancePaths(this.home)
    /** @type {Map<string, {owner: string, version: string, priority: number, active: boolean, reason: string}>} */
    this.local = new Map()
    this.timer = null
    this.lastRefresh = 0
    /** 交接期最坏窗口 = 一个心跳。明确暴露出来供界面与文档引用。 */
    this.handoverWindowMs = GOVERNANCE_HEARTBEAT_MS
  }

  #mine() {
    return { owner: this.moduleId, version: this.moduleVersion, priority: this.priority }
  }

  /**
   * 声明一项治理能力。
   * @returns {{acquired: boolean, owner: string, action: string, reason: string}}
   */
  claim(capability) {
    const key = String(capability)
    const now = this.clock.now()
    const outcome = withFileLock(this.paths.lock, () => {
      const table = readTable(this.paths.file)
      if (table.protocol !== GOVERNANCE_PROTOCOL_VERSION) {
        // 协议不一致：不写、不抢，明确报出来。
        return { acquired: false, owner: '', action: 'protocol-mismatch', reason: `治理表协议是 ${table.protocol}，本模块只认 ${GOVERNANCE_PROTOCOL_VERSION}` }
      }
      const existing = table.claims[key] ?? null
      const decision = decideClaim(existing, this.#mine(), now)
      if (decision.action === 'standby') {
        return { acquired: false, owner: existing.owner, action: decision.action, reason: decision.reason }
      }
      const claim = {
        ...this.#mine(),
        pid: process.pid,
        claimedAt: existing?.owner === this.moduleId ? (existing.claimedAt ?? now) : now,
        heartbeatAt: now,
        expiresAt: now + GOVERNANCE_TTL_MS,
      }
      const next = { ...table, claims: { ...table.claims, [key]: claim } }
      // 写失败必须让调用方知道 —— 不能报"已取得"。
      atomicWriteFile(this.paths.file, `${JSON.stringify(next, null, 2)}\n`)
      return { acquired: true, owner: this.moduleId, action: decision.action, reason: decision.reason }
    }, { clock: this.clock, holder: `${this.moduleId}:${key}` })

    if (!outcome.ok) {
      const reason = outcome.reason ?? '未知原因'
      this.local.set(key, { owner: '', version: '', priority: 0, active: false, reason })
      this.log?.warn?.(`[warden] 治理声明失败 · ${key}：${reason}`)
      this.onEvent?.({ kind: 'governance-claim-failed', capability: key, detail: reason })
      return { acquired: false, owner: '', action: 'error', reason }
    }

    const value = outcome.value
    this.local.set(key, {
      owner: value.owner,
      version: this.moduleVersion,
      priority: this.priority,
      active: value.acquired,
      reason: value.reason,
    })
    if (value.acquired) {
      this.onEvent?.({ kind: 'governance-claim', capability: key, detail: `${this.moduleId} 取得执行权（${value.action}）：${value.reason}` })
    } else {
      this.onEvent?.({ kind: 'governance-standby', capability: key, detail: `待命：${value.reason}` })
    }
    return value
  }

  /**
   * 这项能力现在该不该由我执行。
   *
   * 带限频磁盘复核（`GOVERNANCE_HEARTBEAT_MS` 内直接用内存值），
   * 所以放在每次工具调用前也不贵。
   */
  isActive(capability) {
    const key = String(capability)
    this.#refreshIfDue()
    return this.local.get(key)?.active === true
  }

  /** 谁在执行这项能力（给界面显示"由 xx 执行"）。 */
  ownerOf(capability) {
    const key = String(capability)
    this.#refreshIfDue()
    const local = this.local.get(key)
    if (local?.active) return { owner: this.moduleId, version: this.moduleVersion, active: true, reason: local.reason }
    try {
      const table = readTable(this.paths.file)
      const claim = table.claims[key]
      if (claim && !isStaleClaim(claim, this.clock.now())) {
        return { owner: claim.owner, version: claim.version ?? '?', active: false, reason: `由 ${claim.owner} 执行` }
      }
    } catch { /* 读不到就按无人声明 */ }
    return { owner: '', version: '', active: false, reason: '无人声明' }
  }

  /** 限频复核：发现自己被抢占就自动待命。 */
  #refreshIfDue() {
    const now = this.clock.now()
    if (now - this.lastRefresh < GOVERNANCE_HEARTBEAT_MS) return
    this.lastRefresh = now
    for (const [key, state] of this.local) {
      if (!state.active) continue
      try {
        const table = readTable(this.paths.file)
        const claim = table.claims[key]
        const stillMine = claim && claim.owner === this.moduleId && !isStaleClaim(claim, now)
        if (!stillMine) {
          state.active = false
          state.reason = `已被 ${claim?.owner ?? '未知模块'} 接管，本模块转为待命`
          this.log?.warn?.(`[warden] 治理交接 · ${key}：${state.reason}`)
          this.onEvent?.({ kind: 'governance-handover', capability: key, detail: state.reason })
        }
      } catch { /* 读不到就维持现状，下一次心跳再试 */ }
    }
  }

  /** 续一次心跳（所有本模块持有的声明）。 */
  heartbeat() {
    const held = [...this.local.entries()].filter(([, state]) => state.active).map(([key]) => key)
    if (held.length === 0) return { renewed: 0 }
    const now = this.clock.now()
    const outcome = withFileLock(this.paths.lock, () => {
      const table = readTable(this.paths.file)
      let renewed = 0
      for (const key of held) {
        const claim = table.claims[key]
        if (!claim || claim.owner !== this.moduleId) continue
        table.claims[key] = { ...claim, heartbeatAt: now, expiresAt: now + GOVERNANCE_TTL_MS }
        renewed++
      }
      atomicWriteFile(this.paths.file, `${JSON.stringify(table, null, 2)}\n`)
      return { renewed }
    }, { clock: this.clock, holder: `${this.moduleId}:heartbeat` })
    if (!outcome.ok) {
      // 心跳写不进去 = 声明迟早被判陈旧。明确降级，不假装还健康。
      for (const key of held) {
        const state = this.local.get(key)
        if (state) { state.active = false; state.reason = `心跳续期失败：${outcome.reason}` }
      }
      this.log?.warn?.(`[warden] 治理心跳失败：${outcome.reason}`)
      this.onEvent?.({ kind: 'governance-heartbeat-failed', detail: outcome.reason })
      return { renewed: 0, error: outcome.reason }
    }
    return outcome.value
  }

  /** 开始定时心跳。返回停止函数。 */
  startHeartbeat() {
    this.stopHeartbeat()
    this.timer = setInterval(() => {
      try { this.heartbeat() } catch { /* 心跳异常不许冒泡到宿主 */ }
    }, GOVERNANCE_HEARTBEAT_MS)
    // 心跳定时器不该拖住进程退出。
    this.timer.unref?.()
    return () => this.stopHeartbeat()
  }

  stopHeartbeat() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 释放本模块持有的声明（卸载/停用时调用）。 */
  releaseAll() {
    this.stopHeartbeat()
    const held = [...this.local.entries()].filter(([, state]) => state.active).map(([key]) => key)
    this.local.clear()
    if (held.length === 0) return { released: 0 }
    const outcome = withFileLock(this.paths.lock, () => {
      const table = readTable(this.paths.file)
      let released = 0
      for (const key of held) {
        if (table.claims[key]?.owner === this.moduleId) {
          delete table.claims[key]
          released++
        }
      }
      atomicWriteFile(this.paths.file, `${JSON.stringify(table, null, 2)}\n`)
      return { released }
    }, { clock: this.clock, holder: `${this.moduleId}:release` })
    if (!outcome.ok) {
      this.log?.warn?.(`[warden] 治理声明释放失败：${outcome.reason}`)
      return { released: 0, error: outcome.reason }
    }
    this.onEvent?.({ kind: 'governance-release', detail: `释放 ${outcome.value.released} 项：${held.join('、')}` })
    return outcome.value
  }

  /** 全部治理能力的当前归属（给状态页）。 */
  snapshot() {
    return Object.keys(GOVERNANCE_CAPABILITIES).map((key) => ({
      capability: key,
      label: GOVERNANCE_CAPABILITIES[key].label,
      ...this.ownerOf(key),
    }))
  }
}

/** 确保治理目录存在（幂等）。 */
export function ensureGovernanceDir(home) {
  try {
    mkdirSync(dirname(governancePaths(home).file), { recursive: true })
    return true
  } catch {
    return false
  }
}
