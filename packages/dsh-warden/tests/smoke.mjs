/**
 * dsh-warden · 单元与数据层测试（补充，不代替宿主验收）
 *
 * ⚠ 评审的原话：「纯 fake ctx 不再作为通过宿主接线的证明」。
 * 所以**宿主接线的验收在 `tests/host-contract.mjs`**，那里加载本机
 * app.asar 里的官方 cordis / ToolRuntime / SystemPrompt 跑真实链路。
 *
 * 这一份只覆盖不需要宿主的部分：配置归一、三档预设、纯函数、
 * 数据层持久化、HTTP 数据面、以及 `apply()` 的装配契约。
 *
 * ── 已经被删掉的旧用例（连同它们测的东西）─────────────────────────────
 *   `capWaitTimeout`  在冻结参数上原地改写，生产里从来没生效过（R1）。
 *                     等待上限改到 `tools/execute` 期限信号层，见 host/wait.js。
 *   `microCompact`    在 `agent/pre-step` 裁"历史工具结果"，但那一层根本没有
 *                     历史（R3）。旧用例人为往待追加批次里塞 20 条 tool 消息，
 *                     测的是生产不存在的输入。历史压缩唯一 owner 是官方 Basic。
 *   过期锁 1ms 竞速   改用可注入时钟（core/clock.js），不再赌调度器。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BOOL_KEYS, DEFAULT_CONFIG, ENUM_KEYS, HASH_ALGORITHM_VERSION, LIST_KEYS, NUM_KEYS, PACKAGE_NAME,
  PRESETS, PRESET_LABELS, PRESET_VALUES, RATIO_KEYS, VERSION, archiveDirFor, isUnder, normalizeConfig,
  normalizePath, pickKnown, pluginPaths, resolveDshHome,
} from '../lib/core/config.js'
import {
  callFingerprint, classifyToolError, estimateTokens, extractPath, oneLine, readRangeKey, readRangeOf,
  resultFingerprint, sha256Hex, shortHash, stableKey,
} from '../lib/core/text.js'
import { Capabilities, CAPABILITY_STATES } from '../lib/core/capability.js'
import { fakeClock, systemClock } from '../lib/core/clock.js'
import { atomicWriteFile, pidAlive, withFileLock } from '../lib/core/filelock.js'
import { namedResourceCatalog, parseNamedResource, resolveResourceId, resourcesConflict } from '../lib/core/resource.js'
import { Counters, EvidenceLedger, LockStore, appendEvent, readEvents } from '../lib/core/store.js'
import { loadSettings, saveSettings, verifyPersisted } from '../lib/core/settings.js'
import { ProgressWatch, StageLedger, validateComplete } from '../lib/core/progress.js'
import { isIgnored, isMutatingTool } from '../lib/host/guard.js'
import { isEditMiss, isUnknownTool, shouldFire } from '../lib/host/after.js'
import { rulesText, waterLevelText } from '../lib/host/inject.js'
import { boundedSummary } from '../lib/host/archive.js'
import { createTools } from '../lib/host/tools.js'
import { createHandler, readJsonBody } from '../lib/host/http.js'
import { apply, inject } from '../lib/index.js'

/* ---------------- 极简测试框架 ---------------- */
let passed = 0
let failed = 0
const failures = []
const section = (name) => console.log(`\n── ${name} ` + '─'.repeat(Math.max(0, 58 - name.length)))

function test(name, fn) {
  return runTest(name, fn)
}
async function testAsync(name, fn) {
  return runTest(name, fn)
}
async function runTest(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    failures.push({ name, error })
    console.log(`  ✗ ${name}\n      ${String(error?.message ?? error).split('\n').join('\n      ')}`)
  }
}

function tempHome(prefix = 'warden-smoke-') {
  const home = mkdtempSync(join(tmpdir(), prefix))
  process.env.DSH_HOME = home
  return home
}

/** 一个什么都不提供的假 ctx，用来验"没有宿主服务也不许炸"。 */
function emptyCtx() {
  const listeners = new Map()
  return {
    on: () => () => {},
    get: () => null,
    inject: () => () => {},
    effect: (fn) => { const d = fn?.(); return typeof d === 'function' ? d : () => {} },
    emit: (name, ...args) => { for (const l of listeners.get(name) ?? []) l(...args) },
    listeners,
  }
}

/** 走一遍 handler，返回 { status, body }。 */
async function httpCall(handler, method, path, body) {
  const chunks = []
  const req = {
    method,
    url: path,
    on(event, cb) {
      if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') setTimeout(cb, 0)
      return req
    },
    destroy() {},
  }
  let status = 0
  const headers = {}
  const res = {
    headersSent: false,
    set statusCode(value) { status = value },
    get statusCode() { return status },
    setHeader(k, v) { headers[k] = v },
    end(payload) { chunks.push(payload) },
  }
  await handler(req, res)
  const raw = chunks.filter((c) => c !== undefined).join('')
  return { status, headers, body: raw ? JSON.parse(raw) : null }
}

function execFor(name, args = {}, sessionId = 'sess-1', cwd = '/work') {
  return {
    name,
    arguments: args,
    callId: `call-${name}`,
    agent: sessionId ? { id: `agent-${sessionId}`, session: { id: sessionId, header: { cwd } } } : undefined,
  }
}

/* ================================================================== *
 * A. 身份与配置
 * ================================================================== */
section('A. 身份与配置')

test('包名与版本自洽（VERSION 与 package.json 一致）', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
  assert.equal(PACKAGE_NAME, pkg.name)
  assert.equal(VERSION, pkg.version)
  assert.equal(pkg.name, 'dsh-warden')
})

test('三档预设 + custom 都在，且中文名齐全', () => {
  assert.deepEqual(PRESETS, ['gentle', 'balanced', 'strict', 'custom'])
  for (const id of PRESETS) assert.ok(PRESET_LABELS[id], `${id} 缺中文名`)
})

test('每档预设都覆盖了全部布尔键与数值键（防漏键导致该项永远失效）', () => {
  for (const id of ['gentle', 'balanced', 'strict']) {
    const values = PRESET_VALUES[id]
    for (const key of BOOL_KEYS) {
      if (key === 'enabled') continue
      assert.ok(key in values, `${id} 缺布尔键 ${key}`)
    }
    for (const key of Object.keys(NUM_KEYS)) assert.ok(key in values, `${id} 缺数值键 ${key}`)
    for (const key of Object.keys(RATIO_KEYS)) assert.ok(key in values, `${id} 缺比例键 ${key}`)
    for (const key of Object.keys(ENUM_KEYS)) assert.ok(key in values, `${id} 缺枚举键 ${key}`)
    for (const key of Object.keys(LIST_KEYS)) assert.ok(Array.isArray(values[key]), `${id} 缺列表键 ${key}`)
  }
})

test('每档预设的数值都落在合法区间内', () => {
  for (const id of ['gentle', 'balanced', 'strict']) {
    for (const [key, [min, max]] of Object.entries(NUM_KEYS)) {
      const value = PRESET_VALUES[id][key]
      assert.ok(value >= min && value <= max, `${id}.${key}=${value} 越界 [${min},${max}]`)
    }
  }
})

test('三档的激进程度是单调的（严格最短等待、最早提醒、最积极归档）', () => {
  const { gentle, balanced, strict } = PRESET_VALUES
  assert.ok(gentle.waitCapMs > balanced.waitCapMs, '温和的等待上限应当最长')
  assert.ok(balanced.waitCapMs > strict.waitCapMs)
  assert.ok(gentle.waterLevelStep > balanced.waterLevelStep)
  assert.ok(balanced.waterLevelStep > strict.waterLevelStep)
  assert.ok(gentle.archiveThresholdChars >= balanced.archiveThresholdChars)
  assert.ok(balanced.archiveThresholdChars >= strict.archiveThresholdChars)
})

test('严格档不等于"更容易杀正常任务"：无进展阈值更高不是更低，归档更积极', () => {
  const { gentle, strict } = PRESET_VALUES
  assert.ok(strict.progressFailureThreshold <= gentle.progressFailureThreshold)
  assert.equal(strict.progressMode, 'enforce')
  assert.equal(gentle.progressMode, 'observe', '默认就该先观察，不直接动手')
  assert.ok(strict.archiveThresholdChars < gentle.archiveThresholdChars, '严格档应当更早归档（保住证据）')
  assert.ok(strict.archiveToolResults, '严格档关掉归档等于丢证据')
})

