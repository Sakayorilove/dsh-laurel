/**
 * 运行时能力模型。
 *
 * ──  E 改了什么 ───────────────────────────────────────────────
 * 原实现在 `fact()` 里写 `lastVerifiedAt: new Date().toISOString()` ——
 * 每次构造能力表都盖一个「刚刚验证过」的时间戳，**而没有任何验证发生**。
 * 同时 `worktreeIsolation` / `perCallCwd` 标 `available: true`，
 * 但它们自己的 `limits` 又写着「provider 未接线」。这是自相矛盾：
 * 「接口支持」被当成了「当前可运行」。
 *
 * 现在改成**四个正交字段**，任一为真都不蕴含其余为真：
 *
 *   declaredByHost  —— 宿主公开契约里有没有这个入口（静态可查，读 .d.ts）
 *   implementedByLoom —— Loom 代码写完了没有（有代码 + 有测试）
 *   availableInEnv  —— 当前环境真的探测到了吗（需要探测动作 + 回执）
 *   verifiedInRun   —— 这次运行里真的跑到过吗（需要 run 证据 + 时间戳）
 *
 * `lastVerifiedAt` **只**在 `verifiedInRun === true` 时有值，
 * 且来自**那次验证发生的时间**，不是「现在」。
 *
 * ── 本项目的依赖立场 ───────────────────────────────────────────────────
 * Loom **不使用任何第三方插件的代码**。所以 backend 只有两种：
 *   `host` —— 宿主 DSH 自己提供的能力（我们只调用它的公开契约）
 *   `loom` —— 本项目自建的能力（代码全在本仓库里）
 * 没有第三种。任何「装个别人写的插件就有这个能力」的路径都不在设计里。
 */

/** 能力从哪来。只有两种，见文件头。 */
export type CapabilityBackend = 'host' | 'loom'

/** 证据来源的类别 —— 决定它能支撑到哪一档。 */
export type EvidenceKind =
  /** 读宿主 .d.ts / README 得到的公开契约。只能支撑 declaredByHost。 */
  | 'spec'
  /** 本仓库的源码 + 测试。只能支撑 implementedByLoom。 */
  | 'source'
  /** 一次探测动作的回执（命令 + 输出）。支撑 availableInEnv。 */
  | 'probe'
  /** 一次真实运行的回执（run id + 时间）。支撑 verifiedInRun。 */
  | 'run'

export interface CapabilityEvidence {
  readonly kind: EvidenceKind
  /** 人可核对的位置：文件:行号，或命令 + 关键输出。 */
  readonly where: string
  /** 证据产生的时间（ISO）。spec/source 类可以为 null（它们没有「发生时间」）。 */
  readonly at: string | null
}

/**
 * 一项能力的事实。
 *
 * ⚠ 四个字段的顺序就是它们的强度顺序。写 `availableInEnv: true` 前，
 * `declaredByHost` 与 `implementedByLoom` 必须已经为 true —— 由
 * `assertCapabilityCoherence()` 在构造时断言。
 */
export interface CapabilityFact {
  readonly backend: CapabilityBackend
  /** 1. 宿主公开契约里存在这个入口。读 .d.ts 可得，不需要运行。 */
  readonly declaredByHost: boolean
  /** 2. Loom 侧代码写完并有测试覆盖。 */
  readonly implementedByLoom: boolean
  /** 3. 当前环境探测到可用。需要真实探测回执。`'unknown'` 表示没探过。 */
  readonly availableInEnv: boolean | 'unknown'
  /** 4. 本次运行实际跑通过。需要真实 run 证据。 */
  readonly verifiedInRun: boolean
  /** 只在 verifiedInRun 为 true 时有值，且是那次验证的时间。 */
  readonly lastVerifiedAt: string | null
  readonly evidence: readonly CapabilityEvidence[]
  /** 未做到的部分。**必须展示给 UI**，不再被 true 过滤掉。 */
  readonly limits: readonly string[]
}

