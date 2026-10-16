/**
 * Laurel-Center · release 目标边界检查（第三轮 G3 重写）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * `scripts/release.mjs` 会 `rmSync(dest, { recursive: true, force: true })` 再往里拷。
 * 第一轮用「极小可丢弃夹具」实测过：把 `--to` 指向脚本**自己的源码目录**，
 * 脚本先旁路备份、**删掉源码目录**，再试图从已经删掉的源码复制 → ENOENT，
 * 原 payload 不存在了。普通安装目标也一样是先删后逐文件复制，中途出错没有恢复路径。
 *
 * 所以：**任何字符串都不许直接进递归 rm**。先过这一层检查，再谈写。
 *
 * ── 第三轮补修（G3）：上一版只看字符串，等于没看 ──────────────────────────
 * 上一版只调 `resolve()`（纯字符串运算），既没有解析符号链接，也没有逐级检查祖先。
 * 独立复现：仓库外的符号链接指向夹具源码时 `alias` 与 `alias/packages` 都被放行；
 * 已有 `profile/node_modules/foo` 被放行；WSL 盘根 `/mnt/d` 也被放行
 * （两个路径段就过了「层级过浅」那一条）。
 *
 * 现在：
 *   · 目标、仓库、家目录都解析**真实路径**（`realpathSync` 解析最长的已存在前缀，
 *     再接上还不存在的后缀），词法路径与物理路径**同时**参与判断
 *   · 逐级检查目标的祖先：像 profile 的、以及 `$DSH_HOME` 数据目录的后代，一律拒绝
 *   · 显式拒绝文件系统/挂载根与 `/mnt/<盘符>`
 *   · 返回**已验证的物理目标**，后续 staging / 备份 / 删除都用它；
 *     切换前还会再核一次身份（`recheckDestination`），防止 guard 之后链接被换掉
 *
 * ── 拒绝哪些目标 ──────────────────────────────────────────────────────────
 *   · 源码根本身、源码根的**任何祖先**（那会连仓库一起删）
 *   · 仓库内**不在白名单**的路径（白名单只有 `<repo>/release` 与 `<repo>/release-<名字>`）
 *   · `$HOME`、`$HOME/.dsh/**`（DSH 数据）
 *   · 文件系统根 / 挂载点 / `/mnt/<盘符>`
 *   · 看起来像 **profile** 的目录及其后代（有 cordis.yml / cordis.patch.yml 且
 *     package.json 声明 `dsh.profile`）
 *   · 通过符号链接绕到上面任何一处
 *
 * 允许的目标：仓库外的任意普通目录（例如另一块盘上的安装面），或仓库内白名单目录。
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'

/** 仓库内允许写入的目录（显式白名单）。`release` 是默认目标。 */
export const IN_REPO_WHITELIST = [/^release$/, /^release-[A-Za-z0-9._-]+$/]

