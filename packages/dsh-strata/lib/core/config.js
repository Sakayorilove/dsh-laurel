/**
 * dsh-strata · 配置、路径、作用域常量
 *
 * 依赖只有 node 内置模块。这是刻意的：插件要能被别人直接装，
 * 不该带第三方依赖；而且 `@deepseek-ai/*` 的可用性取决于宿主版本的
 * 运行时解析，不保证一定在。所以宿主服务一律走 `ctx.get()` 取，
 * 模块一律不 import 非内置包。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 包名。同时是客户端半边 `window.__ModuleLoader__.load({ id })` 用的 id，两处必须一致。 */
export const PACKAGE_NAME = 'dsh-strata'

/** 与 package.json 的 version 保持一致（测试会核对）。 */
export const VERSION = '0.3.1'

/** 内容归属。读取策略与工作区授权独立，不把查 B 等同于全局保存。 */
export const SCOPES = ['session', 'workspace', 'global']

/** 阶梯序号。数值越大越"公开"，用于比较与提升判定。 */
export const SCOPE_RANK = { session: 0, workspace: 1, global: 2 }

/** 记忆种类。规则抽取只产出前四类；后两类只能由工具显式写入。 */
export const KINDS = ['preference', 'constraint', 'decision', 'fact', 'insight', 'entity']

/** 跨工作区读取的策略。 */
export const CROSS_MODES = ['deny', 'ask']

/**
 * 注入里那段「什么时候值得记」的规则强度。
 *   off          只注入资料，不注入规则（回到 0.2.0 的行为）
 *   conservative 默认
 *   balanced
 *   eager
 */
export const WRITE_PROMPT_MODES = ['off', 'conservative', 'balanced', 'eager']

/** 授权有效期。 */
export const GRANT_DURATIONS = ['once', 'session', 'persistent']

/**
 * 插件配置默认值。
 *
 * `cordis.patch.yml` 里那份 config 会被当成**默认值的覆盖**；
 * `$DSH_HOME/strata/settings.json`（设置页写的那份）再盖一层。
 */