test('历史裁剪在所有档位默认关闭（R3：这一层拿不到历史）', () => {
  for (const id of ['gentle', 'balanced', 'strict']) {
    assert.equal(PRESET_VALUES[id].microCompact, false, `${id} 仍然默认开着历史裁剪`)
  }
})

test('DEFAULT_CONFIG 就是 balanced 档（键集合完全一致）', () => {
  const keys = Object.keys(DEFAULT_CONFIG).filter((k) => !['enabled', 'preset', 'logLevel'].includes(k)).sort()
  const presetKeys = Object.keys(PRESET_VALUES.balanced).sort()
  assert.deepEqual(keys, presetKeys)
  for (const key of presetKeys) assert.deepEqual(DEFAULT_CONFIG[key], PRESET_VALUES.balanced[key], `${key} 与 balanced 不一致`)
})

test('normalizeConfig：preset 决定整张表，不会留下上一档的值', () => {
  const base = normalizeConfig({ preset: 'strict' })
  const gentle = normalizeConfig({ preset: 'gentle' }, base)
  assert.equal(gentle.preset, 'gentle')
  assert.equal(gentle.waitCapMs, PRESET_VALUES.gentle.waitCapMs)
  assert.equal(gentle.reworkThreshold, PRESET_VALUES.gentle.reworkThreshold)
})

test('normalizeConfig：custom 不覆盖任何值，以显式传入的为准', () => {
  const base = normalizeConfig({ preset: 'balanced' })
  const custom = normalizeConfig({ preset: 'custom', microCompact: true, waitCapMs: 12345 }, base)
  assert.equal(custom.preset, 'custom')
  assert.equal(custom.microCompact, true)
  assert.equal(custom.waitCapMs, 12345)
  // 没显式传的项保持 base 的值
  assert.equal(custom.reworkThreshold, base.reworkThreshold)
})

test('normalizeConfig：数值越界被夹住、非数字退回兜底', () => {
  assert.equal(normalizeConfig({ waitCapMs: 99999999 }).waitCapMs, NUM_KEYS.waitCapMs[1])
  assert.equal(normalizeConfig({ waitCapMs: -5 }).waitCapMs, NUM_KEYS.waitCapMs[0])
  assert.equal(normalizeConfig({ reworkThreshold: 'abc' }).reworkThreshold, NUM_KEYS.reworkThreshold[2])
  assert.equal(normalizeConfig({ waterLevelRatio: 5 }).waterLevelRatio, RATIO_KEYS.waterLevelRatio[1])
})

test('normalizeConfig：枚举与列表键有兜底，不会被写坏', () => {
  assert.equal(normalizeConfig({ progressMode: 'yolo' }).progressMode, 'observe')
  assert.equal(normalizeConfig({ idleAction: 'kill-everything' }).idleAction, 'notify')
  assert.deepEqual(normalizeConfig({ waitTools: 'wait_agent' }).waitTools, LIST_KEYS.waitTools[1])
  const cleaned = normalizeConfig({ waitTools: ['wait_agent', '', 'wait_agent', 42, 'job_output'] }).waitTools
  assert.deepEqual(cleaned, ['wait_agent', 'job_output'])
})

test('normalizeConfig：归档保留量不会大到失去意义', () => {
  const cfg = normalizeConfig({ archiveThresholdChars: 2000, archiveKeepChars: 1900 })
  assert.ok(cfg.archiveKeepChars * 2 <= cfg.archiveThresholdChars, `保留 ${cfg.archiveKeepChars} / 阈值 ${cfg.archiveThresholdChars}`)
})

test('normalizeConfig：非法 preset 退回 base 的档位', () => {
  const base = normalizeConfig({ preset: 'strict' })
  assert.equal(normalizeConfig({ preset: 'nope' }, base).preset, 'strict')
})

test('normalizeConfig：pathIgnore 去空、去重、限 16 条', () => {
  const list = Array.from({ length: 30 }, (_, i) => `/p/${i % 20}`)
  const cfg = normalizeConfig({ pathIgnore: ['', '  ', '/ok', '/ok', ...list] })
  assert.ok(cfg.pathIgnore.length <= 16)
  assert.ok(cfg.pathIgnore.includes('/ok'))
  assert.equal(new Set(cfg.pathIgnore).size, cfg.pathIgnore.length)
})

test('pickKnown 只留已知键（不会把临时字段写进 settings.json）', () => {
  const picked = pickKnown({ ...DEFAULT_CONFIG, __temp: 1, injected: true })
  assert.ok(!('__temp' in picked))
  assert.ok(!('injected' in picked))
})

test('pluginPaths 全部落在 $DSH_HOME/warden 之下', () => {
  const home = '/tmp/dsh-home-x'
  const paths = pluginPaths(home)
  for (const [key, value] of Object.entries(paths)) {
    assert.ok(value.startsWith(join(home, 'warden')), `${key} 跑到了外面：${value}`)
  }
  assert.ok(paths.archive.includes('warden'))
  assert.equal(archiveDirFor(home, 'sess/1'), join(paths.archive, 'sess_1'), '会话 id 没有消毒就当了目录名')
})

test('resolveDshHome 只认 DSH_HOME，不从 profile 目录往上推', () => {
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/explicit-home'
  assert.equal(resolveDshHome(), '/tmp/explicit-home')
  delete process.env.DSH_HOME
  assert.ok(resolveDshHome().endsWith('.dsh'))
  if (saved !== undefined) process.env.DSH_HOME = saved
})

test('normalizePath / isUnder：Windows 大小写不敏感、分隔符统一', () => {
  assert.equal(normalizePath('D:\\A\\B\\'), 'd:/a/b')
  assert.equal(normalizePath('/srv/app/'), '/srv/app')
  assert.ok(isUnder('D:\\a\\b\\c.txt', 'd:/A/B'))
  assert.ok(isUnder('/srv/app/dist', '/srv/app/dist'), '自身也算 under')
  assert.ok(!isUnder('/srv/application', '/srv/app'), '前缀相似不等于在子树下')
})

/* ================================================================== *
 * B. 纯函数：指纹 / 键 / 区间
 * ================================================================== */
section('B. 纯函数')