/** 是否位于 parent 之内（含 parent 本身）。 */
function within(child, parent) {
  const c = resolve(child)
  const p = resolve(parent)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** 安全 realpath。 */
function safeRealpath(p) {
  try { return realpathSync(p) } catch { return null }
}

/**
 * 解析**物理路径**：对最长的已存在前缀做 realpath，再接上还不存在的后缀。
 *
 * 这样「目标还不存在」也能拿到真实位置 —— 光 `resolve()` 是拿不到的
 * （G3 的 alias/packages 就是这么绕过去的）。
 *
 * @returns {{ physical: string, existingPrefix: string, suffix: string[], realpathApplied: boolean }}
 */
export function resolvePhysical(p) {
  const abs = resolve(p)
  const suffix = []
  let cursor = abs
  for (;;) {
    if (existsSync(cursor)) break
    const parent = dirname(cursor)
    if (parent === cursor) break
    suffix.unshift(basename(cursor))
    cursor = parent
  }
  const real = safeRealpath(cursor)
  const base = real ?? cursor
  return {
    physical: suffix.length > 0 ? join(base, ...suffix) : base,
    existingPrefix: cursor,
    suffix,
    realpathApplied: real !== null,
  }
}

/** 目标的祖先链（从根到自身，含自身）。 */
function ancestorChain(p) {
  const abs = resolve(p)
  const out = []
  let cursor = abs
  for (;;) {
    out.unshift(cursor)
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return out
}

/** 本机挂载点（Linux）。拿不到就返回空表，不影响其它判据。 */
export function mountPoints() {
  try {
    return readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .map((line) => line.split(' ')[1])
      .filter((p) => typeof p === 'string' && p.length > 0)
      .map((p) => p.replace(/\\040/g, ' '))
  } catch {
    return []
  }
}

/** 这个目录看起来像不像一个 DSH profile。 */
export function looksLikeProfile(dir) {
  try {
    if (!existsSync(join(dir, 'package.json'))) return false
    if (!existsSync(join(dir, 'cordis.yml')) && !existsSync(join(dir, 'cordis.patch.yml'))) return false
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return Boolean(pkg?.dsh?.profile)
  } catch {
    return false
  }
}

/** 从 path 起向上找第一个已存在的目录。 */
function nearestExisting(path) {
  const abs = resolve(path)
  let cursor = abs
  const root = parse(cursor).root
  while (!existsSync(cursor)) {
    if (cursor === root) return root
    cursor = dirname(cursor)
  }
  return cursor
}

/**
 * 检查 release 目标是否允许。
 *
 * @param {string} rawDest 用户给的 `--to`（或默认值）
 * @param {{ repo?: string, home?: string, mounts?: string[] }} [options]
 * @returns {{ ok: boolean, dest: string, destPhysical: string, reason: string | null, evidence: object }}
 */
export function guardDestination(rawDest, options = {}) {
  const repo = resolve(options.repo ?? process.cwd())
  const home = resolve(options.home ?? homedir())
  const mounts = options.mounts ?? mountPoints()

  const destLexical = resolve(rawDest)
  const repoResolved = resolvePhysical(repo)
  const homeResolved = resolvePhysical(home)
  const destResolved = resolvePhysical(destLexical)
  const repoPhys = repoResolved.physical
  const homePhys = homeResolved.physical
  const destPhysical = destResolved.physical

  const evidence = {
    repo,
    repoPhysical: repoPhys,
    home,
    homePhysical: homePhys,
    dest: destLexical,
    destPhysical,
    existingPrefix: destResolved.existingPrefix,
    existingPrefixPhysical: safeRealpath(destResolved.existingPrefix),
    realpathApplied: destResolved.realpathApplied,
    nearestExisting: nearestExisting(destLexical),
    mounts: mounts.length,
  }
  const reject = (reason) => ({ ok: false, dest: destLexical, destPhysical, reason, evidence })

  if (typeof rawDest !== 'string' || rawDest.trim().length === 0) return reject('空目标')
  // 相对路径照收，但要先 resolve 成绝对路径再判 —— 判据是**真实位置**，不是字符串写法。
  // （`--to .` 会 resolve 成 cwd，落在源码根时下面第 1 条就拒了。）

  // 判据只用**目标自己**的词法/物理形式。
  // 不要把「目标的已存在祖先」也塞进来 —— 那是 dest 的上级，本来就可能包含仓库
  // （夹具里 dest=<父>/out、repo=<父>/guard/source，用祖先判会误杀合法目标）。
  // 符号链接父目录已经由 destPhysical（对已存在前缀做 realpath）覆盖。
  const destForms = () => new Set([destLexical, destPhysical])

  // ── 1) 源码根与它的祖先（词法 + 物理两种形式都判）──────────────────────
  for (const repoForm of new Set([repo, repoPhys])) {
    for (const destForm of destForms()) {
      if (within(repoForm, destForm)) {
        return reject(`目标是源码根或它的祖先（${destForm} 包含 ${repoForm}）—— 会连仓库一起删`)
      }
    }
  }

  // ── 2) 仓库内：只有白名单（按物理位置算相对路径）───────────────────────
  for (const destForm of destForms()) {
    if (within(destForm, repoPhys) || within(destForm, repo)) {
      const base = within(destForm, repoPhys) ? repoPhys : repo
      const rel = resolve(destForm).slice(resolve(base).length).replace(/^[\\/]+/, '').split(sep).join('/')
      const allowed = IN_REPO_WHITELIST.some((re) => re.test(rel))
      if (!allowed) {
        return reject(`仓库内目标不在白名单（允许：${IN_REPO_WHITELIST.map(String).join(' / ')}），实得 "${rel}"`)
      }
    }
  }

  // ── 3) 家目录 / DSH 数据目录 ────────────────────────────────────────────
  const dshData = join(homePhys, '.dsh')
  for (const destForm of new Set([destLexical, destPhysical])) {
    if (resolve(destForm) === homePhys || resolve(destForm) === home) return reject('目标是 $HOME 本身')
    if (within(destForm, dshData) || within(destForm, join(home, '.dsh'))) {
      return reject(`目标是 DSH 数据目录（${dshData}）`)
    }
  }

  // ── 4) 文件系统根 / 挂载点 / WSL 盘根 ───────────────────────────────────
  const roots = new Set([parse(destLexical).root, parse(destPhysical).root, ...mounts])
  for (const destForm of new Set([destLexical, destPhysical])) {
    if (roots.has(resolve(destForm))) return reject(`目标是文件系统根或挂载点：${destForm}`)
  }
  if (/^\/mnt\/[A-Za-z]\/?$/.test(destPhysical) || /^\/mnt\/[A-Za-z]\/?$/.test(destLexical)) {
    return reject(`目标是 WSL 盘根：${destPhysical}`)
  }
  const segs = destPhysical.split(sep).filter(Boolean)
  if (segs.length < 2) return reject(`目标层级过浅（像是盘根）：${destPhysical}`)

  // ── 5) 逐级检查祖先：profile 及其后代、DSH 数据祖先 ─────────────────────
  const chain = new Set([
    ...ancestorChain(destPhysical),
    ...ancestorChain(destLexical),
    ...ancestorChain(destResolved.existingPrefix),
  ])
  evidence.ancestorsChecked = chain.size
  for (const ancestor of chain) {
    if (looksLikeProfile(ancestor)) return reject(`目标落在 profile 里（祖先 ${ancestor} 是 profile）：${destPhysical}`)
    if (within(ancestor, dshData)) return reject(`目标的祖先在 DSH 数据目录里：${ancestor}`)
  }

  return { ok: true, dest: destLexical, destPhysical, reason: null, evidence }
}

/**
 * 切换前再核一次身份：guard 之后链接可能被换掉。
 * @returns {{ ok: boolean, reason: string | null, destPhysical: string }}
 */
export function recheckDestination(guard) {
  const again = guardDestination(guard.dest, { repo: guard.evidence.repo, home: guard.evidence.home })
  if (!again.ok) return { ok: false, reason: `切换前复核失败：${again.reason}`, destPhysical: again.destPhysical }
  if (again.destPhysical !== guard.destPhysical) {
    return { ok: false, reason: `切换前复核发现目标真实路径变了：${guard.destPhysical} → ${again.destPhysical}`, destPhysical: again.destPhysical }
  }
  return { ok: true, reason: null, destPhysical: again.destPhysical }
}