export const DEFAULT_CONFIG = {
  /** 总开关。关掉后工具仍在，但不再自动注入提示词。 */
  enabled: true,

  // ── 注入 ──────────────────────────────────────────────────────────────
  /** 是否把召回到的记忆注入系统上下文。关掉后只剩模型主动调 memory_recall。 */
  injectSection: true,
  /** 每次注入几条。6 是平衡点；15+ 会开始吃掉上下文预算。 */
  recallLimit: 6,
  /**
   * 注入的最低分。**这是最重要的旋钮。**
   * 设成 0 等于「任何词重合都注入」，通常比没有记忆更糟。
   */
  minScore: 0.12,
  /** 注入块的总字符上限，超了从低分往高砍。 */
  maxInjectChars: 1600,
  /**
   * 注入里是否附带「什么时候值得记」的规则，以及强度。见 `WRITE_PROMPT_MODES`。
   *
   * ── 为什么必须有这一段（2026-10-07 实测事故）──────────────────────────
   * 写入指令原先只写在 `memory_remember` 的 tool description 里 —— 模型**没有
   * 调用意图时根本看不到它**；而空库时 `packInjection` 返回 null ⇒ 干脆不注入
   * ⇒ 模型连"这里可以记东西"都不知道。本机实测：4 天、53 次加载、长期记忆
   * **0 条**、注入 **0 次**。这就是空库死锁：
   *     没指令 → 不写 → 库还是空 → 还是不注入
   * 所以规则段必须在**空库时也注入**（只注入规则，不伪造资料）。
   *
   * eager 会主动攒内容，也最容易攒噪声；默认取 conservative。
   */
  writePrompt: 'conservative',

  // ── 作用域 ────────────────────────────────────────────────────────────
  /** 新记忆默认落在哪一层。 */
  defaultScope: 'workspace',
  readScope: 'workspace',
  readGlobal: true,
  searchHistory: true,
  historySessions: 30,
  historyMaxChars: 60000,
  /** 是否允许写入 L2 全局记忆（`memory_remember` 传 scope=global 时）。 */
  allowGlobalWrite: false,
  /**
   * 跨工作区召回的默认策略：
   *   deny —— 从不跨（最省上下文，但「查 B 工作区」永远查不到）
   *   ask  —— 有授权才跨（默认：勾过的能查，没勾的查不到并提示你去勾）
   */
  crossWorkspace: 'ask',
  /** 单次召回最多跨几个工作区。防止一次把全部工作区扫一遍。 */
  maxForeignWorkspaces: 3,

  // ── 召回算法 ──────────────────────────────────────────────────────────
  /** 联想传播跳数。2 会显著扩大召回面，也显著增加噪声。 */
  associationHops: 1,
  /** 每跳的衰减。越小，间接关联衰减越快。 */
  associationDecay: 0.35,
  /** 时间衰减半衰期（天）。长期项目可以调到 180。 */
  halfLifeDays: 45,
  /** 每个来源会话最多占几个召回名额，防止一次长会话垄断。 */
  perSessionQuota: 2,
  /** 存储上限。超出后按 显著度×置信度×新鲜度 淘汰最弱的。 */
  maxRecords: 5000,

  // ── 写入 ──────────────────────────────────────────────────────────────
  /**
   * 自动抽取。**默认关，而且建议一直关。**
   *
   * 这是从 dsh-memory-loom 作者实测结论抄来的：规则抽取的投入产出比是负的
   * ——真实任务导向会话里产出 0 条，两次误判都是把 harness 自己的提示词
   * 写进了用户记忆库。留下这个开关是为了让你能自己验一遍，不是推荐你开。
   */
  autoExtract: false,
  /** 每条消息最多抽几条。 */
  autoExtractMax: 3,

  // ── 维护 ──────────────────────────────────────────────────────────────
  /** 回填时扫描多少个历史会话。 */
  backfillSessions: 50,
  /** 会话文件解压后的单文件字节上限，超了跳过（防一个巨型会话拖垮回填）。 */
  maxSessionBytes: 24 * 1024 * 1024,
  /**
   * 额外的会话根目录。**这不是多余的开关。**
   *
   * 2026-10-02 实机发生的事：`~/.dsh/sessions/` 下上百个会话在半小时内被清空，
   * 只剩一个 437 字节的空壳；而另一次备份的 `dsh-home/sessions/` 里还躺着
   * 12 个会话、37MB。**会话日志不是可靠的长期存储** ——
   * 这恰恰是记忆必须自己落一份 `memories.jsonl` 的理由。
   *
   * 所以回填允许你指向自己的备份目录。默认空数组（只扫 `$DSH_HOME/sessions`）。
   * 例：`extraSessionRoots: ['<你的备份目录>/dsh-home/sessions']`
   */
  extraSessionRoots: [],

  // ── 上下文领航（从 ACP 借来的做法，见 lib/core/pilot.js）───────────────
  /**
   * 增长式上下文提醒。**与宿主的压缩阈值无关**——宿主是"窗口到 80% 才动"
   * （1M 窗口 = 80 万 token），本机实测长会话最多到 42 万，所以它一次都没触发。
   * 这里改成：**上下文每长大 N token 就温和提醒一次**，与窗口大小无关。
   * 只提醒，不代替模型做任何删除或改写。
   */
  contextNudge: true,
  /** 距上次提醒长大多少 token 就再提醒一次。ACP 的默认值是 5 万。 */
  contextNudgeGrowthTokens: 50000,
  /** 低于这个量不提醒——省得在短会话里刷屏。 */
  contextNudgeMinTokens: 20000,
  /** 已核实台账：记住"哪些文件读过并核实过、且没被改过"，减少重复读。 */
  verifiedLedger: true,

  // ── 子代理与压缩（2026-10-14 新增，见 lib/host/guard.js）─────────────────
  /**
   * `wait_agent` 单次等待上限（毫秒）。**0 = 不干预**。
   *
   * 为什么需要它：宿主里 `wait_agent` 的超时是**模型每次自己传**的，
   * 默认 30 秒、上限 1 小时。宿主的 `dsh-tool-call-timeout-policy` 只对
   * 「自己声明了 timeoutMs 的工具」生效，而 `wait_agent` 没声明 ——
   * 所以模型挑 1 小时就真等 1 小时。本机 2026-10-14 实测：一个会话里
   * `wait_agent` 被调 41 次，486 步的会话跨度 6 小时而真正在算的只有 73 分钟。
   *
   * 这里在 `tools/pre-execute` 里把它压到上限以内，**只改参数、不改语义**。
   */
  subagentWaitCapMs: 60000,
  /**
   * 子代理通信纪律：提醒模型「子代理只对主控汇报、彼此不互发消息」。
   *
   * 出处：本机 2026-10-14 实测，一个会话里 98 条 team message 全是子代理之间
   * 直接对话、互相「更正（请以这条为准）」，读数互相污染。
   * 业界做法（LangGraph 的 Supervisor、Anthropic 的多智能体）都是**星型拓扑**：
   * worker 只回主控，彼此不通信。这条只注入一段短规则，不拦截任何工具。
   */
  subagentStarTopology: true,
  /**
   * 重复工具调用提醒：同一条工具连续重复 N 次就温和提醒一次。
   *
   * 为什么需要：本机 2026-10-14 实测，一个会话里 shell 调用 1006 次、
   * 改文件 831 次 —— 典型的「改了又试、试了又改」。提醒只追加一句话，
   * 不阻止调用（阻止会误伤正常的重试）。
   */
  repeatToolNudge: true,
  /** 同一条工具连续重复几次开始提醒。 */
  repeatToolThreshold: 3,

  logLevel: 'info',
}

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'])

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function pickEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback
}