test('sha256Hex 对字符串稳定，对 Buffer 走字节而不是 String()', () => {
  assert.equal(sha256Hex('abc'), sha256Hex('abc'))
  assert.notEqual(sha256Hex('abc'), sha256Hex('abd'))
  // 字节路径：0x80 与 0x81 必须不同（旧实现会撞成同一个）
  assert.notEqual(sha256Hex(Buffer.from([0x80])), sha256Hex(Buffer.from([0x81])))
  assert.equal(sha256Hex(Buffer.from('abc')), sha256Hex('abc'), '同样的字节应当得到同样的 hash')
  // 与已知标准值对齐（echo -n abc | sha256sum）
  assert.equal(sha256Hex(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('shortHash 短且稳定', () => {
  assert.equal(shortHash('x').length, 12)
  assert.equal(shortHash('x'), shortHash('x'))
  assert.notEqual(shortHash('x'), shortHash('y'))
})

test('stableKey 对键序不敏感（这是"两次调用算不算重复"的判据）', () => {
  assert.equal(stableKey('t', { a: 1, b: 2 }), stableKey('t', { b: 2, a: 1 }))
  assert.notEqual(stableKey('t', { a: 1 }), stableKey('t2', { a: 1 }))
  assert.equal(stableKey('t', '{"b":2,"a":1}'), stableKey('t', { a: 1, b: 2 }))
})

test('readRangeOf 认得各种"只读一段"的参数名；readRangeKey 稳定', () => {
  assert.deepEqual(readRangeOf({ offset: 10, limit: 20 }), { offset: 10, limit: 20, pattern: null })
  assert.equal(readRangeKey(readRangeOf({ offset: 10, limit: 20 })), 'o10|l20')
  assert.equal(readRangeKey(readRangeOf({ start_line: 5, end_line: 9 })), 'o5|l9')
  assert.equal(readRangeKey(readRangeOf({ pattern: 'foo' })), 'pfoo')
  assert.equal(readRangeOf({ path: '/x' }), null, '没有区间信息时应当返回 null')
  assert.equal(readRangeKey(null), 'full')
})

test('callFingerprint：同文件不同区间一定是不同的键（R6 的根）', () => {
  const a = callFingerprint('read', { path: '/big.js', offset: 0, limit: 50 })
  const b = callFingerprint('read', { path: '/big.js', offset: 50, limit: 50 })
  assert.notEqual(a, b)
  assert.equal(a, callFingerprint('read', { limit: 50, offset: 0, path: '/big.js' }), '键序不同就变了指纹')
})

test('resultFingerprint：抹掉时间戳与 uuid，保留真实差异', () => {
  const mk = (text) => ({ isError: true, content: [{ type: 'text', text }] })
  assert.equal(
    resultFingerprint(mk('failed at 2026-10-15T01:02:03Z id=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')),
    resultFingerprint(mk('failed at 2027-01-01T09:08:07Z id=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')),
  )
  assert.notEqual(resultFingerprint(mk('boom A')), resultFingerprint(mk('boom B')))
  assert.notEqual(resultFingerprint({ isError: true, content: [] }), resultFingerprint({ isError: false, content: [] }))
})

test('classifyToolError：六类错误分开，各给不同下一步', () => {
  assert.equal(classifyToolError('unknown tool "foo"'), 'capability')
  assert.equal(classifyToolError('EACCES permission denied'), 'auth')
  assert.equal(classifyToolError('ENOENT no such file'), 'path-env')
  assert.equal(classifyToolError('ENOTSUP ... link'), 'path-env')
  assert.equal(classifyToolError('old_string was not found'), 'edit-miss')
  assert.equal(classifyToolError('ETIMEDOUT'), 'transient')
  assert.equal(classifyToolError('WARDEN_RESOURCE_CONFLICT'), 'resource-conflict')
  assert.equal(classifyToolError('assertion failed: 1 !== 2'), 'business')
})

test('extractPath 认得各种工具的参数名', () => {
  assert.equal(extractPath({ file_path: '/a' }), '/a')
  assert.equal(extractPath({ path: '/b' }), '/b')
  assert.equal(extractPath({ target_file: '/c' }), '/c')
  assert.equal(extractPath({ notebook_path: '/d' }), '/d')
  assert.equal(extractPath({ cwd: '/e' }), '/e')
  assert.equal(extractPath('{"file_path":"/f"}'), '/f')
  assert.equal(extractPath({}), '')
  assert.equal(extractPath(null), '')
})

test('estimateTokens：CJK 按 1 字 1 token，其余 4 字符 1 token', () => {
  assert.equal(estimateTokens('中文'), 2)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens(''), 0)
})

test('oneLine 折叠空白并截断', () => {
  assert.equal(oneLine('a\n\n  b'), 'a b')
  assert.ok(oneLine('x'.repeat(300), 50).length <= 50)
})

test('isMutatingTool：认得出会动东西的工具，认不出就当只读（fail-open）', () => {
  for (const name of ['write_file', 'edit', 'bash', 'run_command', 'deploy_target', 'git_commit']) {
    assert.equal(isMutatingTool(name), true, `${name} 应当算写操作`)
  }
  for (const name of ['read', 'glob', 'grep', 'wait_agent', 'list_agents', 'warden_status', 'acquire_lock']) {
    assert.equal(isMutatingTool(name), false, `${name} 不该算写操作`)
  }
  assert.equal(isMutatingTool('mystery_tool'), false)
  assert.equal(isMutatingTool(''), false)
})

test('isIgnored：按路径前缀判定，空名单不拦任何东西', () => {
  assert.equal(isIgnored('/p/node_modules/x', ['/p/node_modules']), true)
  assert.equal(isIgnored('/p/src/x', ['/p/node_modules']), false)
  assert.equal(isIgnored('/p/x', []), false)
  assert.equal(isIgnored('/p/x', undefined), false)
})

test('shouldFire：正好踩线，以及之后每个整数倍', () => {
  assert.equal(shouldFire(3, 3), true)
  assert.equal(shouldFire(6, 3), true)
  assert.equal(shouldFire(4, 3), false)
  assert.equal(shouldFire(1, 0), false)
})

test('isEditMiss / isUnknownTool 认得各种措辞', () => {
  assert.ok(isEditMiss('old_string was not found in file'))
  assert.ok(isEditMiss('old_string matched 2 times'))
  assert.ok(!isEditMiss('some other error'))
  assert.ok(isUnknownTool('unknown tool "x"'))
  assert.ok(isUnknownTool('工具不存在'))
})

/* ================================================================== *
 * C. 资源身份
 * ================================================================== */
section('C. 资源身份与冲突集合')

test('父子路径互相冲突，兄弟路径不冲突', () => {
  const parent = resolveResourceId('/srv/app').resourceId
  const child = resolveResourceId('/srv/app/dist').resourceId
  const sibling = resolveResourceId('/srv/application').resourceId
  assert.ok(resourcesConflict(parent, child))
  assert.ok(resourcesConflict(child, parent))
  assert.ok(!resourcesConflict(parent, sibling), '前缀相似被误判成父子')
  assert.ok(resourcesConflict(parent, parent))
})

test('命名资源目录可列举，示例能自解析', () => {
  const catalog = namedResourceCatalog()
  assert.ok(catalog.length >= 4)
  for (const item of catalog) {
    if (!item.withValue) {
      const r = resolveResourceId(item.example)
      assert.equal(r.resolvable, true, `${item.example} 自己解析不了`)
      assert.equal(r.resourceId, item.resourceId)
    }
  }
})

test('parseNamedResource 认得同义写法，缺目标时报错而不是猜', () => {
  assert.equal(parseNamedResource('desktop').resourceId, parseNamedResource('desktop-input').resourceId)
  assert.equal(parseNamedResource('display').resourceId, 'named:display-mode')
  assert.equal(parseNamedResource('deployment:Web Host').resourceId, 'named:deployment:web-host')
  const missing = parseNamedResource('deployment:')
  assert.equal(missing.resolvable, false)
  assert.match(missing.reason, /缺少具体目标/)
  assert.equal(parseNamedResource('/srv/app'), null, '路径不该被当成命名资源')
})

/* ================================================================== *
 * D. 文件锁原语
 * ================================================================== */
section('D. 文件锁原语')

test('withFileLock：临界区串行，锁文件用完就删', () => {
  const home = tempHome()
  const lock = join(home, 'a.lock')
  const order = []
  const r1 = withFileLock(lock, () => { order.push('a'); return 1 })
  const r2 = withFileLock(lock, () => { order.push('b'); return 2 })
  assert.deepEqual(order, ['a', 'b'])
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(existsSync(lock), false, '锁文件没有清掉')
  rmSync(home, { recursive: true, force: true })
})

test('withFileLock：临界区抛错也返回失败并清锁，不留死锁', () => {
  const home = tempHome()
  const lock = join(home, 'b.lock')
  const r = withFileLock(lock, () => { throw new Error('boom') })
  assert.equal(r.ok, false)
  assert.match(r.reason, /boom/)
  assert.equal(existsSync(lock), false)
  rmSync(home, { recursive: true, force: true })
})

test('withFileLock：锁目录建不出来时返回失败，不抛', () => {
  const home = tempHome()
  const blocker = join(home, 'file')
  writeFileSync(blocker, 'x')
  const r = withFileLock(join(blocker, 'sub', 'x.lock'), () => 1)
  assert.equal(r.ok, false)
  assert.match(r.reason, /锁目录|锁/)
  rmSync(home, { recursive: true, force: true })
})

test('pidAlive：当前进程活着，荒谬 pid 不活着', () => {
  assert.equal(pidAlive(process.pid), true)
  assert.equal(pidAlive(-1), false)
  assert.equal(pidAlive('abc'), false)
})

test('atomicWriteFile：写失败必须抛，不静默', () => {
  const home = tempHome()
  const blocker = join(home, 'file')
  writeFileSync(blocker, 'x')
  assert.throws(() => atomicWriteFile(join(blocker, 'sub.json'), '{}'))
  const ok = join(home, 'ok.json')
  atomicWriteFile(ok, '{"a":1}')
  assert.equal(readFileSync(ok, 'utf8'), '{"a":1}')
  rmSync(home, { recursive: true, force: true })
})

/* ================================================================== *
 * E. 数据层：锁 / 台账 / 计数器 / 事件
 * ================================================================== */
section('E. 数据层')

test('LockStore：取得 → 别人冲突 → 本人续期 → 释放', () => {
  const home = tempHome()
  const clock = fakeClock(0)
  const locks = new LockStore(home, { clock })
  const a = locks.acquire({ name: 'dist', resource: '/srv/app/dist', owner: 'A', ttlMs: 1000 })
  assert.equal(a.ok, true)
  assert.equal(a.lock.fence, 1)
  const b = locks.acquire({ name: 'dist', resource: '/srv/app/dist', owner: 'B', ttlMs: 1000 })
  assert.equal(b.ok, false)
  assert.equal(b.heldBy.owner, 'A')
  const again = locks.acquire({ name: 'dist', resource: '/srv/app/dist', owner: 'A', ttlMs: 1000 })
  assert.equal(again.ok, true, '同一持有者重复获取应当成功（刷新 TTL）')
  assert.equal(again.lock.fence, 2, '每次取得都该推进 fence')
  const rel = locks.release({ resourceId: a.lock.resourceId, owner: 'A' })
  assert.equal(rel.ok, true)
  assert.equal(rel.released, true)
  rmSync(home, { recursive: true, force: true })
})

test('LockStore：过期的锁隐身（可注入时钟，没有真实时间竞速）', () => {
  const home = tempHome()
  const clock = fakeClock(0)
  const locks = new LockStore(home, { clock })
  locks.acquire({ name: 'x', resource: '/a', owner: 'A', ttlMs: 1000 })
  assert.equal(Object.keys(locks.list(clock.now())).length, 1)
  clock.advance(1500)
  // 过期但进程还活着 → 仍然看得见，不会被随便抢走
  assert.equal(Object.keys(locks.list(clock.now())).length, 1, '过期但持有者还活着就被隐藏了')
  rmSync(home, { recursive: true, force: true })
})

test('LockStore：读不到 / 写坏的锁文件一律当空表，不抛', () => {
  const home = tempHome()
  const locks = new LockStore(home, {})
  assert.deepEqual(locks.list(), {})
  mkdirSync(join(home, 'warden'), { recursive: true })
  writeFileSync(join(home, 'warden', 'locks.json'), '{ not json')
  assert.deepEqual(locks.list(), {})
  rmSync(home, { recursive: true, force: true })
})

test('LockStore：拿不到会话身份时明确拒绝，不静默加锁', () => {
  const home = tempHome()
  const locks = new LockStore(home, {})
  const r = locks.acquire({ name: 'x', resource: 'desktop-input', owner: '' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /持有者标识/)
  rmSync(home, { recursive: true, force: true })
})

test('EvidenceLedger：给了产物路径就自动按字节算指纹，不会静默变 unverified', () => {
  const home = tempHome()
  const artifact = join(home, 'a.bin')
  writeFileSync(artifact, Buffer.from([0x80]))
  const ev = new EvidenceLedger(home, {})
  const r = ev.record({ label: 'auto', reading: '1', artifact })
  assert.equal(r.ok, true)
  assert.equal(r.row.artifactHash, sha256Hex(Buffer.from([0x80])))
  assert.equal(r.row.hashVersion, HASH_ALGORITHM_VERSION)
  assert.equal(ev.check({ id: r.row.id }, (p) => ({ hash: sha256Hex(readFileSync(p)) })).state, 'verified')
  rmSync(home, { recursive: true, force: true })
})

test('EvidenceLedger：相对路径不会被当成绝对路径乱算', () => {
  const home = tempHome()
  const ev = new EvidenceLedger(home, {})
  const r = ev.record({ label: 'rel', reading: '1', artifact: 'build/out.txt' })
  assert.equal(r.ok, true)
  assert.equal(r.row.artifactHash, '', '相对路径没有 cwd，不该硬算一个指纹')
  assert.equal(ev.check({ id: r.row.id }, () => ({ hash: 'x' })).state, 'unverified')
  rmSync(home, { recursive: true, force: true })
})

test('EvidenceLedger：stats 分开统计已绑定 / 未绑定 / 旧算法', () => {
  const home = tempHome()
  const ev = new EvidenceLedger(home, {})
  const artifact = join(home, 'b.bin')
  writeFileSync(artifact, 'x')
  ev.record({ label: 'bound', reading: '1', artifact })
  ev.record({ label: 'unbound', reading: '2' })
  const stats = ev.stats()
  assert.equal(stats.total, 2)
  assert.equal(stats.bound, 1)
  assert.equal(stats.unbound, 1)
  assert.equal(stats.artifacts, 1)
  assert.equal(stats.hashAlgorithmVersion, HASH_ALGORITHM_VERSION)
  rmSync(home, { recursive: true, force: true })
})

test('Counters：按会话隔离、单会话键数有上限', () => {
  const c = new Counters()
  assert.equal(c.bump('s1', 'k'), 1)
  assert.equal(c.bump('s1', 'k'), 2)
  assert.equal(c.bump('s2', 'k'), 1, '串会话了')
  for (let i = 0; i < 500; i++) c.bump('s3', `k${i}`)
  assert.ok(c.bySession.get('s3').size <= c.limit, '键数没有上限')
  c.reset('s1')
  assert.equal(c.get('s1', 'k'), 0)
})

test('appendEvent / readEvents：最新在前，坏行跳过，返回写入结果', () => {
  const home = tempHome()
  assert.equal(appendEvent({ kind: 'a' }, home), true)
  assert.equal(appendEvent({ kind: 'b' }, home), true)
  const events = readEvents(home, 10)
  assert.equal(events[0].kind, 'b', '不是最新在前')
  assert.ok(events[0].at, '事件没有带时间戳')
  // 写不进去要返回 false，不能静默
  const blocker = join(tempHome(), 'file')
  writeFileSync(blocker, 'x')
  assert.equal(appendEvent({ kind: 'x' }, blocker), false)
  rmSync(home, { recursive: true, force: true })
})

/* ================================================================== *
 * F. 设置持久化（R7：写失败必须报失败）
 * ================================================================== */
section('F. 设置持久化')

test('settings：写进去能读出来；文件坏了退回空对象而不是抛', () => {
  const home = tempHome()
  const cfg = normalizeConfig({ preset: 'strict' })
  const saved = saveSettings(cfg, home, Object.keys(DEFAULT_CONFIG))
  assert.equal(saved.ok, true)
  assert.equal(saved.persisted, true)
  assert.ok(saved.bytes > 0)
  const loaded = loadSettings(home)
  assert.equal(loaded.config.preset, 'strict')
  writeFileSync(pluginPaths(home).settings, '{ broken')
  assert.deepEqual(loadSettings(home), {})
  rmSync(home, { recursive: true, force: true })
})

test('settings：写盘失败返回 ok:false + 原因（旧版把 false 丢了，界面谎报成功）', () => {
  const home = tempHome()
  const blocker = join(home, 'not-a-dir')
  writeFileSync(blocker, 'x')
  const r = saveSettings(normalizeConfig({}), blocker, Object.keys(DEFAULT_CONFIG))
  assert.equal(r.ok, false)
  assert.equal(r.persisted, false)
  assert.ok(r.reason && r.reason.length > 0, '失败没有给原因')
  rmSync(home, { recursive: true, force: true })
})

test('verifyPersisted：能发现"内存改了但盘上没改"', () => {
  const home = tempHome()
  const cfg = normalizeConfig({ preset: 'balanced' })
  saveSettings(cfg, home, Object.keys(DEFAULT_CONFIG))
  assert.equal(verifyPersisted(cfg, home, Object.keys(DEFAULT_CONFIG)).matches, true)
  const drifted = { ...cfg, waitCapMs: 12345 }
  const check = verifyPersisted(drifted, home, Object.keys(DEFAULT_CONFIG))
  assert.equal(check.matches, false)
  assert.match(check.reason, /waitCapMs/)
  rmSync(home, { recursive: true, force: true })
})

/* ================================================================== *
 * G. 能力台账（R7）
 * ================================================================== */
section('G. 能力台账')

test('四态互斥且可判：supported / mounted / observed / degraded', () => {
  const clock = fakeClock(1000)
  const caps = new Capabilities({ clock })
  caps.define('x', '测试能力')
  assert.equal(caps.snapshot()[0].state, 'unknown')
  caps.markSupported('x')
  assert.equal(caps.snapshot()[0].state, 'supported')
  caps.markMounted('x', () => {})
  assert.equal(caps.snapshot()[0].state, 'mounted')
  caps.markObserved('x')
  assert.equal(caps.snapshot()[0].state, 'observed')
  assert.equal(caps.get('x').observedCount, 1)
  caps.markDegraded('x', '坏了')
  assert.equal(caps.snapshot()[0].state, 'degraded')
  assert.equal(caps.snapshot()[0].mounted, false, '降级了还说挂着')
})

test('markMounted 传空句柄 = 挂载失败（R7 的病根：不能拿任意 disposer 当证据）', () => {
  const caps = new Capabilities({ clock: fakeClock(0) })
  for (const handle of [null, undefined, false]) {
    caps.markMounted('y', handle)
    assert.equal(caps.get('y').mounted, false, `句柄 ${String(handle)} 被当成了成功`)
    assert.equal(caps.get('y').degraded, true)
  }
  caps.markMounted('y', () => {})
  assert.equal(caps.get('y').mounted, true)
})

test('markUnsupported 与 standby 分得清：一个是宿主没有，一个是判给了别人', () => {
  const caps = new Capabilities({ clock: fakeClock(0) })
  caps.markUnsupported('historyPruning', '官方 Basic 是唯一 owner')
  caps.markStandby('waitCap', 'dsh-strata', '治理声明判给了 strata')
  const snap = Object.fromEntries(caps.snapshot().map((c) => [c.name, c]))
  assert.equal(snap.historyPruning.state, 'unsupported')
  assert.equal(snap.historyPruning.supported, false)
  assert.equal(snap.waitCap.state, 'standby')
  assert.equal(snap.waitCap.supported, true, 'standby 不等于宿主不支持')
  assert.equal(snap.waitCap.mounted, false)
  assert.equal(snap.waitCap.detail, 'dsh-strata')
})

test('卸载后 mounted/observed 归零，supported 保留', () => {
  const caps = new Capabilities({ clock: fakeClock(0) })
  caps.markMounted('z', () => {})
  caps.markObserved('z')
  caps.markUnmounted('z')
  const c = caps.get('z')
  assert.equal(c.mounted, false)
  assert.equal(c.observed, false)
  assert.equal(c.observedCount, 0)
  assert.equal(c.supported, true, '宿主能力没变，不该跟着归零')
})

test('降级日志限频：同一能力反复失败不会刷屏', () => {
  const clock = fakeClock(0)
  const events = []
  const caps = new Capabilities({ clock, onEvent: (e) => events.push(e) })
  for (let i = 0; i < 50; i++) caps.markDegraded('noisy', 'boom')
  assert.equal(events.filter((e) => e.kind === 'capability-degraded').length, 1)
  clock.advance(61_000)
  caps.markDegraded('noisy', 'boom')
  assert.equal(events.filter((e) => e.kind === 'capability-degraded').length, 2)
})

test('CAPABILITY_STATES 覆盖 snapshot 可能产出的全部取值', () => {
  const caps = new Capabilities({ clock: fakeClock(0) })
  caps.define('a'); caps.markSupported('b'); caps.markMounted('c', () => {})
  caps.markObserved('d'); caps.markDegraded('e', 'x'); caps.markUnsupported('f', 'y'); caps.markStandby('g', 'other')
  for (const entry of caps.snapshot()) {
    assert.ok(CAPABILITY_STATES.includes(entry.state), `产出了未登记的状态 ${entry.state}`)
  }
})

/* ================================================================== *
 * H. 规则正文与水位文案
 * ================================================================== */
section('H. 提示词正文')

test('rulesText：关掉某条规则，正文里就不再出现它', () => {
  const full = rulesText({ starTopology: true, resultsToFile: true, lockGuard: true, evidenceLedger: true, archiveToolResults: true })
  assert.match(full, /星型拓扑/)
  assert.match(full, /结论落文件/)
  assert.match(full, /共享资源/)
  assert.match(full, /指纹/)
  assert.match(full, /大输出会被归档/)
  const none = rulesText({ starTopology: false, resultsToFile: false, lockGuard: false, evidenceLedger: false, archiveToolResults: false })
  assert.equal(none, '', '全关了还产出正文')
  assert.equal(rulesText({ starTopology: false, resultsToFile: true }).includes('星型拓扑'), false)
})

test('rulesText：星型纪律限定为"私自串聊"，明确放行 Loom 经调度的协调（R9-C）', () => {
  const text = rulesText({ starTopology: true })
  // 禁的是"私自/未经批准"的串聊
  assert.match(text, /私自|未经调度/, '没有把禁令限定在私自串聊上')
  // 必须显式放行经批准、经运行时转发的结构化协调
  assert.match(text, /Loom|规划模块/, '没有点名合法协调的来源')
  assert.match(text, /白名单/, '没有说明合法协调的边界条件')
  assert.match(text, /不要因为这条纪律而拒绝/, '没有明确禁止误伤合法协调')
  // 不能写成绝对禁令
  assert.ok(!/只向主控汇报[。\n]*不要给其他子代理/.test(text), '仍然是绝对禁令，会堵死 Loom 的跨组协调')
})

test('rulesText：明确说明锁的覆盖边界，不承诺全局强制（R4）', () => {
  const text = rulesText({ lockGuard: true })
  assert.match(text, /不在覆盖范围|覆盖不到|认得的写入/)
})

test('rulesText：台账说明区分 verified 与 unverified（R5 / R9-D）', () => {
  const text = rulesText({ evidenceLedger: true })
  assert.match(text, /unverified/)
  assert.match(text, /不是.*verified|不能当验收/)
})

test('waterLevelText：读得到窗口就报占比，读不到就明说未知', () => {
  const withWindow = waterLevelText({ pressureTokens: 250000, contextWindow: 1000000, ratio: 0.25, basis: 'official-projection:pressure' }, 50000)
  assert.match(withWindow, /250k/)
  assert.match(withWindow, /25%/)
  assert.ok(!withWindow.includes('占比未知'))
  const noWindow = waterLevelText({ pressureTokens: 250000, contextWindow: null, ratio: null, basis: 'session-event:last-usage' }, 0)
  assert.match(noWindow, /占比未知/)
  assert.match(noWindow, /不是宿主的实时投影/, '退化口径没有说清自己是近似的')
})

/* ================================================================== *
 * I. 阶段合同
 * ================================================================== */
section('I. 阶段合同')

test('validateComplete：四种不合格情况都能点名', () => {
  const ok = { acceptance: [{ item: 'a', verified: true, evidence: 'log' }], requiredRemaining: [], sourceIdentity: 'p@h' }
  assert.deepEqual(validateComplete(ok), [])
  assert.ok(validateComplete({ ...ok, acceptance: [] }).some((p) => p.includes('没有列任何验收项')))
  assert.ok(validateComplete({ ...ok, acceptance: [{ item: 'a', verified: false }] }).some((p) => p.includes('还没有依据')))
  assert.ok(validateComplete({ ...ok, requiredRemaining: ['真实 Electron'] }).some((p) => p.includes('必需项')))
  assert.ok(validateComplete({ ...ok, sourceIdentity: '' }).some((p) => p.includes('源码身份')))
})

test('StageLedger：状态只能是五种之一，写坏的退回 in-progress', () => {
  const home = tempHome()
  const stages = new StageLedger(home, { clock: fakeClock(1) })
  const r = stages.record({ sessionId: 's', goal: 'g', status: 'done-maybe' })
  assert.equal(r.ok, true)
  assert.equal(r.row.status, 'in-progress')
  assert.equal(stages.list().length, 1)
  rmSync(home, { recursive: true, force: true })
})

test('ProgressWatch：假设被否定与新读数都算进展', () => {
  const clock = fakeClock(0)
  const w = new ProgressWatch({ clock })
  w.observe({ sessionId: 's', name: 'x', args: {}, result: { content: [] } }, {})
  const before = w.snapshot('s').lastProgressReason
  w.markHypothesisNegated('s', '不是缓存问题')
  assert.notEqual(w.snapshot('s').lastProgressReason, before)
  assert.equal(w.snapshot('s').hypothesesNegated, 1)
  w.markEvidence('s', '记了一条读数')
  assert.equal(w.snapshot('s').evidenceMarks, 1)
})

test('ProgressWatch：idleFor 反映"最后有效进展"以来的时间', () => {
  const clock = fakeClock(0)
  const w = new ProgressWatch({ clock })
  w.observe({ sessionId: 's', name: 'x', args: {}, result: { content: [{ type: 'text', text: 'a' }] } }, {})
  clock.advance(45_000)
  assert.equal(w.idleFor('s'), 45_000)
})

test('ProgressWatch：开新阶段清计数但保留文件指纹记忆', () => {
  const clock = fakeClock(0)
  const w = new ProgressWatch({ clock })
  w.observe({ sessionId: 's', name: 'write', args: { p: 1 }, result: { content: [{ type: 'text', text: 'r1' }] }, targetPath: '/a', targetHash: 'h1' }, {})
  w.countReply('s')
  w.startStage('s', 'S2')
  const snap = w.snapshot('s')
  assert.equal(snap.stageId, 'S2')
  assert.equal(snap.replies, 0)
  // 同一个文件同一个 hash 在新阶段里仍算"见过"，不会重复算成新证据
  const r = w.observe({ sessionId: 's', name: 'write', args: { p: 2 }, result: { content: [{ type: 'text', text: 'r2' }] }, targetPath: '/a', targetHash: 'h1' }, {})
  assert.ok(!r.reason.includes('新内容'), '换阶段就忘了文件状态，会把老内容当新证据')
})

/* ================================================================== *
 * J. 归档呈现
 * ================================================================== */
section('J. 归档呈现')

test('boundedSummary：给出路径、行数、字节、指纹，并禁止重跑找回', () => {
  const text = boundedSummary({
    toolName: 'bash', text: 'z'.repeat(5000),
    archived: { file: '/tmp/x/y.txt', hash: 'abc123', bytes: 5000, lines: 12 },
    keepChars: 400,
  })
  assert.match(text, /\/tmp\/x\/y\.txt/)
  assert.match(text, /行数：12/)
  assert.match(text, /sha256:abc123/)
  assert.match(text, /不要重新执行/)
  assert.match(text, /按行区间/)
  assert.ok(text.length < 5000, '摘要没有比原文小')
})

/* ================================================================== *
 * K. 模型侧工具
 * ================================================================== */
section('K. 模型侧工具')

function toolDeps(home, overrides = {}) {
  const clock = fakeClock(1_000_000)
  const capabilities = new Capabilities({ clock })
  const locks = new LockStore(home, { clock, capabilities })
  const evidence = new EvidenceLedger(home, { clock, capabilities })
  const stages = new StageLedger(home, { clock, capabilities })
  const progress = new ProgressWatch({ clock, capabilities })
  return {
    deps: {
      home, clock, capabilities, locks, evidence, stages, progress,
      counters: new Counters(),
      config: () => normalizeConfig({ preset: 'balanced' }),
      guards: () => [{ name: 'guard', stats: { blocked: 1 } }],
      onEvent: () => {},
      ...overrides,
    },
    clock,
    capabilities,
  }
}

const TOOL_NAMES = ['warden_status', 'acquire_lock', 'renew_lock', 'release_lock', 'list_locks', 'evidence_record', 'evidence_check', 'warden_stage']

test('createTools 返回全部工具，名字与文档一致', () => {
  const home = tempHome()
  const { deps } = toolDeps(home)
  const tools = createTools(deps)
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort())
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 10, `${t.name} 描述过短`)
    assert.equal(typeof t.execute, 'function')
  }
  rmSync(home, { recursive: true, force: true })
})

test('工具 schema 的 required 必须是父级字符串数组（写成布尔值会静默失效）', () => {
  const home = tempHome()
  const { deps } = toolDeps(home)
  for (const t of createTools(deps)) {
    const check = (schema, where) => {
      if (!schema || typeof schema !== 'object') return
      if ('required' in schema) {
        assert.ok(Array.isArray(schema.required), `${where}.required 不是数组`)
        for (const name of schema.required) {
          assert.ok(name in (schema.properties ?? {}), `${where}.required 里的 ${name} 不在 properties`)
        }
      }
      for (const [name, child] of Object.entries(schema.properties ?? {})) {
        assert.ok(!child || typeof child !== 'object' || !('required' in child), `${where}.${name} 里写了 required`)
      }
    }
    check(t.parameters, t.name)
    check(t.output.schema, `${t.name}.output`)
  }
  rmSync(home, { recursive: true, force: true })
})

test('warden_status 报出档位、能力四态、治理 owner、锁与台账', async () => {
  const home = tempHome()
  const { deps, capabilities } = toolDeps(home)
  capabilities.markMounted('waitCap', () => {})
  capabilities.markObserved('waitCap', 'hit')
  capabilities.markUnsupported('historyPruning', '官方 Basic 是唯一 owner')
  const out = await createTools(deps).find((t) => t.name === 'warden_status').execute({}, execFor('warden_status'))
  assert.match(out.text, /dsh-warden v/)
  assert.match(out.text, /sha256-bytes-v2/, '没有报出指纹算法版本')
  assert.match(out.text, /waitCap.*observed/)
  assert.match(out.text, /historyPruning.*unsupported/)
  assert.match(out.text, /历史压缩：warden \*\*不做\*\*/)
  assert.match(out.text, /治理 owner/)
  rmSync(home, { recursive: true, force: true })
})

test('acquire_lock → list_locks → renew_lock → release_lock 端到端', async () => {
  const home = tempHome()
  const { deps } = toolDeps(home)
  const tools = createTools(deps)
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  const exec = execFor('acquire_lock', {}, 'sess-A')

  const got = await byName.acquire_lock.execute({ resource: 'deployment:web-host', name: 'deploy', note: 'e2e' }, exec)
  assert.match(got.text, /已取得/)
  assert.match(got.text, /fence/)
  assert.match(got.text, /覆盖边界|认得出路径/, '没有说明覆盖边界，等于承诺了全局强制')

  const listed = await byName.list_locks.execute({}, exec)
  assert.match(listed.text, /named:deployment:web-host/)
  assert.match(listed.text, /可用的命名资源/)

  const fence = Number(/fence（栅栏令牌）：(\d+)/.exec(got.text)?.[1] ?? /fence[=＝:：]\s*(\d+)/.exec(got.text)?.[1])
  assert.ok(Number.isFinite(fence), `没从回执里解析出 fence：${got.text}`)
  const renewed = await byName.renew_lock.execute({ resource: 'deployment:web-host', fence }, exec)
  assert.match(renewed.text, /已续租/)

  // 用**过期** fence 续租必须被拒（执行面 fencing）
  const staleRenew = await byName.renew_lock.execute({ resource: 'deployment:web-host', fence: fence + 99 }, exec)
  assert.match(staleRenew.text, /栅栏令牌已失效/)
  assert.match(staleRenew.text, /停止写入/)

  const rel = await byName.release_lock.execute({ resource: 'deployment:web-host', fence }, exec)
  assert.match(rel.text, /已释放/)
  const after = await byName.list_locks.execute({}, exec)
  assert.match(after.text, /没有任何资源锁/)
  rmSync(home, { recursive: true, force: true })
})

test('acquire_lock：目标归一不出来时明说"没有加锁"，不假装锁住', async () => {
  const home = tempHome()
  const { deps } = toolDeps(home)
  const byName = Object.fromEntries(createTools(deps).map((t) => [t.name, t]))
  const out = await byName.acquire_lock.execute({ resource: '~/whatever' }, execFor('acquire_lock', {}, 'sess-A'))
  assert.match(out.text, /没有加锁|无法归一/)
  rmSync(home, { recursive: true, force: true })
})

test('acquire_lock：拿不到会话标识时明确失败', async () => {
  const home = tempHome()
  const { deps } = toolDeps(home)
  const byName = Object.fromEntries(createTools(deps).map((t) => [t.name, t]))
  const out = await byName.acquire_lock.execute({ resource: 'desktop-input' }, execFor('acquire_lock', {}, ''))
  assert.match(out.text, /拿不到当前会话标识/)
  assert.match(out.text, /没有取得/)
  rmSync(home, { recursive: true, force: true })
})

test('共享锁关掉时，acquire_lock 明说"功能关着"而不是静默失败', async () => {
  const home = tempHome()
  const { deps } = toolDeps(home, { config: () => normalizeConfig({ preset: 'custom', lockGuard: false }) })
  const byName = Object.fromEntries(createTools(deps).map((t) => [t.name, t]))
  const out = await byName.acquire_lock.execute({ resource: 'desktop-input' }, execFor('acquire_lock'))
  assert.match(out.text, /关闭/)
  rmSync(home, { recursive: true, force: true })
})

test('evidence_record → evidence_check：产物没变 verified，变了 stale', async () => {
  const home = tempHome()
  const { deps } = toolDeps(home)
  const byName = Object.fromEntries(createTools(deps).map((t) => [t.name, t]))
  const artifact = join(home, 'build.exe')
  writeFileSync(artifact, Buffer.from([0x80, 0x81, 0xff]))
  const exec = execFor('evidence_record', {}, 'sess-E', home)

  const rec = await byName.evidence_record.execute({ label: '启动耗时', reading: '1.2s', artifact: 'build.exe', environment: { profile: 'isolated' } }, exec)
  assert.match(rec.text, /已记录/)
  assert.match(rec.text, /sha256:/)
  assert.ok(!rec.text.includes('⚠'), `绑定了产物却报了警告：${rec.text}`)

  const okCheck = await byName.evidence_check.execute({ label: '启动耗时' }, exec)
  assert.match(okCheck.text, /verified/)
  assert.match(okCheck.text, /不证明测试通过/, 'verified 被说成了产品合格')
  assert.match(okCheck.text, /isolated/, '没有回显实验环境')

  writeFileSync(artifact, Buffer.from([0x80, 0x81, 0xfe]))
  const stale = await byName.evidence_check.execute({ label: '启动耗时' }, exec)
  assert.match(stale.text, /stale/)
  assert.match(stale.text, /作废/)
  rmSync(home, { recursive: true, force: true })
})

test('evidence_record：读不到产物时明说无法核对，不显示成有效', async () => {
  const home = tempHome()
  const { deps } = toolDeps(home)
  const byName = Object.fromEntries(createTools(deps).map((t) => [t.name, t]))
  const exec = execFor('evidence_record', {}, 'sess-E', home)
  const rec = await byName.evidence_record.execute({ label: 'x', reading: '1', artifact: join(home, 'missing.bin') }, exec)
  assert.match(rec.text, /读不到产物/)
  assert.match(rec.text, /unverified|不能作为验收依据/)
  const check = await byName.evidence_check.execute({ label: 'x' }, exec)
  assert.match(check.text, /unverified/)
  assert.ok(!check.text.includes('✅'), '未核对的读数显示了有效标记')
  rmSync(home, { recursive: true, force: true })
})

test('台账关掉时 evidence_record 明说原因', async () => {
  const home = tempHome()
  const { deps } = toolDeps(home, { config: () => normalizeConfig({ preset: 'custom', evidenceLedger: false }) })
  const byName = Object.fromEntries(createTools(deps).map((t) => [t.name, t]))
  const out = await byName.evidence_record.execute({ label: 'x', reading: '1' }, execFor('evidence_record'))
  assert.match(out.text, /关闭/)
  rmSync(home, { recursive: true, force: true })
})

test('warden_stage：缺必需项时拒绝 complete，并给出替代状态', async () => {
  const home = tempHome()
  const { deps } = toolDeps(home)
  const byName = Object.fromEntries(createTools(deps).map((t) => [t.name, t]))
  const exec = execFor('warden_stage', {}, 'sess-S')
  const denied = await byName.warden_stage.execute({
    goal: '修好等待上限', status: 'complete', required_remaining: ['真实 Electron 未验'],
  }, exec)
  assert.match(denied.text, /被拒/)
  assert.match(denied.text, /conditional-complete/)
  assert.match(denied.text, /blocked/)

  const accepted = await byName.warden_stage.execute({
    goal: '修好等待上限', stage_id: 'S1', status: 'blocked',
    acceptance: [{ item: '隔离宿主等待被截断', verified: true, evidence: 'tests/host-contract.mjs' }],
    required_remaining: ['真实 Electron 未验'], source_identity: 'path@hash',
  }, exec)
  assert.match(accepted.text, /已记录阶段/)
  assert.match(accepted.text, /blocked/)
  assert.match(accepted.text, /1\/1 已有依据/)
  rmSync(home, { recursive: true, force: true })
})

test('阶段合同关掉时 warden_stage 明说原因', async () => {
  const home = tempHome()
  const { deps } = toolDeps(home, { config: () => normalizeConfig({ preset: 'custom', stageContract: false }) })
  const byName = Object.fromEntries(createTools(deps).map((t) => [t.name, t]))
  const out = await byName.warden_stage.execute({ goal: 'g' }, execFor('warden_stage'))
  assert.match(out.text, /关闭/)
  rmSync(home, { recursive: true, force: true })
})

/* ================================================================== *
 * L. HTTP 数据面
 * ================================================================== */
section('L. HTTP 数据面')

function httpDeps(home, overrides = {}) {
  const clock = fakeClock(1_000_000)
  const capabilities = new Capabilities({ clock })
  let current = normalizeConfig({ preset: 'balanced' })
  let persistOk = true
  const deps = {
    home,
    clock,
    getConfig: () => ({ ...current }),
    setConfig: (patch) => {
      current = normalizeConfig(patch, current)
      const saved = persistOk ? saveSettings(current, home, Object.keys(DEFAULT_CONFIG)) : { ok: false, reason: 'EROFS: read-only file system' }
      return { config: { ...current }, persisted: saved.ok, reason: saved.ok ? '已落盘' : saved.reason }
    },
    getPersistence: () => ({ persisted: persistOk, reason: persistOk ? '已落盘' : '写盘失败' }),
    verifyPersisted: () => verifyPersisted(current, home, Object.keys(DEFAULT_CONFIG)),
    locks: new LockStore(home, { clock, capabilities }),
    evidence: new EvidenceLedger(home, { clock, capabilities }),
    counters: new Counters(),
    progress: new ProgressWatch({ clock, capabilities }),
    stages: new StageLedger(home, { clock, capabilities }),
    ledger: { list: () => [] },
    governance: { snapshot: () => [] },
    capabilities,
    stats: () => [{ name: 'guard', stats: { blocked: 1 } }],
    ...overrides,
  }
  return { deps, setPersistOk: (v) => { persistOk = v }, current: () => current }
}

await testAsync('GET /warden/status 返回配置/档位/能力/治理/锁/台账/阶段/事件', async () => {
  const home = tempHome()
  const { deps } = httpDeps(home)
  appendEvent({ kind: 'ready' }, home)
  const res = await httpCall(createHandler(deps), 'GET', '/warden/status')
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  const data = res.body.data
  assert.equal(data.package, 'dsh-warden')
  assert.equal(data.version, VERSION)
  for (const key of ['config', 'presets', 'capabilities', 'governance', 'locks', 'evidence', 'stages', 'progress', 'persistence', 'persistedCheck', 'events', 'stats']) {
    assert.ok(key in data, `status 少了 ${key}`)
  }
  assert.equal(data.presets.length, 4)
  rmSync(home, { recursive: true, force: true })
})

await testAsync('GET /warden/capabilities 只返回能力与治理归属', async () => {
  const home = tempHome()
  const { deps } = httpDeps(home)
  const res = await httpCall(createHandler(deps), 'GET', '/warden/capabilities')
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body.data.capabilities))
  assert.ok(Array.isArray(res.body.data.governance))
  rmSync(home, { recursive: true, force: true })
})

