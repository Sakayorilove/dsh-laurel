/**
 * Laurel-Center · 离线自检
 *
 * 不依赖 DSH 运行时，直接 import 宿主半边的各个模块，验证：
 *   1. 模块语法与导出完整
 *   2. 注册表自洽（id 唯一、entry 指向本包内的真实文件）
 *   3. 每个子包的 package.json 与 client bundle 存在、且三处 id 一致
 *   4. 原生适配层：id→entryId 映射、冲突拒绝、结果合同（R1/R4/R6）
 *   5. 一次性迁移只带「开」的意图、绝不被反复执行（R1）
 *   6. 记账与事件日志轮转
 *   7. 客户端 bundle 可执行、inject 白名单、走原生 RPC（R2/R3）
 *   8. 结构性断言：宿主半边不再暴露裸 HTTP 写端点（R2）
 *   9. 仓库里每个 JS/MJS/CJS 都能被解析（R3）
 *  10. 装配校验核在缺文件时**返回结论**而不是抛异常（R7）
 *
 * 用法：node scripts/check.mjs
 */

import { existsSync, readFileSync, statSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { unknownClientServices } from './client-services.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

/**
 * 找 `@deepseek-ai/dsh-client-ui-slots` 的入口文件。找不到返回 null。
 *
 * 仓库本身是零依赖的，这个包只在装了 DSH 的机器上才有 —— 所以**找不到就跳过**，
 * 不当失败（否则别人克隆下来跑 check 会红一片）。想显式指定就用 DSH_CLIENT_SLOTS。
 */
function resolveClientSlotsEntry() {
  const rel = join('node_modules', '@deepseek-ai', 'dsh-client-ui-slots', 'lib', 'index.js')
  const candidates = [
    process.env.DSH_CLIENT_SLOTS,
    join(ROOT, rel),
    join(homedir(), 'projects', 'deepseek-harness-runtime', rel),
  ]
  return candidates.find((p) => typeof p === 'string' && p.length > 0 && existsSync(p)) ?? null
}

// ── 1. 模块可加载 ────────────────────────────────────────────────────────
section('1. 模块加载')
const registry = await import('../lib/registry.js')
const store = await import('../lib/store.js')
const host = await import('../lib/host.js')
const migrate = await import('../lib/migrate.js')
const result = await import('../lib/result.js')
const config = await import('../lib/config.js')
const changeResult = await import('../lib/change-result.js')
const patchLib = await import('../lib/patch.js')
const identityLib = await import('../lib/identity.js')
const hostMod = await import('../lib/index.js')
ok('registry.js 可加载', typeof registry.SUB_PLUGINS !== 'undefined')
ok('store.js 可加载', typeof store.loadState === 'function')
ok('host.js 可加载', typeof host.listNative === 'function' && typeof host.setNative === 'function')
ok('migrate.js 可加载', typeof migrate.planMigration === 'function')
ok('result.js 可加载', typeof result.envelope === 'function')
ok('change-result.js 可加载（宿主与客户端共用的唯一解释器）', typeof changeResult.interpretChangeResult === 'function')
ok('patch.js 可加载（读用户层显式条目）', typeof patchLib.readUserOverrides === 'function')
ok('identity.js 可加载（运行实例身份）', typeof identityLib.makeIdentity === 'function')
ok('config.js 可加载', typeof config.PACKAGE_NAME === 'string')
ok('index.js 可加载', typeof hostMod.apply === 'function')
ok('index.js 顶层 inject 为空数组', Array.isArray(hostMod.inject) && hostMod.inject.length === 0)

// ── 2. 注册表自洽 ────────────────────────────────────────────────────────
section('2. 注册表自洽')
const plugins = registry.SUB_PLUGINS
// 不再硬编「4」：模块可以随时增删，数量要与 packages/ 下登记过的目录一致。
// 硬编数字在增删模块时会变成一条永远为假（或永远为真）的断言 —— 那正是
// 「测试全绿 ≠ 生产没坏」的典型来源。
const moduleDirs = readdirSync(join(ROOT, 'packages')).filter((n) => !n.startsWith('.') && n !== 'node_modules')
ok('注册表条目数 = packages/ 下登记的模块目录数', plugins.length === moduleDirs.length, `注册表 ${plugins.length} / 目录 ${moduleDirs.length}`)
const ids = plugins.map((p) => p.id)
ok('id 唯一', new Set(ids).size === ids.length, ids.join(','))
ok('id 与目录名映射齐全', plugins.every((p) => typeof p.dir === 'string' && p.dir.length > 0))
ok('entry 都是纯包名（client-modules 能解析）', plugins.every((p) => !p.entry.includes('/') && !p.entry.startsWith('.')), plugins.map((p) => p.entry).join(','))
ok('entry 与 clientId 一致', plugins.every((p) => p.entry === p.clientId), plugins.map((p) => `${p.entry}!=${p.clientId}`).join(','))

// ── 3. 子包实体存在 ──────────────────────────────────────────────────────
section('3. 子包实体')
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
ok('根包名是 laurel-center', rootPkg.name === 'laurel-center', rootPkg.name)
ok('根包声明了 dsh.client', rootPkg.dsh?.client?.platform === 'web')
ok('根包声明了 dsh.bundle.patch', typeof rootPkg.dsh?.bundle?.patch === 'string')
ok('版本与 config.js 一致', rootPkg.version === config.VERSION, `${rootPkg.version} vs ${config.VERSION}`)

for (const p of plugins) {
  const dir = join(ROOT, 'packages', p.dir)
  const pkgPath = join(dir, 'package.json')
  const hasPkg = existsSync(pkgPath)
  ok(`[${p.id}] package.json 存在`, hasPkg)
  if (!hasPkg) continue

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  ok(`[${p.id}] 包名与 clientId 一致`, pkg.name === p.clientId, `${pkg.name} vs ${p.clientId}`)

  const mainRel = typeof pkg.exports?.['.'] === 'string' ? pkg.exports['.'] : pkg.main
  ok(`[${p.id}] 宿主入口存在 (${mainRel})`, mainRel && existsSync(join(dir, mainRel)), String(mainRel))

  const clientRel = pkg.exports?.['./client']
  ok(`[${p.id}] client bundle 存在 (${clientRel})`, typeof clientRel === 'string' && existsSync(join(dir, clientRel)), String(clientRel))

  const rel = join(ROOT, 'packages', p.dir)
  ok(`[${p.id}] 源码在本包 packages/ 内`, rel.startsWith(join(ROOT, 'packages')))

  if (typeof clientRel === 'string' && existsSync(join(dir, clientRel))) {
    const bundle = readFileSync(join(dir, clientRel), 'utf8')
    const stripped = bundle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    const m = stripped.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*['"]([^'"]+)['"]/)
    ok(`[${p.id}] bundle 注册 id = ${p.clientId}`, m !== null && m[1] === p.clientId, m ? m[1] : '未找到 load({id})')
    ok(`[${p.id}] bundle 声明 dsh.client.platform=web`, pkg.dsh?.client?.platform === 'web')
  }

  const trapKeys = Object.keys(rootPkg.exports ?? {}).filter((k) => k.startsWith('./packages/'))
  ok(`[${p.id}] 根包 exports 没有埋雷的包内子路径`, trapKeys.length === 0, trapKeys.join(', '))
}

// ── 4. 原生适配层（桩 pluginManager）─────────────────────────────────────
section('4. 原生适配层（桩 pluginManager）')

/** 造一个假 ctx，只提供 pluginManager（可带 profile.patchPath / profileContext）。 */
function stubCtx({ rows, behaviour, patchPath, profileContext }) {
  const calls = []
  return {
    calls,
    get(name) {
      if (name === 'profileContext') return profileContext ?? null
      if (name !== 'pluginManager') return null
      return {
        profile: patchPath === undefined ? undefined : { patchPath },
        listPlugins: async () => {
          if (behaviour?.listThrows) throw new Error('list boom')
          return rows
        },
        setPluginEnabled: async (entryId, enabled) => {
          calls.push({ entryId, enabled })
          if (behaviour?.setThrows) throw new Error('set boom')
          // 显式给 undefined 也要原样返回（测「协议缺字段」）
          if (behaviour && Object.prototype.hasOwnProperty.call(behaviour, 'answer')) return behaviour.answer
          return { application: 'applied', changed: true, warnings: [] }
        },
      }
    },
  }
}

