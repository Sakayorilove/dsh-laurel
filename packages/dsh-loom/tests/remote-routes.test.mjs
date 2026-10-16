/**
 * 路由白名单防复发测试（42 号 S1 / ，0.7.2 事故固化）。
 *
 * 真宿主的客户端只走 RPC、没有 HTTP 回退：lib/client.js 里每个 requestJSON 端点
 * 都必须同步出现在 src/remote.ts 的 reads（GET）/ writes（POST）白名单里；
 * 漏一条 = 整条功能静默不可达（0.7.2 修的就是 /flow、/planning/stage 等五条）。
 *
 * 双向断言：
 *   1) 客户端调用 → 白名单（含真实 parseLoomRequest 边界校验）；
 *   2) 白名单 → 客户端：未被调用的路由必须在 KNOWN_NON_CLIENT 登记理由。
 *
 * 客户端新增端点：同步补 src/remote.ts 白名单。
 * 服务端新增仅宿主/工具用的路由：登记进 KNOWN_NON_CLIENT。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLoomRequest } from '../lib/remote.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const remote = readFileSync(join(root, 'src', 'remote.ts'), 'utf8')

/** 白名单里允许存在、但当前没有客户端调用的路由（每条都要写清消费方/原因）。 */
const KNOWN_NON_CLIENT = new Map([
  ['/capabilities', '客户端未调用：会话无关的能力清单，由 HTTP handler 提供（src/http.ts「/capabilities」分支）。'],
  ['/events', '客户端未调用：工作区事件日志读取（src/http.ts「/events」分支，store.readEvents）。'],
  ['/runs', '客户端未调用：最近运行列表；tests/persistence-http.test.mjs 直接经 handler 调用（api(\'/runs\')）。'],
  ['/batch', '客户端未调用：批次脚本正文端点，供外部 agent 经 HTTP 取用（src/tools.ts 的 loom_compile 输出明确引用）。'],
  ['/architecture/adopt', '客户端未调用：架构采纳的 HTTP 侧路径（src/http.ts 与 /architecture 同分支）；客户端走 POST /architecture 与 POST /adopt。'],
])

/* ---------- 解析 lib/client.js 的 requestJSON 调用 ---------- */

/** 从 open 处的 '(' 起做引号/注释感知的括号配平，返回顶层实参文本数组。 */
function callArguments(text, open) {
  const args = []
  let current = ''
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      current += ch
      for (i += 1; i < text.length; i += 1) {
        const inside = text[i]
        current += inside
        if (inside === '\\') { i += 1; current += text[i] ?? ''; continue }
        if (inside === ch) break
      }
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      i -= 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; current += ch; continue }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1
      if (depth === 0) { args.push(current); return args }
      current += ch
      continue
    }
    if (ch === ',' && depth === 1) { args.push(current); current = ''; continue }
    current += ch
  }
  throw new Error('requestJSON(...) 调用未闭合')
}

function normalizeRoute(raw, line, text) {
  const cut = raw.indexOf('?')
  const path = cut === -1 ? raw : raw.slice(0, cut)
  if (!path.startsWith('/') || path.includes('${')) {
    throw new Error(`requestJSON 路径实参不是静态路由（lib/client.js:${line}）：${text.trim().slice(0, 120)}`)
  }
  return path
}