await testAsync('POST /warden/config 改单项会把档位标成 custom（不留幽灵状态）', async () => {
  const home = tempHome()
  const { deps, current } = httpDeps(home)
  const res = await httpCall(createHandler(deps), 'POST', '/warden/config', { config: { archiveToolResults: false } })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.data.config.preset, 'custom', '改了单项却没标 custom')
  assert.equal(current().archiveToolResults, false)
  assert.equal(res.body.data.persisted, true)
  rmSync(home, { recursive: true, force: true })
})

await testAsync('POST /warden/config 写盘失败 → 500 + ok:false（R7：不许谎报保存成功）', async () => {
  const home = tempHome()
  const { deps, setPersistOk } = httpDeps(home)
  setPersistOk(false)
  const res = await httpCall(createHandler(deps), 'POST', '/warden/config', { config: { waitCapMs: 30000 } })
  assert.equal(res.status, 500, '写盘失败却回了 200')
  assert.equal(res.body.ok, false)
  assert.match(res.body.error, /写盘失败/)
  assert.match(res.body.error, /重启后会丢失/)
  assert.equal(res.body.data.persisted, false)
  rmSync(home, { recursive: true, force: true })
})

await testAsync('POST /warden/preset 换整张取值表；custom 只改标记', async () => {
  const home = tempHome()
  const { deps, current } = httpDeps(home)
  const strict = await httpCall(createHandler(deps), 'POST', '/warden/preset', { preset: 'strict' })
  assert.equal(strict.status, 200)
  assert.equal(current().waitCapMs, PRESET_VALUES.strict.waitCapMs)
  assert.equal(current().archiveThresholdChars, PRESET_VALUES.strict.archiveThresholdChars)
  const custom = await httpCall(createHandler(deps), 'POST', '/warden/preset', { preset: 'custom' })
  assert.equal(custom.status, 200)
  assert.equal(current().preset, 'custom')
  assert.equal(current().waitCapMs, PRESET_VALUES.strict.waitCapMs, 'custom 不该改值')
  const bad = await httpCall(createHandler(deps), 'POST', '/warden/preset', { preset: 'yolo' })
  assert.equal(bad.status, 400)
  rmSync(home, { recursive: true, force: true })
})