const readyRows = plugins.map((p) => ({
  entryId: 'include:' + p.id,
  moduleName: p.entry,
  patchId: p.id,
  enabled: false,
  fiberPhase: null,
}))

{
  const ctx = stubCtx({ rows: readyRows })
  const map = await host.listNative(ctx)
  ok('listNative 四条都 ready', plugins.every((p) => map[p.id].state === 'ready'), JSON.stringify(map))
  ok('entryId 映射正确', map.laurel.entryId === 'include:laurel', String(map.laurel.entryId))
  ok('fiberPhase 透传', map.laurel.fiberPhase === null, String(map.laurel.fiberPhase))
}

{
  // 同名多行 → ambiguous，绝不猜第一个（R6）
  const ctx = stubCtx({ rows: [...readyRows, { entryId: 'include:laurel2', moduleName: 'laurel', patchId: 'laurel', enabled: true, fiberPhase: 'active' }] })
  const map = await host.listNative(ctx)
  ok('重复 patchId → ambiguous（不猜第一个）', map.laurel.state === 'ambiguous' && map.laurel.count === 2, JSON.stringify(map.laurel))
}

{
  // 包名不符 → name-mismatch
  const rows = readyRows.map((r) => (r.patchId === 'strata' ? { ...r, moduleName: 'unrelated-plugin' } : r))
  const ctx = stubCtx({ rows })
  const map = await host.listNative(ctx)
  ok('包名不符 → name-mismatch', map.strata.state === 'name-mismatch', JSON.stringify(map.strata))
}

{
  // 缺行 → missing
  const ctx = stubCtx({ rows: readyRows.filter((r) => r.patchId !== 'loom') })
  const map = await host.listNative(ctx)
  ok('缺行 → missing（不凭空造行）', map.loom.state === 'missing', JSON.stringify(map.loom))
}

{
  // readOnlyReason → read-only
  const rows = readyRows.map((r) => (r.patchId === 'loom' ? { ...r, readOnlyReason: 'unaddressable' } : r))
  const ctx = stubCtx({ rows })
  const map = await host.listNative(ctx)
  ok('readOnlyReason → read-only', map.loom.state === 'read-only' && map.loom.reason === 'unaddressable', JSON.stringify(map.loom))
}

{
  // 没有 pluginManager → no-native，且不抛
  const map = await host.listNative({ get: () => null })
  ok('无 pluginManager → no-native（不抛）', plugins.every((p) => map[p.id].state === 'no-native'))
}

{
  const ctx = stubCtx({ rows: readyRows })
  const r = await host.setNative(ctx, 'laurel', true)
  ok('setNative 用 entryId 调原生 setPluginEnabled', ctx.calls[0]?.entryId === 'include:laurel' && ctx.calls[0]?.enabled === true, JSON.stringify(ctx.calls))
  ok('application=applied → ok/saved/applied 全 true', r.ok && r.saved === true && r.applied === true, JSON.stringify(r))
  ok('applied → outcome=success', r.outcome === 'success', JSON.stringify(r))
}

{
  const ctx = stubCtx({ rows: readyRows, behaviour: { answer: { application: 'restart-required', changed: true } } })
  const r = await host.setNative(ctx, 'laurel', true)
  ok('restart-required → saved=true 但 applied=false（不谎报已生效）', r.ok && r.saved === true && r.applied === false, JSON.stringify(r))
  ok('restart-required → reason 明确、重启能解决', r.reason === 'restart-required' && r.restartHelps === true, JSON.stringify(r))
}

{
  const ctx = stubCtx({ rows: readyRows, behaviour: { answer: { application: 'overridden', changed: true } } })
  const r = await host.setNative(ctx, 'laurel', true)
  ok('overridden → partial 且**不承诺**重启能解决', r.outcome === 'partial' && r.reason === 'overridden' && r.restartHelps === false, JSON.stringify(r))
}

{
  const ctx = stubCtx({ rows: readyRows, behaviour: { answer: { application: 'failed', changed: false, error: { code: 'unaddressable' } } } })
  const r = await host.setNative(ctx, 'laurel', true)
  ok('failed → ok=false 且带原生错误码', !r.ok && r.code === 'unaddressable', JSON.stringify(r))
  ok('failed → saved=false（没保存）', r.saved === false && r.outcome === 'failure', JSON.stringify(r))
}

{
  // F2 第 3 条：协议缺字段（native 返回 undefined）不许当成功保存
  const ctx = stubCtx({ rows: readyRows, behaviour: { answer: undefined } })
  const r = await host.setNative(ctx, 'laurel', true)
  ok('协议缺字段 → outcome=unknown，saved=null（不是 true）', r.outcome === 'unknown' && r.saved === null && r.ok === false, JSON.stringify(r))
}

{
  const ctx = stubCtx({ rows: readyRows, behaviour: { setThrows: true } })
  const r = await host.setNative(ctx, 'laurel', true)
  ok('setPluginEnabled 抛异常 → 转成结果不冒泡', !r.ok && r.code === 'transport-error', JSON.stringify(r))
}

{
  const ctx = stubCtx({ rows: readyRows })
  const r = await host.setNative(ctx, 'nope', true)
  ok('未知 id → unknown-plugin', !r.ok && r.code === 'unknown-plugin', JSON.stringify(r))
}

{
  // 映射不上时绝不下发写请求（不能误伤别的行）
  const ctx = stubCtx({ rows: readyRows.filter((r) => r.patchId !== 'laurel') })
  const r = await host.setNative(ctx, 'laurel', true)
  ok('missing 时不下发原生写请求', !r.ok && ctx.calls.length === 0, JSON.stringify({ r, calls: ctx.calls }))
}

{
  // F2 第 2 条：写盘成功但 reload 失败 → 回读用户层确认目标值，saved 必须为 true
  const patchPath = join(ROOT, '.tmp-check-user-patch.yml')
  writeFileSync(patchPath, '- id: laurel\n  disabled: false\n')
  const ctx = stubCtx({
    rows: readyRows,
    patchPath,
    behaviour: { answer: { application: 'failed', changed: true, error: { code: 'reload-failed' } } },
  })
  const r = await host.setNative(ctx, 'laurel', true)
  ok('failed+changed 但回读确认目标值已到位 → saved=true / partial / reload-failed',
    r.saved === true && r.outcome === 'partial' && r.reason === 'reload-failed', JSON.stringify(r))
  rmSync(patchPath, { force: true })
}

{
  // 回读说目标值不是我们要的 → 不能算保存成功
  const patchPath = join(ROOT, '.tmp-check-user-patch2.yml')
  writeFileSync(patchPath, '- id: laurel\n  disabled: true\n')
  const ctx = stubCtx({
    rows: readyRows,
    patchPath,
    behaviour: { answer: { application: 'failed', changed: true } },
  })
  const r = await host.setNative(ctx, 'laurel', true)
  ok('回读说目标值没到位 → saved=false / failure', r.saved === false && r.outcome === 'failure', JSON.stringify(r))
  rmSync(patchPath, { force: true })
}

