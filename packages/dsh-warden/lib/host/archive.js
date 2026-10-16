/**
 * dsh-warden · 大输出归档与有界呈现（R3 的正解）
 *
 * ── 为什么挂 `tools/post-execute` 而不是 `agent/pre-step` ──────────────
 * 旧版在 `agent/pre-step` 里筛 `decision.messages` 的 `role==='tool'` 消息。
 * 实读宿主 `dsh-agent-loop` 的 `preStep()`：那个 `messages` 是 **inbox 待追加
 * 的新批次**（`this.inbox.claim(...)` 的结果）加一条 runtime context，
 * 完整历史要到 `buildRequest()` 才从 session surface 构建。
 * **这一层通常根本没有旧工具结果**，所以旧版裁的是空气；
 * 旧单测人为塞了 20 条历史 tool 消息，才"测过"了一个生产不存在的输入。
 *
 * `tools/post-execute` 才是结果**进入 surface 之前**的位置。实读
 * `dsh-tools` 的 `postExecute()`：`accept` 决策可以替换 `content`
 * （不能同时给 `value`），并可以挂 `additionalContexts`。
 * 在这里把大文本换成有界摘要，原文就根本不会进上下文 ——
 * 比"先进去再裁掉"省得多，也不需要碰任何历史。
 *
 * ── 与官方压缩的分工（不抢 owner）─────────────────────────────────────
 *   `dsh-compaction-basic`        历史压缩的**唯一 owner**（压力压缩 + 溢出重试）
 *   `dsh-compaction-tool-result-pruner`  单条超长结果的 head+tail 裁剪
 *   warden（本模块）              **新产生的**大结果先落盘，只留有界摘要 + 指纹 + 引用
 *
 * warden 不改历史、不改冻结请求、不假装能算上下文容量。
 * `historyPruning` 在能力台账里明确是 `unsupported`。
 *
 * ── 三条不能破的底线 ───────────────────────────────────────────────────
 *   1. **归档失败就保留原结果。** 宁可上下文大，不能把数据弄丢。
 *   2. **失败结果不隐藏。** `isError` 的结果一律原样放过 ——
 *      错误信息本身往往就是最关键的证据。
 *   3. **不把"重新执行"当找回手段。** 写入、部署、网络请求都不可重放。
 *      摘要里给的是**文件路径 + 行区间**，让模型用宿主的读取工具去读。
 *      （这也正是 DeepAgents 的做法：输出先写 backend，再留预览与引用。）
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { archiveDirFor } from '../core/config.js'
import { sha256Hex } from '../core/text.js'

/** 自家工具的输出不归档（会形成噪声，而且它们本来就是短文本）。 */
const OWN_TOOLS = new Set([
  'warden_status', 'warden_stage', 'acquire_lock', 'release_lock', 'list_locks',
  'renew_lock', 'evidence_record', 'evidence_check',
])

/** 粗略 token 估算：CJK 一字一 token，其余 4 字符一 token。只用于显示。 */
function roughTokens(text) {
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) cjk++
  }
  return cjk + Math.ceil((text.length - cjk) / 4)
}

/** 把 content 里的文本块与非文本块分开。非文本块（图片/文件）必须原样保留。 */
function splitContent(content) {
  const blocks = Array.isArray(content) ? content : []
  const texts = []
  const others = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block)
    else others.push(block)
  }
  return { texts, others, totalChars: texts.reduce((sum, b) => sum + b.text.length, 0) }
}

/**
 * 归档正文，返回有界呈现所需的材料。
 *
 * @returns {{ok: true, file: string, hash: string, bytes: number, lines: number}|{ok: false, reason: string}}
 */