await testAsync('POST /warden/lock/release：用户侧可以强制释放活锁', async () => {
  const home = tempHome()
  const { deps } = httpDeps(home)
  deps.locks.acquire({ name: 'live', resource: 'desktop-input', owner: 'agent-A', ttlMs: 60_000 })
  const refused = await httpCall(createHandler(deps), 'POST', '/warden/lock/release', { name: 'live' })
  assert.equal(refused.body.data.result.ok, false, '不带 force 也能释放别人的锁')
  const forced = await httpCall(createHandler(deps), 'POST', '/warden/lock/release', { name: 'live', force: true })
  assert.equal(forced.status, 200)
  assert.equal(forced.body.data.result.released, true)
  const bad = await httpCall(createHandler(deps), 'POST', '/warden/lock/release', {})
  assert.equal(bad.status, 400)
  rmSync(home, { recursive: true, force: true })
})

await testAsync('未知路径 404、错误方法 405、坏 JSON 400', async () => {
  const home = tempHome()
  const { deps } = httpDeps(home)
  const handler = createHandler(deps)
  assert.equal((await httpCall(handler, 'GET', '/warden/nope')).status, 404)
  assert.equal((await httpCall(handler, 'DELETE', '/warden/status')).status, 405)
  assert.equal((await httpCall(handler, 'POST', '/warden/config', { nope: 1 })).status, 400)
  rmSync(home, { recursive: true, force: true })
})