// ── 5. 结果合同（F2：宿主与客户端共用同一份解释器）───────────────────────
section('5. 结果合同')
{
  const { interpretChangeResult, summarizeChange, itemOutcome, normalizeApplication } = changeResult
  ok('applied → outcome=success / saved=true / applied=true',
    interpretChangeResult({ application: 'applied' }).outcome === 'success')
  ok('restart-required → partial / saved=true / applied=false',
    (() => { const r = interpretChangeResult({ application: 'restart-required' }); return r.outcome === 'partial' && r.saved === true && r.applied === false })())
  ok('overridden → partial 且 restartHelps=false',
    (() => { const r = interpretChangeResult({ application: 'overridden' }); return r.outcome === 'partial' && r.restartHelps === false })())
  ok('failed（未回读）→ failure / saved=false',
    (() => { const r = interpretChangeResult({ application: 'failed' }); return r.outcome === 'failure' && r.saved === false })())
  ok('failed + 回读确认目标值 → partial / saved=true / reason=reload-failed',
    (() => { const r = interpretChangeResult({ application: 'failed', changed: true }, { confirmTarget: true }); return r.outcome === 'partial' && r.saved === true && r.reason === 'reload-failed' })())
  ok('协议缺字段 → unknown / saved=null（不是成功）',
    (() => { const r = interpretChangeResult(undefined); return r.outcome === 'unknown' && r.saved === null && normalizeApplication('bogus') === 'unknown' })())
  ok('unknown + 回读确认目标值 → partial / saved=true（应用未确认）',
    (() => { const r = interpretChangeResult(undefined, { confirmTarget: true }); return r.outcome === 'partial' && r.saved === true })())
  ok('cancelled → failure', interpretChangeResult({ application: 'cancelled' }).outcome === 'failure')
  ok('transportError → failure / code=transport-error',
    (() => { const r = interpretChangeResult(null, { transportError: 'boom' }); return r.outcome === 'failure' && r.code === 'transport-error' })())

  // F2 第 1 条：全部模块都是 restart-required、逐项 partial → bulk 必须是 partial
  //
  // ⚠ 这里的条数**必须从注册表推导**，不能写死。写死过一次：加第 5 个模块
  // （warden）之后，这条断言立刻变成假失败 —— 而它验的其实是"逐项 partial 会被
  // 正确汇总成 partial"，跟到底有几个模块毫无关系。
  const all = plugins.map((p) => ({ id: p.id, ...interpretChangeResult({ application: 'restart-required' }) }))
  const s = summarizeChange(all)
  ok(`全部 ${plugins.length} 项 restart-required → 汇总 partial（不是 success）`,
    s.outcome === 'partial' && s.partial === plugins.length, JSON.stringify(s))
  ok('一项 unknown → 汇总 partial（未知不算成功）', summarizeChange([{ outcome: 'success' }, { outcome: 'unknown' }]).outcome === 'partial')
  ok('全 success → 汇总 success', summarizeChange([{ outcome: 'success' }, { outcome: 'success' }]).outcome === 'success')
  ok('全 failure → 汇总 failure', summarizeChange([{ outcome: 'failure' }, { outcome: 'failure' }]).outcome === 'failure')
  ok('itemOutcome 兼容裸形状', itemOutcome({ ok: true, hostApplied: true }) === 'success' && itemOutcome({ ok: false }) === 'failure')

  const env = result.envelope('op-1', [
    { id: 'laurel', ok: true, outcome: 'success', saved: true, applied: true, code: 'ok' },
    { id: 'strata', ok: false, outcome: 'failure', saved: false, applied: false, code: 'ambiguous' },
  ])
  ok('外层 outcome=partial（不再一票通过）', env.outcome === 'partial', JSON.stringify(env))
  ok('外层没有裸 ok:true 掩盖失败', env.ok === undefined, JSON.stringify(Object.keys(env)))
  ok('逐项带 saved/applied/code', env.items.length === 2 && env.items[1].saved === false && env.items[1].code === 'ambiguous')
  ok('汇总计数正确', env.succeeded === 1 && env.failed === 1 && env.total === 2, JSON.stringify(env))

  const env2 = result.envelope('op-2', [{ id: 'laurel', ok: false, outcome: 'failure', code: 'missing' }])
  ok('全失败 → outcome=failure', env2.outcome === 'failure', JSON.stringify(env2))

  const env3 = result.envelope('op-3', [{ id: 'laurel', ok: false, outcome: 'unknown', saved: null, code: 'application-unknown' }])
  ok('unknown 项 → 外层 partial，且 saved 是 null 不是 true', env3.outcome === 'partial' && env3.items[0].saved === null, JSON.stringify(env3))
}

// ── 5b. 用户层读取（F1 的地基）──────────────────────────────────────────
section('5b. 用户层 patch 读取')
{
  const dir = join(ROOT, '.tmp-check-patch')
  rmSync(dir, { recursive: true, force: true })
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  const profilePatch = join(dir, 'cordis.patch.yml')
  writeFileSync(profilePatch, [
    '# 用户层',
    '- id: laurel',
    '  disabled: true',
    '- id: strata',
    '  disabled: false',
    '- insert:',
    '    - id: loom',
    '      name: dsh-loom',
    '      disabled: true',
    '',
  ].join('\n'))

  const overrides = patchLib.readUserOverrides([profilePatch])
  ok('读到用户层显式条目', overrides.ok && overrides.overrides.laurel !== undefined, JSON.stringify(overrides))
  ok('显式关闭被读成 disabled=true', overrides.overrides.laurel?.disabled === true, JSON.stringify(overrides.overrides.laurel))
  ok('显式打开被读成 disabled=false', overrides.overrides.strata?.disabled === false)
  ok('`insert:` 里的行**不算**用户显式表态', overrides.overrides.loom === undefined, JSON.stringify(overrides.overrides))
  ok('没提到的 id 没有 override', !patchLib.hasExplicitOverride(overrides.overrides, 'claude-parchment'))

  const missing = patchLib.readUserOverrides([join(dir, 'nope.yml')])
  ok('文件不存在 → ok:true 但没有 override（≠ 读失败）', missing.ok === true && Object.keys(missing.overrides).length === 0)

  const unreadable = patchLib.readUserOverrides([profilePatch], { readFile: () => { throw new Error('EACCES') } })
  ok('读文件报错 → ok:false（上层据此不自动写）', unreadable.ok === false, JSON.stringify(unreadable))

  // ── R7（2026-10-13 第四轮）：`entries` / `rows` **永远存在** ──────────────
  // 调用方普遍写 `[...patch.entries, ...patch.rows]`。少一个键就是 TypeError，
  // 而抛出的位置在**安装事务的装配校验**里 —— 结果是「回滚之前就整个崩掉」，
  // 比「校验报失败」严重得多（现场见 R7）。所以这里把契约钉死：
  // 每一条返回路径都必须给出两个数组，并且真的能展开。
  const spreadOk = (r) => { try { return Array.isArray([...r.entries, ...r.rows]) } catch { return false } }
  const contract = (label, r) => ok(
    `readPatchFile ${label} → entries / rows 都在，展开不抛 TypeError`,
    Array.isArray(r.entries) && Array.isArray(r.rows) && spreadOk(r),
    JSON.stringify({ entries: r.entries, rows: r.rows }),
  )
  contract('路径为空时', patchLib.readPatchFile(''))
  contract('文件不存在时', patchLib.readPatchFile(join(dir, 'nope.yml')))
  contract('读文件报错时', patchLib.readPatchFile(profilePatch, { readFile: () => { throw new Error('EACCES') } }))
  contract('正常读到文件时', patchLib.readPatchFile(profilePatch))
  // 走行扫描（拿不到宿主 yaml）那条分支也要同形状 —— 两条通道都别漏。
  contract('退回行扫描时', patchLib.readPatchFile(profilePatch, { installAnchor: undefined }))

  rmSync(dir, { recursive: true, force: true })
}

// ── 5c. 运行实例身份（F7）────────────────────────────────────────────────
section('5c. 运行实例身份')
{
  const dir = join(ROOT, '.tmp-check-identity')
  rmSync(dir, { recursive: true, force: true })
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'release.manifest.json'), JSON.stringify({
    at: '2026-10-12T00:00:00.000Z',
    fileCount: 2,
    totalBytes: 3,
    source: { head: 'abc', dirty: false },
    files: [{ path: 'a.js', size: 1, sha256: '11' }, { path: 'b.js', size: 2, sha256: '22' }],
  }))
  const one = identityLib.makeIdentity({ root: dir, now: '2026-10-12T01:00:00.000Z' })
  ok('身份带 version', typeof one.version === 'string' && one.version.length > 0, one.version)
  ok('身份带 buildHash（清单汇总）', typeof one.buildHash === 'string' && one.buildHash.length === 64, String(one.buildHash))
  ok('身份带 builtAt / startAt / instanceId', one.builtAt === '2026-10-12T00:00:00.000Z' && one.startAt === '2026-10-12T01:00:00.000Z' && typeof one.instanceId === 'string')
  ok('清单里的 source HEAD 被带出来', one.source?.head === 'abc', JSON.stringify(one.source))
  const two = identityLib.makeIdentity({ root: dir })
  ok('同清单 → 同 buildHash（可复现）', two.buildHash === one.buildHash)

  // 清单里的顺序不影响指纹
  writeFileSync(join(dir, 'release.manifest.json'), JSON.stringify({
    files: [{ path: 'b.js', size: 2, sha256: '22' }, { path: 'a.js', size: 1, sha256: '11' }],
  }))
  ok('清单文件顺序不影响 buildHash', identityLib.makeIdentity({ root: dir }).buildHash === one.buildHash)

  rmSync(join(dir, 'release.manifest.json'), { force: true })
  const none = identityLib.makeIdentity({ root: dir })
  ok('清单缺失 → buildHash=null 且标明未确认（不造假指纹）',
    none.buildHash === null && String(none.buildEvidence).startsWith('unconfirmed'), JSON.stringify(none.buildEvidence))
  rmSync(dir, { recursive: true, force: true })
}

