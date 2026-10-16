/**
 * dsh-strata · 文本层：分词、BM25、净化
 *
 * 为什么不用嵌入模型：召回发生在每一轮请求的组装路径上，走一次网络往返
 * 会直接拖慢每一轮；而且本地没有保证可用的嵌入模型。词法 + 图扩散在
 * 这个规模（几千条记忆）上足够好，而且完全离线、零 token 成本。
 *
 * 为什么不引入分词库：BM25 的 idf 项本来就会压低高频词权重，
 * 中文二元组（bigram）已经能覆盖绝大多数情况。
 */

/* ------------------------------------------------------------------ *
 * 净化
 * ------------------------------------------------------------------ */

/**
 * 剥掉 harness 自己注入的 runtime context 前导块。
 *
 * ── 为什么必须做这件事（这不是洁癖，是真出过事）──────────────────────
 * dsh-memory-loom 的作者在真实启动中发现：形如
 *
 *     Do not call image_generate. Never ask for an API key...
 *
 * 的注入文本会被自动抽取当成**两条「用户约束」记忆**存下来，署着用户的名。
 * 于是下次召回到的「用户偏好」其实是 harness 的运行时规则，而且它会
 * 自我强化——越召回越像真的。
 *
 * 所以抽取和召回查询两处都要剥。剥离**刻意保守**：只认精确的开头，
 * 认不出来就原样返回。宁可漏剥一条，也不要把用户真说的话删掉。
 *
 * @param {string} text 原始文本
 * @returns {string} 剥掉前导块后的文本
 */
export function stripHarnessPreamble(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  let out = text
  // 只认这一个精确开头（大小写与句点都固定）。认不出就原样返回。
  const marker = 'Current runtime context.'
  const index = out.indexOf(marker)
  if (index === 0) {
    // 前导块以空行结束；没有空行就整块丢掉。
    const blank = out.indexOf('\n\n')
    out = blank === -1 ? '' : out.slice(blank + 2)
  }
  return out.trim()
}

/**
 * 归一化正文，用于去重比对。
 *
 * 「同一句话换个说法」不该变成两条记忆。这里只做保守的归一化：
 * 去首尾空白、压空白、去标点、转小写。不做同义改写——
 * 那需要模型，而模型在召回路径上不可接受。
 */
export function normalizeBody(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.,;:!?'"`()[\]{}<>~\-—_/\\|*#@$%^&+=、。，；：！？“”‘’（）【】《》…·]/g, '')
}

/** 估算一段文本的 token 数。中英混排的粗估，只用于展示与预算，不用于计费。 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  let cjk = 0
  let other = 0
  for (const ch of s) {
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk++
    else other++
  }
  // 中文约 1 字 ≈ 1 token；英文约 4 字符 ≈ 1 token。
  return cjk + Math.ceil(other / 4)
}

/* ------------------------------------------------------------------ *
 * 分词
 * ------------------------------------------------------------------ */

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g
const LATIN_WORD = /[a-z0-9_]+/g

/** 英文停用词。中文不设停用词——BM25 的 idf 会自己处理高频字。 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'of', 'to', 'in', 'on',
  'at', 'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they',
  'do', 'does', 'did', 'not', 'no', 'yes', 'so', 'than', 'too', 'very', 'can', 'will',
  'just', 'about', 'into', 'over', 'after', 'before', 'when', 'where', 'what', 'which',
])

/**
 * 分词。中文走二元组（bigram），英文走整词 + 停用词表。
 *
 * @param {string} text
 * @returns {string[]} token 列表（可能有重复，调用方自己算词频）
 */
export function tokenize(text) {
  const out = []
  const lower = String(text ?? '').toLowerCase()
  if (lower.length === 0) return out

  for (const match of lower.matchAll(LATIN_WORD)) {
    const word = match[0]
    if (word.length < 2) continue
    if (STOPWORDS.has(word)) continue
    out.push(word)
  }

  const runs = lower.match(CJK_RUN) ?? []
  for (const run of runs) {
    if (run.length === 1) { out.push(run); continue }
    for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2))
  }
  return out
}

/** 去重后的 token 集合，用于算 document frequency。 */
export function tokenSet(text) {
  return new Set(tokenize(text))
}

/* ------------------------------------------------------------------ *
 * BM25
 * ------------------------------------------------------------------ */

/** BM25 参数。k1 控制词频饱和，b 控制长度归一化强度。 */
const K1 = 1.2
const B = 0.75

/** 字段权重。正文 1.0 / 标签 1.6 / 实体 1.8。 */
export const FIELD_WEIGHTS = { body: 1.0, tags: 1.6, entities: 1.8 }

/**
 * 为一个候选集建索引。索引是**每次召回现算**的，不落盘——
 * 记忆条数是几千量级，现算比维护增量索引更不容易出错，
 * 而且避免了「索引和本体不一致」这类最难查的 bug。
 *
 * @param {Array<{id: string, body: string, tags?: string[], entities?: string[]}>} records
 */