await testAsync('readJsonBody：超限与坏 JSON 都返回 null，不抛', async () => {
  const make = (payload) => ({
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(payload))
      if (event === 'end') setTimeout(cb, 0)
      return this
    },
    destroy() {},
  })
  assert.deepEqual(await readJsonBody(make('{"a":1}')), { a: 1 })
  assert.equal(await readJsonBody(make('not json')), null)
  assert.equal(await readJsonBody(make('x'.repeat(300 * 1024))), null)
})

/* ================================================================== *
 * M. apply() 装配
 * ================================================================== */
section('M. apply() 装配')

test('顶层 inject 故意留空（没写进 inject 的服务访问会抛，非 Web 组合也要能激活）', () => {
  assert.deepEqual(inject, [])
})

test('apply() 在没有任何宿主服务时也能挂上、并返回 status/dispose', () => {
  const home = tempHome()
  const ctx = emptyCtx()
  const instance = apply(ctx, {}, { clock: fakeClock(1_000_000) })
  assert.equal(typeof instance.status, 'function')
  assert.equal(typeof instance.dispose, 'function')
  const snap = instance.status()
  assert.equal(snap.ok, true)
  assert.equal(snap.data.version, VERSION)
  assert.ok(Array.isArray(snap.data.capabilities))
  assert.ok(Array.isArray(snap.data.governance))
  // 没有宿主服务时，依赖服务的能力**绝不能**自称 mounted / observed。
  // unknown 是诚实的（服务还没解析，无从判断）；谎报 mounted 才是 R7 的病。
  const states = Object.fromEntries(snap.data.capabilities.map((c) => [c.name, c.state]))
  for (const name of ['httpRoutes', 'clientUi', 'rulesSection']) {
    assert.ok(!['mounted', 'observed'].includes(states[name]),
      `${name} 在没有任何宿主服务时自称 ${states[name]}`)
  }
  assert.equal(states.historyPruning, 'unsupported', '历史压缩必须明确标不支持')
  instance.dispose()
  rmSync(home, { recursive: true, force: true })
})