// ── 6. 一次性迁移（F1：尊重用户层、按 profile 记完成）────────────────────
section('6. 一次性迁移')
const nativeOff = Object.fromEntries(plugins.map((p) => [p.id, { state: 'ready', enabled: false }]))
const nativeOn = Object.fromEntries(plugins.map((p) => [p.id, { state: 'ready', enabled: true }]))
const attributionOk = { ok: true, key: '/profiles/desktop' }
const OLD = { enabled: { laurel: true }, updatedAt: '2026-01-01T00:00:00Z' }

{
  const plan = migrate.planMigration(OLD, nativeOff, { overrides: {}, userLayerOk: true, attribution: attributionOk })
  ok('旧 state 说开 + 原生关 → 要迁移', plan.needed && plan.writes.length === 1 && plan.writes[0] === 'laurel', JSON.stringify(plan))
  ok('没有 pending → 可以收尾', plan.terminal === true, JSON.stringify(plan))
}

{
  // F1 的第一条反例：用户层显式关闭，迁移必须闭嘴
  const plan = migrate.planMigration(OLD, nativeOff, {
    overrides: { laurel: { disabled: true, from: 'x' } }, userLayerOk: true, attribution: attributionOk,
  })
  ok('用户层显式 disabled:true → 不迁移（skipped-by-user）',
    !plan.needed && plan.items.find((i) => i.id === 'laurel')?.action === 'skipped-by-user', JSON.stringify(plan))
}

{
  // 用户层显式打开：宿主已经是开的，不必再写
  const plan = migrate.planMigration(OLD, nativeOn, {
    overrides: { laurel: { disabled: false, from: 'x' } }, userLayerOk: true, attribution: attributionOk,
  })
  ok('用户层显式打开 → 不迁移', !plan.needed, JSON.stringify(plan))
}

{
  const plan = migrate.planMigration(OLD, nativeOn, { overrides: {}, userLayerOk: true, attribution: attributionOk })
  ok('用户层已经是开的 → already-on，不重复写',
    !plan.needed && plan.items.find((i) => i.id === 'laurel')?.action === 'already-on', JSON.stringify(plan))
}

{
  // F1 的第二条反例：原生没就绪 → 必须 pending，且不许打完成标记
  const notReady = Object.fromEntries(plugins.map((p) => [p.id, { state: 'no-native' }]))
  const plan = migrate.planMigration(OLD, notReady, { overrides: {}, userLayerOk: true, attribution: attributionOk })
  ok('原生未就绪 → pending（不写、不收尾）',
    plan.pending.length === 1 && plan.terminal === false && plan.needed === false, JSON.stringify(plan))
  ok('pending 时不可能完成', migrate.completionState(plan, {}).complete === false)
}

{
  // 归属判不出来 → 只给建议，不往任何 profile 写
  const plan = migrate.planMigration(OLD, nativeOff, { overrides: {}, userLayerOk: true, attribution: { ok: false, reason: 'no-profile-context' } })
  ok('判不出归属 → unattributed 且不写',
    !plan.needed && plan.terminal === false && plan.items[0]?.action === 'unattributed', JSON.stringify(plan))
}

{
  // 用户层读不了 → 无法判断有没有显式关闭，绝不自动写
  const plan = migrate.planMigration(OLD, nativeOff, { overrides: {}, userLayerOk: false, attribution: attributionOk })
  ok('用户层读不了 → user-layer-unreadable 且不写',
    plan.reason === 'user-layer-unreadable' && plan.writes.length === 0, JSON.stringify(plan))
}

{
  const plan = migrate.planMigration(OLD, nativeOff, { overrides: {}, userLayerOk: true, attribution: attributionOk, completed: true })
  ok('当前 profile 已完成 → 不再迁移', !plan.needed && plan.reason === 'already-migrated', JSON.stringify(plan))
}

{
  const plan = migrate.planMigration({ enabled: { laurel: false }, updatedAt: '2026-01-01T00:00:00Z' }, nativeOn, { overrides: {}, userLayerOk: true, attribution: attributionOk })
  ok('绝不迁移「关」（不反向覆盖用户层）',
    !plan.needed && plan.items.find((i) => i.id === 'laurel')?.action === 'not-requested', JSON.stringify(plan))
}

{
  const plan = migrate.planMigration({ enabled: {}, updatedAt: null, migratedAt: null }, nativeOff, { overrides: {}, userLayerOk: true, attribution: attributionOk })
  ok('没有旧 state → 不迁移且不收尾', !plan.needed && plan.reason === 'no-saved-state' && plan.terminal === false, JSON.stringify(plan))
}

{
  const plan = migrate.planMigration(OLD, nativeOff, { overrides: {}, userLayerOk: true, attribution: attributionOk })
  ok('保存成功 → 该项完成', migrate.itemCompletion('migrate', { outcome: 'success', saved: true }) === true)
  ok('restart-required（saved:true）→ 该项完成', migrate.itemCompletion('migrate', { outcome: 'partial', saved: true }) === true)
  ok('**写入失败 → 该项未完成**（G1：不许打完成标记）', migrate.itemCompletion('migrate', { outcome: 'failure', saved: false }) === false)
  ok('**未确认（saved:null）→ 该项未完成**', migrate.itemCompletion('migrate', { outcome: 'partial', saved: null }) === false)
  ok('pending 不算完成', migrate.itemCompletion('pending', null) === false)
  ok('用户明确表态 / 无需处理 算完成',
    migrate.itemCompletion('skipped-by-user', null) === true
    && migrate.itemCompletion('already-on', null) === true
    && migrate.itemCompletion('not-requested', null) === true)

  const okState = migrate.completionState(plan, { laurel: { outcome: 'partial', saved: true, reason: 'restart-required' } })
  ok('全部完成 → complete=true', okState.complete === true && okState.incomplete.length === 0, JSON.stringify(okState))
  const badState = migrate.completionState(plan, { laurel: { outcome: 'failure', saved: false, reason: 'native-error' } })
  ok('有失败 → complete=false 且带原因', badState.complete === false && badState.incomplete[0]?.reason === 'native-error', JSON.stringify(badState))
  const unconfirmed = migrate.completionState(plan, { laurel: { outcome: 'unknown', saved: null, reason: 'unconfirmed' } })
  ok('有未确认 → complete=false', unconfirmed.complete === false, JSON.stringify(unconfirmed))
  const noopState = migrate.completionState({ ...plan, reason: 'no-saved-state', items: [] }, {})
  ok('没有旧 state → noop（不记完成也不记失败）', noopState.noop === true && noopState.complete === false, JSON.stringify(noopState))
}

{
  // G1 反例：失败之后**不能**被 already-migrated 吞掉
  const plans = migrate.planMigration(OLD, nativeOff, { overrides: {}, userLayerOk: true, attribution: attributionOk })
  const failed = migrate.completionState(plans, { laurel: { outcome: 'failure', saved: false } })
  ok('G1：失败不产生完成状态（下次启动仍会处理）', failed.complete === false)
  const recovered = migrate.completionState(plans, { laurel: { outcome: 'partial', saved: true } })
  ok('G1：恢复后同一次计划可以完成', recovered.complete === true)
}

{
  // 另一 profile 不被第一 profile 的标记吞掉：completed 只影响当前 profile
  const a = migrate.planMigration(OLD, nativeOff, { overrides: {}, userLayerOk: true, attribution: { ok: true, key: '/profiles/a' }, completed: true })
  const b = migrate.planMigration(OLD, nativeOff, { overrides: {}, userLayerOk: true, attribution: { ok: true, key: '/profiles/b' }, completed: false })
  ok('profile A 已完成不吞掉 profile B', a.reason === 'already-migrated' && b.needed === true, JSON.stringify({ a: a.reason, b: b.needed }))
}

