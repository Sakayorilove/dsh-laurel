#!/usr/bin/env node
/**
 * Laurel 套件 · 装载机 / 模块工具（**只读**，零副作用）
 *
 * ── 它解决什么问题 ──────────────────────────────────────────────────────
 * 「装载机 + 模块」的好处是：装载机能单独更新，每个模块也能单独更新，
 * 模块可以随时增加/删除。代价是**一个模块同时出现在好几个落点上**，
 * 少改一个不会报错，只是「那一行永远不出现」或「开关点了没反应」。
 *
 * 一个模块的全部落点（本工具逐条校验）：
 *   1. `lib/registry.js` 的 `SUB_PLUGINS` —— **唯一真相**：id / dir / entry / clientId / label / desc / defaultOn
 *   2. `packages/<dir>/` 实体源码 + `package.json`（name / main / exports["./client"] / version）
 *   3. `cordis.patch.yml` insert 里的那一行：id 相同、name 是**纯包名**、`disabled: true`
 *   4. `lib/client/index.mjs` 客户端 locale：`plugin.<id>` 与 `plugin.<id>.desc`（zh 与 en 各一条）
 *   5. profile 的 `package.json`：子包 link 指向 `<装载机>/packages/<dir>`（给 profile 目录才查）
 *   6. `scripts/assembly-check.mjs` **不再有第二份清单** —— 它的 SUB_PACKAGES / STABLE_IDS 由 registry 推导
 *
 * 落点 1 是唯一真相；2–4 由本工具比对；5 只做指向与形状核对
 * （真实装配的权威校验是 `scripts/assembly-check.mjs`，它查 realpath / 入口 / patch 唯一性）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node scripts/module.mjs list                 # 列出装载机与全部模块（含版本与落点状态）
 *   node scripts/module.mjs check                # 校验落点一致；不一致退出码 1
 *   node scripts/module.mjs check <profileDir>   # 连 profile 的依赖指向一起查
 *
 * ── 为什么不去改 patch / 自动增删 ────────────────────────────────────────
 * 自动改写 `cordis.patch.yml` 会毁掉它里面那些「为什么这么写」的注释，
 * 而注释是这个项目里防止重犯 `uiSettings` 那类事故的主要手段。
 * 所以本工具**只读**：它告诉你**还差哪一处**，改由人和评审来做。
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUB_PLUGINS } from '../lib/registry.js'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 装载机自己那一行（patch 里的 name 是相对本包的入口，不是包名 —— 它由本包的 patch 声明）。 */
export const LOADER = { id: 'laurel-center', name: './lib/index.js', dir: '.' }

/** loader 行 id 的形状：小写字母/数字/连字符，且不以连字符开头。 */
const ID_RE = /^[a-z0-9][a-z0-9-]*$/

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function norm(p) {
  return String(p).split(sep).join('/')
}

/** realpath，失败返回 null（断链 / 不存在）。 */
function safeRealpath(p) {
  try {
    return norm(realpathSync(p))
  } catch {
    return null
  }
}

/** `link:` / `file:` spec → 路径；取不到返回 null。 */
function pathFromSpec(spec) {
  if (typeof spec !== 'string') return null
  const m = /^(?:link|file):(.*)$/.exec(spec)
  return m ? m[1] : null
}

/** 把一个路径规整成「平台无关」形状，只用于字符串兜底比较，不用于 IO。 */
function canon(p) {
  const text = norm(resolve(p))
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(text)
  if (win) return `/${win[1].toLowerCase()}/${win[2]}`
  return text
}

/**
 * 取 `cordis.patch.yml` 里 insert 块的行（id / name / disabled）。
 *
 * ⚠ 这是**本仓库自己写的文件**的形状提取，不是通用 YAML 解析器：
 * 只认「缩进里的 `- id: X`，后面跟着同名块里的 `name:` / `disabled:`」这一种写法。
 * 语义层的 YAML 解析仍然只走宿主那份（见 `lib/patch.js` 的注释），
 * 这里刻意不引入第二套 YAML 语义。
 */
