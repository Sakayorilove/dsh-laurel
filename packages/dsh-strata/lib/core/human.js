/**
 * dsh-strata · 真人消息识别（补充评审 R9-B）
 *
 * ── 病灶 ───────────────────────────────────────────────────────────────
 * 旧代码用**黑名单**挑"用户消息"：
 *
 *     if (m?.role === 'user' && m?.source?.kind !== 'strata-memory'
 *                            && m?.source?.kind !== NUDGE_SOURCE_KIND) return i
 *
 * 只排除了自家的两种注入。于是 **任何其他插件的注入消息都会被当成
 * "用户新提问"**，进而被拿去做记忆召回的 query、去顶掉"一回合至多一次"
 * 的闸门，甚至影响跨工作区授权判断。
 *
 * 补充评审已复现两条反例（`compat-probes.json`）：
 *   同批次「真人问题 → warden 提醒」→ 选中的是 warden 提醒
 *   同批次「真人问题 → loom-draft」→ 选中的是 Loom 规划快照
 *
 * ── 本机实测：黑名单差得有多远 ─────────────────────────────────────────
 * 25 个真实会话日志里 `user/message` 事件的 `source.kind` 普查
 * （`docs/warden/scripts/extract-user-message-fixtures.sh`）：
 *
 *     user 44 ← 只有这一种是真人
 *     time-context 79、team-message 73、tool-jobs 70、strata-memory 44、
 *     skill-catalog 34、compact-checkpoint 28、runtime-context 25、
 *     subagent-settled 23、agent-instructions 14、plugin:trisoul-x:* 33、
 *     user-approval 8、agent-message 4、goal 4、model-selection 3、
 *     loom-draft 2、tool-goal 1 ……
 *
 * 也就是说注入消息是真人消息的 **约 10 倍**。黑名单永远追不完，
 * 每装一个新插件就会漏一种。
 *
 * ── 正确判据：宿主自己的合同 ───────────────────────────────────────────
 * 实读 `dsh-llm` 的 `createUserMessage()` 与 `dsh-subagent`
 * （提交子代理 prompt 时写的是 `source: { kind: "user" }`）、
 * `createAssistantMessage()`（写 `source: { kind: "model", ... }`）：
 * **`source.kind === 'user'` 就是宿主标记真人输入的字段**。
 *
 * 这与本插件 `core/history.js` 早就写对的口径一致（那边是
 * `INDEXED_SOURCE_KINDS = new Set(['user','model'])`）。这里把同一条
 * 合同收敛成一处，不再各处写黑名单。
 *
 * ── 兼容性：没有 source 的历史消息按真人处理 ───────────────────────────
 * `history.js` 的注释记着一次事故：曾经用"有 source 就跳过"，结果真实
 * 日志里**每条消息都带 source**，导致 4 天 53 次加载 0 次注入。
 * 所以这里的失败方向必须是**宁可多认，不可全丢**：
 * `source` 缺失（旧格式、测试夹具、将来改版）→ 按真人处理。
 * 但 `source.kind` 存在且不是 `'user'` → 一律不是真人。
 */

/** 宿主标记真人输入的 source.kind。 */
export const HUMAN_SOURCE_KIND = 'user'

/**
 * 这条消息是不是**真人说的话**。
 *
 * @param {any} message 一条 surface / inbox 消息
 * @returns {boolean}
 */
export function isHumanUserMessage(message) {
  if (message?.role !== 'user') return false
  const source = message.source
  // 没有 source 标记：旧格式或夹具 —— 按真人处理（见文件头的事故记录）。
  if (source === undefined || source === null) return true
  const kind = typeof source === 'string' ? source : source.kind
  if (kind === undefined || kind === null) return true
  return kind === HUMAN_SOURCE_KIND
}

/** 取一条消息的纯文本。 */
function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n')
}

/**
 * 最新一条**真人**消息的纯文本。找不到返回空串。
 *
 * 这是召回 query 的唯一合法来源：拿插件注入的提醒或规划快照去召回，
 * 会把记忆越滚越偏，还可能因此错误提升跨工作区授权。
 */
export function latestHumanText(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    if (!isHumanUserMessage(list[i])) continue
    const text = textOf(list[i])
    if (text.length > 0) return text
  }
  return ''
}

/** 最新一条真人消息的下标。找不到返回 -1。 */
export function lastHumanIndex(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    if (isHumanUserMessage(list[i])) return i
  }
  return -1
}

/**
 * 真人消息条数。
 *
 * 用途是"一回合至多注入一次"的闸门：只有真人又说了新话，才该重新召回。
 * 用注入消息计数会让每加一条提醒/规划块就顶掉一次闸门。
 */
export function countHumanMessages(messages) {
  const list = Array.isArray(messages) ? messages : []
  let count = 0
  for (const message of list) if (isHumanUserMessage(message)) count++
  return count
}