// ── 7. 记账 ──────────────────────────────────────────────────────────────
section('7. 记账')
const fakePaths = store.centerPaths(join(ROOT, '.tmp-check-home'))
const s0 = store.loadState(fakePaths)
ok('无文件时返回默认值', s0.revision === 0 && s0.migratedAt === null, JSON.stringify(s0))
const s1 = store.saveState({ laurel: false, strata: true, 'claude-parchment': false, loom: true }, fakePaths)
ok('saveState 成功', s1.ok === true, JSON.stringify(s1))
const s2 = store.loadState(fakePaths)
ok('回读到刚写的值', s2.enabled.laurel === false && s2.enabled.loom === true, JSON.stringify(s2.enabled))
ok('revision 递增', s2.revision === 1, String(s2.revision))
ok('appendEvent 成功', store.appendEvent({ kind: 'check' }, fakePaths) === true)
const mm = store.recordMigration('check-profile', { pending: { reason: 'test', attempts: 1, incomplete: [{ id: 'laurel' }] } }, fakePaths)
ok('recordMigration 成功', mm.ok === true, JSON.stringify(mm))
ok('回读到该 profile 的进度记录', store.loadMigrations(fakePaths).profiles['check-profile'] !== undefined)
ok('**只有 pending 不算已迁移**（G1）', store.isMigrationCompleted(store.loadMigrations(fakePaths).profiles, 'check-profile') === false)
store.recordMigration('check-profile', { completed: { at: 'x' }, pending: null }, fakePaths)
ok('写入 completed 后算已迁移', store.isMigrationCompleted(store.loadMigrations(fakePaths).profiles, 'check-profile') === true)
ok('completed 与 pending 分开保存（合并写不互相覆盖）',
  store.loadMigrations(fakePaths).profiles['check-profile'].pending === null
  && store.loadMigrations(fakePaths).profiles['check-profile'].completed?.at === 'x')
ok('完成记录按 profile 分开（不吞别的 profile）', store.loadMigrations(fakePaths).profiles['other-profile'] === undefined)
ok('state.json 没有被迁移流程改写', store.loadState(fakePaths).enabled.laurel === false && store.loadState(fakePaths).migratedAt === null)
const mmBad = store.recordMigration('', {}, fakePaths)
ok('没有 profile 身份 → 不写完成记录', mmBad.ok === false, JSON.stringify(mmBad))

// ── 7b. 事件日志轮转 ────────────────────────────────────────────────────
section('7b. 事件日志轮转')
{
  const { MAX_EVENT_BYTES } = store
  ok('MAX_EVENT_BYTES 是个正经上限', typeof MAX_EVENT_BYTES === 'number' && MAX_EVENT_BYTES > 1024, String(MAX_EVENT_BYTES))
  const pad = 'x'.repeat(300)
  for (let i = 0; i < 4000; i += 1) store.appendEvent({ kind: 'fill', i, pad }, fakePaths)
  ok('主日志被轮转（存在 .1）', existsSync(fakePaths.events + '.1'))
  ok('主日志尺寸被压回上限附近', existsSync(fakePaths.events) && statSync(fakePaths.events).size < MAX_EVENT_BYTES * 1.5,
    existsSync(fakePaths.events) ? String(statSync(fakePaths.events).size) : 'missing')
}

const { rmSync: rmSyncTmp } = await import('node:fs')
rmSyncTmp(join(ROOT, '.tmp-check-home'), { recursive: true, force: true })

