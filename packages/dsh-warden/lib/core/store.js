/**
 * dsh-warden · 数据层：共享资源锁 / 读数指纹台账 / 事件日志
 *
 * ── 四条纪律 ───────────────────────────────────────────────────────────
 *   1. **IO 失败必须报失败。** 旧版 `#persist()` 把写异常吞掉后照样
 *      `return { ok: true, lock }` —— 评审已复现"写盘失败仍报已取得"。
 *      现在写不进去就是 `{ ok: false }`，绝不谎报。
 *   2. **锁的身份是资源，不是名字。** 见 `core/resource.js`。
 *   3. **读改写必须走独占锁。** `writeFileSync(tmp)+renameSync` 只保证
 *      "读到的永远是完整的一份"，不保证两个进程的改动都在（R4）。
 *   4. **台账只追加。** 指纹一旦写下不改，改的是"它还有效吗"的判定。
 *
 * ── 过期 ≠ 旧写者已停止（R4 的核心）───────────────────────────────────
 * TTL 到点只说明"我们不再替它保证"，**不说明它已经停手**。120 秒到点时
 * 那个部署脚本可能还在跑。所以这里两道防线：
 *   - **fence（栅栏令牌）**：每次取得/回收/抢占都让该资源的 fence +1。
 *     旧持有者手里的 fence 就过期了，`renew` / `release` 会被明确拒绝，
 *     它也就无法再声称自己还持有执行权。
 *   - **回收要有证据**：`isStale()` 要求"已过期 **且** 持有者进程确实不在"
 *     两个条件同时成立；只有其一，宁可让新来的排队，也不把资源从
 *     一个可能还在写的人手里抢走。
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { HASH_ALGORITHM_VERSION, pluginPaths, resolveDshHome } from './config.js'
import { systemClock } from './clock.js'
import { atomicWriteFile, pidAlive, withFileLock } from './filelock.js'
import { resolveResourceId, resourcesConflict } from './resource.js'
import { sha256File, shortHash } from './text.js'

/** 事件日志轮转阈值。 */
const EVENT_ROTATE_BYTES = 512 * 1024

/**
 * 事件日志。带简单的轮转：超过 512KB 就砍掉前一半。
 *
 * @returns {boolean} 写成功了没有。旧版无条件吞掉失败，现在把结果交回调用方。
 */
export function appendEvent(event, home = resolveDshHome(), clock = systemClock()) {
  try {
    const paths = pluginPaths(home)
    mkdirSync(paths.dir, { recursive: true })
    try {
      if (statSync(paths.events).size > EVENT_ROTATE_BYTES) {
        const text = readFileSync(paths.events, 'utf8')
        const lines = text.split('\n')
        atomicWriteFile(paths.events, lines.slice(Math.floor(lines.length / 2)).join('\n'))
      }
    } catch { /* 轮转失败不影响写入 */ }
    appendFileSync(
      paths.events,
      `${JSON.stringify({ at: new Date(clock.now()).toISOString(), ...event })}\n`,
      'utf8',
    )
    return true
  } catch {
    return false
  }
}

/** 事件日志尾巴，给设置页看。 */
export function readEvents(home = resolveDshHome(), limit = 80) {
  try {
    const text = readFileSync(pluginPaths(home).events, 'utf8')
    const lines = text.split('\n').filter((line) => line.trim().length > 0)
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean).reverse()
  } catch {
    return []
  }
}

/** 锁表的默认 TTL。 */
const DEFAULT_LOCK_TTL_MS = 120_000

/** 锁表文件（整体重写，短生命周期）。 */
function lockTableFile(home) {
  return pluginPaths(home).locks
}

function readLockTable(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return { locks: {}, fences: {} }
    return {
      locks: parsed.locks && typeof parsed.locks === 'object' ? parsed.locks : {},
      fences: parsed.fences && typeof parsed.fences === 'object' ? parsed.fences : {},
    }
  } catch {
    return { locks: {}, fences: {} }
  }
}

