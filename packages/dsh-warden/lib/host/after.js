/**
 * dsh-warden · 执行后观察（`tools/post-execute`）
 *
 * ── 这一层现在做四件事 ─────────────────────────────────────────────────
 * ① **大输出归档**（R3）：新产生的大文本结果先落盘，只把有界摘要 + 指纹 +
 *    引用放进上下文。见 `host/archive.js`。
 * ② **无进展识别**（R6）：按"有没有新证据"判，不按路径计数。
 * ③ **失败分型**（R8）：能力不支持 / 认证缺失 / 路径环境 / 契约 / 瞬时 /
 *    资源冲突 / 业务失败 —— 不同类别给不同的下一步，而不是一律"再试一次"。
 * ④ **两条老提示**：改文件匹配失败、未知工具。这两条只在**已经失败**时触发，
 *    所以不可能误伤正常调用。
 *
 * ── 契约（实读 0.2.0-rc.2 `dsh-tools` 的 `postExecute()`）──────────────
 *   `waterfall(carrier, "tools/post-execute", exec, result, () => ({kind:"accept"}))`
 *   - `{ kind:'accept', content? }` 保持成功，**替换呈现内容**
 *   - `{ kind:'accept', value? }`   替换结构化值；`isError` 的结果不允许替换 value
 *   - `{ kind:'block', feedback }`  变成 isError
 *   - 两种决策都可挂 `additionalContexts`（消息数组，会进下一批上下文）
 *   `content` 与 `value` **不能同时给**（宿主会抛 TypeError）。
 *
 * ── 三条纪律 ───────────────────────────────────────────────────────────
 *   1. **不隐藏失败。** `isError` 的结果一律不归档、不改写正文。
 *   2. **不盲删媒体块。** 归档只动文本块，图片/文件块原样保留。
 *   3. **content 只由这一处组装。** 归档与提醒都在同一条 waterfall 上，
 *      两个监听器各改一次 content 会互相覆盖。
 */

import { randomUUID } from 'node:crypto'
import { extractPath, oneLine, classifyToolError, ERROR_CLASS_HINTS } from '../core/text.js'
import { createArchiver } from './archive.js'
import { isIgnored, isMutatingTool, sessionOf } from './guard.js'

/** 提醒消息的 source 标记。 */
const NOTICE_SOURCE = { kind: 'warden', form: 'notice' }

/**
 * 造一条提醒消息。形状与宿主 `createUserMessage` 一致：`{ id, role, content, source }`。
 *
 * ⚠ `source.kind` 是 `'warden'`。这一点很关键：宿主用 `source.kind === 'user'`
 * 标记真人输入（实读 `dsh-subagent` 提交 prompt 时写的就是 `{kind:"user"}`），
 * 所以带 `source` 的插件消息**不该**被别的插件当成"用户新提问"。
 * 补充评审 R9-B 修的就是 Strata 那边只按黑名单排除自家消息的问题。
 */
function createNotice(text, summary) {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { ...NOTICE_SOURCE, summary: String(summary ?? '').slice(0, 60) },
  }
  try { return structuredClone(message) } catch { return message }
}