/** 路径表达式 → 路由字面量列表；解析不了的写法显式失败（要求登记解析规则）。 */
function routeLiterals(expr, line) {
  const text = expr.trim()
  const ternary = /^[\s\S]*?\?\s*('([^']*)'|"([^"]*)")\s*:\s*('([^']*)'|"([^"]*)")\s*$/.exec(text)
  if (ternary) {
    return [normalizeRoute(ternary[2] ?? ternary[3], line, text), normalizeRoute(ternary[5] ?? ternary[6], line, text)]
  }
  const literal = /^('([^']*)'|"([^"]*)")\s*(\+[\s\S]*)?$/.exec(text)
  if (literal) return [normalizeRoute(literal[2] ?? literal[3], line, text)]
  const template = /^`([^`]*)`\s*(\+[\s\S]*)?$/.exec(text)
  if (template) return [normalizeRoute(template[1], line, text)]
  throw new Error(
    `无法静态解析 requestJSON 的路径实参（lib/client.js:${line}）：${text.slice(0, 120)}\n` +
    '请改用字面量/三元字面量写法，或更新本测试的解析规则并登记。',
  )
}

const clientRoutes = new Map()
{
  const pattern = /requestJSON\s*\(/g
  let match
  while ((match = pattern.exec(client)) !== null) {
    if (/function\s*$/.test(client.slice(Math.max(0, match.index - 20), match.index))) continue
    const lineStart = client.lastIndexOf('\n', match.index)
    if (client.slice(lineStart + 1, match.index).includes('//')) continue
    const open = match.index + match[0].length - 1
    const args = callArguments(client, open)
    assert.ok(args.length >= 2, `requestJSON 调用缺少 path 实参（lib/client.js:${client.slice(0, match.index).split('\n').length}）`)
    const line = client.slice(0, match.index).split('\n').length
    const method = /\bmethod\s*:\s*'POST'/.test(args[2] ?? '') ? 'POST' : 'GET'
    for (const path of routeLiterals(args[1], line)) {
      const key = `${method} ${path}`
      if (!clientRoutes.has(key)) clientRoutes.set(key, { method, path, line })
    }
  }
}

/** 从 src/remote.ts 提取白名单 Set（声明格式变化时显式失败）。 */
function extractSet(name) {
  const match = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(remote)
  assert.ok(match, `无法解析 src/remote.ts 的 ${name} 白名单（声明格式变了？同步更新本测试）`)
  const values = [...match[1].matchAll(/'([^']+)'/g)].map((one) => one[1])
  assert.ok(values.length >= 10, `${name} 白名单解析结果异常（只有 ${values.length} 条）`)
  return new Set(values)
}

/* ---------- 断言 ---------- */

test('every client requestJSON route is admitted by the RPC whitelist', () => {
  assert.ok(clientRoutes.size >= 25, `扫描到的客户端路由太少（${clientRoutes.size} 条），解析器可能失效`)
  assert.ok(clientRoutes.has('POST /planning/preview') && clientRoutes.has('POST /architecture/preview'), '三元分支解析失效：未扫到 /planning|architecture/preview')
  assert.ok(clientRoutes.has('POST /planning/accept') && clientRoutes.has('POST /architecture/accept'), '三元分支解析失效：未扫到 /planning|architecture/accept')
  assert.ok(clientRoutes.has('GET /planning/collect'), '带查询串的 /planning/collect 未被扫到')

  const reads = extractSet('reads')
  const writes = extractSet('writes')
  const missing = []
  for (const { method, path, line } of clientRoutes.values()) {
    const whitelist = method === 'GET' ? reads : writes
    if (!whitelist.has(path)) missing.push(`${method} ${path}（lib/client.js:${line}）`)
  }
  assert.deepEqual(missing, [], `以下客户端路由不在 src/remote.ts 白名单里，真宿主会静默不可达：\n  ${missing.join('\n  ')}`)
})

test('every client route passes the real parseLoomRequest boundary', () => {
  for (const { method, path } of clientRoutes.values()) {
    try {
      parseLoomRequest({ sessionId: 'routes-guard', method, path, ...(method === 'POST' ? { body: {} } : {}) })
    } catch (error) {
      assert.fail(`parseLoomRequest 拒绝了客户端路由 ${method} ${path}：${error.message}`)
    }
  }
})

test('the whitelist has no unregistered unused routes', () => {
  const reads = extractSet('reads')
  const writes = extractSet('writes')
  const whitelist = new Set([...reads, ...writes])
  for (const path of KNOWN_NON_CLIENT.keys()) {
    assert.ok(whitelist.has(path), `KNOWN_NON_CLIENT 登记的 ${path} 已不在白名单里，请删除这条登记`)
  }
  const clientPaths = new Set([...clientRoutes.values()].map((route) => route.path))
  const unused = [...whitelist].filter((path) => !clientPaths.has(path) && !KNOWN_NON_CLIENT.has(path))
  assert.deepEqual(unused, [], [
    '白名单里出现客户端未调用、也未登记的路由：',
    ...unused.map((path) => `  ${path}`),
    '客户端新端点 → 补 lib/client.js 的 requestJSON 调用或修正白名单；',
    '宿主/工具专用 → 在 KNOWN_NON_CLIENT 登记理由；历史遗留 → 评估后随版本清理。',
  ].join('\n'))
})