/** 一条锁记录是不是陈旧的。**过期与持有者已死必须同时成立。** */
export function isStaleLock(entry, now) {
  if (!entry || typeof entry !== 'object') return true
  const expiresAt = Number(entry.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt > now) return false
  if (entry.pid === undefined || entry.pid === null) return false
  return !pidAlive(entry.pid)
}

/**
 * 共享资源锁。
 *
 * 语义：**同一个规范资源同一时刻只有一个写者**。读不受限（`conflictFor`
 * 只在写路径上被调用）—— 别的子代理正需要读它来核对读数。
 */
export class LockStore {
  /**
   * @param {string} [home]
   * @param {{clock?: any, log?: any, onEvent?: (e: object) => void, capabilities?: any}} [deps]
   */
  constructor(home = resolveDshHome(), deps = {}) {
    this.home = home
    this.paths = pluginPaths(home)
    this.file = lockTableFile(home)
    this.lockFile = `${this.file}.lock`
    this.clock = deps.clock ?? systemClock()
    this.log = deps.log ?? null
    this.onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null
    this.capabilities = deps.capabilities ?? null
    this.stats = { acquired: 0, denied: 0, ioFailed: 0, reclaimed: 0, unresolved: 0, renewed: 0, released: 0 }
  }

  /** 读全部未过期的锁。读不到文件 = 空表（这一条是安全的失败方向）。 */
  list(now = this.clock.now()) {
    const table = readLockTable(this.file)
    const out = {}
    for (const [id, entry] of Object.entries(table.locks)) {
      if (!entry || typeof entry !== 'object') continue
      const expiresAt = Number(entry.expiresAt) || 0
      if (expiresAt > 0 && expiresAt <= now && isStaleLock(entry, now)) continue
      out[id] = this.#shape(id, entry, table.fences)
    }
    return out
  }