/** 从 result 里抠出错误文本。 */
function errorText(result) {
  if (!result) return ''
  const parts = []
  if (result.error?.message) parts.push(String(result.error.message))
  const content = result.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** 到这个计数就该提醒一次：正好踩线、以及之后每个整数倍。 */
export function shouldFire(count, threshold) {
  const t = Number(threshold)
  if (!Number.isFinite(t) || t <= 0) return false
  return count >= t && count % t === 0
}

/** 返回结果是否是"改文件时匹配失败"这一类。 */
export function isEditMiss(message) {
  return /old_string was not found|old_string matched \d+ times|String to replace not found|No exact match found/i.test(String(message ?? ''))
}

/** 返回结果是否是"工具名不存在"。 */
export function isUnknownTool(message) {
  return /unknown tool|no such tool|tool .* not found|工具不存在/i.test(String(message ?? ''))
}

function editMissText(target, message) {
  return `[warden] 改文件没匹配上（${oneLine(message, 120)}）${target ? `，目标：${oneLine(target, 120)}` : ''}\n`
    + `这几乎总是因为**你手里的原文已经过时**（上一轮改过它、或者全角/半角括号、换行对不上）。\n`
    + `正确做法：只重读**你要改的那一段**（带 offset/limit），拿现在的原文去匹配，再改。`
    + `不需要把整个文件重读一遍。`
}

function unknownToolText(name, schemas) {
  const names = Array.isArray(schemas)
    ? schemas.map((s) => s?.name).filter((n) => typeof n === 'string' && n.length > 0)
    : []
  const list = names.length > 0
    ? `\n当前这个 agent 实际可以调用的工具（${names.length} 个）：\n  ${names.join('、')}`
    : '\n（拿不到工具清单，请以你本轮看到的工具定义为唯一依据。）'
  return `[warden] 你调了一个不存在的工具：\`${oneLine(name, 60)}\`${list}\n`
    + `**不要凭记忆拼工具名** —— 只使用上面这份清单里的名字；`
    + `清单里没有的能力，就说明这条路走不通（能力不支持），换通道或把限制报给用户，别在原地反复撞。`
}

/** 失败分型的提醒。按类别给具体下一步，不给"再试一次"。 */
function errorClassText(toolName, message, klass) {
  const hint = ERROR_CLASS_HINTS[klass] ?? ''
  if (!hint) return null
  return `[warden] 这次 \`${toolName}\` 失败被归为「${klass}」类。\n`
    + `  错误：${oneLine(message, 200)}\n`
    + `  ${hint}`
}

/**
 * 挂上执行后观察。返回卸载函数；拿不到钩子返回 null。
 *
 * @param {any} ctx cordis 上下文
 * @param {{config: () => any, counters: any, tools: () => any, progress?: any,
 *          home: string, capabilities?: any, clock?: any, log?: any,
 *          onEvent?: (e: object) => void}} deps
 */
export function installAfter(ctx, deps) {
  if (typeof ctx?.on !== 'function') {
    deps.capabilities?.markUnsupported?.('archiveToolResults', '拿不到 ctx.on')
    return null
  }
  const stats = {
    rework: 0, reread: 0, editMiss: 0, unknownTool: 0,
    archived: 0, stalled: 0, classified: 0,
  }
  const archiveDecision = createArchiver(deps)

  let off = null
  try {
    off = ctx.on('tools/post-execute', async (exec, result, next) => {
      const notices = []
      let contentOverride = null
      try {
        const config = deps.config?.() ?? {}
        if (config.enabled !== false) {
          const sessionId = sessionOf(exec)
          const target = extractPath(exec.arguments)
          const usable = sessionId && target && !isIgnored(target, config.pathIgnore)

          /* ── ① 大输出归档（只动成功结果的文本块）── */
          const archived = archiveDecision(exec, result, config)
          if (archived?.content) {
            contentOverride = archived.content
            stats.archived++
          }

          /* ── ② 无进展识别（R6）── */
          let progressNoticeSent = false
          if (deps.progress && sessionId) {
            const observation = deps.progress.observe({
              sessionId,
              name: exec.name,
              args: exec.arguments,
              result,
              targetPath: usable ? target : '',
              // 内容指纹由 S2 的字节级 hash 提供；这里只在拿得到时传。
              targetHash: result?.meta?.wardenTargetHash ?? null,
            }, config)
            if (observation.notice) {
              notices.push(createNotice(observation.notice, `no-progress ${observation.stallKind}`))
              progressNoticeSent = true
              stats.stalled++
            }
            if (observation.progress) deps.capabilities?.markObserved?.('progressWatch', observation.reason)
          }

          /* ── ③ 返工提醒：按路径计数，但**只在真的没有新证据时**才发 ── */
          if (usable && config.reworkNudge !== false && isMutatingTool(exec.name)) {
            const key = `w:${target}`
            const count = deps.counters.bump(sessionId, key)
            // 与 ProgressWatch 的差异：这里数的是"对同一路径的写尝试次数"，
            // 用来提醒"该停下来看一眼整体"，不是判定空转。
            if (shouldFire(count, config.reworkThreshold)) {
              notices.push(createNotice(
                `[warden] 同一个文件已经改了 ${count} 次：${oneLine(target, 140)}\n`
                + `先停一下再动手。可选：① 一次改完，而不是改一处试一次；`
                + `② 只重读你要改的那一段（带 offset/limit），不必整个文件重读；`
                + `③ 如果是"改完没生效"，先确认你改的是**真正被加载的那一份**`
                + `（同一份文件在仓库里可能有两处副本，安装面链接指向的才是生效的那份）。`,
                `rework ×${count}`,
              ))
              stats.rework++
              deps.onEvent?.({ kind: 'rework', sessionId, count, detail: `${exec.name} → ${oneLine(target, 100)}` })
            }
          }

          /* ── ④ 重复读提醒：只在**同一区间**反复读时才算 ──
             不同片段的读取是省上下文的正确做法，绝不提醒（R6 的复现项）。
             ProgressWatch 已经按 readRangeKey 判过了；这一步刚发过无进展提醒
             就不再叠第二条，避免同一步里塞两条内容相近的消息。 */
          if (usable && config.rereadNudge !== false && isReadTool(exec.name) && !progressNoticeSent) {
            const key = `r:${target}`
            const count = deps.counters.bump(sessionId, key)
            if (shouldFire(count, config.rereadThreshold)) {
              notices.push(createNotice(
                `[warden] 同一个文件的**同一区间**已经读了 ${count} 次：${oneLine(target, 140)}\n`
                + `如果它没变，你要的信息第一次读的时候就拿到了 —— 回到上下文里找。`
                + `如果它变了，说明有人在改它：先搞清楚是谁改到哪一版再继续。`
                + `（读**不同**区间不会被算作重复。）`,
                `reread ×${count}`,
              ))
              stats.reread++
              deps.onEvent?.({ kind: 'reread', sessionId, count, detail: `${exec.name} → ${oneLine(target, 100)}` })
            }
          }

          /* ── ⑤ 只在**调用已经失败**时触发的三条 ── */
          if (result?.isError) {
            const message = errorText(result)
            if (config.editMissHint !== false && isEditMiss(message)) {
              notices.push(createNotice(editMissText(target, message), 'edit miss'))
              stats.editMiss++
              deps.onEvent?.({ kind: 'edit-miss', sessionId, detail: oneLine(message, 140) })
            } else if (config.unknownToolHint !== false && isUnknownTool(message)) {
              let schemas = []
              try { schemas = deps.tools?.()?.schemas?.(exec.agent) ?? [] } catch { schemas = [] }
              notices.push(createNotice(unknownToolText(exec.name, schemas), 'unknown tool'))
              stats.unknownTool++
              deps.onEvent?.({ kind: 'unknown-tool', sessionId, detail: oneLine(exec.name, 80) })
            } else if (config.errorClassify !== false) {
              const klass = classifyToolError(message)
              const text = errorClassText(String(exec.name ?? 'tool'), message, klass)
              if (text && klass !== 'business') {
                notices.push(createNotice(text, `error class ${klass}`))
                stats.classified++
                deps.onEvent?.({ kind: 'error-class', sessionId, detail: `${klass}：${oneLine(message, 120)}` })
              }
              // 能力不支持这一类要单独记：同一能力不该在各会话里反复撞（R8）。
              if (klass === 'capability' || klass === 'auth') {
                deps.capabilities?.markObserved?.('capabilityPrecheck', `${klass}：${oneLine(message, 100)}`)
              }
            }
          }
        }
      } catch (error) {
        // 观察失败绝不能影响这次调用，但要让降级可见。
        deps.capabilities?.markDegraded?.('postExecute', `post-execute 异常：${error?.message ?? error}`)
      }

      const downstream = await next()
      if (notices.length === 0 && !contentOverride) return downstream

      // 下游可能是 accept 也可能是 block；两种都要把提醒带上。
      try {
        const existing = Array.isArray(downstream?.additionalContexts) ? downstream.additionalContexts : []
        const decision = { ...downstream, additionalContexts: [...notices, ...existing] }
        // ⚠ content 与 value 不能同时给（宿主会抛 TypeError）。
        // block 决策用 feedback 而不是 content，所以只在非 block 时替换。
        if (contentOverride && decision.kind !== 'block' && !('value' in decision)) {
          decision.content = contentOverride
        }
        return decision
      } catch {
        return downstream
      }
    })
  } catch (error) {
    deps.capabilities?.markDegraded?.('archiveToolResults', `tools/post-execute 挂载失败：${error?.message ?? error}`)
    deps.log?.warn?.(`执行后观察挂载失败（归档与提醒不生效，其余正常）：${error?.message ?? error}`)
    return null
  }

  if (typeof off !== 'function') {
    deps.capabilities?.markDegraded?.('archiveToolResults', 'tools/post-execute 注册没有返回卸载句柄')
    return null
  }
  deps.capabilities?.markMounted?.('archiveToolResults', off, 'tools/post-execute')
  deps.capabilities?.markSupported?.('progressWatch', 'ProgressWatch 已接入')
  deps.capabilities?.markSupported?.('capabilityPrecheck', '失败分型已接入')

  const dispose = () => {
    try { off() } catch { /* 清理失败无所谓 */ }
    deps.capabilities?.markUnmounted?.('archiveToolResults', '已卸载')
  }
  dispose.stats = stats
  dispose.handle = off
  return dispose
}

/** 只读工具名。用来区分"改同一个文件"和"读同一个文件"。 */
const READ_TOOLS = new Set([
  'read', 'read_file', 'view', 'cat', 'list', 'ls', 'list_dir', 'list_directory',
  'glob', 'grep', 'search', 'find', 'codebase_search',
])

function isReadTool(name) {
  return READ_TOOLS.has(String(name ?? '').toLowerCase())
}
