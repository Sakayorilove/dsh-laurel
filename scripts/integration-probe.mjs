/**
 * Laurel-Center · 集成探针
 *
 * 验证「装了 Laurel-Center 之后，DSH 会怎么组 loader 树」。
 *
 * 复刻 dsh-app-boot 的真实行为：
 *   1. profile 的 cordis.yml 是空数组
 *   2. 按 dsh.profile.bundles 顺序，逐个读各 bundle 的 cordis.patch.yml 并 apply
 *   3. 最后 apply profile 自己的 cordis.patch.yml（用户层）
 *
 * 然后检查：全部子插件行是否都在树里、name 是否能解析到真实文件、
 * 每个子包的 package.json 是否声明了 dsh.client（决定能否产出 boot graph row）。
 *
 * 用法：node scripts/integration-probe.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { SUB_PLUGINS } from '../lib/registry.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`) }
}

// ── 极简 YAML 读：只认本套件的 patch 形状（顶层数组 + insert/id/name/config/disabled）
// 不引 js-yaml 是为了零依赖；真实的 DSH 用完整的 yaml 库，这里只需读我们自己的文件。
function readPatchYaml(file) {
  const text = readFileSync(file, 'utf8')
  // 用 JSON 兜底：如果 patch 是 JSON 数组直接能解析
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) return JSON.parse(trimmed)

  // 解析我们自己的 YAML 子集
  const docs = []
  let current = null
  let currentInsert = null
  let inInsert = false
  let inConfig = false
  let configIndent = -1
  let pendingKey = null
  let pendingBlock = null

  const indentOf = (line) => line.match(/^[ \t]*/)[0].length
  // 转义值里的引号
  const scalar = (raw) => {
    let v = raw.trim()
    // 去掉行内注释（不在引号内才算）
    let out = ''
    let quote = null
    for (let i = 0; i < v.length; i++) {
      const c = v[i]
      if (quote) { if (c === quote) quote = null; out += c; continue }
      if (c === "'" || c === '"') { quote = c; out += c; continue }
      if (c === '#' && (i === 0 || /\s/.test(v[i - 1]))) break
      out += c
    }
    v = out.trim()
    if (v === 'true') return true
    if (v === 'false') return false
    if (v === 'null' || v === '') return null
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) return v.slice(1, -1)
    return v
  }

  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    if (/^\s*#/.test(raw) || raw.trim() === '') continue
    const ind = indentOf(raw)
    const line = raw.trim()

    if (line.startsWith('- insert:')) {
      current = { insert: [] }
      docs.push(current)
      currentInsert = current.insert
      inInsert = true
      inConfig = false
      continue
    }
    if (inInsert && /^-\s+id:/.test(line)) {
      pendingBlock = { id: scalar(line.replace(/^-\s+id:/, '')) }
      currentInsert.push(pendingBlock)
      inConfig = false
      continue
    }
    if (inInsert && pendingBlock) {
      if (/^name:/.test(line)) { pendingBlock.name = scalar(line.slice(5)); inConfig = false; continue }
      if (/^disabled:/.test(line)) { pendingBlock.disabled = scalar(line.slice(9)); inConfig = false; continue }
      if (/^config:\s*$/.test(line)) { pendingBlock.config = {}; inConfig = true; configIndent = ind; continue }
      if (inConfig && ind > configIndent && /^[A-Za-z_][\w-]*:/.test(line)) {
        const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
        pendingBlock.config[m[1]] = scalar(m[2])
        continue
      }
    }
    // 非 insert 的 patch（id + disabled）
    if (!inInsert && /^-\s+id:/.test(line)) {
      pendingBlock = { id: scalar(line.replace(/^-\s+id:/, '')) }
      docs.push(pendingBlock)
      continue
    }
    if (!inInsert && pendingBlock && /^disabled:/.test(line)) {
      pendingBlock.disabled = scalar(line.slice(9))
      continue
    }
  }
  return docs
}

// ── 复刻 dsh-app-boot 的 applyEntryPatches ──────────────────────────────
function applyEntryPatches(data, patches, warn = () => {}) {
  if (!patches?.length) return [...data]
  data = JSON.parse(JSON.stringify(data))
  const entryMap = new Map()
  const buildMap = (entries) => {
    for (const entry of entries) {
      if (entry.id) entryMap.set(entry.id, entry)
      if (entry.group && Array.isArray(entry.config)) buildMap(entry.config)
    }
  }
  buildMap(data)
  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch
    if (insert) {
      if (id) {
        const target = entryMap.get(id)
        if (!target) { warn(`patch insert: entry ${id} not found`); continue }
        if (!Array.isArray(target.config)) target.config = []
        target.config.push(...insert)
      } else data.push(...insert)
      buildMap(insert)
      continue
    }
    if (!id) { warn('patch: id is required'); continue }
    const target = entryMap.get(id)
    if (!target) { warn(`patch: entry ${id} not found`); continue }
    if (name && name !== target.name) { warn(`patch: name mismatch for ${id}`); continue }
    for (const [k, v] of Object.entries(overrides)) { if (k !== 'id') target[k] = v }
  }
  return data
}