/**
 * 归一化一份配置：只认声明过的键；类型不对就用 base 里的值；数值一律夹到合理区间。
 *
 * 为什么不信任输入：这份配置有三个来处（patch、settings.json、设置页的 POST），
 * 任何一个写坏了都不该让插件带着一个 NaN 去算召回。
 *
 * @param {Record<string, unknown>} raw 待归一化的配置
 * @param {typeof DEFAULT_CONFIG} base 类型不对时的兜底
 */
export function normalizeConfig(raw = {}, base = DEFAULT_CONFIG) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const out = { ...base }
  const bool = (key) => { if (typeof input[key] === 'boolean') out[key] = input[key] }
  bool('enabled')
  bool('injectSection')
  bool('allowGlobalWrite')
  bool('autoExtract')
  bool('readGlobal')
  bool('searchHistory')
  bool('contextNudge')
  bool('verifiedLedger')
  bool('subagentStarTopology')
  bool('repeatToolNudge')
  // 0 表示「不干预」；上限 1 小时与宿主 wait_agent 的硬上限对齐。
  out.subagentWaitCapMs = clampNumber(input.subagentWaitCapMs ?? base.subagentWaitCapMs, 0, 3600000, base.subagentWaitCapMs)
  out.repeatToolThreshold = clampNumber(input.repeatToolThreshold ?? base.repeatToolThreshold, 2, 50, base.repeatToolThreshold)
  out.contextNudgeGrowthTokens = clampNumber(input.contextNudgeGrowthTokens ?? base.contextNudgeGrowthTokens, 2000, 500000, base.contextNudgeGrowthTokens)
  out.contextNudgeMinTokens = clampNumber(input.contextNudgeMinTokens ?? base.contextNudgeMinTokens, 0, 500000, base.contextNudgeMinTokens)
  out.readScope = pickEnum(input.readScope, new Set(['session', 'workspace']), base.readScope)
  out.historySessions = clampNumber(input.historySessions ?? base.historySessions, 1, 100, base.historySessions)
  out.historyMaxChars = clampNumber(input.historyMaxChars ?? base.historyMaxChars, 1000, 200000, base.historyMaxChars)
  out.recallLimit = clampNumber(input.recallLimit ?? base.recallLimit, 0, 40, base.recallLimit)
  out.maxInjectChars = clampNumber(input.maxInjectChars ?? base.maxInjectChars, 200, 20000, base.maxInjectChars)
  out.associationHops = clampNumber(input.associationHops ?? base.associationHops, 0, 4, base.associationHops)
  out.halfLifeDays = clampNumber(input.halfLifeDays ?? base.halfLifeDays, 1, 3650, base.halfLifeDays)
  out.perSessionQuota = clampNumber(input.perSessionQuota ?? base.perSessionQuota, 1, 20, base.perSessionQuota)
  out.maxRecords = clampNumber(input.maxRecords ?? base.maxRecords, 50, 200000, base.maxRecords)
  out.autoExtractMax = clampNumber(input.autoExtractMax ?? base.autoExtractMax, 0, 20, base.autoExtractMax)
  out.backfillSessions = clampNumber(input.backfillSessions ?? base.backfillSessions, 0, 2000, base.backfillSessions)
  out.maxForeignWorkspaces = clampNumber(input.maxForeignWorkspaces ?? base.maxForeignWorkspaces, 0, 50, base.maxForeignWorkspaces)
  // 分数是 0..1 的小数，不能走 clampNumber（它会取整）。
  const minScore = Number(input.minScore ?? base.minScore)
  out.minScore = Number.isFinite(minScore) ? Math.min(1, Math.max(0, minScore)) : base.minScore
  const decay = Number(input.associationDecay ?? base.associationDecay)
  out.associationDecay = Number.isFinite(decay) ? Math.min(1, Math.max(0.01, decay)) : base.associationDecay
  out.defaultScope = pickEnum(input.defaultScope, new Set(SCOPES), base.defaultScope)
  out.crossWorkspace = pickEnum(input.crossWorkspace, new Set(CROSS_MODES), base.crossWorkspace)
  out.writePrompt = pickEnum(input.writePrompt, new Set(WRITE_PROMPT_MODES), base.writePrompt)
  out.logLevel = pickEnum(input.logLevel, LOG_LEVELS, base.logLevel)
  // 路径数组：只接受字符串，去掉空项与重复项。
  if (Array.isArray(input.extraSessionRoots)) {
    out.extraSessionRoots = [...new Set(input.extraSessionRoots.filter((p) => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim()))].slice(0, 8)
  }
  return out
}