// ── 8. 结构性断言：不再有裸 HTTP 写端点（R2）─────────────────────────────
section('8. 没有裸 HTTP 写端点')
const libFiles = readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
ok('lib 下不再有 http.js / contract.js / switches.js', !libFiles.includes('http.js') && !libFiles.includes('contract.js') && !libFiles.includes('switches.js'), libFiles.join(','))
{
  const hostSrc = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  ok('宿主半边不再注册 webServer 路由', !/webServer\.register/.test(hostSrc))
  ok('宿主半边不再用 loader.update 改行', !/loader\s*\.\s*update|\.update\s*\(\s*entry/.test(hostSrc))
  ok('宿主半边走原生 setPluginEnabled', /setPluginEnabled/.test(readFileSync(join(ROOT, 'lib', 'host.js'), 'utf8')))
  ok('宿主半边用 ctx.provide 注册服务（不是 ctx.set）', /ctx\.provide\(/.test(hostSrc) && !/ctx\.set\?\.\(/.test(hostSrc))
}
{
  const clientSrc = readFileSync(join(ROOT, 'lib', 'client', 'index.mjs'), 'utf8')
  ok('客户端不再 fetch 裸 HTTP 端点', !/fetch\s*\(/.test(clientSrc))
  ok('客户端走 remote.pluginManager', /remote\.pluginManager/.test(clientSrc))
  ok('客户端解包原生 RPC 结果封套 {ok,value}', /answer\.ok === true/.test(clientSrc) && /\.value/.test(clientSrc))
  ok('客户端不再有 4 秒轮询', !/setInterval/.test(clientSrc))
  // F2：客户端不再自己翻译 application，改用共用解释器
  ok('客户端不再自己写 outcomeOf 翻译', !/outcomeOf\s*=/.test(clientSrc))
  ok('客户端调用共用解释器 interpretChangeResult', /interpretChangeResult\(/.test(clientSrc))
  ok('客户端汇总用共用 summarizeChange（bulk partial 不再变 success）', /summarizeChange\(/.test(clientSrc))
  ok('客户端有「回执已收到、状态未确认」文案', /notice\.unconfirmed/.test(clientSrc) && /readbackOk/.test(clientSrc))
  const hostSrc = readFileSync(join(ROOT, 'lib', 'host.js'), 'utf8')
  ok('宿主半边用同一份解释器（不是第二套翻译）', /from '\.\/change-result\.js'/.test(hostSrc))
  ok('宿主半边有回读确认（保存与应用分开）', /confirmTarget/.test(hostSrc) && /readOverrides/.test(hostSrc))
  const buildSrc = readFileSync(join(ROOT, 'scripts', 'build-client.mjs'), 'utf8')
  ok('打包清单包含共用解释器', /lib\/change-result\.js/.test(buildSrc))
}

// ── 9. 客户端 bundle 可执行 ─────────────────────────────────────────────
section('9. 客户端 bundle')
/** 第 9 节从 bundle 里抓出来的 zh 字典，供 9b 用真字典验可见文案。 */
let capturedZh = null
{
  const vm = await import('node:vm')
  const clientPath = join(ROOT, 'lib', 'client.js')
  ok('lib/client.js 存在', existsSync(clientPath))

  const src = readFileSync(clientPath, 'utf8')
  ok('没有顶层 import（会被当 ESM 解析而崩）', !/^[ \t]*import\s.+$/m.test(src))
  ok('没有 export default', !/^\s*export\s+default/m.test(src))
  ok('没有动态 import()', !/\bimport\s*\(/.test(src))

  const loaded = []
  const sandbox = { window: { __ModuleLoader__: { load(reg) { loaded.push(reg) } } }, console }
  sandbox.globalThis = sandbox

  let threw = null
  try {
    vm.createContext(sandbox)
    vm.runInContext(src, sandbox, { filename: 'lib/client.js' })
  } catch (error) {
    threw = error
  }
  ok('bundle 能被 classic script 求值', threw === null, threw ? threw.message : '')
  ok('恰好注册 1 个模块', loaded.length === 1, `实得 ${loaded.length}`)
  if (loaded.length === 1) {
    ok('注册 id = laurel-center', loaded[0].id === 'laurel-center', loaded[0].id)
    ok('factory 是函数', typeof loaded[0].factory === 'function')

    const ReactStub = {
      createElement: (...args) => ({ __el: args[0], props: args[1], children: args.slice(2) }),
      useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
      useEffect: () => {},
    }
    const req = (name) => {
      if (name === 'react') return ReactStub
      throw new Error(`require("${name}") missed the module table`)
    }
    let exports = null
    try {
      exports = loaded[0].factory(req)
    } catch (error) {
      threw = error
    }
    ok('factory 能物化（只 require react）', exports !== null && threw === null, threw ? threw.message : '')
    if (exports) {
      ok('导出 apply', typeof exports.apply === 'function')
      ok('导出 inject 且含 slots', Array.isArray(exports.inject) && exports.inject.includes('slots'), JSON.stringify(exports.inject))
      ok('inject 声明了原生 RPC 依赖', exports.inject.includes('remote') && exports.inject.includes('remote.pluginManager'), JSON.stringify(exports.inject))
      const unknownServices = unknownClientServices(exports.inject)
      ok('inject 里没有不存在的服务名（写了会让 web boot 挂掉）',
        unknownServices.length === 0, `未知服务名：${JSON.stringify(unknownServices)}（当前 ${JSON.stringify(exports.inject)}）`)

      const registered = []
      const effects = []
      const dicts = []
      const fakeClientCtx = {
        slots: {
          inject(slotName, fn) { registered.push({ slot: slotName, via: 'inject' }); return fn() },
          register(def, component) { registered.push({ slot: def.name, id: def.id, order: def.order, component }); return () => {} },
        },
        locale: {
          register(ns, dictsObj) { dicts.push({ ns, keys: Object.keys(dictsObj?.zh ?? {}).length }); capturedZh = dictsObj?.zh ?? null; return () => {} },
          bind() { return (key) => key },
        },
        remote: { $on: () => () => {} },
        effect(fn, name) { effects.push(name ?? 'anon'); const cleanup = fn(); return () => { if (typeof cleanup === 'function') cleanup() } },
      }
      let applyThrew = null
      try {
        exports.apply(fakeClientCtx)
      } catch (error) {
        applyThrew = error
      }
      ok('apply(ctx) 不抛', applyThrew === null, applyThrew ? applyThrew.message : '')
      ok('注册了 locale 字典', dicts.length === 1 && dicts[0].ns === 'laurel-center', JSON.stringify(dicts))
      const section = registered.find((r) => r.slot === 'settings.section' && r.id)
      ok('注册了 settings.section', section !== undefined)
      if (section) {
        ok('section id = laurel-center', section.id === 'laurel-center', section.id)
        ok('section order = 15', section.order === 15, String(section.order))
        ok('section 带 component', typeof section.component === 'function')
      }
    }
  }

  const built = readFileSync(clientPath, 'utf8')
  let fresh = null
  try {
    const mod = await import('../scripts/build-client.mjs')
    fresh = mod.buildBundle({ repoRootPath: ROOT, preserveComments: true }).code
  } catch (error) {
    fresh = `ERROR ${error.message}`
  }
  ok('产物与源码一致（无需重新打包）', fresh === built, typeof fresh === 'string' && fresh.startsWith('ERROR') ? fresh : '源码改过但没重新打包，跑 npm run build:client')
}

// ── 9b. 宿主忙 / RPC 超时（2026-10-12 真事故的回归）─────────────────────
// 用户报「四个功能打开就卡死」：宿主 `setPluginEnabled` 要先拿 profile 的写锁，
// 而任何插件安装都握着同一把锁（pnpm 11.x 还有「装完不退出」的已知缺陷，
// 宿主靠 10 分钟空闲看门狗兜底）→ 那段时间里开关一个回执都拿不到。
// 所以客户端必须**到点停止等待**，并且如实报「结果未确认」。
section('9b. 宿主忙 / RPC 超时')
{
  const { formatNotice, interpretRpcTimeout, interpretNotAttempted } = changeResult
  const clientSrc = readFileSync(join(ROOT, 'lib', 'client', 'index.mjs'), 'utf8')

  ok('客户端给原生 RPC 加了等待上限', /RPC_TIMEOUT_MS/.test(clientSrc) && /withDeadline\(/.test(clientSrc))
  ok('客户端不再无限等（没有裸 await remote.pluginManager）',
    !/await ctx\.remote\.pluginManager\.(listPlugins|setPluginEnabled)\(/.test(clientSrc))
  ok('超时走共用解释器，不自己编 outcome',
    /interpretRpcTimeout\(/.test(clientSrc) && /interpretNotAttempted\(/.test(clientSrc))
  ok('超时后不追加回读（不把等待翻倍）', /hostBusy: true/.test(clientSrc))
  ok('等待中会给一行反馈（界面没有进度条）', /notice\.busyWaiting/.test(clientSrc) && /RPC_SLOW_MS/.test(clientSrc))

  const timeoutItem = { id: 'strata', ...interpretRpcTimeout({ waitedMs: 30000 }) }
  ok('RPC 超时 → unknown / saved=null（既不许当成功，也不许当失败）',
    timeoutItem.outcome === 'unknown' && timeoutItem.saved === null && timeoutItem.applied === false,
    JSON.stringify(timeoutItem))
  ok('RPC 超时的 reason/code 是 host-busy', timeoutItem.reason === 'host-busy' && timeoutItem.code === 'host-busy')
  const notAttempted = interpretNotAttempted()
  ok('未执行项 → unknown / code=not-attempted / saved=null',
    notAttempted.outcome === 'unknown' && notAttempted.code === 'not-attempted' && notAttempted.saved === null,
    JSON.stringify(notAttempted))

  ok('抓到客户端真实 zh 字典（否则下面验的是假文案）', capturedZh !== null && typeof capturedZh['plugin.strata'] === 'string')
  const t = (key, params) => {
    const raw = capturedZh?.[key]
    if (typeof raw !== 'string') return key
    if (params === undefined) return raw
    return raw.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(params, name) ? String(params[name]) : whole))
  }

  const busy = formatNotice({ hostBusy: true, items: [timeoutItem], waitedSeconds: 30, readbackOk: false }, t)
  ok('宿主忙的文案点出是哪一项', busy.includes('记忆与上下文'), busy)
  ok('宿主忙的文案带等待秒数', busy.includes('30'), busy)
  ok('宿主忙**不说**「已生效」', !busy.includes('已生效'), busy)
  ok('宿主忙的文案说清「未确认」', busy.includes('未确认'), busy)
  ok('hostBusy 优先于 readbackOk:false（两者同设时不许走错分支）',
    busy === formatNotice({ hostBusy: true, items: [timeoutItem], waitedSeconds: 30 }, t), busy)
  // 分区名从真实字典读，不手抄 —— 2026-10-13 把「功能管理」改名成「Laurel总控」时，
  // 硬编码的那一份就是唯一会漏的地方。名字本身另有一条断言盯着。
  const sectionTitle = capturedZh?.['section.title']
  ok('设置页分区名是「Laurel 控制中心」', sectionTitle === 'Laurel 控制中心', String(sectionTitle))
  ok('items 为空时用分区名兜底，不留空主语',
    typeof sectionTitle === 'string' && sectionTitle.length > 0
      && formatNotice({ hostBusy: true, items: [], waitedSeconds: 30 }, t).includes(sectionTitle),
    String(sectionTitle))
  ok('bulk 里「未执行」的项单独说清（不混进主语让人以为试过了）',
    (() => {
      const text = formatNotice({ hostBusy: true, items: [timeoutItem, { id: 'loom', ...interpretNotAttempted() }], waitedSeconds: 30 }, t)
      return text.includes('未执行') && text.includes(t('plugin.loom')) && !text.includes(t('plugin.strata') + '、' + t('plugin.loom'))
    })())
  ok('等待中的文案是「仍在等待」', formatNotice({ pending: true }, t).includes('仍在等待'))
  // 真浏览器探针抓到的：两档若都以「宿主正忙」开头，用户（和判别逻辑）都分不清
  // 「还在等」和「已经放弃」。等待档必须是**推测**语气，终态档才是**确认**语气。
  ok('等待档与终态档一眼能分开（等待档不许含「宿主正忙」）',
    (() => {
      const waiting = formatNotice({ pending: true }, t)
      return !waiting.includes('宿主正忙') && busy.includes('宿主正忙') && waiting !== busy
    })(),
    `等待档=「${formatNotice({ pending: true }, t)}」 终态档=「${busy}」`)
  ok('reason.hostBusy / reason.notAttempted 都有真文案（键名对得上）',
    t('reason.hostBusy') !== 'reason.hostBusy' && t('reason.notAttempted') !== 'reason.notAttempted',
    `${t('reason.hostBusy')} / ${t('reason.notAttempted')}`)
  ok('problem.hostBusy 有真文案', t('problem.hostBusy') !== 'problem.hostBusy', t('problem.hostBusy'))
  // 普通成功路径不许被这次改动影响。
  ok('正常成功仍报「已生效」',
    formatNotice({ outcome: 'success', items: [{ id: 'laurel', outcome: 'success' }], readbackOk: true }, t) === t('notice.success'))
  ok('回读失败仍走「回执已收到」分支（没被 hostBusy 抢走）',
    formatNotice({ outcome: 'unknown', items: [{ id: 'laurel', outcome: 'unknown' }], readbackOk: false }, t) === t('notice.unconfirmed'))
}

// ── 9c. 失败原因必须看得见（2026-10-15 真事故的回归）────────────────────
// 用户在总控台点一个**刚加进套件、但还没装进 profile** 的模块，界面只显示
// 「操作未成功：内耗护栏:operation-error」—— 一个字的原因都没有，只能来问人。
//
// 而宿主其实把真实原因放在 `error.diagnostic` 里。asar 里 `managementError()`：
//     if (!(error instanceof ManagementFailure)) return { code: 'operation-error', diagnostic: messageOf(error) }
// 也就是说 operation-error 是**兜底码**：任何非预期异常都归到它头上。
// 只显示码 = 把唯一有用的那条信息丢掉。
section('9c. 失败原因必须看得见')
{
  const { formatNotice, CODE_TEXT_KEY } = changeResult
  const t = (key, params) => {
    const raw = capturedZh?.[key]
    if (typeof raw !== 'string') return key
    if (params === undefined) return raw
    return raw.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(params, name) ? String(params[name]) : whole))
  }

  ok('抓到了 zh 字典（否则下面验的是假文案）', typeof capturedZh?.['plugin.warden'] === 'string')

  const diagnostic = "Cannot find module 'dsh-warden'"
  const failed = { id: 'warden', outcome: 'failure', reason: 'write-failed', code: 'operation-error', diagnostic }
  const text = formatNotice({ outcome: 'failure', items: [failed], readbackOk: true }, t)
  ok('failure 文案带上了宿主的 diagnostic（不再只甩一个码）', text.includes(diagnostic), text)
  ok('failure 文案仍点名是哪一项', text.includes('内耗护栏'), text)
  ok('failure 文案仍带原始 code（可搜索、可上报）', text.includes('operation-error'), text)

  const bare = formatNotice({ outcome: 'failure', items: [{ id: 'warden', outcome: 'failure', code: 'unknown-plugin' }], readbackOk: true }, t)
  ok('没有 diagnostic 时只显示「项:码」，不编原因',
    bare.includes('unknown-plugin') && !bare.includes('（'), bare)

  const readback = formatNotice({ outcome: 'unknown', items: [failed], readbackOk: false }, t)
  ok('回读失败分支也带 diagnostic（那条路同样会遇到 operation-error）', readback.includes(diagnostic), readback)

  ok('CODE_TEXT_KEY 只收 Laurel 自己的码（宿主的 operation-error 不在里面）',
    CODE_TEXT_KEY['package-missing'] === 'code.packageMissing' && CODE_TEXT_KEY['operation-error'] === undefined,
    JSON.stringify(CODE_TEXT_KEY))

  const missing = formatNotice({ outcome: 'failure', items: [{ id: 'warden', outcome: 'failure', reason: 'package-missing', code: 'package-missing' }], readbackOk: true }, t)
  ok('package-missing 有真文案（键名对得上）',
    t('code.packageMissing') !== 'code.packageMissing' && missing.includes(t('code.packageMissing')), missing)

  ok('界面给了 operation-error 的修复指引（指出要跑安装事务）',
    t('notice.operationErrorHint') !== 'notice.operationErrorHint' && /安装事务/.test(t('notice.operationErrorHint')),
    t('notice.operationErrorHint'))

  // 宿主半边：包不在 profile 里就**别发原生调用**。
  // 发了的后果是实测出来的：宿主先写 patch（profile 被写脏一行），再 reload 抛异常，
  // 兜底成 operation-error —— 用户既看到一个没有原因的码，profile 还多了一行脏数据。
  const hostSrc = readFileSync(join(ROOT, 'lib', 'host.js'), 'utf8')
  ok('宿主侧在发原生调用前先查包在不在 profile 里',
    /packagePresent/.test(hostSrc) && /row\.packagePresent === false/.test(hostSrc))
  ok('包不在 → 返回稳定码 package-missing（不让宿主兜底成 operation-error）',
    /code: 'package-missing'/.test(hostSrc))
  ok('判不出包在不在时**不拦**（拿不到 profile 目录不该误伤正常的包）',
    /const present = row\.state === 'ready' \? packagePresent\(ctx, p\.entry\) : null/.test(hostSrc)
    && /present === null \? row : \{ \.\.\.row, packagePresent: present \}/.test(hostSrc))
}

// ── 11. 装载机 / 模块落点一致（增删模块与单独更新的安全网）──────────────
section('11. 装载机 / 模块落点一致')
{
  const moduleLib = await import('./module.mjs')
  const mods = moduleLib.collectModules()
  const bad = (pred) => mods.modules.filter((m) => !pred(m)).map((m) => m.id).join(',')
  ok('registry.SUB_PLUGINS 非空', registry.SUB_PLUGINS.length > 0, `${registry.SUB_PLUGINS.length} 个模块`)
  ok('每个模块都有实体目录、且 package.json 的 name = registry.entry',
    mods.modules.every((m) => m.dirExists && m.pkgName === m.entry),
    bad((m) => m.dirExists && m.pkgName === m.entry))
  ok('每个模块在 cordis.patch.yml 里恰好一行、name 是纯包名、默认 disabled',
    mods.modules.every((m) => m.patchRow && m.patchRow.name === m.entry && m.patchRow.disabled === true),
    bad((m) => m.patchRow && m.patchRow.name === m.entry && m.patchRow.disabled === true))
  // **行为断言，不是文本断言**：真的把装配校验核 import 进来，比对它推导出的清单。
  // 上一版这里只 grep 源码文本（`includes('SUB_PLUGINS.map')`），于是
  // 「改了代码但忘了 import SUB_PLUGINS」这种会让 verify-installed 直接
  // ReferenceError 的错误，照样全绿通过 —— 实测踩过一次，所以改成真的执行它。
  const assembly = await import('./assembly-check.mjs')
  const wantPairs = registry.SUB_PLUGINS.map((p) => ({ name: p.entry, dir: p.dir }))
  ok('装配校验核的清单 = 注册表推导的清单（真的 import 并执行了它）',
    JSON.stringify(assembly.SUB_PACKAGES) === JSON.stringify(wantPairs)
    && JSON.stringify(assembly.STABLE_IDS) === JSON.stringify(registry.SUB_PLUGINS.map((p) => p.id)),
    `${JSON.stringify(assembly.SUB_PACKAGES)} / ${JSON.stringify(assembly.STABLE_IDS)}`)
  ok('客户端清单来自注册表（build-client 清单里有 lib/registry.js）',
    readFileSync(join(ROOT, 'scripts', 'build-client.mjs'), 'utf8').includes('lib/registry.js'))
  ok('module.mjs check 零问题', mods.ok, mods.problems.join(' / '))
  for (const w of mods.warnings) console.log(`  · 提醒：${w}`)
}

// ── 12. 全仓 JS 语法（R3 的回归防线）─────────────────────────────────────
// 2026-10-13 公开仓首次使用评审 R3：主题包的浏览器测试文件把**真实换行**写进了
// 单引号字符串，`node --test` 直接 SyntaxError；而当时的门禁只跑装载机的几个
// 离线检查，完全没碰到那个文件，于是坏语法一路进了公开仓。
//
// 所以这里把「仓库里每个 JS/MJS/CJS 都能被解析」变成一条常驻断言。
// 只遍历本仓库自己的源码/测试/脚本，跳过依赖与生成物目录。
section('12. 全仓 JS 语法（每个文件都要能被解析）')
{
  const SKIP_DIRS = new Set(['node_modules', '.git', 'release', '.verification', '.browser-evidence'])
  const files = []
  const walk = (dir, rel) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.laurel-center-backup-')) continue
      const next = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), next) } else if (/\.(?:js|mjs|cjs)$/.test(e.name)) files.push(next)
    }
  }
  walk(ROOT, '')

  const broken = []
  for (const rel of files) {
    const r = spawnSync(process.execPath, ['--check', join(ROOT, rel)], { encoding: 'utf8' })
    if (r.status !== 0) broken.push(`${rel}：${(r.stderr || '').split('\n').find((l) => l.includes('Error')) ?? '解析失败'}`)
  }
  ok(`仓库内 ${files.length} 个 JS/MJS/CJS 全部解析通过`, broken.length === 0, broken.join(' | '))
}

// ── 13. 装配校验核缺文件时不许崩（R7 的回归防线）─────────────────────────
// 2026-10-13 公开仓首次使用评审 R7：安装面缺 `cordis.patch.yml` 时，
// `assembly-check.mjs` 在 `[...entries, ...rows]` 那一行抛
// `TypeError: loaderPatch.rows is not iterable` —— 安装事务**在回滚之前就整个崩掉**，
// 比「校验报失败」严重得多（失败至少还会回滚，崩掉就留一个半装状态）。
//
// 修复有**两层**：`lib/patch.js` 保证两个键永远存在，校验核再兜一层 `?? []`。
// 只拆一层会被另一层遮住，所以这里对**最外层行为**下断言：校验核必须**返回**
// 一个 ok:false 的结论，而不是抛异常。上一层（5b）的键契约断言负责让失败信息更精确。
section('13. 装配校验核缺文件时不许崩（R7）')
{
  const assembly = await import('./assembly-check.mjs')
  const { mkdirSync } = await import('node:fs')
  const dir = join(ROOT, '.tmp-check-assembly-crash')
  rmSync(dir, { recursive: true, force: true })
  const profileDir = join(dir, 'profile')
  const centerDir = join(dir, 'center')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(centerDir, { recursive: true })
  // 最小可用 profile：只要 package.json 能解析，校验核就会走到「装载机 patch」那一节。
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'r7-crash-probe-profile',
    dependencies: { 'laurel-center': `link:${centerDir}` },
    dsh: { profile: { bundles: ['laurel-center'] } },
  }))
  // centerDir 故意**不放** `cordis.patch.yml` —— 这正是 R7 的触发条件。

  let threw = null
  let report = null
  try {
    report = assembly.checkAssembly({ profileDir, centerDir })
  } catch (error) {
    threw = String(error?.message ?? error)
  }
  ok('装载机 patch 缺失时校验核**返回**结论而不是抛异常', threw === null, threw ?? '')
  ok('装载机 patch 缺失 → 结论是 ok:false（不是静默通过）', report?.ok === false, JSON.stringify(report?.problems?.slice(0, 3) ?? null))
  ok('问题清单里点名了装载机 patch（看得出缺什么，而不是只有一句 TypeError）',
    (report?.problems ?? []).some((p) => p.includes('装载机 patch')),
    JSON.stringify(report?.problems ?? null))
  rmSync(dir, { recursive: true, force: true })
}