  #shape(id, entry, fences) {
    return {
      id,
      name: typeof entry.name === 'string' ? entry.name : id,
      resourceId: typeof entry.resourceId === 'string' ? entry.resourceId : '',
      resourceKind: typeof entry.resourceKind === 'string' ? entry.resourceKind : '',
      path: typeof entry.path === 'string' ? entry.path : '',
      owner: typeof entry.owner === 'string' ? entry.owner : '',
      pid: entry.pid ?? null,
      fence: Number(fences?.[entry.resourceId] ?? entry.fence ?? 1),
      acquiredAt: Number(entry.acquiredAt) || 0,
      renewedAt: Number(entry.renewedAt) || 0,
      expiresAt: Number(entry.expiresAt) || 0,
      note: typeof entry.note === 'string' ? entry.note : '',
    }
  }

  /**
   * 尝试取得某个资源的执行权。
   *
   * @param {{name?: string, resource?: string, path?: string, owner: string,
   *          ttlMs?: number, note?: string, cwd?: string}} request
   * @returns {{ok: true, lock: object}|{ok: false, reason: string, heldBy?: object, unresolvable?: boolean}}
   */
  acquire(request) {
    const owner = typeof request?.owner === 'string' ? request.owner.trim() : ''
    if (!owner) return { ok: false, reason: '缺少持有者标识（拿不到会话 id）' }

    // ── 资源身份：命名资源优先，其次路径 ──
    const target = request.resource?.trim() || request.path?.trim() || request.name?.trim() || ''
    const resolved = resolveResourceId(target, request.cwd ?? '', {
      mergeCrossPlatform: request.mergeCrossPlatform !== false,
    })
    if (!resolved.resolvable) {
      this.stats.unresolved++
      this.capabilities?.markObserved?.('lockCoverageGap', `无法归一：${resolved.reason}`)
      return {
        ok: false,
        unresolvable: true,
        reason: `这个目标无法归一成可靠的资源身份，因此**没有加锁**：${resolved.reason}\n`
          + `请改用①绝对路径，或②明确的命名资源（desktop-input / display-mode / deployment:<目标> / port:<端口>）。`,
      }
    }

    const now = this.clock.now()
    const ttl = Number(request.ttlMs) > 0 ? Number(request.ttlMs) : DEFAULT_LOCK_TTL_MS
    const name = typeof request.name === 'string' && request.name.trim() ? request.name.trim() : resolved.resourceId

    const outcome = withFileLock(this.lockFile, () => {
      const table = readLockTable(this.file)

      // ── 冲突判定：任何**资源身份相撞**的锁都算，不看锁名 ──
      for (const [id, entry] of Object.entries(table.locks)) {
        if (!entry || typeof entry !== 'object') continue
        if (entry.owner === owner) continue
        if (!resourcesConflict(entry.resourceId, resolved.resourceId)) continue
        if (!isStaleLock(entry, now)) {
          return { ok: false, heldBy: this.#shape(id, entry, table.fences), conflictOn: id }
        }
        // 陈旧：过期 **且** 持有者进程不在 —— 可以回收，并把 fence 推进。
        this.stats.reclaimed++
        this.onEvent?.({
          kind: 'lock-reclaim',
          detail: `回收陈旧锁 ${entry.name}（原持有者 ${entry.owner} pid=${entry.pid} 已不在）`,
        })
        delete table.locks[id]
      }

      const fence = Number(table.fences[resolved.resourceId] ?? 0) + 1
      table.fences[resolved.resourceId] = fence

      const existing = table.locks[resolved.resourceId]
      const lock = {
        name,
        resourceId: resolved.resourceId,
        resourceKind: resolved.kind,
        path: resolved.path,
        owner,
        pid: process.pid,
        fence,
        acquiredAt: existing?.owner === owner ? (existing.acquiredAt ?? now) : now,
        renewedAt: now,
        expiresAt: now + ttl,
        note: typeof request.note === 'string' ? request.note.slice(0, 300) : '',
        hashVersion: HASH_ALGORITHM_VERSION,
      }
      table.locks[resolved.resourceId] = lock
      // 写失败必须让调用方知道（R4）。atomicWriteFile 会抛。
      atomicWriteFile(this.file, `${JSON.stringify(table, null, 2)}\n`)
      return { ok: true, lock: this.#shape(resolved.resourceId, lock, table.fences) }
    }, { clock: this.clock, holder: `lockstore:${owner}` })

    if (!outcome.ok) {
      this.stats.ioFailed++
      this.capabilities?.markDegraded?.('sharedLock', `锁表读写失败：${outcome.reason}`)
      this.log?.warn?.(`共享锁未取得（IO 失败）：${outcome.reason}`)
      // ⚠ 绝不返回 ok:true。旧版就是在这里谎报的。
      return { ok: false, reason: `锁表读写失败，本次**没有取得**执行权：${outcome.reason}`, ...(outcome.heldBy ? { heldBy: outcome.heldBy } : {}) }
    }

    const value = outcome.value
    if (!value.ok) {
      this.stats.denied++
      const held = value.heldBy
      this.onEvent?.({
        kind: 'lock-denied',
        detail: `${owner} 想拿 ${resolved.resourceId}，被 ${held?.owner} 挡下`,
      })
      return {
        ok: false,
        reason: `资源已被 ${held?.owner ?? '另一个会话'} 占用`,
        ...(held ? { heldBy: held } : {}),
        resourceId: resolved.resourceId,
      }
    }

    this.stats.acquired++
    this.capabilities?.markObserved?.('sharedLock', `取得 ${resolved.resourceId}（fence=${value.lock.fence}）`)
    this.onEvent?.({
      kind: 'lock-acquire',
      detail: `${owner} 取得 ${resolved.resourceId}（fence=${value.lock.fence}，${Math.round(ttl / 1000)} 秒后过期）`,
      mergedCrossPlatform: resolved.mergedCrossPlatform,
    })
    return { ok: true, lock: value.lock, mergedCrossPlatform: resolved.mergedCrossPlatform }
  }

  /**
   * 续租。长任务必须在过期前续，否则会被判陈旧回收。
   *
   * fence 不匹配 = 这把锁已经被回收/抢占了，**续租失败**，
   * 调用方必须停手（这就是执行面的 fencing）。
   */
  renew({ resourceId, owner, fence, ttlMs }) {
    const now = this.clock.now()
    const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_LOCK_TTL_MS
    const outcome = withFileLock(this.lockFile, () => {
      const table = readLockTable(this.file)
      const entry = table.locks[resourceId]
      if (!entry) return { ok: false, reason: '这把锁已经不在了（可能已过期并被回收）' }
      const currentFence = Number(table.fences[resourceId] ?? entry.fence ?? 1)
      // fence 先判：令牌失效说明这把锁**已经被回收/抢占过**，
      // 这比"现在归谁"更根本 —— 旧持有者必须先停手，而不是被告知换个主人。
      if (fence !== undefined && Number(fence) !== currentFence) {
        return {
          ok: false,
          fenced: true,
          reason: `栅栏令牌已失效（你的是 ${fence}，当前是 ${currentFence}）——`
            + '这把锁曾被回收或抢占，**你必须停止对该资源的写入**并重新申请。',
        }
      }
      if (entry.owner !== owner) return { ok: false, reason: `这把锁现在归 ${entry.owner}` }
      entry.renewedAt = now
      entry.expiresAt = now + ttl
      entry.fence = currentFence
      atomicWriteFile(this.file, `${JSON.stringify(table, null, 2)}\n`)
      return { ok: true, lock: this.#shape(resourceId, entry, table.fences) }
    }, { clock: this.clock, holder: `lockstore:renew:${owner}` })

    if (!outcome.ok) {
      this.stats.ioFailed++
      return { ok: false, reason: `续租失败（IO）：${outcome.reason}` }
    }
    if (outcome.value.ok) {
      this.stats.renewed++
      return outcome.value
    }
    return outcome.value
  }

  /**
   * 释放。
   *
   * `force` **不是万能钥匙**（R4：强制释放活锁不能只凭模型 force:true）：
   *   - 持有者自己 → 直接放
   *   - `actor === 'user'`（设置页/HTTP，背后是真人）+ force → 放，并记账
   *   - `actor === 'model'` + force → **只有锁确实陈旧才放**；活锁一律拒绝
   *   - 其余 → 拒绝
   *
   * @returns {{ok: boolean, released?: boolean, reason?: string, heldBy?: object}}
   */
  release({ resourceId, name, owner, force = false, actor = 'model', fence }) {
    const now = this.clock.now()
    const outcome = withFileLock(this.lockFile, () => {
      const table = readLockTable(this.file)
      // ⚠ 这里必须用"空串也算没有"的判定，不能用 `??`：
      // HTTP 面在没有 resource 时会传 `resourceId: ''`，`?? ` 不会穿透空串，
      // 于是 key 变成 ''、查不到锁、反而回一句"本来就没有这把锁"（ok:true）。
      const byName = Object.keys(table.locks).find((id) => table.locks[id]?.name === name)
      const key = (typeof resourceId === 'string' && resourceId.length > 0)
        ? resourceId
        : (byName ?? ((typeof name === 'string' && name.length > 0) ? name : ''))
      const entry = table.locks[key]
      if (!entry) return { ok: true, released: false, reason: '本来就没有这把锁' }

      const stale = isStaleLock(entry, now)
      const isOwner = typeof owner === 'string' && owner.length > 0 && entry.owner === owner
      const currentFence = Number(table.fences[entry.resourceId] ?? entry.fence ?? 1)

      if (!isOwner) {
        const userForced = force === true && actor === 'user'
        const staleForced = force === true && stale
        if (!userForced && !staleForced) {
          return {
            ok: false,
            heldBy: this.#shape(key, entry, table.fences),
            reason: force === true
              ? `这把锁**还活着**（持有者 ${entry.owner}，pid=${entry.pid}，`
                + `${Math.max(0, Math.round((entry.expiresAt - now) / 1000))} 秒后过期）。`
                + '模型端的 force 不能释放活锁 —— 过期不代表对方已经停手。'
                + '要么等它自己 release/过期，要么由用户在设置页强制释放。'
              : `这把锁归 ${entry.owner}，只有持有者能释放。`,
          }
        }
        if (userForced && !stale) {
          this.onEvent?.({
            kind: 'lock-force-release',
            detail: `用户在设置页强制释放了 ${entry.name}（原持有者 ${entry.owner} 可能仍在写，fence 已推进）`,
          })
        }
      }

      if (isOwner && fence !== undefined && Number(fence) !== currentFence) {
        return {
          ok: false,
          fenced: true,
          reason: `栅栏令牌已失效（你的是 ${fence}，当前是 ${currentFence}）——这把锁已被回收或抢占。`,
        }
      }

      delete table.locks[key]
      // fence **保留并推进**：这样旧持有者即使没收到通知，也无法再续租或声称持有。
      table.fences[entry.resourceId] = currentFence + 1
      atomicWriteFile(this.file, `${JSON.stringify(table, null, 2)}\n`)
      return { ok: true, released: true, resourceId: entry.resourceId }
    }, { clock: this.clock, holder: `lockstore:release:${owner || actor}` })

    if (!outcome.ok) {
      this.stats.ioFailed++
      return { ok: false, reason: `释放失败（IO）：${outcome.reason}` }
    }
    if (outcome.value.released) {
      this.stats.released++
      this.onEvent?.({ kind: 'lock-release', detail: `${owner || actor} 释放了 ${lockLabel(resourceId, name)}` })
    }
    return outcome.value
  }

  /**
   * 这次操作的目标资源，是不是正被**别人**占着？
   *
   * 只在写路径上调用。判据是**规范资源身份的冲突集合**（含父子路径），
   * 不是锁名。归一不出来返回 null（fail-open）—— 但调用方必须把
   * "没覆盖到"记进能力台账，不能假装全面强制。
   *
   * @param {string} targetOrResourceId 规范 id，或原始路径
   * @param {string} owner 当前会话
   * @param {{path?: string, cwd?: string, now?: number}} [options]
   * @returns {object|null} 占用者
   */
  conflictFor(targetOrResourceId, owner, options = {}) {
    const now = options.now ?? this.clock.now()
    const isId = typeof targetOrResourceId === 'string'
      && (targetOrResourceId.startsWith('path:') || targetOrResourceId.startsWith('named:'))
    const resolved = isId
      ? { resolvable: true, resourceId: targetOrResourceId }
      : resolveResourceId(targetOrResourceId, options.cwd ?? '')
    if (!resolved.resolvable) return null

    for (const lock of Object.values(this.list(now))) {
      if (lock.owner === owner) continue
      if (resourcesConflict(lock.resourceId, resolved.resourceId)) return lock
    }
    return null
  }

  /** 统计快照。 */
  snapshot() {
    return { ...this.stats, held: Object.keys(this.list()).length }
  }
}

function lockLabel(resourceId, name) {
  return resourceId || name || '(未知)'
}

/**
 * 读数指纹台账。
 *
 * ── 它治的是什么 ───────────────────────────────────────────────────────
 * 实测原话：「验收期间部署换了三次，读数无法归属」。根因是**读数与产物
 * 之间没有绑定** —— 谁都能拿一个数说"我测的是最新版"。
 *
 * ── 四种状态，绝不把"不知道"显示成"有效"（R5）─────────────────────────
 *   `verified`   绑定过产物，且当前指纹与记录时**逐字节一致**
 *   `stale`      绑定过产物，但指纹变了 —— 这条读数作废
 *   `unverified` 没绑定产物 / 环境未知 / 指纹算法是旧版 —— **不能当验收通过**
 *   `error`      产物读不到、台账写不进去等
 *
 * `verified` 只代表"产物身份没变"这一件具体的事。它**不等于**测试通过、
 * 也不等于实验环境没被污染（补充评审 R9-D：与 Strata 的 verified 更不是
 * 同一件事，那边说的是"这个文件读过且没变"）。
 */
export class EvidenceLedger {
  /**
   * @param {string} [home]
   * @param {{clock?: any, log?: any, onEvent?: (e: object) => void, capabilities?: any}} [deps]
   */
  constructor(home = resolveDshHome(), deps = {}) {
    this.home = home
    this.paths = pluginPaths(home)
    this.clock = deps.clock ?? systemClock()
    this.log = deps.log ?? null
    this.onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null
    this.capabilities = deps.capabilities ?? null
  }

  /**
   * 记一条。**写不进去就返回失败**，不返回一个假装存在的记录对象（R5）。
   *
   * @param {{label: string, artifact?: string, artifactHash?: string, reading: string,
   *          owner?: string, note?: string, environment?: object, hashVersion?: number}} entry
   * @returns {{ok: true, row: object}|{ok: false, reason: string}}
   */
  record(entry) {
    const now = this.clock.now()
    let artifactHash = String(entry.artifactHash ?? '')
    const artifact = String(entry.artifact ?? '')
    // 给了产物路径却没给指纹时，自己按字节算一次。
    // 否则调用方一旦忘了传 hash，就会静默产出一堆 unverified 的"读数"，
    // 看起来记上了、实际永远无法核对。
    if (!artifactHash && artifact && isAbsolute(artifact)) {
      try {
        artifactHash = sha256File(artifact).hash
      } catch (error) {
        this.capabilities?.markObserved?.('evidenceLedger', `产物读不到，记为 unverified：${error?.message ?? error}`)
      }
    }
    const row = {
      at: new Date(now).toISOString(),
      label: String(entry.label ?? '').slice(0, 120),
      artifact,
      artifactHash,
      hashVersion: Number(entry.hashVersion) > 0 ? Number(entry.hashVersion) : HASH_ALGORITHM_VERSION,
      reading: String(entry.reading ?? '').slice(0, 500),
      owner: String(entry.owner ?? ''),
      note: String(entry.note ?? '').slice(0, 300),
      environment: entry.environment && typeof entry.environment === 'object' ? entry.environment : {},
      id: shortHash(`${now}:${entry.label}:${entry.reading}:${artifactHash}`),
    }
    try {
      mkdirSync(this.paths.dir, { recursive: true })
      appendFileSync(this.paths.evidence, `${JSON.stringify(row)}\n`, 'utf8')
    } catch (error) {
      this.capabilities?.markDegraded?.('evidenceLedger', `台账写入失败：${error?.message ?? error}`)
      return { ok: false, reason: `台账写入失败，这条读数**没有记上**：${error?.message ?? error}` }
    }
    this.capabilities?.markObserved?.('evidenceLedger', `${row.label} @${row.artifactHash.slice(0, 12) || '(无指纹)'}`)
    return { ok: true, row }
  }

  /** 全部读数（最新的在前）。 */
  list(limit = 200) {
    try {
      const text = readFileSync(this.paths.evidence, 'utf8')
      const rows = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { rows.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
      }
      return rows.slice(-limit).reverse()
    } catch {
      return []
    }
  }

  /**
   * 复核一条读数。
   *
   * @param {{label?: string, id?: string}} query
   * @param {(artifact: string) => {hash: string, algorithm: string}} hashOf
   *        由调用方提供"怎么算当前指纹"（必须是字节级 SHA-256）
   * @returns {{found: boolean, state: 'verified'|'stale'|'unverified'|'error',
   *            valid: boolean, row?: object, currentHash?: string, reason: string}}
   */
  check(query, hashOf) {
    const rows = this.list(500)
    const row = query?.id
      ? rows.find((r) => r.id === query.id)
      : rows.find((r) => r.label === query?.label)
    if (!row) {
      return { found: false, state: 'error', valid: false, reason: '台账里没有这条读数' }
    }
    if (!row.artifact || !row.artifactHash) {
      return {
        found: true,
        state: 'unverified',
        valid: false,
        row,
        reason: '这条读数没有绑定产物指纹，**无法核对** —— 它不是有效验收，只是一条自述。',
      }
    }
    // 旧算法（v1：先 String(buffer) 再 UTF-8 hash）的记录不能无条件继承为有效。
    const version = Number(row.hashVersion) || 1
    if (version < HASH_ALGORITHM_VERSION) {
      return {
        found: true,
        state: 'unverified',
        valid: false,
        row,
        reason: `这条读数的指纹是旧算法（hashVersion=${version}）算的：它把字节流先转成 UTF-8 字符串，`
          + '不同字节可能撞成同一个 hash，也与 sha256sum 不一致。**必须重新记录**，不能沿用它当验收。',
      }
    }

    let current
    try {
      current = hashOf(row.artifact)
    } catch (error) {
      return {
        found: true,
        state: 'error',
        valid: false,
        row,
        reason: `算不出当前指纹（产物读不到？）：${error?.message ?? error}`,
      }
    }
    const currentHash = String(current?.hash ?? '')
    if (!currentHash) {
      return { found: true, state: 'error', valid: false, row, reason: '当前指纹为空，无法核对' }
    }
    if (currentHash !== row.artifactHash) {
      return {
        found: true,
        state: 'stale',
        valid: false,
        row,
        currentHash,
        reason: `产物已漂移：记读数时是 ${row.artifactHash.slice(0, 12)}，现在是 ${currentHash.slice(0, 12)} —— 这条读数作废。`,
      }
    }
    return {
      found: true,
      state: 'verified',
      valid: true,
      row,
      currentHash,
      reason: '产物指纹逐字节一致。注意：这只证明**产物身份没变**，'
        + '不证明测试通过、也不证明实验环境没被污染。',
    }
  }

  /** 统计：总共几条、涉及几个不同产物指纹、各状态几条。 */
  stats() {
    const rows = this.list(2000)
    const byVersion = {}
    for (const row of rows) {
      const version = Number(row.hashVersion) || 1
      byVersion[version] = (byVersion[version] ?? 0) + 1
    }
    return {
      total: rows.length,
      artifacts: new Set(rows.map((r) => r.artifactHash).filter(Boolean)).size,
      bound: rows.filter((r) => r.artifactHash).length,
      unbound: rows.filter((r) => !r.artifactHash).length,
      legacyHashVersion: byVersion[1] ?? 0,
      byHashVersion: byVersion,
      hashAlgorithmVersion: HASH_ALGORITHM_VERSION,
    }
  }
}

/**
 * 会话级计数器（内存态，不落盘）。
 *
 * 只用来回答"这条命令在这个会话里跑了几次"。重启后归零是**可以接受**的：
 * 它只影响一次提醒，不是审计数据。
 */
export class Counters {
  constructor() {
    /** @type {Map<string, Map<string, number>>} sessionId → (key → count) */
    this.bySession = new Map()
    this.limit = 400
  }

  /** 加一并返回新的计数。 */
  bump(sessionId, key) {
    const id = String(sessionId ?? '-')
    let bucket = this.bySession.get(id)
    if (!bucket) { bucket = new Map(); this.bySession.set(id, bucket) }
    const next = (bucket.get(key) ?? 0) + 1
    bucket.set(key, next)
    // 单个会话的键数上限，防止超长会话把内存吃光。
    if (bucket.size > this.limit) {
      const first = bucket.keys().next().value
      bucket.delete(first)
    }
    return next
  }

  get(sessionId, key) {
    return this.bySession.get(String(sessionId ?? '-'))?.get(key) ?? 0
  }

  reset(sessionId) {
    if (sessionId === undefined) this.bySession.clear()
    else this.bySession.delete(String(sessionId ?? '-'))
  }
}
