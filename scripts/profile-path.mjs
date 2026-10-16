/**
 * Laurel 套件 · profile 与安装面的**默认位置**（唯一一份判定）
 *
 * ── 为什么单独抽一个文件 ─────────────────────────────────────────────────
 * 这条判定原本在两个脚本里各写了一遍，而且都是**写死某台机器的绝对路径**：
 *   · `verify-installed.mjs` 的默认 profile：`C:/Users/<某人>/.dsh/profiles/desktop`
 *   · `release.mjs --check` 的默认目标：`<工作区>/.../Laurel-Center`
 * 后果有两个，都不是小事：
 *   1. **换机器/换用户就错**。在 WSL 里跑，`C:/Users/...` 会被 `resolve()` 当成
 *      相对路径，拼成 `<仓库>/C:/Users/...`，检查直接报「profile 不存在」。
 *   2. **把某个用户的目录结构写进了要开源的代码里**（隐私 + 别人跑不通）。
 *
 * 现在只有这一份：**环境变量 → profile 里 `laurel-center` 的 link 指向 → 仓库内 release/**，
 * 每一步都可解释，找不到就返回 null（**不猜**一个看起来像的路径继续跑）。
 *
 * WSL 里 Windows 盘符路径会被翻成 `/mnt/<盘>/…`；Windows 上原样保留。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 这个进程是不是跑在 WSL 里（Windows 路径要翻译）。 */
export function isWsl(env = process.env) {
  return process.platform !== 'win32'
    && typeof env.WSL_DISTRO_NAME === 'string' && env.WSL_DISTRO_NAME.length > 0
}

/** Windows 盘符路径 → WSL 的 `/mnt/<盘>/…`；非 Windows 路径原样返回。 */
export function toPosixPath(p, env = process.env) {
  if (typeof p !== 'string' || p.length === 0) return p
  const text = p.replace(/\\/g, '/')
  const m = /^([A-Za-z]):\/(.*)$/.exec(text)
  if (m === null) return text
  if (process.platform === 'win32' && !isWsl(env)) return text
  return `/mnt/${m[1].toLowerCase()}/${m[2]}`
}

/** profile 目录的候选清单（按优先级去重）。 */
export function profileCandidates(env = process.env) {
  const out = []
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0) {
    out.push(join(toPosixPath(env.DSH_HOME), 'profiles', 'desktop'))
  }
  for (const home of [env.USERPROFILE, env.HOME, homedir()]) {
    if (typeof home !== 'string' || home.length === 0) continue
    out.push(join(toPosixPath(home), '.dsh', 'profiles', 'desktop'))
  }
  // WSL 里 Windows 侧的 profile 不在本机家目录下，而在 /mnt/<盘>/Users/<用户名>/。
  // 这里做一次**有界**列目录（只认 Windows 用户目录的形状，跳过系统账户）：
  // 找到的候选**同样要真实存在**才算数，所以这不是「猜一个看起来像的路径」。
  if (isWsl(env)) {
    for (const drive of ['c', 'd', 'e', 'f']) {
      const usersRoot = `/mnt/${drive}/Users`
      let names = []
      try {
        names = readdirSync(usersRoot)
      } catch {
        continue
      }
      for (const name of names) {
        if (/^(Public|Default|Default User|All Users|WDAGUtilityAccount)$/i.test(name)) continue
        out.push(join(usersRoot, name, '.dsh', 'profiles', 'desktop'))
      }
    }
  }
  return [...new Set(out)]
}

/** 真实存在的 profile 目录；都没有 → `null`（调用方必须显式报错，不许猜）。 */
export function defaultProfileDir(env = process.env, exists = existsSync) {
  for (const c of profileCandidates(env)) if (exists(c)) return c
  return null
}

/**
 * 解析「这次要操作哪个 profile」。
 *
 * 三条规则，都是为了让**不带参数**的默认调用真的可用（R1），同时不猜：
 *   · 显式传了位置参数 → 用它，但要求里面真有 `package.json`（否则装到一半才发现是错目录）
 *   · 没传 → 按 `profileCandidates()` 找；**恰好一个**才用
 *   · 一个都找不到 / 找到多个 → 返回 `error` + 候选清单，由调用方打印并要求显式传参
 *
 * 「多个候选就拒绝」是刻意的：候选清单包含 WSL 里扫到的其它 Windows 用户目录，
 * 猜错等于往别人的 profile 里写依赖。
 *
 * @returns {{ dir: string, error?: undefined } | { dir?: undefined, error: string, candidates: string[] }}
 */
export function resolveProfileDir({ explicit = null, env = process.env, exists = existsSync } = {}) {
  if (typeof explicit === 'string' && explicit.length > 0) {
    const dir = toPosixPath(explicit)
    if (!exists(join(dir, 'package.json'))) {
      return { error: `指定的 profile 里没有 package.json：${dir}`, candidates: [] }
    }
    return { dir }
  }
  const all = profileCandidates(env)
  const found = all.filter((c) => exists(join(c, 'package.json')))
  if (found.length === 0) {
    return { error: '找不到 Harness profile 目录（没传位置参数，自动查找也没命中）', candidates: all }
  }
  if (found.length > 1) {
    return { error: '找到多个候选 profile，不能替你猜', candidates: found }
  }
  return { dir: found[0] }
}

/**
 * `link:` / `file:` 依赖 spec 的规范写法。
 *
 * **必须把反斜杠换成正斜杠**：Windows 上 `resolve()` 给出 `D:\a\b`，拼成 `link:D:\a\b`
 * 之后 pnpm 会把 `\` 当转义字符，spec 解析不到目标目录。真实 profile 里存的也是
 * `link:D:/...` 这种正斜杠形式（`pathFromSpec` 反过来读得回来）。
 */
export function linkSpec(target, protocol = 'link') {
  return `${protocol}:${String(target).replace(/\\/g, '/')}`
}

/** 从 profile 的 `package.json` 读某个包的 `link:` / `file:` 目标（两段依赖都认）。 */
export function depTarget(profileDir, name, { exists = existsSync, readFile = readFileSync } = {}) {
  const file = join(profileDir, 'package.json')
  if (!exists(file)) return null
  let pkg
  try {
    pkg = JSON.parse(readFile(file, 'utf8'))
  } catch {
    return null
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const spec = deps[name]
  if (typeof spec !== 'string') return null
  const m = /^(?:link|file):(.*)$/.exec(spec)
  return m === null ? null : toPosixPath(m[1])
}

/**
 * 安装面（release 生成物）的默认目录。
 *
 * 顺序：`LAUREL_CENTER_INSTALL` 环境变量 → profile 里 `laurel-center` 的 link 指向
 *      → `<repo>/release`（`release.mjs` 默认就是生成到那里）。
 */
export function defaultInstallDir({ repo, env = process.env, exists = existsSync } = {}) {
  if (typeof env.LAUREL_CENTER_INSTALL === 'string' && env.LAUREL_CENTER_INSTALL.length > 0) {
    return toPosixPath(env.LAUREL_CENTER_INSTALL)
  }
  const profile = defaultProfileDir(env, exists)
  if (profile !== null) {
    const target = depTarget(profile, 'laurel-center', { exists })
    if (target !== null) return target
  }
  return join(repo, 'release')
}