export function archiveText(home, sessionId, callId, toolName, text) {
  try {
    const dir = archiveDirFor(home, sessionId)
    mkdirSync(dir, { recursive: true })
    const safeCall = String(callId ?? `noid-${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
    const file = join(dir, `${safeCall}.txt`)
    const bytes = Buffer.from(text, 'utf8')
    writeFileSync(file, bytes)
    const lines = text.split('\n').length
    return { ok: true, file, hash: sha256Hex(bytes), bytes: bytes.length, lines }
  } catch (error) {
    return { ok: false, reason: `${error?.message ?? error}` }
  }
}

/** 有界摘要正文。 */
export function boundedSummary({ toolName, text, archived, keepChars }) {
  const head = Math.ceil(keepChars / 2)
  const tail = keepChars - head
  const headPart = text.slice(0, head)
  const tailPart = text.length > tail ? text.slice(-tail) : ''
  const omitted = text.length - headPart.length - tailPart.length
  return `[warden 归档] \`${toolName}\` 的输出共 ${text.length} 字符（约 ${roughTokens(text)} token），`
    + `已**完整**保存到本地文件，这里只显示首尾。\n`
    + `  文件：${archived.file}\n`
    + `  行数：${archived.lines}　字节：${archived.bytes}\n`
    + `  指纹：sha256:${archived.hash}\n`
    + `  中间省略了 ${omitted} 字符。\n`
    + `需要中间部分时，**用读取工具按行区间去读上面那个文件**（例如读第 200–320 行）。\n`
    + `**不要重新执行刚才那个工具** —— 写入、部署、网络请求这类操作重跑一次就有副作用，`
    + `而且重跑得到的输出未必和这次一致。\n`
    + `\n──── 开头 ${headPart.length} 字符 ────\n${headPart}\n`
    + (tailPart
      ? `──── 中间省略 ────\n──── 结尾 ${tailPart.length} 字符 ────\n${tailPart}\n`
      : '')
    + `──── 全文见 ${archived.file} ────`
}

/**
 * 造归档钩子。挂在 `tools/post-execute` 上。
 *
 * @param {{home: string, config: () => any, capabilities?: any, log?: any,
 *          onEvent?: (e: object) => void, clock?: any}} deps
 * @returns {(exec: object, result: object, downstream: object|null) => object|null}
 *   返回一个"决策补丁"：null 表示不介入，否则是 `{content}` 用于 accept 决策。
 */
export function createArchiver(deps) {
  return function archiveDecision(exec, result, config) {
    try {
      if (config?.archiveToolResults === false) return null
      if (!result || result.isError) return null          // 底线 2：失败结果不隐藏
      const toolName = String(exec?.name ?? '')
      if (!toolName || OWN_TOOLS.has(toolName)) return null
      if (Array.isArray(config?.archiveExcludeTools) && config.archiveExcludeTools.includes(toolName)) return null

      const { texts, others, totalChars } = splitContent(result.content)
      const threshold = Number(config?.archiveThresholdChars) > 0 ? Number(config.archiveThresholdChars) : 8192
      if (texts.length === 0 || totalChars < threshold) return null

      const sessionId = String(exec?.agent?.session?.id ?? '') || 'no-session'
      const callId = String(exec?.callId ?? '') || `call-${deps.clock?.now?.() ?? Date.now()}`
      const text = texts.map((b) => b.text).join('\n')

      const archived = archiveText(deps.home, sessionId, callId, toolName, text)
      if (!archived.ok) {
        // 底线 1：归档失败就保留原结果，并让降级可见。
        deps.capabilities?.markDegraded?.('archiveToolResults', `归档写入失败：${archived.reason}`)
        deps.log?.warn?.(`[warden] 结果归档失败，保留原始输出（${toolName}）：${archived.reason}`)
        deps.onEvent?.({ kind: 'archive-failed', sessionId, detail: `${toolName}：${archived.reason}` })
        return null
      }

      const keepChars = Math.max(200, Number(config?.archiveKeepChars) || 1200)
      const summary = boundedSummary({ toolName, text, archived, keepChars })
      deps.capabilities?.markObserved?.('archiveToolResults', `${toolName} ${totalChars}→${summary.length} 字符`)
      deps.onEvent?.({
        kind: 'archive',
        sessionId,
        detail: `${toolName} 输出 ${totalChars} 字符已归档，呈现压到 ${summary.length} 字符（sha256:${archived.hash.slice(0, 12)}）`,
      })
      // 非文本块（图片/文件）原样保留在摘要之后 —— 底线：不盲删媒体块。
      return { content: [{ type: 'text', text: summary }, ...others] }
    } catch (error) {
      deps.capabilities?.markDegraded?.('archiveToolResults', `归档判定异常：${error?.message ?? error}`)
      return null
    }
  }
}

/**
 * 挂到 `tools/post-execute`。
 *
 * 与 `host/after.js` 的提醒共存：那边负责"返工/重复读/错误分型"的提醒，
 * 这边负责"大输出归档"。两者都在同一条 waterfall 上，所以这里**只返回
 * content 替换建议**，由 `after.js` 统一组装最终决策，避免两个监听器
 * 互相覆盖 content。
 */
export function installArchiver(ctx, deps) {
  return createArchiver(deps)
}
