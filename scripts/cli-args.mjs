/**
 * Laurel 套件 · 命令行参数解析（唯一一份）
 *
 * ── 为什么单独抽出来 ─────────────────────────────────────────────────────
 * 三个脚本（`install-profile.mjs` / `assembly-check.mjs` / `verify-installed.mjs`）
 * 原来各写了一遍「过滤掉 `--` 开头的、剩下的当位置参数」。这个写法有一个**必然的**
 * 错误：带值的选项，它的**值**不以 `--` 开头，于是被当成位置参数。
 *
 * 实测复现（2026-10-13 公开仓首次使用评审 R1）：
 *   node scripts/install-profile.mjs --center /tmp/center /tmp/profile
 *     → positional = ['/tmp/center', '/tmp/profile'] → profileDir 取成了 **center**
 *   node scripts/install-profile.mjs <profile> --center
 *     → argv[centerIdx + 1] 是 undefined → resolve(undefined) 直接抛异常
 *
 * 所以解析只写一遍，放这里：
 *   · `--opt value` 与 `--opt=value` 两种写法都认
 *   · 带值的选项**吃掉**它的值，值不进位置参数
 *   · 缺值的选项记一条明确错误，不静默继续
 *   · 不认识的 `--xxx` 也记错误（写错选项名时最怕「什么都没发生」）
 */

/**
 * @param {string[]} argv `process.argv.slice(2)`
 * @param {{ valueOptions?: string[], knownFlags?: string[] }} [spec]
 *   `valueOptions`：需要跟一个值的选项（如 `--center`）。
 *   `knownFlags`：不接值的选项白名单；给了就校验，没给就全部接受。
 * @returns {{
 *   values: Map<string, string>,
 *   flags: Set<string>,
 *   positional: string[],
 *   errors: string[],
 * }}
 */
export function parseArgs(argv, spec = {}) {
  const valueOptions = new Set(spec.valueOptions ?? [])
  const knownFlags = spec.knownFlags ? new Set(spec.knownFlags) : null

  const values = new Map()
  const flags = new Set()
  const positional = []
  const errors = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    // `--` 之后一律当位置参数（路径可能真的以 `-` 开头）。
    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }

    const eq = /^(--[^=]+)=(.*)$/.exec(arg)
    const name = eq === null ? arg : eq[1]

    if (valueOptions.has(name)) {
      if (eq !== null) {
        values.set(name, eq[2])
        continue
      }
      const next = argv[i + 1]
      // 缺值：不拿下一个选项名当值。
      if (next === undefined || next.startsWith('--')) {
        errors.push(`${name} 缺少值`)
        continue
      }
      values.set(name, next)
      i += 1
      continue
    }

    if (name.startsWith('--')) {
      if (knownFlags !== null && !knownFlags.has(name)) {
        errors.push(`不认识的选项：${name}`)
        continue
      }
      if (eq !== null) {
        errors.push(`${name} 不接受值（写成 ${name} 就行）`)
        continue
      }
      flags.add(name)
      continue
    }

    positional.push(arg)
  }

  return { values, flags, positional, errors }
}
