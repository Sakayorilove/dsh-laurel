/**
 * dsh-strata · 已核实台账（verified ledger）
 *
 * ── 为什么要有这个东西（这是这次从 ACP 借来的最实用的一条）───────────────
 * 本机实测那次 286 步的会话里，**工具调用参数占总消耗的 25.9%**，其中
 * 40% 的 `write` 参数是在**整文件重写已经写过的文件**；再加上 30 次 `read`。
 * 而同一个文件被重读、重写的内容**会永久留在上下文里，之后每一步重发一次**。
 *
 * ACP（billion-context / acp-kernel）的做法叫 `verifiedReadings`：压缩一段
 * 历史时，把"这一段里我确实读过并核实过的文件"记进摘要，后续回合**不必重读
 * 也知道哪些已经核实过**。它随摘要持久化 ⇒ 能穿越压缩。
 *
 * 这里把它落到工作区级：一份 JSON，记 `路径 → 核实时的 mtime+size`。
 * 关键在 **mtime+size 比对**——文件被改过就自动失效，不会拿过期结论当依据。
 *
 * ── 三条纪律 ───────────────────────────────────────────────────────────
 *   1. **只记录，不代替模型判断。** 表里说"已核实"不代表现在就一定对；
 *      文件没变过才作数，变了就自动不算。
 *   2. **所有 IO 吞异常。** 台账坏了不能让记忆功能跟着坏。
 *   3. **有界。** 每个工作区最多留 N 条，超了丢最旧的。
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './atomic.js'
import { pluginPaths, workspaceKey } from './config.js'

/** 每个工作区最多记多少条。超了按"最近核实时间"丢最旧的。 */
const MAX_PER_WORKSPACE = 300
/** 单个工作区最多记多少个工作区（跨重启的宽限）。 */
const MAX_WORKSPACES = 64
/** 多久没核实就整体丢掉（天）。文件系统会一直变，留太久没意义。 */
const TTL_DAYS = 30

/** 台账文件位置：与记忆本体同一个目录，便于一起备份。 */
function ledgerPath(home) {
  return join(pluginPaths(home).dir, 'verified.json')
}

/** 读台账。文件不存在 / 坏掉都返回空对象——**绝不在读取路径上抛**。 */
function load(home) {
  const file = ledgerPath(home)
  try {
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function save(home, state) {
  try {
    const dir = pluginPaths(home).dir
    mkdirSync(dir, { recursive: true })
    atomicWrite(ledgerPath(home), `${JSON.stringify(state)}\n`)
    return true
  } catch {
    return false
  }
}

/** 归一化路径：统一分隔符、Windows 下大小写不敏感。 */
export function normalizePath(path) {
  const p = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (p.length === 0) return ''
  return /^[a-z]:\//i.test(p) || p.startsWith('//') ? p.toLowerCase() : p
}

/**
 * 记一条"我读过并核实过这个文件"。
 *
 * mtimeMs + size 在**记录时**取，之后用它判断有没有被改过。
 *
 * @returns {{path: string, ok: boolean, mtimeMs?: number, size?: number, reason?: string}}
 */
export function markVerified(home, workspace, rawPath) {
  const path = normalizePath(rawPath)
  const key = workspaceKey(workspace)
  if (!path || !key) return { path, ok: false, reason: 'bad-input' }
  let stat = null
  try {
    stat = statSync(String(rawPath))
  } catch {
    // 文件不存在（或没权限）：**不记**。记一条查不到的文件只会误导后续回合。
    return { path, ok: false, reason: 'not-readable' }
  }
  if (!stat?.isFile?.()) return { path, ok: false, reason: 'not-a-file' }

  const state = load(home)
  const bucket = state[key] && typeof state[key] === 'object' ? state[key] : {}
  bucket[path] = { at: Date.now(), mtimeMs: Number(stat.mtimeMs) || 0, size: Number(stat.size) || 0 }

  // 有界：超了丢最旧的。
  const entries = Object.entries(bucket)
  if (entries.length > MAX_PER_WORKSPACE) {
    entries.sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0))
    state[key] = Object.fromEntries(entries.slice(0, MAX_PER_WORKSPACE))
  } else {
    state[key] = bucket
  }
  // 工作区数量也有界。
  const wsKeys = Object.keys(state)
  if (wsKeys.length > MAX_WORKSPACES) {
    wsKeys.sort((a, b) => latestAt(state[b]) - latestAt(state[a]))
    for (const stale of wsKeys.slice(MAX_WORKSPACES)) delete state[stale]
  }
  const saved = save(home, state)
  return { path, ok: saved, mtimeMs: Number(stat.mtimeMs) || 0, size: Number(stat.size) || 0, reason: saved ? undefined : 'write-failed' }
}

/** 一个工作区桶里最近一次核实时间。 */
function latestAt(bucket) {
  let max = 0
  for (const item of Object.values(bucket ?? {})) max = Math.max(max, Number(item?.at) || 0)
  return max
}

/**
 * 列出这条工作区**仍然有效**的条目（文件未被改动、且没超 TTL）。
 *
 * 这是台账的全部价值所在：文件改了就不算数，绝不拿过期结论骗模型。
 *
 * @returns {Array<{path: string, at: number, mtimeMs: number, size: number}>}
 */
export function listVerified(home, workspace, { check = true } = {}) {
  const key = workspaceKey(workspace)
  if (!key) return []
  const bucket = load(home)[key]
  if (!bucket || typeof bucket !== 'object') return []
  const cutoff = Date.now() - TTL_DAYS * 86400000
  const out = []
  for (const [path, item] of Object.entries(bucket)) {
    const at = Number(item?.at) || 0
    if (at < cutoff) continue
    const entry = { path, at, mtimeMs: Number(item?.mtimeMs) || 0, size: Number(item?.size) || 0 }
    if (check) {
      try {
        const stat = statSync(path)
        if (!stat.isFile()) continue
        if (Number(stat.mtimeMs) !== entry.mtimeMs || Number(stat.size) !== entry.size) continue
      } catch {
        continue // 删了 / 读不到 ⇒ 不算已核实
      }
    }
    out.push(entry)
  }
  out.sort((a, b) => b.at - a.at)
  return out
}

/** 把一条从台账里去掉。 */
export function forgetVerified(home, workspace, rawPath) {
  const key = workspaceKey(workspace)
  const path = normalizePath(rawPath)
  if (!key || !path) return false
  const state = load(home)
  const bucket = state[key]
  if (!bucket || typeof bucket !== 'object' || !(path in bucket)) return false
  delete bucket[path]
  return save(home, state)
}

/**
 * 给提醒/工具用的一行摘要：只给文件名，够模型认出来就行。
 *
 * 为什么不给全路径：这一段会随提醒**每轮重发**，路径前缀是纯浪费。
 */
export function verifiedLabels(home, workspace, limit = 12) {
  return listVerified(home, workspace).slice(0, limit).map((e) => {
    const parts = e.path.split('/')
    return parts[parts.length - 1] || e.path
  })
}

/** 台账自检信息。 */
export function verifiedStats(home, workspace) {
  const key = workspaceKey(workspace)
  const bucket = key ? load(home)[key] : null
  const recorded = bucket && typeof bucket === 'object' ? Object.keys(bucket).length : 0
  const live = listVerified(home, workspace)
  return { workspace: key, recorded, live: live.length, stale: Math.max(0, recorded - live.length), path: ledgerPath(home) }
}