/** 只保留已知键，写盘前用一次，避免把临时字段写进 settings.json。 */
export function pickKnown(config) {
  const out = {}
  for (const key of Object.keys(DEFAULT_CONFIG)) out[key] = config[key]
  return out
}

/**
 * DSH 家目录 —— 与宿主自己的 `@deepseek-ai/dsh-home-paths` 同一条规则：
 *   1. `DSH_HOME` 环境变量（有就用它）；
 *   2. 否则 `os.homedir()/.dsh`。
 *
 * ⚠️ 不要用 `DSH_PROFILE_DIR` 去推父目录。桌面版宿主是 Electron fork 出来的
 * 子进程，那个环境里**没有** `DSH_HOME`，从 profile 目录推会推到错误位置。
 */
export function resolveDshHome() {
  const home = process.env.DSH_HOME
  if (home && home.length > 0) return home
  return join(homedir(), '.dsh')
}

/** 本插件的数据位置。 */
export function pluginPaths(home = resolveDshHome()) {
  const dir = join(home, 'strata')
  return {
    dir,
    settings: join(dir, 'settings.json'),
    /** 记忆本体：一行一个事件的追加式 JSONL（永不覆盖，只追加）。 */
    memories: join(dir, 'memories.jsonl'),
    /** 授权台账：跨工作区读取的许可。 */
    grants: join(dir, 'grants.json'),
    /** 事件日志：召回/写入/授权的事后核对。 */
    events: join(dir, 'events.log'),
    /** 宿主自己的会话目录与 storage 目录（只读，用来发现工作区）。 */
    sessions: join(home, 'sessions'),
    storages: join(home, 'storages'),
  }
}

/** 工作区 key 的归一化：Windows 上大小写不敏感，分隔符统一。 */
export function workspaceKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return ''
  const path = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path
}

/** 工作区展示名：取最后一段目录名。 */
export function workspaceLabel(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return '(未知)'
  const parts = cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : cwd
}