// ── 14. 聚合插槽链路（Laurel总控 ↔ 四个模块）─────────────────────────────
// 2026-10-13 起，装载机注册自己那条设置页时**顺带声明**子插槽
// `laurel-center.module`；四个模块的设置页注册进去，由总控渲染进各自的卡片。
//
// 这条约定有两个必须钉住的点，用**真实的** SlotCore 验（不是复刻它的行为）：
//   • 装载机在 → 声明成立、四个模块都进得去、卸载时级联干净；
//   • 装载机不在 → 注册那个插槽**直接抛**。这正是 kit 里必须留兜底路径的理由：
//     只留聚合一条路，单独装某个模块的人设置页会整块消失（而且不报错）。
section('14. 聚合插槽链路（总控 ↔ 四个模块）')
{
  // 静态那半：每个模块的客户端产物里必须真的出现聚合插槽名 —— 挡住「漏改某个模块」。
  // 本轮就真漏过一个：laurel **实际加载**的是手写的 `packages/laurel/lib/client.js`，
  // 而构建产物 `packages/laurel/library/laurel-sample/client.js` 只是示例模板 ——
  // 改后者不生效，而且全程不报错（这一条就是那次漏改的回归防线）。
  for (const p of registry.SUB_PLUGINS) {
    const clientPath = join(ROOT, 'packages', p.dir, 'lib', 'client.js')
    const src = existsSync(clientPath) ? readFileSync(clientPath, 'utf8') : ''
    ok(`[${p.id}] 客户端产物里有聚合插槽名（说明这个模块真的改了）`,
      src.includes('laurel-center.module'),
      src.length === 0 ? `读不到 ${clientPath}` : clientPath)
  }

  // 运行时那半：用真实 SlotCore 验链路。拿不到那个包就跳过（仓库是零依赖的）。
  const slotsEntry = resolveClientSlotsEntry()
  if (slotsEntry === null) {
    console.log('  · 跳过：没找到 @deepseek-ai/dsh-client-ui-slots（没装 DSH 的机器上正常）')
  } else {
    const { SlotCore } = await import(pathToFileURL(slotsEntry).href)
    // 真实里 settings.section 由 dsh-client-ui-settings 声明；这里照它的形状铺一层。
    const SHELL_CHILDREN = { 'settings.section': { kind: 'list', scope: 'root' } }
    const CENTER = {
      name: 'settings.section', id: 'laurel-center', order: 15,
      children: { 'laurel-center.module': { kind: 'list', scope: 'root' } },
    }
    // 四个模块注册时用的 id 直接取自注册表 —— 这正是「不许手抄第二份映射」那条约定。
    const MODULES = registry.SUB_PLUGINS.map((p) => ({ id: p.settingsId, order: 50 }))

    const core = new SlotCore()
    core.register({ name: 'root', children: SHELL_CHILDREN }, () => null)
    const center = core.register(CENTER, () => null)
    ok('装载机注册时能把聚合插槽声明出来', core.specDynamic('laurel-center.module')?.kind === 'list')

    const moduleDisposers = MODULES.map((m) => core.register({ name: 'laurel-center.module', ...m }, () => null))
    const grouped = core.entriesOfSlot('laurel-center.module')
    ok('四个模块的设置页都进得去聚合插槽', grouped.length === MODULES.length, `${grouped.length}/${MODULES.length}`)
    ok('注册表里的 settingsId 与模块实际注册的 id 对得上（对不上就是「卡片展开是空的」）',
      MODULES.every((m) => grouped.some((e) => e.options.id === m.id)),
      JSON.stringify(grouped.map((e) => e.options.id)))
    ok('聚合成立后装载机在设置导航里只剩一条', core.entriesOfSlot('settings.section').length === 1)

    center()
    ok('卸载装载机时聚合插槽跟着塌陷', core.specDynamic('laurel-center.module') === undefined)
    ok('塌陷后模块的条目一并清空（不留孤儿）', core.entriesOfSlot('laurel-center.module').length === 0)
    core.register(CENTER, () => null)
    for (const d of moduleDisposers) d()
    ok('装载机重载后，模块的旧 disposer 是 no-op（不往新插槽里塞孤儿）',
      core.entriesOfSlot('laurel-center.module').length === 0)

    // 装载机不在 —— 兜底路径存在的理由
    const bare = new SlotCore()
    bare.register({ name: 'root', children: SHELL_CHILDREN }, () => null)
    let refusal = ''
    try { bare.register({ name: 'laurel-center.module', id: 'loom' }, () => null) } catch (error) { refusal = String(error?.message ?? error) }
    ok('没有装载机时注册聚合插槽会直接抛（不会静默不生效）', /not declared/.test(refusal), refusal || '（居然没抛）')
    let fallbackWorks = false
    try {
      bare.register({ name: 'settings.section', id: 'loom' }, () => null)
      fallbackWorks = bare.entriesOfSlot('settings.section').length === 1
    } catch { /* 兜底也不通就是失败 */ }
    ok('兜底路径（照旧注册 settings.section）在没有装载机时可用', fallbackWorks)
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