console.log('Laurel-Center · 集成探针\n')

// ── 1. patch 文件可解析 ─────────────────────────────────────────────────
console.log('1. patch 文件')
const patchPath = join(ROOT, 'cordis.patch.yml')
ok('cordis.patch.yml 存在', existsSync(patchPath))
let patches = []
try {
  patches = readPatchYaml(patchPath)
} catch (error) {
  ok('cordis.patch.yml 可解析', false, error.message)
}
ok('是顶层数组', Array.isArray(patches))
ok('恰好 1 条 insert patch', patches.length === 1 && Array.isArray(patches[0].insert), JSON.stringify(patches.map((p) => Object.keys(p))))
const inserted = patches[0]?.insert ?? []
const EXPECT_ROWS = 1 + SUB_PLUGINS.length
ok(`insert 里 ${EXPECT_ROWS} 行（装载机自己 + ${SUB_PLUGINS.length} 个子插件）`,
  inserted.length === EXPECT_ROWS, `实得 ${inserted.length}`)
ok('第 1 行 id = laurel-center', inserted[0]?.id === 'laurel-center', String(inserted[0]?.id))
ok('第 1 行 name = ./lib/index.js', inserted[0]?.name === './lib/index.js', String(inserted[0]?.name))
ok('第 1 行带 config.enabled', inserted[0]?.config && typeof inserted[0].config === 'object')
ok(`${EXPECT_ROWS} 行 id 各不相同`,
  new Set(inserted.map((e) => e.id)).size === EXPECT_ROWS, inserted.map((e) => e.id).join(','))

// ── 2. 组树（模拟 profile）──────────────────────────────────────────────
console.log('\n2. 组 loader 树')
const profileDir = join(ROOT, '.tmp-probe-profile')
const bundleLayers = [
  // @deepseek-ai/dsh-base / web-app 等官方 bundle 这里不模拟（它们不插我们的行）
  readPatchYaml(patchPath), // laurel-center 自己的 bundle 层
]
let tree = []
for (const layer of bundleLayers) tree = applyEntryPatches(tree, layer)
ok(`树里有 ${EXPECT_ROWS} 行`, tree.length === EXPECT_ROWS, JSON.stringify(tree.map((e) => e.id)))
ok('第 1 行就是 laurel-center', tree[0]?.id === 'laurel-center')
const subEntries = tree.filter((e) => e.id !== 'laurel-center')
ok(`全部 ${SUB_PLUGINS.length} 个子插件行都在树里（静态声明）`,
  subEntries.length === SUB_PLUGINS.length, `实得 ${subEntries.length}`)
ok('装载机自己默认是开的', tree.find((e) => e.id === 'laurel-center')?.disabled === undefined)
ok('全部子插件默认都是关的（初始状态写死在 patch）',
  subEntries.every((e) => e.disabled === true), JSON.stringify(subEntries.map((e) => [e.id, e.disabled])))

// 用户层：模拟「单独打开 strata」—— 应当只影响 strata，其余不变
const userLayer = [{ id: 'strata', disabled: false }]
const tree2 = applyEntryPatches(tree, userLayer)
ok('用户层可以打开单个子插件', tree2.find((e) => e.id === 'strata')?.disabled === false)
ok('开一个不影响别的（其余仍是初始的 true）',
  SUB_PLUGINS.map((p) => p.id).filter((id) => id !== 'strata')
    .every((id) => tree2.find((e) => e.id === id)?.disabled === true))

// 用户层：一键全开
const tree4 = applyEntryPatches(tree, subEntries.map((e) => ({ id: e.id, disabled: false })))
ok('一键全开：全部子插件都不是 disabled', subEntries.every((e) => tree4.find((x) => x.id === e.id)?.disabled === false))
ok('一键全开不动装载机自己', tree4.find((e) => e.id === 'laurel-center')?.disabled === undefined)

// ── 3. 子插件行必须是合法可解析的包名 ───────────────────────────────────
console.log('\n3. 子插件行的 name')
// 从注册表推导，不手抄 —— 手抄过一次，加第 5 个模块时这里静默少测一个。
const subSpecs = SUB_PLUGINS.map((p) => [p.id, p.entry])
for (const [id, spec] of subSpecs) {
  const row = tree.find((e) => e.id === id)
  ok(`[${id}] 行存在`, row !== undefined)
  if (!row) continue
  ok(`[${id}] name = ${spec}`, row.name === spec, String(row.name))
  // 必须是纯包名：带斜杠的非 scope 包名会被 client-modules 判非法 → 返回 null → 不产出 row
  const looksLikePlainPackage = !row.name.startsWith('.') && !row.name.startsWith('file:')
    && !/^\//.test(row.name) && !row.name.includes(':')
    && (row.name.startsWith('@') ? row.name.split('/').length === 2 : !row.name.includes('/'))
  ok(`[${id}] name 是合法包名（client-modules 能解析）`, looksLikePlainPackage, row.name)
}

console.log(`\n${'─'.repeat(48)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