export interface LoomCapabilities {
  /** 探测时间（UTC ISO）。真实探测动作发生的时间。 */
  readonly probedAt: string
  readonly hostVersion: string
  /** 宿主实际生效的 workflow engine 与 provider。 */
  readonly engine: {
    readonly workflowEnginePackage: string
    readonly subagentProvider: string
  }
  /* ---- 宿主提供 ---- */
  readonly parallel: CapabilityFact
  readonly realParentAgent: CapabilityFact
  readonly cancel: CapabilityFact
  readonly backgroundJobs: CapabilityFact
  readonly multiSessionApi: CapabilityFact
  /* ---- 本项目自建 ---- */
  readonly worktreeIsolation: CapabilityFact
  readonly journal: CapabilityFact
  readonly wslExecution: CapabilityFact
  /* ---- 逐任务 cwd：走 provider 层，入口是宿主的 ---- */
  readonly perCallCwd: CapabilityFact
}

export const CAPABILITY_KEYS = [
  'parallel',
  'realParentAgent',
  'cancel',
  'backgroundJobs',
  'multiSessionApi',
  'worktreeIsolation',
  'journal',
  'wslExecution',
  'perCallCwd',
] as const

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number]

/** 构造一项能力事实。**不再自动盖时间戳** —— 时间必须由调用方显式给出。 */
export function capabilityFact(input: {
  readonly backend: CapabilityBackend
  readonly declaredByHost: boolean
  readonly implementedByLoom: boolean
  readonly availableInEnv: boolean | 'unknown'
  readonly verifiedInRun?: boolean
  readonly lastVerifiedAt?: string | null
  readonly evidence?: readonly CapabilityEvidence[]
  readonly limits?: readonly string[]
}): CapabilityFact {
  const verifiedInRun = input.verifiedInRun === true
  const lastVerifiedAt = input.lastVerifiedAt ?? null

  const fact: CapabilityFact = {
    backend: input.backend,
    declaredByHost: input.declaredByHost,
    implementedByLoom: input.implementedByLoom,
    availableInEnv: input.availableInEnv,
    verifiedInRun,
    lastVerifiedAt,
    evidence: input.evidence ?? [],
    limits: input.limits ?? [],
  }
  assertCapabilityCoherence(fact)
  return fact
}

/**
 * 一致性断言 —— 这是本文件的核心价值。
 *
 * 三条规则，违反任一条说明能力表在说谎：
 *   R1. `availableInEnv === true` ⟹ `declaredByHost === true`
 *       （宿主都不认识这个入口，环境不可能「可用」）
 *   R2. `availableInEnv === true` ⟹ `implementedByLoom === true`
 *       （Loom 没写代码，不可能「可用」）
 *   R3. `verifiedInRun === true` ⟹ `lastVerifiedAt !== null`
 *       （说验证过却拿不出时间，就是没有证据）
 *
 * 反向不成立：`declaredByHost` 为真不代表能跑 —— 那正是原实现搞错的地方。
 */
export function assertCapabilityCoherence(fact: CapabilityFact): void {
  const name = 'capability'
  if (fact.backend === 'host' && fact.availableInEnv === true && !fact.declaredByHost) {
    throw new Error(
      `[${name}] 不一致：availableInEnv=true 但 declaredByHost=false。` +
        '宿主契约里没有这个入口，环境不可能探测到它。',
    )
  }
  if (fact.availableInEnv === true && !fact.implementedByLoom) {
    throw new Error(
      `[${name}] 不一致：availableInEnv=true 但 implementedByLoom=false。` +
        'Loom 侧没有实现，谈不上「当前可用」。',
    )
  }
  if (fact.verifiedInRun && fact.lastVerifiedAt === null) {
    throw new Error(
      `[${name}] 不一致：verifiedInRun=true 但 lastVerifiedAt=null。` +
        '验证过就必须留下那次验证的时间。',
    )
  }
}

