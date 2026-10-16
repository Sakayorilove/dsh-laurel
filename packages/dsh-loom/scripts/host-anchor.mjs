/**
 * Loom · 「宿主锚点」解析（唯一一份，测试与开发脚本共用）
 *
 * ── 这个文件解决什么 ─────────────────────────────────────────────────────
 * 一批测试和开发脚本需要**本机安装的 DSH 宿主**（`@deepseek-ai/cordis`、
 * `@deepseek-ai/dsh-session`、`dsh-tools` …）。它们原来的写法是把锚点写死成
 * 一个**占位符路径**：
 *
 *   const host = createRequire('/home/<你的用户>/projects/deepseek-harness-runtime/package.json')
 *
 * 后果（2026-10-13 公开仓首次使用反馈里复现）：
 *   · 这个路径在任何人机器上都不存在 → `createRequire` 在**模块加载期**就抛，
 *     测试文件根本没机会报告「缺少宿主环境」，整个测试运行器直接停在那里；
 *   · 而且它是**某一台机器的目录形状**，等于把开发者的目录结构写进了公开代码。
 *
 * 现在：
 *   · 锚点**可配置**（`LOOM_HOST_ANCHOR`，也认 `DSH_HOME`），
 *   · 每个候选都**真的试着解析一次宿主模块**才算数（不是「文件存在就算」），
 *   · 一个都没有 → 需要宿主的测试**明确 skip 并打印怎么准备环境**，
 *     不需要宿主的单元测试照常跑（`tests/run-tests.mjs` 也按这个区分报告）。
 *
 * ── 怎么准备宿主环境 ─────────────────────────────────────────────────────
 * 三种情况，任选其一：
 *   1. 开发机装了 Harness 源码/运行时：
 *        LOOM_HOST_ANCHOR=~/projects/deepseek-harness-runtime/package.json npm test
 *      （也可以给安装目录，脚本自己找里面的 package.json）
 *   2. 设了 `DSH_HOME`（Harness 的用户目录）：脚本会从它和它的上一级找 package.json
 *   3. Loom 被**装进宿主**（profile 的 node_modules 里）时，模块自身就在宿主的解析路径上，
 *      不用配任何东西。
 *
 * 探测模块用 `@deepseek-ai/cordis`：宿主里的所有半边都建在它上面。
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/** 指定宿主锚点的环境变量（可以是 package.json，也可以是安装目录）。 */
export const HOST_ANCHOR_ENV = 'LOOM_HOST_ANCHOR'

/** 用来判断「这个锚点背后真的有宿主」的包。 */
const PROBE_MODULE = '@deepseek-ai/cordis'

/** 把候选规整成 `createRequire` 能吃的字符串；明显不可用的返回 null。 */
function usableCandidate(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  if (value.startsWith('file:')) return value
  if (existsSync(join(value, 'package.json'))) return join(value, 'package.json')
  if (value.endsWith('.json') && existsSync(value)) return value
  return null
}

/**
 * 候选清单（按优先级）。
 * @returns {string[]} 已去掉明显不可用的项
 */
export function hostAnchorCandidates(env = process.env) {
  const raw = []
  if (env[HOST_ANCHOR_ENV]) raw.push(env[HOST_ANCHOR_ENV])
  if (env.DSH_HOME) {
    raw.push(env.DSH_HOME)
    raw.push(dirname(env.DSH_HOME))
  }
  // 本机开发时的常见位置：都是**候选**，下面必须真的能解析出宿主模块才算数。
  const home = homedir()
  raw.push(join(home, 'projects', 'deepseek-harness-runtime'))
  raw.push(join(home, 'deepseek-harness-runtime'))
  // 被装进宿主时，本模块自己就在宿主的解析路径里。
  raw.push(import.meta.url)
  if (process.argv[1] && isAbsolute(process.argv[1])) raw.push(process.argv[1])

  const out = []
  for (const item of raw) {
    const candidate = usableCandidate(item)
    if (candidate !== null && !out.includes(candidate)) out.push(candidate)
  }
  return out
}

/**
 * 第一个**真的能解析出宿主模块**的锚点；都没有 → null（不猜）。
 * @returns {string | null}
 */
export function resolveHostAnchor(env = process.env) {
  for (const candidate of hostAnchorCandidates(env)) {
    try {
      createRequire(candidate)(PROBE_MODULE)
      return candidate
    } catch { /* 下一个候选 */ }
  }
  return null
}

/** 本次运行的宿主锚点（模块加载时算一次）。 */
export const hostAnchor = resolveHostAnchor()

/** 本机有没有可用的宿主。 */
export const hasHost = hostAnchor !== null

/** 需要宿主却没宿主时，测试显示的原因 —— 必须能照着做。 */
export const hostSkipReason = hasHost
  ? false
  : `需要本机 DSH 宿主（找不到能解析 ${PROBE_MODULE} 的锚点）。准备方式任选其一：`
    + `① 装了 Harness 就设 ${HOST_ANCHOR_ENV}=<Harness 的 package.json 或安装目录>；`
    + `② 设 DSH_HOME；③ 把 Loom 装进 profile（那时本模块自己就在宿主的解析路径里）。`

/** 取一个宿主作用域的 `require`（带 `.resolve`），没有宿主时抛能照着做的错。 */
function hostScopedRequire() {
  if (hostAnchor === null) {
    throw new Error(`HOST_UNAVAILABLE: ${hostSkipReason}`)
  }
  return createRequire(hostAnchor)
}

/**
 * 取一个宿主模块。没有宿主时**抛一个能照着做的错**，而不是 ENOENT。
 * 用法与 `createRequire(...)` 的返回值完全一致：`host('@deepseek-ai/cordis')`。
 *
 * 也保留 `createRequire` 返回值的 `.resolve` —— 有些用例要的是**路径**
 * （`host.resolve('@deepseek-ai/dsh-web-frontend/package.json')`），
 * 换成只返回模块的函数会让它们报 `host.resolve is not a function`。
 */
export function hostRequire(name) {
  return hostScopedRequire()(name)
}

/** 与 `createRequire(...).resolve` 同形。 */
hostRequire.resolve = (name) => hostScopedRequire().resolve(name)

/**
 * 需要宿主的测试：没有宿主就 **skip 并说明怎么准备**（不是静默通过，也不是崩在加载期）。
 * 不需要宿主的测试继续用 `node:test` 的 `test`。
 */
export function hostTest(name, fn) {
  return test(name, { skip: hostSkipReason }, fn)
}

/** 命令行自检：`node scripts/host-anchor.mjs` 打印解析结果，便于排查。 */
const invokedDirectly = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedDirectly) {
  console.log(`宿主锚点：${hostAnchor ?? '（未找到）'}`)
  if (!hasHost) {
    console.log('候选（都不满足）：')
    for (const c of hostAnchorCandidates()) console.log(`  · ${c}`)
    console.log(hostSkipReason)
    process.exitCode = 1
  }
}
