/**
 * dsh-warden · 执行前守卫（`tools/pre-execute`）
 *
 * ── 这一层现在只做一件事：共享资源执行权 ───────────────────────────────
 * 等待上限已经搬到 `host/wait.js`（挂 `tools/execute`）。原因是实读宿主
 * `dsh-tools` 的 `createExecution()`：
 *
 *     arguments: deepFreeze(snapshotJsonValue(exec.arguments))
 *
 * `pre-execute` 拿到的参数是**深冻结**的，改它必抛；而这一层的决策只有
 * `allow / deny / ask / cancel`，`tools.guard()` 也只能返回拒绝字符串 ——
 * 两处都改不了参数。旧版在这里写 `args.value.timeout_ms = cap`，异常被自己的
 * `catch {}` 吞掉后继续 `next()`，工具体照旧收到 900000ms（评审探针 R1 已复现）。
 *
 * ── 契约（实读 0.2.0-rc.2 运行件核对过）───────────────────────────────
 *   `prepareExecution()`：
 *     `waterfall(carrier, "tools/pre-execute", exec, () => ({ kind: "allow" }))`
 *   - 不拥有这个决策 → 必须 `return next()`
 *   - 要拦 → `{ kind: 'deny', reason, info? }`（**不是** `reject`）；
 *     宿主会把 `reason` 变成 `Error: <reason>` 的 isError 结果，`info` 挂在 `error.info`
 *   - 要问用户 → `{ kind: 'ask', reason, displayReason: { zh, en } }`
 *   - 兜底值是 `{ kind: 'allow' }`
 *   `exec` 上可用：`name` / `arguments`（冻结） / `agent` / `signal` / `callId` / `parent`。
 *
 * ── 两条纪律 ───────────────────────────────────────────────────────────
 *   1. **拿不准就不拦。** 资源身份归一不出来、锁读不到、工具名不在写工具里 ——
 *      一律放行。宁可漏拦，不可误拦：`pre-execute` 抛出去会直接打断这次工具调用。
 *   2. **任何异常都必须吞掉，但降级必须可见。** 守卫坏掉不许影响宿主里别的工具，
 *      同时要把"我现在不生效了"写进能力台账（R7）——放行宿主和不伪造自身成功
 *      是两件不同的事。
 */

import { isUnder } from '../core/config.js'
import { extractPath, oneLine } from '../core/text.js'
import { resolveResourceId } from '../core/resource.js'

/**
 * 这个工具名算不算"会动东西"。
 *
 * 为什么要判：锁只该拦**写**。读一个被锁住的资源完全没问题 ——
 * 恰恰相反，别的子代理正需要读它来核对读数。
 *
 * 判法：先排除明确的只读工具，再看名字里有没有动词。
 * 认不出来就**当只读**（fail-open）。
 */
const READ_ONLY_TOOLS = new Set([
  'read', 'read_file', 'view', 'cat', 'list', 'ls', 'list_dir', 'list_directory',
  'glob', 'grep', 'search', 'find', 'codebase_search', 'list_agents', 'wait_agent',
  'job_output', 'job_status', 'get_goal', 'list_goal',
  // 护栏自己的工具不参与路径锁判定：锁管理工具本身要在有冲突时也能跑，
  // 否则"想释放别人的锁"会被自己拦住，形成死结。
  'warden_status', 'warden_stage', 'acquire_lock', 'renew_lock', 'release_lock',
  'list_locks', 'evidence_record', 'evidence_check',
])

const MUTATING_HINT = /(^|[_\-\s])(write|edit|patch|apply|create|delete|remove|move|rename|mkdir|touch|bash|shell|sh|pwsh|powershell|cmd|exec|spawn|run|deploy|build|install|publish|upload|commit|push|chmod|chown|acquire|release|record)([_\-\s]|$)/i

export function isMutatingTool(name) {
  const value = String(name ?? '')
  if (value.length === 0) return false
  if (READ_ONLY_TOOLS.has(value.toLowerCase())) return false
  return MUTATING_HINT.test(value) || MUTATING_HINT.test(value.replace(/([a-z])([A-Z])/g, '$1_$2'))
}

/** 目标路径是否落在忽略名单里。 */
export function isIgnored(targetPath, list) {
  if (!Array.isArray(list) || list.length === 0) return false
  for (const root of list) {
    if (typeof root === 'string' && root.length > 0 && isUnder(targetPath, root)) return true
  }
  return false
}

/** 取这次调用所属的会话标识。拿不到就返回空串（空串的锁判定一律放行）。 */
export function sessionOf(exec) {
  const id = exec?.agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : ''
}

/** 取这次调用所属的工作区 cwd。 */
export function workspaceOf(exec) {
  return exec?.agent?.session?.header?.cwd ?? ''
}