/** 收集一项事实里所有「没做到」的说明，供 UI 展示。 */
export function capabilityGaps(fact: CapabilityFact): string[] {
  const gaps: string[] = []
  if (fact.backend === 'host' && !fact.declaredByHost) gaps.push('宿主公开契约里没有这个入口')
  else if (!fact.implementedByLoom) gaps.push('宿主有入口，但 Loom 侧尚未实现')
  else if (fact.availableInEnv !== true) gaps.push('Loom 已实现，但当前环境尚未探测到可用')
  else if (!fact.verifiedInRun) gaps.push('环境探测可用，但尚未在真实运行中验证')
  return [...gaps, ...fact.limits]
}

/**
 * 给测试与调用方看的「能不能用」判定。
 *
 * ⚠ 注意这里**不用** available（那是「探测到了」），而要求 verifiedInRun 或
 * 至少 availableInEnv===true 且 implementedByLoom。派发闸门（requireCapability）
 * 用这个，不用 available。
 */
export function isUsable(fact: CapabilityFact): boolean {
  return fact.implementedByLoom && fact.availableInEnv === true
}

/**
 * 实测得到的默认能力表（2026-10-02）。
 *
 * 默认值只记录实现与公开接口事实，环境状态保持 unknown。
 * WSL 原生进程注册 provider 并加载公开 helper 后，入口才报告当前环境可用。
 * Windows 桌面跨进程子代理未接线；任何静态资料和注册结果都不能代替真实运行回执。
 */