export function parsePatchRows(text) {
  const rows = []
  let current = null
  for (const raw of String(text).split(/\r?\n/)) {
    if (/^\s*$/.test(raw) || /^\s*#/.test(raw)) continue
    const item = /^\s*-\s*id:\s*(\S+)\s*$/.exec(raw)
    if (item) {
      current = { id: item[1], name: null, disabled: undefined }
      rows.push(current)
      continue
    }
    if (current === null) continue
    const kv = /^\s*(name|disabled):\s*(.+?)\s*$/.exec(raw)
    if (!kv) continue
    if (kv[1] === 'name') current.name = kv[2].replace(/^['"]|['"]$/g, '')
    else if (kv[2] === 'true') current.disabled = true
    else if (kv[2] === 'false') current.disabled = false
  }
  return rows
}

/**
 * 收集装载机与全部模块，并核对落点 1–4。
 *
 * @returns {{ ok: boolean, problems: string[], warnings: string[], modules: object[], loader: object, patchRows: object[] }}
 */
export function collectModules({ repo = REPO } = {}) {
  const problems = []
  const warnings = []
  const modules = []
  const seen = new Set()

  for (const p of SUB_PLUGINS) {
    const item = {
      id: p.id,
      dir: p.dir,
      entry: p.entry,
      clientId: p.clientId,
      label: p.label,
      defaultOn: p.defaultOn,
      version: null,
      pkgName: null,
      hasMain: false,
      hasClient: false,
      dirExists: false,
      patchRow: null,
    }

    if (!ID_RE.test(p.id)) problems.push(`registry: id 形状不合法（应为小写字母/数字/连字符）：${p.id}`)
    if (seen.has(p.id)) problems.push(`registry: id 重复：${p.id}`)
    seen.add(p.id)
    if (typeof p.entry !== 'string' || p.entry.length === 0 || p.entry.includes('/')) {
      problems.push(`registry: ${p.id} 的 entry 必须是**纯包名**（不能带斜杠）：${p.entry}`)
    }
    if (p.clientId !== undefined && p.clientId !== p.entry) {
      problems.push(`registry: ${p.id} 的 clientId=${p.clientId} 与 entry=${p.entry} 不一致（三处必须同名）`)
    }

    const dir = join(repo, 'packages', p.dir)
    item.dirExists = existsSync(dir) && statSync(dir).isDirectory()
    if (!item.dirExists) {
      problems.push(`packages/${p.dir} 不存在（注册表指向了不存在的模块）`)
      modules.push(item)
      continue
    }

    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) {
      problems.push(`packages/${p.dir}/package.json 不存在`)
    } else {
      let pkg = null
      try {
        pkg = readJson(pkgFile)
      } catch (error) {
        problems.push(`packages/${p.dir}/package.json 解析失败：${String(error?.message ?? error)}`)
      }
      if (pkg) {
        item.pkgName = pkg.name ?? null
        item.version = pkg.version ?? null
        if (pkg.name !== p.entry) problems.push(`packages/${p.dir}/package.json name=${pkg.name} ≠ registry.entry=${p.entry}`)
        if (typeof pkg.version !== 'string' || pkg.version.length === 0) problems.push(`packages/${p.dir}/package.json 没有 version`)
        const main = typeof pkg.main === 'string' ? pkg.main : null
        if (main === null) problems.push(`packages/${p.dir}/package.json 没有 main（宿主入口）`)
        else {
          item.hasMain = existsSync(join(dir, main))
          if (!item.hasMain) problems.push(`packages/${p.dir} 的 main 指向的入口不存在：${main}`)
        }
        const client = pkg.exports?.['./client'] ?? pkg.dsh?.client?.entry ?? null
        if (typeof client === 'string') {
          item.hasClient = existsSync(join(dir, client))
          if (!item.hasClient) problems.push(`packages/${p.dir} 的客户端 bundle 不存在：${client}`)
        } else {
          warnings.push(`packages/${p.dir} 没有声明 exports["./client"]（宿主侧模块可以没有客户端半边，确认是有意的）`)
        }
      }
    }

    modules.push(item)
  }

  // packages/ 下的孤儿目录：有实体、没注册 —— 删模块时最容易漏的一处。
  const pkgRoot = join(repo, 'packages')
  if (existsSync(pkgRoot)) {
    for (const name of readdirSync(pkgRoot)) {
      if (name.startsWith('.') || name === 'node_modules') continue
      const full = join(pkgRoot, name)
      if (!statSync(full).isDirectory()) continue
      if (!SUB_PLUGINS.some((p) => p.dir === name)) {
        warnings.push(`packages/${name} 存在但没有注册表条目（孤儿目录：要么登记它，要么删掉）`)
      }
    }
  }

  // 落点 3：cordis.patch.yml
  const patchFile = join(repo, 'cordis.patch.yml')
  let patchRows = []
  if (!existsSync(patchFile)) {
    problems.push('cordis.patch.yml 不存在')
  } else {
    patchRows = parsePatchRows(readFileSync(patchFile, 'utf8'))
    const loaderRows = patchRows.filter((r) => r.id === LOADER.id)
    if (loaderRows.length !== 1) {
      problems.push(`cordis.patch.yml: 装载机那行（id: ${LOADER.id}）应恰好 1 行，实际 ${loaderRows.length} 行`)
    } else if (loaderRows[0].name !== LOADER.name) {
      problems.push(`cordis.patch.yml: ${LOADER.id} 的 name 应为 ${LOADER.name}，实际 ${loaderRows[0].name}`)
    }
    for (const p of SUB_PLUGINS) {
      const hit = patchRows.filter((r) => r.id === p.id)
      const item = modules.find((m) => m.id === p.id)
      if (item) item.patchRow = hit[0] ?? null
      if (hit.length !== 1) {
        problems.push(`cordis.patch.yml: id ${p.id} 应恰好 1 行，实际 ${hit.length} 行（漏插或重复插都会让开关失效）`)
        continue
      }
      if (hit[0].name !== p.entry) {
        problems.push(`cordis.patch.yml: ${p.id} 的 name 应为纯包名 ${p.entry}，实际 ${hit[0].name}（带斜杠会静默失效）`)
      }
      if (hit[0].disabled !== true) {
        problems.push(`cordis.patch.yml: ${p.id} 缺 disabled: true（出厂默认应全关，由总控台打开）`)
      }
    }
    const known = new Set([LOADER.id, ...SUB_PLUGINS.map((p) => p.id)])
    for (const r of patchRows) {
      if (!known.has(r.id)) warnings.push(`cordis.patch.yml: id ${r.id} 不在注册表里（手工加的行？）`)
    }
  }

  // 落点 4：客户端 locale 键（zh + en）
  const clientSrcFile = join(repo, 'lib', 'client', 'index.mjs')
  const clientSrc = existsSync(clientSrcFile) ? readFileSync(clientSrcFile, 'utf8') : ''
  if (clientSrc.length === 0) problems.push('lib/client/index.mjs 不存在或为空')
  for (const p of SUB_PLUGINS) {
    for (const key of [`'plugin.${p.id}'`, `'plugin.${p.id}.desc'`]) {
      const count = clientSrc.split(key).length - 1
      if (count < 2) {
        problems.push(`lib/client/index.mjs: locale 缺 ${key}（zh 与 en 各要一条，实际 ${count} 条）`)
      }
    }
  }

  // 落点 6：客户端清单必须来自注册表（否则又变成两份）
  const buildFile = join(repo, 'scripts', 'build-client.mjs')
  const buildSrc = existsSync(buildFile) ? readFileSync(buildFile, 'utf8') : ''
  if (!/['"]lib\/registry\.js['"]/.test(buildSrc)) {
    problems.push('scripts/build-client.mjs 的清单里没有 lib/registry.js：客户端清单不再来自注册表（又变成两份）')
  }
  const bundleFile = join(repo, 'lib', 'client.js')
  const bundle = existsSync(bundleFile) ? readFileSync(bundleFile, 'utf8') : ''
  if (!bundle.includes('SUB_PLUGINS')) {
    problems.push('lib/client.js 里没有 SUB_PLUGINS：客户端 bundle 未按新清单重建，跑 `node scripts/build-client.mjs`')
  }

  return { ok: problems.length === 0, problems, warnings, modules, loader: LOADER, patchRows }
}

/**
 * 落点 5：profile 的依赖指向（只做形状与指向核对）。
 *
 * @returns {{ problems: string[], warnings: string[], rows: Array<object> }}
 */
export function checkProfile(profileDir, { repo = REPO } = {}) {
  const problems = []
  const warnings = []
  const rows = []
  const pkgFile = join(profileDir, 'package.json')
  if (!existsSync(pkgFile)) {
    problems.push(`profile 没有 package.json：${pkgFile}`)
    return { problems, warnings, rows }
  }
  let pkg = null
  try {
    pkg = readJson(pkgFile)
  } catch (error) {
    problems.push(`profile package.json 解析失败：${String(error?.message ?? error)}`)
    return { problems, warnings, rows }
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const expected = [
    { id: LOADER.id, name: LOADER.id, target: repo },
    ...SUB_PLUGINS.map((p) => ({ id: p.id, name: p.entry, target: join(repo, 'packages', p.dir) })),
  ]
  for (const e of expected) {
    const spec = deps[e.name]
    const row = { name: e.name, spec: spec ?? null, ok: false, note: '' }
    if (spec === undefined) {
      problems.push(`profile 缺依赖 ${e.name}（宿主按裸包名解析 loader 行，缺一个就少一行）`)
      row.note = '缺依赖'
      rows.push(row)
      continue
    }
    const specPath = pathFromSpec(spec)
    if (specPath === null) {
      row.note = `非 link/file spec（${spec}）`
      warnings.push(`profile 的 ${e.name} 不是 link:/file:（${spec}）：变更后是否仍指向本仓库，需要人工确认`)
      rows.push(row)
      continue
    }
    const want = canon(e.target)
    const got = canon(specPath)
    const real = safeRealpath(specPath)
    if (real !== null) {
      row.ok = real === want
      row.note = row.ok ? '' : `realpath=${real} ≠ ${want}`
      if (!row.ok) problems.push(`profile 的 ${e.name} realpath 指向别处：${real} ≠ ${want}`)
    } else if (got === want) {
      // 路径还不存在（尚未安装）：形状对就算过，但要说清没验 realpath
      row.ok = true
      row.note = '路径尚不存在，只核了形状'
      warnings.push(`profile 的 ${e.name} 目标尚不存在（${spec}）：只核了形状，没有 realpath 证据`)
    } else {
      row.note = `${got} ≠ ${want}`
      problems.push(`profile 的 ${e.name} 指向 ${got}，期望 ${want}`)
    }
    rows.push(row)
  }
  return { problems, warnings, rows }
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function pad(text, width) {
  const s = String(text ?? '')
  let w = 0
  for (const ch of s) w += ch.codePointAt(0) > 0x2e80 ? 2 : 1
  return s + ' '.repeat(Math.max(0, width - w))
}

function printList(result) {
  const { modules, loader } = result
  console.log(`装载机  ${pad(loader.id, 22)}${pad('(本仓库根)', 30)}${loader.name}`)
  console.log('模块：')
  console.log(`  ${pad('id', 18)}${pad('目录', 24)}${pad('包名', 24)}${pad('版本', 10)}${pad('默认', 8)}落点`)
  for (const m of modules) {
    const marks = []
    marks.push(m.dirExists ? 'dir✓' : 'dir✗')
    marks.push(m.pkgName === m.entry ? 'pkg✓' : 'pkg✗')
    marks.push(m.patchRow ? 'patch✓' : 'patch✗')
    marks.push(m.patchRow?.disabled === true ? '默认关' : m.patchRow ? '默认开!' : '-')
    console.log(`  ${pad(m.id, 18)}${pad(m.dir, 24)}${pad(m.entry, 24)}${pad(m.version ?? '-', 10)}${pad(m.defaultOn ? 'on' : 'off', 8)}${marks.join(' ')}`)
  }
}

function main(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'))
  const cmd = positional[0] ?? 'list'
  const profileDir = positional[1] ? resolve(positional[1]) : null

  if (cmd === 'list') {
    const result = collectModules()
    printList(result)
    if (result.warnings.length > 0) {
      console.log('\n提醒：')
      for (const w of result.warnings) console.log(`  · ${w}`)
    }
    if (!result.ok) {
      console.log(`\n✗ 有 ${result.problems.length} 处不一致（跑 \`node scripts/module.mjs check\` 看逐条）：`)
      for (const p of result.problems) console.log(`  · ${p}`)
      return 1
    }
    console.log('\n✓ 注册表 / packages / patch / 客户端清单 一致')
    return 0
  }

  if (cmd === 'check') {
    const result = collectModules()
    const profile = profileDir === null ? null : checkProfile(profileDir)
    console.log('落点核对：')
    for (const m of result.modules) {
      const line = [
        m.dirExists ? 'packages/ 目录' : 'packages/ 目录 ✗',
        m.pkgName === m.entry ? `package.json name=${m.pkgName}` : `package.json name≠${m.entry} ✗`,
        m.patchRow ? `patch 行(id=${m.patchRow.id}, name=${m.patchRow.name}${m.patchRow.disabled === true ? ', disabled:true' : ', 缺 disabled:true!'})` : 'patch 行 ✗',
      ]
      console.log(`  ${pad(m.id, 18)}${line.join('  |  ')}`)
    }
    if (profile !== null) {
      console.log('profile 依赖：')
      for (const r of profile.rows) console.log(`  ${pad(r.name, 24)}${pad(r.ok ? '✓' : '✗', 3)}${r.spec ?? '(缺)'}${r.note ? `  ← ${r.note}` : ''}`)
    }
    const problems = [...result.problems, ...(profile?.problems ?? [])]
    const warnings = [...result.warnings, ...(profile?.warnings ?? [])]
    console.log(`\n${'─'.repeat(48)}`)
    console.log(`问题 ${problems.length} 项，提醒 ${warnings.length} 项`)
    for (const p of problems) console.log(`  ✗ ${p}`)
    for (const w of warnings) console.log(`  · ${w}`)
    if (problems.length === 0) {
      console.log('✓ 装载机与全部模块的落点一致')
      return 0
    }
    console.log('改完再跑一次；增删模块的完整步骤见 MODULES.md。')
    return 1
  }

  console.error(`未知子命令：${cmd}\n用法：node scripts/module.mjs list | check [profileDir]`)
  return 2
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)))
}