/** 把剩余时间说成人话。 */
export function humanTtl(expiresAt, now = Date.now()) {
  const ms = Number(expiresAt) - now
  if (!Number.isFinite(ms) || ms <= 0) return '已过期'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec} 秒后过期`
  const min = Math.round(sec / 60)
  return `${min} 分钟后过期`
}

/** 拒绝文案。结构化：说清"这次没做什么、为什么、接下来能做什么"。 */
export function denyText({ conflict, target, resourceId, now }) {
  return `目标资源正被另一个会话占用，本次调用**没有执行**。\n`
    + `  资源：${resourceId}\n`
    + `  占用者：${conflict.owner}\n`
    + `  锁名：${conflict.name}${conflict.path ? `（覆盖 ${oneLine(conflict.path, 80)}）` : '（命名资源）'}\n`
    + `  ${humanTtl(conflict.expiresAt, now)}\n`
    + `  你这次要动的：${oneLine(target, 120)}\n`
    + `  怎么办：① 先做不依赖这个资源的部分；② 或改用你自己的独立目录/部署目标（推荐 —— `
    + `物理隔离比排队更省时间）；③ 确实必须等，就隔一会儿再试，或让对方 release_lock。\n`
    + `  注意：不要为了绕开它而扩大权限或改用看不见的写入方式 —— 那样只会让读数更无法归属。`
}

/**
 * 挂上守卫。返回卸载函数；拿不到钩子返回 null。
 *
 * @param {any} ctx cordis 上下文
 * @param {{config: () => any, locks: any, capabilities?: any, clock?: any,
 *          log?: any, onEvent?: (e: object) => void}} deps
 */
export function installGuard(ctx, deps) {
  if (typeof ctx?.on !== 'function') {
    deps.capabilities?.markUnsupported?.('sharedLock', '拿不到 ctx.on')
    return null
  }
  const clock = deps.clock ?? { now: () => Date.now() }
  const stats = { blocked: 0, checked: 0, unresolved: 0 }

  let off = null
  try {
    off = ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const config = deps.config?.() ?? {}
        if (config.enabled === false) return await next()
        if (config.lockGuard === false || !deps.locks) return await next()
        if (!isMutatingTool(exec.name)) return await next()

        const target = extractPath(exec.arguments)
        if (!target) return await next()
        if (isIgnored(target, config.pathIgnore)) return await next()

        const owner = sessionOf(exec)
        // 拿不到会话身份就没法判"是不是别人占的"，放行（fail-open）。
        if (!owner) return await next()

        stats.checked++
        const resolved = resolveResourceId(target, workspaceOf(exec))
        if (!resolved.resolvable) {
          // 归一不出来（例如任意 shell 命令里看不出的写入）——**明确记未覆盖**，
          // 不假装护栏管住了所有写入。
          stats.unresolved++
          deps.capabilities?.markObserved?.('lockCoverageGap', `${exec.name}：${resolved.reason}`)
          return await next()
        }

        const conflict = deps.locks.conflictFor(resolved.resourceId, owner, {
          path: resolved.path,
          now: clock.now(),
        })
        if (!conflict) return await next()

        stats.blocked++
        const reason = denyText({
          conflict,
          target,
          resourceId: resolved.resourceId,
          now: clock.now(),
        })
        deps.onEvent?.({
          kind: 'lock-block',
          workspace: workspaceOf(exec),
          sessionId: owner,
          detail: `${exec.name} → ${oneLine(target, 100)} 被 ${conflict.owner} 的锁 ${conflict.name} 挡住`,
        })
        deps.capabilities?.markObserved?.('sharedLock', `拦下 ${exec.name} @${resolved.resourceId}`)
        deps.log?.warn?.(`共享资源被占用，拦下一次 ${exec.name}：${oneLine(target, 80)}`)
        return {
          kind: 'deny',
          reason,
          info: {
            name: 'WardenResourceConflict',
            code: 'WARDEN_RESOURCE_CONFLICT',
            resourceId: resolved.resourceId,
            heldBy: conflict.owner,
            lockName: conflict.name,
            expiresAt: conflict.expiresAt,
          },
        }
      } catch (error) {
        // 守卫失败不能影响这次工具调用，但必须让降级可见。
        deps.capabilities?.markDegraded?.('sharedLock', `pre-execute 异常：${error?.message ?? error}`)
      }
      return await next()
    })
  } catch (error) {
    deps.capabilities?.markDegraded?.('sharedLock', `tools/pre-execute 挂载失败：${error?.message ?? error}`)
    deps.log?.warn?.(`执行前守卫挂载失败（共享锁不生效，其余正常）：${error?.message ?? error}`)
    return null
  }

  if (typeof off !== 'function') {
    deps.capabilities?.markDegraded?.('sharedLock', 'tools/pre-execute 注册没有返回卸载句柄')
    return null
  }
  deps.capabilities?.markMounted?.('sharedLock', off, 'tools/pre-execute')
  deps.capabilities?.markSupported?.('lockCoverageGap', '记录护栏覆盖不到的写入')

  const dispose = () => {
    try { off() } catch { /* 清理失败无所谓 */ }
    deps.capabilities?.markUnmounted?.('sharedLock', '已卸载')
  }
  dispose.stats = stats
  dispose.handle = off
  return dispose
}