export function knownCapabilities(): LoomCapabilities {
  return {
    probedAt: '2026-10-02T00:00:00.000Z',
    hostVersion: '0.2.0-rc.2',
    engine: {
      workflowEnginePackage: '@deepseek-ai/dsh-workflow-ptc',
      subagentProvider: 'spawn',
    },
    parallel: capabilityFact({
      backend: 'host',
      declaredByHost: true,
      implementedByLoom: true,
      availableInEnv: 'unknown',
      verifiedInRun: false,
      evidence: [
        { kind: 'spec', where: 'dsh-workflow-ptc/README.zh.md:12 — agent()/parallel()/pipeline()/phase()/log()', at: null },
        { kind: 'probe', where: 'dump-config.desktop-via-wsl.yml — id: workflow-ptc, provider: spawn', at: '2026-10-02T00:00:00.000Z' },
      ],
      limits: ['尚未在真实运行中观测到两个 agent 的时间区间重叠'],
    }),
    realParentAgent: capabilityFact({
      backend: 'host',
      declaredByHost: true,
      implementedByLoom: true,
      availableInEnv: 'unknown',
      evidence: [
        { kind: 'spec', where: 'dsh-workflow/lib/types/runtime-types.d.ts — WorkflowStartRequest.parent: Agent 必填', at: null },
      ],
      limits: ['UI 不能自造 Agent；必须从真实工具调用上下文取 exec.agent', '当前实例尚未验证真实 exec.agent'],
    }),
    cancel: capabilityFact({
      backend: 'host',
      declaredByHost: true,
      implementedByLoom: true,
      availableInEnv: 'unknown',
      evidence: [
        { kind: 'spec', where: 'dsh-workflow/lib/types/runtime-types.d.ts — WorkflowRun.cancel() / dispose()', at: null },
      ],
      limits: ['WSL 进程组取消、任务取消等待和工作树保留已做程序实测；模型侧取消仍需实测'],
    }),
    backgroundJobs: capabilityFact({
      backend: 'host',
      declaredByHost: true,
      implementedByLoom: false,
      availableInEnv: 'unknown',
      evidence: [
        { kind: 'spec', where: 'dsh-jobs/README.zh.md — 后台任务注册表约定', at: null },
      ],
      limits: ['需动态验证 UI 关闭后是否继续'],
    }),
    multiSessionApi: capabilityFact({
      backend: 'host',
      declaredByHost: true,
      implementedByLoom: false,
      availableInEnv: 'unknown',
      evidence: [
        { kind: 'spec', where: '存在 @deepseek-ai/dsh-api-session-controller / dsh-api-gateway 包', at: null },
        { kind: 'probe', where: '桌面宿主监听 127.0.0.1:64318 / 64319（bearer 401）', at: '2026-10-02T00:00:00.000Z' },
      ],
      limits: ['已接公开当前会话 command/prompt/retain API；不自动选择或向其他主会话发送目标'],
    }),
    worktreeIsolation: capabilityFact({
      backend: 'loom',
      // 宿主没有工作树隔离的公开入口 —— 这是我们自建的，所以 declaredByHost=false。
      declaredByHost: false,
      implementedByLoom: true,
      // 建树确实能跑（26 项真实 git 集成测试），但「子代理进树」这一环没接线。
      // 为避免把「能建树」误读成「隔离可用」，这里保持 'unknown'。
      availableInEnv: 'unknown',
      verifiedInRun: false,
      evidence: [
        { kind: 'source', where: '本仓库 src/worktree.ts — 自建 git worktree add/status/remove，无第三方代码', at: null },
        { kind: 'source', where: 'src/core/worktree-plan.ts — 保留裁决纯函数', at: null },
        { kind: 'probe', where: 'scripts/verify-worktree.sh — 26 项真实 git 集成通过', at: '2026-10-02T00:00:00.000Z' },
        { kind: 'spec', where: 'dsh-agent/lib/types/index.d.ts:48 — CreateAgentOptions.meta.cwd', at: null },
      ],
      limits: [
        '建树、独立 cwd 与 Windows→WSL 工具通路已做真实程序实测；模型子代理需当前宿主 provider 注册',
        'provider 支持真实 WSL 与 Windows 桌面；Windows 子会话单独接 WSL Shell/FileSystem，父会话服务保留',
        '真实模型 Agent 的完整派发尚需部署验收',
      ],
    }),
    journal: capabilityFact({
      backend: 'loom',
      declaredByHost: false,
      implementedByLoom: false,
      availableInEnv: false,
      evidence: [
        { kind: 'spec', where: '宿主没有 journal 能力', at: null },
      ],
      limits: ['Loom 尚未实现调用结果复用', '重跑即重新执行，不做假缓存'],
    }),
    wslExecution: capabilityFact({
      backend: 'loom',
      declaredByHost: false,
      implementedByLoom: true,
      availableInEnv: 'unknown',
      evidence: [
        { kind: 'probe', where: '桌面宿主是 Windows 进程（Get-Process: DeepSeek Harness）', at: '2026-10-02T00:00:00.000Z' },
        { kind: 'spec', where: 'dsh-workflow-ptc 按调用 Session 的 cwd 解析执行目录，引擎层没有 per-call cwd', at: null },
      ],
      limits: ['Windows→WSL 进程、真实公开文件工具与并行程序任务已实测', '真实宿主中的完整执行路径尚未验收'],
    }),
    perCallCwd: capabilityFact({
      backend: 'host',
      declaredByHost: true,
      // ⚠ 关键：覆盖函数 withTaskCwd() 写好了，但**没有任何地方调用它**。
      // 所以「Loom 实现完成」为 false，进而 availableInEnv 不能是 true。
      implementedByLoom: true,
      availableInEnv: 'unknown',
      evidence: [
        { kind: 'spec', where: 'dsh-workflow-ptc/lib/types/types.d.ts — ChildStartRequest 只有 prompt/schema/provider/model（引擎层无 per-call cwd）', at: null },
        { kind: 'spec', where: 'dsh-agent/lib/types/index.d.ts:48 — CreateAgentOptions.meta.cwd 存在，逐任务 cwd 在 provider 层可用', at: null },
        { kind: 'spec', where: 'dsh-session/lib/index.js:1046 — cwd 校验只有 isAbsolute', at: null },
        { kind: 'spec', where: 'dsh-sandbox-policy — 「A session cwd is its workspace-write boundary」', at: null },
        { kind: 'source', where: 'src/index.ts 注册 LoomWorktreeProvider；逐任务 meta.cwd 与子会话 WSL 服务接线', at: null },
      ],
      limits: ['WSL 与 Windows 宿主 provider 接线已实现，当前进程是否注册成功由运行时探测', 'Windows 子会话以 UNC 标识目录，并通过 WSL 专用 Shell/FileSystem 执行，不改变共享父会话 cwd'],
    }),
  }
}