test('apply() 的 settings.json 会盖在 patch 默认值之上', () => {
  const home = tempHome()
  saveSettings(normalizeConfig({ preset: 'strict' }), home, Object.keys(DEFAULT_CONFIG))
  const instance = apply(emptyCtx(), { preset: 'gentle' }, { clock: fakeClock(1) })
  assert.equal(instance.status().data.config.preset, 'strict', 'settings.json 没有盖过 patch')
  instance.dispose()
  rmSync(home, { recursive: true, force: true })
})

test('apply() 关掉总开关会卸载钩子并释放治理声明', () => {
  const home = tempHome()
  const instance = apply(emptyCtx(), { logLevel: 'error' }, { clock: fakeClock(1_000_000) })
  assert.equal(instance.status().data.config.enabled, true)
  instance.internals.setConfig({ enabled: false })
  const snap = instance.status()
  assert.equal(snap.data.config.enabled, false)
  assert.equal(snap.data.stats.length, 0, '停用后还有钩子挂着')
  // 治理声明必须释放，否则另一个模块会一直待命
  for (const g of snap.data.governance) {
    assert.notEqual(g.owner, PACKAGE_NAME, `停用后还占着 ${g.capability}`)
  }
  instance.dispose()
  rmSync(home, { recursive: true, force: true })
})

