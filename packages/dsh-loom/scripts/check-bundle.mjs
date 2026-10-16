/**
 * 宿主半边产物的纯净性检查。
 *
 * 检查三件事：
 *   1. lib/index.js 存在（说明 tsc 真的跑过）
 *   2. 它的 import 只有 `node:*` 与相对路径 —— **一个裸包名都不许有**
 *   3. lib/client.js 存在，且它的 `require(...)` 只有 `react`（宿主平台表）
 *
 * 为什么第 2 条是硬要求：宿主半边能不能 `import '@deepseek-ai/xxx'` 取决于
 * 宿主的运行时解析机制，那是实现细节不是契约。少依赖一个，就少一种
 * 「插件装上但什么都不发生」的可能。第 3 条同理：客户端 `require()` 只认
 * 平台 seed 表，裸包名会直接抛。
 *
 * 用法：node scripts/check-bundle.mjs [--check]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let failures = 0
let checks = 0
function check(name, ok, detail = '') {
  checks += 1
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

console.log('# 产物纯净性检查')

/* ---------- 1. 宿主半边 ---------- */
const hostEntry = join(root, 'lib', 'index.js')
check('lib/index.js 存在', existsSync(hostEntry))

if (existsSync(hostEntry)) {
  const hostFiles = walk(join(root, 'lib')).filter((f) => f.endsWith('.js') && !f.endsWith('client.js'))
  const offenders = []
  for (const file of hostFiles) {
    const code = readFileSync(file, 'utf8')
    const specs = [
      ...code.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm),
      ...code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...code.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1])
    for (const spec of specs) {
      if (spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../')) continue
      offenders.push(`${relative(root, file)} → ${spec}`)
    }
    // The optional host adapter only loads these public APIs from the installed host.
    // These are interface calls, not bundled dependencies or copied source.
    const hostAPIs = new Set(['@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-shell', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tools'])
    for (const match of code.matchAll(/fromHost\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!(relative(root, file) === 'lib/host-helpers.js' && hostAPIs.has(match[1])) && !(relative(root, file) === 'lib/remote.js' && match[1] === '@deepseek-ai/dsh-typert-protocol')) offenders.push(`${relative(root, file)} → host API ${match[1]}`)
    }
  }
  check('宿主半边零非内置 import（只有 node:* 与相对路径）', offenders.length === 0, offenders.join('、'))
  check('宿主半边文件数 > 1（core 被编译进来）', hostFiles.length > 1, `实际 ${hostFiles.length}`)

  const entryCode = readFileSync(hostEntry, 'utf8')
  check('入口导出 apply()', /export\s+(?:async\s+)?function\s+apply|export\s*\{[^}]*apply/.test(entryCode))
  check('入口顶层 inject 是空数组', /export\s+const\s+inject\s*=\s*\[\s*\]/.test(entryCode))
}

/* ---------- 2. 客户端半边 ---------- */
const clientFile = join(root, 'lib', 'client.js')
check('lib/client.js 存在', existsSync(clientFile))
check('客户端有宿主扫描所需 exports ./client', JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).exports?.['./client'] === './lib/client.js')

if (existsSync(clientFile)) {
  const code = readFileSync(clientFile, 'utf8')
  check('客户端形状是 __ModuleLoader__.load(...)', /window\.__ModuleLoader__\.load\(\{/.test(code))
  check('客户端 id 是 dsh-loom', /id:\s*'dsh-loom'/.test(code))
  check('客户端没有顶层 import（会被当 ESM 解析而崩）', !/^\s*import\s/m.test(code))
  check('客户端没有 export 语句', !/^\s*export\s/m.test(code))

  const reqs = [...code.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  const unexpected = [...new Set(reqs)].filter((s) => s !== 'react')
  check('客户端只 require 平台 seed 表里的 react', unexpected.length === 0, unexpected.join('、'))

  // 形状检查：必须有 apply / inject 导出赋值
  check('客户端导出 apply', /module\.exports\.apply\s*=/.test(code))
  check('客户端导出 inject', /module\.exports\.inject\s*=/.test(code))
}

/* ---------- 3. 版本三处一致 ---------- */
{
  const { checkVersions } = await import('./sync-client-version.mjs')
  const v = checkVersions()
  check('package / config / client 三处版本一致', v.ok, v.problems.join('；') || JSON.stringify(v.versions))
}

/* ---------- 4. 第三方代码自检 ---------- */
const srcFiles = walk(join(root, 'src'))
const copiedMarkers = [
  'laurel-kit',
  '@xyflow',
  'react-flow',
  'ReactFlow',
  'dsh-strata',
]
const hits = []
for (const file of [...srcFiles, clientFile].filter((f) => existsSync(f))) {
  const code = readFileSync(file, 'utf8')
  for (const marker of copiedMarkers) {
    if (code.includes(marker)) hits.push(`${relative(root, file)} 含 ${marker}`)
  }
}
check('源码里没有第三方插件/库的残留标记', hits.length === 0, hits.join('、'))

console.log('')
console.log(failures === 0 ? `✅ 产物纯净性检查通过（${checks} 项）` : `❌ ${failures} 项失败 / 共 ${checks} 项`)
process.exit(failures === 0 ? 0 : 1)