export function buildIndex(records) {
  const docs = []
  const df = new Map()
  const totalLen = { body: 0, tags: 0, entities: 0 }

  for (const record of records) {
    const fields = {
      body: tokenize(record.body ?? ''),
      tags: tokenize((record.tags ?? []).join(' ')),
      entities: tokenize((record.entities ?? []).join(' ')),
    }
    const seen = new Set([...fields.body, ...fields.tags, ...fields.entities])
    for (const token of seen) df.set(token, (df.get(token) ?? 0) + 1)
    totalLen.body += fields.body.length
    totalLen.tags += fields.tags.length
    totalLen.entities += fields.entities.length
    docs.push({ record, fields })
  }

  const n = Math.max(1, docs.length)
  return {
    n: docs.length,
    df,
    docs,
    avgLen: {
      body: Math.max(1, totalLen.body / n),
      tags: Math.max(1, totalLen.tags / n),
      entities: Math.max(1, totalLen.entities / n),
    },
  }
}

/** BM25 的 idf。加 0.5 平滑，保证非负。 */
function idf(df, n, token) {
  const d = df.get(token) ?? 0
  return Math.log(1 + (n - d + 0.5) / (d + 0.5))
}

/**
 * 单个文档对一个查询的 BM25 分。三字段分别算再按权重加权。
 *
 * @returns {number} 未归一化的原始分
 */
export function bm25Score(index, doc, queryTokens) {
  if (queryTokens.length === 0 || index.n === 0) return 0
  const querySet = new Set(queryTokens)
  let total = 0

  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    const tokens = doc.fields[field]
    if (tokens.length === 0) continue
    const tf = new Map()
    for (const token of tokens) if (querySet.has(token)) tf.set(token, (tf.get(token) ?? 0) + 1)
    if (tf.size === 0) continue

    const dl = tokens.length
    const avgdl = index.avgLen[field]
    let fieldScore = 0
    for (const [token, freq] of tf) {
      const numerator = freq * (K1 + 1)
      const denominator = freq + K1 * (1 - B + B * (dl / avgdl))
      fieldScore += idf(index.df, index.n, token) * (numerator / denominator)
    }
    total += weight * fieldScore
  }
  return total
}

/* ------------------------------------------------------------------ *
 * 规则抽取（默认关闭，但保留给你自己验）
 * ------------------------------------------------------------------ */

/**
 * 四条正则线索表。**只产出 preference / constraint / decision / fact。**
 * entity 与 insight 只能由工具显式写入——规则抽不出这两类。
 *
 * ⚠️ 再说一次：dsh-memory-loom 的作者实测这套规则 ROI 为负。
 * 默认 `autoExtract: false`。留着是为了让你能自己验一遍，不是推荐你开。
 */
const EXTRACT_RULES = [
  { kind: 'preference', pattern: /(?:我|俺)(?:比较)?(?:喜欢|偏好|习惯|倾向)(?:用|使用|把|在)?\s*([^。！？\n]{2,60})/g },
  { kind: 'preference', pattern: /(?:以后|下次|之后)(?:都|请|要)?\s*([^。！？\n]{2,60})/g },
  { kind: 'constraint', pattern: /(?:不要|别|禁止|不许|不能)\s*([^。！？\n]{2,60})/g },
  { kind: 'decision', pattern: /(?:决定|确定|就)?(?:用|采用|选)\s*([^。！？\n]{2,60})(?:了|吧)?[。！\n]/g },
  { kind: 'fact', pattern: /(?:我的|这个|该)\s*([^。！？\n]{2,40})\s*(?:是|在|叫)\s*([^。！？\n]{2,60})/g },
]

/**
 * 从一段用户文本里按规则抽候选记忆。
 *
 * 三条纪律：
 *   1. 先剥 harness 前导块——否则把运行时规则存成用户偏好；
 *   2. 问句不当事实存（「你记住了吗？」不是记忆）；
 *   3. 长度过滤 + 去重。
 *
 * @param {string} text 用户消息原文
 * @param {number} max 最多抽几条
 * @returns {Array<{kind: string, body: string}>}
 */
export function extractCandidates(text, max = 3) {
  const clean = stripHarnessPreamble(text)
  if (clean.length < 4) return []
  // 问句不当事实存。
  if (/[?？]\s*$/.test(clean) && clean.length < 40) return []

  const out = []
  const seen = new Set()
  for (const rule of EXTRACT_RULES) {
    rule.pattern.lastIndex = 0
    let match
    while ((match = rule.pattern.exec(clean)) !== null) {
      const captured = match.slice(1).filter(Boolean).join(' ').trim()
      if (captured.length < 2 || captured.length > 80) continue
      const body = rule.kind === 'fact' && match[2] ? `${match[1]} 是 ${match[2]}` : captured
      const key = normalizeBody(body)
      if (key.length < 2 || seen.has(key)) continue
      seen.add(key)
      out.push({ kind: rule.kind, body })
      if (out.length >= max) return out
    }
  }
  return out
}
