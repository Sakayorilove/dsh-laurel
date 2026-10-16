#!/usr/bin/env node
/**
 * dsh-loom · 客户端版本常量生成 / 校验
 *
 * ── 问题 ──────────────────────────────────────────────────────────────────
 * `lib/client.js` 是**手写**的客户端（没有打包步骤），里面硬编码
 *     const CLIENT_VERSION = '0.8.5'
 * 而 `package.json` 与 `lib/config.js` 都是 0.8.6。诊断页会把
 * `CLIENT_VERSION` 和后台 `loadedVersion` 对比，于是**同一个完整 release**
 * 也会报「前后台版本不同，请完全退出并重新打开 Harness」——
 * 用户按提示重启多少次都不会好，因为两边根本不是同一个版本源。
 *
 * ── 做法：从包版本生成，不靠人手抄 ────────────────────────────────────────
 *   node scripts/sync-client-version.mjs           # 把 CLIENT_VERSION 写成 package.json 的版本
 *   node scripts/sync-client-version.mjs --check    # 只校验 package / config / client 三处一致
 *
 * 三处必须一致：`package.json.version` = `lib/config.js` 的 `VERSION` = `lib/client.js` 的
 * `CLIENT_VERSION`。构建（`check-bundle.mjs`）与本脚本都会核，避免人工多份版本漂移。
 * 只隐藏提示而不修数值，是后来明确否掉的做法。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const CLIENT = join(root, 'lib', 'client.js')
const CONFIG = join(root, 'lib', 'config.js')
const PKG = join(root, 'package.json')

const CLIENT_RE = /(\bconst\s+CLIENT_VERSION\s*=\s*')([^']*)(')/
const CONFIG_RE = /(\bexport\s+const\s+VERSION\s*=\s*')([^']*)(')/

/** 读三处的版本号。 */
export function readVersions() {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
  const client = readFileSync(CLIENT, 'utf8')
  const config = readFileSync(CONFIG, 'utf8')
  const clientMatch = CLIENT_RE.exec(client)
  const configMatch = CONFIG_RE.exec(config)
  return {
    package: typeof pkg.version === 'string' ? pkg.version : null,
    config: configMatch ? configMatch[2] : null,
    client: clientMatch ? clientMatch[2] : null,
  }
}

/**
 * 校验三处一致。
 * @returns {{ ok: boolean, versions: object, problems: string[] }}
 */
export function checkVersions() {
  const versions = readVersions()
  const problems = []
  if (versions.package === null) problems.push('package.json 没有 version')
  if (versions.config === null) problems.push('lib/config.js 里找不到 VERSION')
  if (versions.client === null) problems.push('lib/client.js 里找不到 CLIENT_VERSION')
  if (versions.package !== null && versions.config !== versions.package) {
    problems.push(`lib/config.js VERSION=${versions.config} 与 package.json ${versions.package} 不一致`)
  }
  if (versions.package !== null && versions.client !== versions.package) {
    problems.push(`lib/client.js CLIENT_VERSION=${versions.client} 与 package.json ${versions.package} 不一致`)
  }
  return { ok: problems.length === 0, versions, problems }
}

/** 把 client / config 的版本写成 package.json 的版本。 */
export function syncVersions() {
  const versions = readVersions()
  if (versions.package === null) throw new Error('package.json 没有 version')
  const changed = []
  const client = readFileSync(CLIENT, 'utf8')
  if (versions.client !== versions.package) {
    writeFileSync(CLIENT, client.replace(CLIENT_RE, `$1${versions.package}$3`))
    changed.push(`lib/client.js CLIENT_VERSION: ${versions.client} → ${versions.package}`)
  }
  const config = readFileSync(CONFIG, 'utf8')
  if (versions.config !== versions.package) {
    writeFileSync(CONFIG, config.replace(CONFIG_RE, `$1${versions.package}$3`))
    changed.push(`lib/config.js VERSION: ${versions.config} → ${versions.package}`)
  }
  return changed
}

function main(argv) {
  const check = argv.includes('--check')
  if (check) {
    const result = checkVersions()
    if (result.ok) {
      console.log(`✓ 版本三处一致：${result.versions.package}`)
      return 0
    }
    for (const p of result.problems) console.error(`✗ ${p}`)
    console.error('  跑 `node scripts/sync-client-version.mjs` 由包版本生成，别手改。')
    return 1
  }
  const changed = syncVersions()
  if (changed.length === 0) console.log(`✓ 无需改动（${readVersions().package}）`)
  else for (const c of changed) console.log(`✓ ${c}`)
  return 0
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])
if (invokedDirectly) process.exit(main(process.argv.slice(2)))