test('apply() 重复 reconcile 不会重复挂载（R7：总开关/重载不重复挂载）', () => {
  const home = tempHome()
  const instance = apply(emptyCtx(), { logLevel: 'error' }, { clock: fakeClock(1_000_000) })
  const before = instance.status().data.stats.length
  instance.internals.reconcileHooks()
  instance.internals.reconcileHooks()
  assert.equal(instance.status().data.stats.length, before, '重复挂载了钩子')
  instance.dispose()
  rmSync(home, { recursive: true, force: true })
})

test('apply() 的配置写盘失败会反映在 persistence 与能力台账上', () => {
  const home = tempHome()
  const blocker = join(home, 'warden')
  mkdirSync(join(home, 'warden'), { recursive: true })
  writeFileSync(join(home, 'warden', 'settings.json'), 'x')
  // 让 settings.json 变成一个目录，写盘必然失败
  rmSync(join(home, 'warden', 'settings.json'))
  mkdirSync(join(home, 'warden', 'settings.json'))
  const instance = apply(emptyCtx(), { logLevel: 'error' }, { clock: fakeClock(1_000_000) })
  const result = instance.internals.setConfig({ waitCapMs: 30000 })
  assert.equal(result.persisted, false, '写盘失败却报告已持久化')
  assert.ok(result.reason.length > 0)
  const snap = instance.status()
  assert.equal(snap.data.persistence.persisted, false)
  const cap = snap.data.capabilities.find((c) => c.name === 'settingsPersistence')
  assert.equal(cap.degraded, true, '写盘失败没有标降级')
  instance.dispose()
  rmSync(home, { recursive: true, force: true })
})

test('apply() 内存配置在写盘失败后仍然生效（热生效与持久化分开报）', () => {
  const home = tempHome()
  mkdirSync(join(home, 'warden', 'settings.json'), { recursive: true })
  const instance = apply(emptyCtx(), { logLevel: 'error' }, { clock: fakeClock(1_000_000) })
  instance.internals.setConfig({ waitCapMs: 12345 })
  assert.equal(instance.status().data.config.waitCapMs, 12345, '写盘失败时内存配置也没生效')
  instance.dispose()
  rmSync(home, { recursive: true, force: true })
})

test('systemClock 与 fakeClock 接口一致（可互换，不留真实时间竞速）', () => {
  const real = systemClock()
  const fake = fakeClock(0)
  for (const clock of [real, fake]) {
    assert.equal(typeof clock.now(), 'number')
    const id = clock.setTimeout(() => {}, 10)
    assert.ok(id !== undefined)
    clock.clearTimeout(id)
  }
  assert.equal(fake.now(), 0)
  assert.equal(fake.advance(500), 0)
  assert.equal(fake.now(), 500)
  let fired = 0
  fake.setTimeout(() => { fired++ }, 100)
  fake.setTimeout(() => { fired++ }, 200)
  fake.advance(150)
  assert.equal(fired, 1, '推进 150ms 应当只触发第一个定时器')
  assert.equal(fake.pending, 1)
  fake.advance(100)
  assert.equal(fired, 2)
  assert.equal(fake.pending, 0, '定时器泄漏')
})

/* ================================================================== *
 * 汇总
 * ================================================================== */
console.log(`\n${'='.repeat(62)}`)
console.log(`单元与数据层：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  for (const f of failures) console.log(`  ✗ ${f.name}`)
  process.exit(1)
}
process.exit(0)
