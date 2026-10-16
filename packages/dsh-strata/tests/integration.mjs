/**
 * dsh-strata · 真机集成探针（只读）
 *
 * 与 smoke.mjs 的区别：smoke 用临时目录自造数据，这个探针读**真实的 `~/.dsh`**，
 * 验证插件能不能真的看懂这台机器上的会话与工作区。
 *
 * 它**只读**：`MemoryStore` / `GrantLedger` 的构造只走 `reload()` / `load()`，
 * 不会创建 `~/.dsh/strata/`，也不会写任何东西。
 *
 * 跑法：
 *   node tests/integration.mjs
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { resolveDshHome, pluginPaths } from '../lib/core/config.js'
import { GrantLedger, MemoryStore, discoverWorkspaces, readSessionHeader, readZstdFrames } from '../lib/core/store.js'

const home = resolveDshHome()
process.stdout.write(`DSH_HOME = ${home}\n`)

/* ---------------- 1. 工作区发现 ---------------- */
const workspaces = discoverWorkspaces(home)
const sources = [...new Set(workspaces.map((w) => w.source))].join(' / ')
process.stdout.write(`\n发现 ${workspaces.length} 个工作区（来源：${sources || '无'}）\n`)
for (const w of workspaces.slice(0, 20)) process.stdout.write(`  - ${w.path}\n`)
if (workspaces.length > 20) process.stdout.write(`  … 另有 ${workspaces.length - 20} 个\n`)

/* ---------------- 2. 会话目录扫描 ---------------- */
const paths = pluginPaths(home)
let totalSessions = 0
let totalBytes = 0
let headersOk = 0
let headersBad = 0
const perWorkspace = []

let dirs = []
try { dirs = readdirSync(paths.sessions, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { dirs = [] }

for (const entry of dirs) {
  const wsDir = join(paths.sessions, entry.name)
  let sessionIds = []
  try { sessionIds = readdirSync(wsDir) } catch { continue }
  let bytes = 0
  for (const sessionId of sessionIds) {
    try { bytes += statSync(join(wsDir, sessionId, 'session.v4.jsonl.zstd')).size } catch { /* 没有这个文件 */ }
  }
  totalSessions += sessionIds.length
  totalBytes += bytes
  const sample = sessionIds.length > 0 ? readSessionHeader(join(wsDir, sessionIds[0]), home) : null
  if (sample) headersOk++
  else if (sessionIds.length > 0) headersBad++
  perWorkspace.push({
    dir: entry.name,
    sessions: sessionIds.length,
    mb: bytes / 1048576,
    cwd: sample?.cwd ?? '(读不到)',
    preset: sample?.agentPreset ?? '',
  })
}

process.stdout.write(`\n共 ${totalSessions} 个会话，${(totalBytes / 1048576).toFixed(1)} MB 压缩数据\n`)
process.stdout.write(`会话头解析成功 ${headersOk} 个目录 / 失败 ${headersBad} 个\n`)

perWorkspace.sort((a, b) => b.sessions - a.sessions)
process.stdout.write('\n会话数最多的 8 个工作区：\n')
for (const w of perWorkspace.slice(0, 8)) {
  process.stdout.write(`  ${String(w.sessions).padStart(3)} 个  ${w.mb.toFixed(1).padStart(6)} MB  ${w.cwd}\n`)
}

/* ---------------- 3. 多帧 zstd 真机验证 ---------------- */
process.stdout.write('\n多帧 zstd 真机验证：\n')
let biggest = null
for (const entry of dirs) {
  const wsDir = join(paths.sessions, entry.name)
  let sessionIds = []
  try { sessionIds = readdirSync(wsDir) } catch { continue }
  for (const sessionId of sessionIds) {
    const file = join(wsDir, sessionId, 'session.v4.jsonl.zstd')
    try {
      const size = statSync(file).size
      if (!biggest || size > biggest.size) biggest = { file, size }
    } catch { /* 跳过 */ }
  }
}
if (biggest) {
  const text = readZstdFrames(biggest.file, 64 * 1024 * 1024)
  const lines = text.split('\n').filter(Boolean)
  const types = new Map()
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      types.set(parsed.type, (types.get(parsed.type) ?? 0) + 1)
    } catch { /* 坏行 */ }
  }
  const top = [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  process.stdout.write(`  最大会话：${(biggest.size / 1048576).toFixed(2)} MB → 解压 ${(text.length / 1048576).toFixed(2)} MB / ${lines.length} 条事件\n`)
  process.stdout.write(`  事件类型 top8：${top.map(([k, v]) => `${k}:${v}`).join('  ')}\n`)
  const userMessages = types.get('user/message') ?? 0
  process.stdout.write(`  可回填的 user/message：${userMessages} 条\n`)
}

/* ---------------- 4. 存储层只读打开 ---------------- */
const store = new MemoryStore(home)
const ledger = new GrantLedger(home)
process.stdout.write('\n存储层（只读打开，未创建任何文件）：\n')
process.stdout.write(`  记忆库：${store.live().length} 条 live / ${store.records.size} 条 total\n`)
process.stdout.write(`  授权台账：${ledger.grants.length} 条（有效 ${ledger.active().length}）\n`)
process.stdout.write(`  记忆路径：${paths.memories}\n`)
process.stdout.write(`  台账路径：${paths.grants}\n`)