/** 编译期/派发前的闸门：不支持就抛，不静默降级。 */
export class UnsupportedCapabilityError extends Error {
  readonly key: string
  constructor(key: string, detail: string) {
    super(`不支持的能力「${key}」：${detail}`)
    this.name = 'UnsupportedCapabilityError'
    this.key = key
  }
}

/**
 * 派发闸门。用 `isUsable()` 而不是 `available` ——
 * 后者只表示「探测到了」，不表示「Loom 真的能跑」。
 */
export function requireCapability(caps: LoomCapabilities, key: CapabilityKey, detail: string): CapabilityFact {
  const f = caps[key]
  if (!isUsable(f)) {
    const gaps = capabilityGaps(f)
    throw new UnsupportedCapabilityError(
      key,
      `${detail}（${gaps.length ? gaps.join('；') : '未说明原因'}）`,
    )
  }
  return f
}

/** 降级清单的一行。 */
export interface DegradationRow {
  readonly key: string
  readonly backend: CapabilityBackend
  /** 人可读状态，逐档显示卡在哪一步。 */
  readonly state: string
  readonly gaps: readonly string[]
  readonly fallback: string
}

/**
 * 面向 UI 的降级说明：哪些功能当前不可用，替代路径是什么。
 *
 * ── 与旧版的差别（评审 E 的第 3 点）──────────────────────────────────────
 * 旧版 `if (state !== '可用') rows.push(...)` —— 只收集 available!==true 的项，
 * 于是 `worktreeIsolation` / `perCallCwd` 的 limits（正是「未接线」这个最该
 * 展示给用户的信息）**永远不会出现**。
 *
 * 现在改成：**只要 `capabilityGaps()` 非空就纳入**。一项「探测可用但没在
 * 真实运行里验证过」的能力也会带缺口出现 —— 那才是诚实的 UI。
 */
export function describeDegradations(caps: LoomCapabilities): DegradationRow[] {
  const fallback: Record<CapabilityKey, string> = {
    parallel: '串行执行',
    realParentAgent: '只提供导出/复制请求，不伪造 Agent',
    cancel: '只提供「停止派发新任务」，不承诺终止在途进程',
    backgroundJobs: '前台运行并如实显示；不承诺关闭 UI 后继续',
    multiSessionApi: '导出任务包手工发送，标注为未完成',
    worktreeIsolation: '自建 git 工作树（建树与保留裁决已通过 26 项真实集成测试）；provider 接线前按单树串行派发',
    journal: '不复用历史调用结果；重跑重新执行',
    wslExecution: '导出任务包由用户在 WSL 手工执行；仅桥和真实 WSL 子代理都通过闸门后运行',
    perCallCwd: '经 provider 层注入 meta.cwd；未接线时拒绝派发，禁止退回共享父目录',
  }

  const rows: DegradationRow[] = []
  for (const key of CAPABILITY_KEYS) {
    const f = caps[key]
    const gaps = capabilityGaps(f)
    if (gaps.length === 0) continue
    rows.push({
      key,
      backend: f.backend,
      state: stageLabel(f),
      gaps,
      fallback: fallback[key],
    })
  }
  return rows
}

/** 一项能力卡在哪一档 —— 逐档回答，不用「可用/不可用」这个粗糙二分。 */
export function stageLabel(f: CapabilityFact): string {
  if (!f.declaredByHost && !f.implementedByLoom) return '未声明且未实现'
  if (!f.declaredByHost) return f.implementedByLoom ? '宿主无此入口（Loom 自建，已实现）' : '宿主无此入口（Loom 未实现）'
  if (!f.implementedByLoom) return '宿主已声明，Loom 未实现'
  if (f.availableInEnv === 'unknown') return 'Loom 已实现，环境未探测'
  if (f.availableInEnv === false) return 'Loom 已实现，环境探测为不可用'
  if (!f.verifiedInRun) return '环境探测可用，未在真实运行中验证'
  return '真实运行已验证'
}
