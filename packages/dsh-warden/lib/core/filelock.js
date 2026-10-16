/**
 * dsh-warden · 跨进程文件锁原语
 *
 * ── 为什么需要它 ───────────────────────────────────────────────────────
 * 评审 R4 的原话：**「原子文件 rename 不是读改写事务」**。
 *
 * `writeFileSync(tmp)` + `renameSync(tmp, file)` 只保证「读到的永远是某一份
 * 完整的 JSON」，不保证「两个进程同时 读→改→写 之后两边的改动都还在」。
 * 后者必然丢一边。锁表、治理声明表都是典型的读改写，所以必须先拿到
 * **独占创建**的锁文件才允许改。
 *
 * 独占靠 `openSync(path, 'wx')`：`O_CREAT|O_EXCL`，文件已存在就抛 `EEXIST`。
 * 这是 POSIX/Windows 都由文件系统保证的原子操作，比"先 stat 再 write"可靠。
 *
 * ── 边界（必须诚实说明）────────────────────────────────────────────────
 *   1. 进程崩在临界区里会留下锁文件。所以锁文件带 `expiresAt` 与 `pid`，
 *      过期或持有者已死才可回收 —— **回收前必须验证持有者不在了**，
 *      不能只看时间（否则就是 R4 说的"过期不等于旧写者已停止"）。
 *   2. 这管不住"任意 shell 命令里看不出来的写入"。那种情况一律标未覆盖。
 *   3. 网络文件系统（含某些 `/mnt/*` 挂载）上 `O_EXCL` 语义不保证。
 *      因此默认把锁放在 `$DSH_HOME`（本机盘），不放共享挂载。
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { systemClock } from './clock.js'

/** 默认锁持有上限。到期且持有者已死才可回收。 */
export const DEFAULT_LOCK_TTL_MS = 5000

/** 拿不到锁时的重试节奏。 */
const RETRY_DELAY_MS = 8
const RETRY_COUNT = 40

function sleep(ms) {
  const until = Date.now() + ms
  // 忙等只用于毫秒级的临界区；比引入 timer 依赖更可控。
  while (Date.now() < until) { /* spin */ }
}

/** 进程还在不在。`process.kill(pid, 0)` 不发信号，只探测。 */
export function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isSafeInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    // ESRCH = 进程不存在；EPERM = 存在但不属于我们（也算活着）。
    return error?.code === 'EPERM'
  }
}

/** 锁文件里写了什么。读不出来当"内容未知"，不当"没人持有"。 */
function readLockMeta(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 这个陈旧锁能不能回收。
 *
 * 必须**两个条件都成立**：已过期，且持有者进程确实不在了。
 * 只有其一都返回 false —— 时间到了不代表旧写者已经停止（R4）。
 * `pid` 缺失时按"无法证明已停止"处理，保守不回收。
 */
export function reclaimable(meta, now) {
  if (!meta) return false
  const expiresAt = Number(meta.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt > now) return false
  if (meta.pid === undefined || meta.pid === null) return false
  return !pidAlive(meta.pid)
}

/**
 * 在独占锁保护下跑一次读改写。
 *
 * @param {string} lockFile 锁文件路径（不要和目标文件同名）
 * @param {() => T} body 临界区。里面的读改写才是原子的。
 * @param {{ttlMs?: number, clock?: any, holder?: string, onStale?: (meta: object) => void}} [options]
 * @returns {{ok: true, value: T}|{ok: false, reason: string, heldBy?: object}}
 */
export function withFileLock(lockFile, body, options = {}) {
  const clock = options.clock ?? systemClock()
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_LOCK_TTL_MS
  const holder = options.holder ?? `${process.pid}`

  try {
    mkdirSync(dirname(lockFile), { recursive: true })
  } catch (error) {
    return { ok: false, reason: `建不出锁目录：${error?.message ?? error}` }
  }

  let fd = null
  for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
    try {
      fd = openSync(lockFile, 'wx')
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { ok: false, reason: `创建锁失败：${error?.code ?? error?.message ?? error}` }
      }
      const meta = readLockMeta(lockFile)
      if (reclaimable(meta, clock.now())) {
        options.onStale?.(meta)
        try { rmSync(lockFile, { force: true }) } catch { /* 下一轮重试 */ }
        continue
      }
      // 有人真的持有（或无法证明它已停止）—— 等一会儿再试。
      sleep(RETRY_DELAY_MS)
    }
  }

  if (fd === null) {
    const meta = readLockMeta(lockFile)
    return {
      ok: false,
      reason: '在限定时间内没有取得文件锁',
      ...(meta ? { heldBy: meta } : {}),
    }
  }

  const expiresAt = clock.now() + ttlMs
  try {
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, holder, expiresAt })}\n`, 'utf8')
  } catch { /* 元数据写不进去不影响本次独占，只是回收时更保守 */ }

  try {
    const value = body()
    return { ok: true, value }
  } catch (error) {
    return { ok: false, reason: `临界区失败：${error?.message ?? error}` }
  } finally {
    try { closeSync(fd) } catch { /* 已关就忽略 */ }
    try { rmSync(lockFile, { force: true }) } catch { /* 删不掉就等它过期回收 */ }
  }
}

/** 原子写：先写临时文件再改名。失败**必须**抛给调用方，不许静默。 */
export function atomicWriteFile(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  try {
    // 改名前先确认临时文件真的落盘了，避免把 0 字节换上去。
    if (statSync(tmp).size !== Buffer.byteLength(text, 'utf8')) {
      throw new Error('临时文件大小与内容不一致')
    }
    renameSync(tmp, file)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* 清不掉就算了 */ }
    throw error
  }
}
