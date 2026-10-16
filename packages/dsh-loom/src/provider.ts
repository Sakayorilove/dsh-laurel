/**
 * dsh-loom · 宿主半边：逐任务工作树 provider。
 *
 * ── 这个文件存在的唯一理由 ──────────────────────────────────────────────
 * 官方每个 in-process 子代理都继承**父会话的 cwd**（`childSessionMeta()`
 * 直接把 `parent.session.header.cwd` 抄给子会话，见
 * `@deepseek-ai/dsh-subagent/lib/types/child-agent.js`）。于是「多个子代理
 * 并行写同一个仓库」必然互相踩。
 *
 * Loom 要让每个子代理落在**自己的 git 工作树**里。挂载点不在 workflow 层
 * （`ChildStartRequest` 没有 cwd），而在 provider 层：provider 自己调
 * `parent.ctx.agents.create({ meta })`，而 `meta.cwd` 是公开字段。
 *
 * ── 为什么不直接复用 `startInProcessRun` ────────────────────────────────
 * `@deepseek-ai/dsh-subagent-in-process-driver` 的 `startInProcessRun(request, options)`
 * 只接受 `{ seed? }`，**没有 cwd 通道** —— 它内部写死 `childSessionMeta()`。
 * 所以 Loom 自己写 `start()`，按公开 API 的生命周期契约独立实现，只在 `meta` 那一步换成 `withTaskCwd(...)`。
 * 这样我们复用它的**契约**而不是它的代码，符合「零第三方代码」约束。
 *
 * ── 幂等性要求 ──────────────────────────────────────────────────────────
 * 宿主可能对同一个 provider 调多次 `start()`（并发不同子代理）。
 * 本实现不持有跨 run 的可变状态：每次 `start()` 的局部变量互不干扰。
 */
import { installWslChildFileSystem } from './wsl-fs.js'
import { installWslChildShell } from './wsl-shell.js'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { realpathSync } from 'node:fs'
import {
  latestRecords,
  resolveDispatch,
  sanitizeRefSegment,
  type WorktreeRecord,
} from './core/worktree-plan.js'
import type { LoomPaths } from './config.js'
import { createWorktreeStore, withTaskCwd, type WorktreeStore } from './worktree.js'

/* ------------------------------------------------------------------ *
 * 与宿主 dsh-* 包的最小结构契约
 * ------------------------------------------------------------------ *
 * 这里**不 import** 任何 `@deepseek-ai/*` —— 一旦 import，产物就带上了
 * 对外部包的运行期依赖，`scripts/check-bundle.mjs` 会拒绝，而且会让
 * 插件在宿主版本变化时直接崩在装载期。
 *
 * 代价是这些接口必须手写。它们只描述「我们用到的那几个成员」，
 * 比官方完整接口窄得多 —— 宿主多给的东西我们不看，少给的东西 TS 抓不到，
 * 所以下方每个 `?` 都有对应的运行期守卫。 */

/** 宿主 `Session` 的窄视图。 */
export interface HostSession {
  readonly id: string
  readonly header: { readonly cwd?: string; readonly id?: string }
  append(type: string, data: unknown): void
}

/** 宿主 `Agent` 的窄视图。 */
export interface HostAgent {
  readonly session: HostSession
  readonly ctx: HostAgentContext
  cancel(cause: { readonly kind: string }, options?: unknown): void
  whenIdle(): Promise<void>
  followup(message: unknown): void
}

/** 宿主 agent-scoped `Context` 的窄视图。 */
export interface HostAgentContext {
  readonly agents: {
    create(options: {
      readonly sessionId: string
      readonly parentAgent: HostAgent
      readonly meta?: Readonly<Record<string, unknown>>
      readonly agentOptions?: unknown
      readonly signal?: AbortSignal
      readonly setup?: (childCtx: unknown, child: HostAgent) => unknown
    }): Promise<{ readonly agent: HostAgent; dispose(): Promise<void> }>
  }
  on?(event: string, handler: (...args: never[]) => unknown): void
}

/** 宿主 provider 请求的窄视图（对应 `ResolvedSubagentStartRequest`）。 */
export interface HostStartRequest {
  readonly label?: string
  readonly prompt: readonly unknown[]
  readonly parent: HostAgent
  readonly signal: AbortSignal
  readonly agentOptions?: unknown
  readonly outputSchema?: unknown
  readonly maxDepth?: number
  readonly toolFilter?: unknown
  readonly persona?: string
  readonly descriptor?: unknown
}

/** 宿主 `SubagentRun` 的窄视图。 */
export interface HostRun {
  readonly id: string
  readonly localAgent: HostAgent | undefined
  readonly result: Promise<HostRunResult>
  dispose(): Promise<void>
}

export interface HostRunResult {
  readonly output: readonly unknown[]
  readonly structured?: unknown
  readonly diagnostic?: string
  readonly stopReason: string
}

/**
 * 由 `src/index.ts` 注入的宿主组合辅助函数。
 *
 * 这些是 `@deepseek-ai/dsh-subagent` 的**公开导出**，但按上面的理由，
 * 我们不能 import。所以由调用方（能 import 宿主包的入口层）传进来。
 * 缺任何一个 → `assertHostHelpers()` 在注册前就抛，而不是等到派发才崩。
 */
export interface HostHelpers {
  /** `childSessionMeta(parent, childDepth, isSeeded)` */
  readonly childSessionMeta: (parent: HostAgent, childDepth: number, isSeeded: boolean) => Record<string, unknown>
  /** `resolveChildDepth(parent, maxDepth)` */
  readonly resolveChildDepth: (parent: HostAgent, maxDepth: number | undefined) => number
  /** `resolveChildAgentOptions(parent, requested, childDepth)` */
  readonly resolveChildAgentOptions: (parent: HostAgent, requested: unknown, childDepth: number) => unknown
  /** `assertSubagentMaxDepth(maxDepth)` */
  readonly assertSubagentMaxDepth: (maxDepth: number | undefined) => void
  /** `captureDelegatedPolicyOverrides(parent)` */
  readonly captureDelegatedPolicyOverrides: (parent: HostAgent) => unknown
  /** `appendDelegatedPolicyOverrides(childSession, overrides)` */
  readonly appendDelegatedPolicyOverrides: (childSession: HostSession, overrides: unknown) => void
  /** `applyChildComposition(childCtx, parent, { persona, toolFilter })` */
  readonly applyChildComposition: (
    childCtx: unknown,
    parent: HostAgent,
    composition: { readonly persona?: string; readonly toolFilter?: unknown },
  ) => void
  /** `createUserMessage({ content, source })` */
  readonly createUserMessage: (input: { readonly content: readonly unknown[]; readonly source: unknown }) => unknown
  /** `brandString(raw)` —— 把裸字符串铸成 brand 类型。 */
  readonly brandString?: (raw: string) => unknown
  /** `foldConsumedWork(events)` —— 从事件里取本轮结束原因。 */
  readonly foldConsumedWork?: (events: readonly unknown[]) => { readonly end?: { readonly data?: { readonly reason?: unknown } } }
  /** `finalAssistantOutput(events)` */
  readonly finalAssistantOutput?: (events: readonly unknown[]) => readonly unknown[] | undefined
  /** `SessionLogOffset(n)` */
  readonly sessionLogOffset?: (n: number) => unknown
  readonly assertOutputSchema?: (schema: unknown) => void
  readonly validateOutput?: (schema: unknown, value: unknown) => readonly unknown[]
  readonly ToolArgsError?: new (violations: any) => Error
}

/** 缺哪个 helper 就说哪个，别让人猜。 */
export function assertHostHelpers(helpers: Partial<HostHelpers>): asserts helpers is HostHelpers {
  const required = [
    'childSessionMeta',
    'resolveChildDepth',
    'resolveChildAgentOptions',
    'assertSubagentMaxDepth',
    'captureDelegatedPolicyOverrides',
    'appendDelegatedPolicyOverrides',
    'applyChildComposition',
    'createUserMessage',
  ] as const
  const missing = required.filter((k) => typeof helpers[k] !== 'function')
  if (missing.length > 0) {
    throw new Error(
      `Loom 工作树 provider 缺少宿主组合辅助函数：${missing.join('、')}。` +
        '这些必须由能 import @deepseek-ai/dsh-subagent 的入口层注入。',
    )
  }
}

/* ------------------------------------------------------------------ *
 * provider 本体
 * ------------------------------------------------------------------ */

/** provider 注册名。`loom_run` 与文档都用这个字符串。 */
export const LOOM_PROVIDER_NAME = 'loom-worktree'

export interface LoomProviderOptions {
  readonly resolveExecutionRepo?: (parent: HostAgent) => string | null
  readonly paths: LoomPaths
  readonly helpers: Partial<HostHelpers>
  readonly log?: {
    info(msg: string): void
    warn(msg: string): void
    error(msg: string): void
  }
}

/**
 * 派发前的归属解析：**唯一**决定子代理落在哪棵树的函数。
 *
 * 抽出来是为了它可测：不碰 git、不碰宿主，纯读 store + 纯裁决。
 * 返回 `DispatchRefusal` 时调用方必须抛 —— 绝不回落父 cwd。
 */
export function resolveTaskWorktree(
  store: WorktreeStore,
  label: string | undefined,
): WorktreeRecord | { readonly refuse: string } {
  const records = latestRecords(store.listAll())
  const resolution = resolveDispatch(label, records)
  if (!resolution.ok) {
    return { refuse: `${resolution.code}：${resolution.detail}` }
  }
  const hit = records.find((r) => r.runId === resolution.runId && r.taskId === resolution.taskId)
  if (hit === undefined) return { refuse: 'NO_RECORD：解析成功但记录消失了' }
  return hit
}

/**
 * Loom 的逐任务工作树 provider。
 *
 * ── 为什么 `capabilities.agentOptions` 为 true ─────────────────────────
 * 模型选项、深度与组合策略由宿主公开 API 处理。outputSchema 仅在宿主
 * 提供公开 schema 校验 API 时声明支持；本 provider 注册作用域回执工具，
 * 等工具结果真正成功后捕获，不能把助手正文当作结构化交付。
 *
 * ── 为什么 `inheritsParentContext = false` ────────────────────────────
 * 这是事实陈述，不是策略：我们不给子会话 seed，子代理看到的是空会话。
 * 它决定模型侧工具对用户怎么描述这次委托，说错了就是骗人。
 */
export class LoomWorktreeProvider {
  readonly name = LOOM_PROVIDER_NAME

  get capabilities() { return {
    agentOptions: true,
    outputSchema: typeof this.helpers.assertOutputSchema === 'function' && typeof this.helpers.validateOutput === 'function' && typeof this.helpers.ToolArgsError === 'function',
    depthLimit: true,
    toolFilter: true,
    persona: true,
  } as const }

  readonly inheritsParentContext = false

  private readonly store: WorktreeStore
  private readonly helpers: Partial<HostHelpers>
  private readonly log: NonNullable<LoomProviderOptions['log']>
  private readonly resolveExecutionRepo?: (parent: HostAgent) => string | null

  constructor(options: LoomProviderOptions) {
    this.resolveExecutionRepo=options.resolveExecutionRepo
    this.store = createWorktreeStore(options.paths)
    this.helpers = options.helpers
    this.log = options.log ?? { info() {}, warn() {}, error() {} }
  }

  /** 本次 run 用哪棵树 —— 供测试与 `loom_run` 共用。 */
  locate(label: string | undefined): WorktreeRecord | { readonly refuse: string } {
    return resolveTaskWorktree(this.store, label)
  }

  async start(request: HostStartRequest): Promise<HostRun> {
    const h = this.helpers
    assertHostHelpers(h)
    if (request.outputSchema !== undefined) {
      if (!this.capabilities.outputSchema) throw new Error('STRUCTURED_OUTPUT_UNAVAILABLE: 宿主缺少公开 schema 校验 API')
      h.assertOutputSchema!(request.outputSchema)
    }

    // 1. 先解析归属。这一步在**任何 await 之前**，因为它是纯读；
    //    失败必须早于子会话创建，否则会留下一个生在父 cwd 的子代理。
    const target = this.locate(request.label)
    if ('refuse' in target) {
      this.log.error(`拒绝派发：${target.refuse}`)
      throw new Error(
        `Loom 拒绝派发：${target.refuse}。` +
          '不会回落到父会话目录 —— 那会让子代理在共享目录里并行写代码。',
      )
    }
    const worktreePath = target.path
    const parentCwd = this.resolveExecutionRepo?.(request.parent) ?? request.parent.session.header.cwd
    if (typeof parentCwd !== 'string' || realpathSync(parentCwd) !== realpathSync(target.repoPath)) {
      throw new Error('WORKSPACE_MISMATCH: 派发标签不能借用其他项目的工作树')
    }
    if (!isAbsolute(worktreePath)) {
      throw new Error(`Loom 工作树路径不是绝对路径：${worktreePath}`)
    }

    h.assertSubagentMaxDepth(request.maxDepth)
    if (request.descriptor === undefined) throw new Error('DESCRIPTOR_REQUIRED: 缺少宿主生成的子代理归属描述')
    if (request.signal.aborted) {
      throw new Error('subagent request was aborted before child publication')
    }

    const parent = request.parent
    const childDepth = h.resolveChildDepth(parent, request.maxDepth)
    const childId = (h.brandString ?? ((raw: string) => raw))(randomUUID())

    // 快照委托策略 —— 必须同步捕获（父会话之后切换预设属于它的未来）
    const inherited = h.captureDelegatedPolicyOverrides(parent)
    let captured: unknown

    const setup = async (childCtx: unknown, child: HostAgent): Promise<void> => {
      h.appendDelegatedPolicyOverrides(child.session, inherited)
      if (request.outputSchema !== undefined) {
        const context = childCtx as any, staged = new WeakMap<object, unknown>()
        let pending: { parent: unknown; value: unknown } | undefined
        context.tools.register({
          name: 'structured_output', description: '最终交付回执。必须填写当前执行身份并调用本工具；普通文字不是交付。', parameters: request.outputSchema,
          output: { schema: { type: 'object', properties: { recorded: { type: 'boolean', const: true } }, required: ['recorded'], additionalProperties: false }, render: () => [{ type: 'text', text: 'Structured delivery recorded.' }] },
          async execute(value: unknown, execution: any) {
            const violations = h.validateOutput!(request.outputSchema, value)
            if (violations.length) throw new h.ToolArgsError!(violations)
            staged.set(execution, structuredClone(value)); execution.concludeTurn(); return { recorded: true }
          },
        })
        context.systemPrompt.section({ name: 'loom:structured-delivery', order: context.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT'), text: '最终结果必须调用 structured_output 工具，严格填写其 schema。禁止用 Markdown 或普通文本代替。' })
        context.tools.guard(() => captured !== undefined || pending !== undefined ? 'LOOM_DELIVERY_RECORDED: 本轮已经交付，不能继续执行工具' : undefined)
        context.on('tools/result', (execution: any, result: any) => {
          if (execution.name === 'structured_output' && staged.has(execution)) {
            const value = staged.get(execution); staged.delete(execution)
            if (result.isError) return
            if (execution.parent === undefined) captured = value
            else pending = { parent: execution.parent, value }
          } else if (pending && pending.parent === execution.token) {
            const accepted = pending; pending = undefined
            if (!result.isError) captured = accepted.value
          }
        })
      }
      h.applyChildComposition(childCtx, parent, {
        persona: request.persona,
        toolFilter: request.toolFilter,
      })
      if(request.persona==='Loom 独立只读审查') {
        const tools=(childCtx as any).tools
        if(typeof tools?.guard!=='function')throw new Error('READONLY_GUARD_UNAVAILABLE')
        tools.guard((execution:any)=>['read','glob','grep','structured_output'].includes(execution.name)?undefined:'LOOM_REVIEW_READ_ONLY: 独立审查不能执行写入、命令或委托工具')
        child.session.append('sandbox/mode',{mode:'read-only'})
      }
      const context = childCtx as { on?: (name: string, handler: (payload: any, next: () => Promise<any>) => Promise<any>) => unknown }
      if (typeof context.on !== 'function') throw new Error('CHILD_HOOK_UNAVAILABLE: 无法记录子代理归属')
      let descriptorRecorded = false
      context.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (decision?.kind === 'enter' && !descriptorRecorded) {
          payload.agent.session.append('subagent/descriptor', request.descriptor)
          descriptorRecorded = true
        }
        return decision
      })
      if (child.session.header.cwd !== worktreePath) {
        // 不该发生：meta 是我们传的。真发生了说明宿主改写了 cwd —— 必须可见。
        throw new Error(`CHILD_CWD_MISMATCH: 期望 ${worktreePath}，实际 ${String(child.session.header.cwd)}`)
      }
      if (process.platform === 'win32') {
        await installWslChildFileSystem(childCtx, worktreePath)
        await installWslChildShell(childCtx, worktreePath)
      }
    }

    // 为本任务显式设置子会话 meta.cwd
    const meta = withTaskCwd(h.childSessionMeta(parent, childDepth, false), worktreePath)

    const handle = await parent.ctx.agents.create({
      sessionId: childId as string,
      parentAgent: parent,
      meta,
      agentOptions: h.resolveChildAgentOptions(parent, request.agentOptions, childDepth),
      signal: request.signal,
      setup,
    })

    this.log.info(`子代理 ${String(childId)} 落在工作树 ${worktreePath}`)
    return this.drive(handle, request.signal, request.prompt, childId, h, request.outputSchema !== undefined ? () => captured : undefined)
  }

  /**
   * 把已发布的子代理包成单个 run 生命周期：信号交接、一轮对话、结果读取、
   * 静默销毁。形状与 `drivePublishedRun()` 一致 —— 顺序是契约的一部分。
   */
  private drive(
    handle: { readonly agent: HostAgent; dispose(): Promise<void> },
    signal: AbortSignal,
    prompt: readonly unknown[],
    childId: unknown,
    h: HostHelpers,
    capture?: () => unknown,
  ): HostRun {
    const child = handle.agent
    const flags = { cancelled: false }
    const onAbort = (): void => {
      flags.cancelled = true
      child.cancel({ kind: 'parent' })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()

    const result: Promise<HostRunResult> = (async () => {
      try {
        if (!flags.cancelled) {
          child.followup(h.createUserMessage({ content: prompt, source: { kind: 'user' } }))
          await child.whenIdle()
        }
        const result = this.readResult(child, flags.cancelled, h)
        if (!capture) return result
        const structured = capture()
        return structured !== undefined ? { ...result, structured } : { ...result, stopReason: result.stopReason === 'completed' ? 'refusal' : result.stopReason, diagnostic: 'STRUCTURED_OUTPUT_MISSING: 子代理没有通过工具交付有效回执' }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    })()

    return {
      id: String(childId),
      localAgent: child,
      result,
      async dispose(): Promise<void> {
        signal.removeEventListener('abort', onAbort)
        flags.cancelled = true
        const settled = await Promise.allSettled([handle.dispose(), result])
        const first = settled[0]
        if (first.status === 'rejected') throw first.reason
      },
    }
  }

  /**
   * 从子会话事件里读结果。
   *
   * `foldConsumedWork` / `finalAssistantOutput` 是可选的 —— 宿主没给时
   * 退化成「空输出 + 粗粒度 stopReason」，而不是编一个假的 completed。
   */
  private readResult(child: HostAgent, cancelled: boolean, h: HostHelpers): HostRunResult {
    const session = child.session as unknown as {
      snapshotEvents?: (offset: unknown) => readonly unknown[]
    }
    const offset = typeof h.sessionLogOffset === 'function' ? h.sessionLogOffset(0) : undefined
    const events =
      typeof session.snapshotEvents === 'function' && offset !== undefined ? session.snapshotEvents(offset) : []

    let recorded = 'error'
    if (typeof h.foldConsumedWork === 'function') {
      const folded = h.foldConsumedWork(events)
      recorded = toStopReason(folded.end?.data?.reason)
    }

    const output = typeof h.finalAssistantOutput === 'function' ? (h.finalAssistantOutput(events) ?? []) : []
    const stopReason = cancelled && recorded !== 'completed' ? 'aborted' : recorded
    return { output, stopReason }
  }
}

/** 把会话轮次结果映射到 subagent 缝的终态词汇（与官方 driver 同表）。 */
export function toStopReason(reason: unknown): string {
  const kind = (reason as { kind?: unknown } | undefined)?.kind
  switch (kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    case 'blocked':
      return 'refusal'
    default:
      return 'error'
  }
}

/** 派发前的自检：给定 label 与已登记记录，会落在哪 / 为什么拒绝。 */
export function describeDispatch(label: string | undefined, records: readonly WorktreeRecord[]): string {
  const resolution = resolveDispatch(label, records)
  if (resolution.ok) {
    return `会落进 ${resolution.path}（run ${resolution.runId} / 任务 ${resolution.taskId}）`
  }
  return `拒绝（${resolution.code}）：${resolution.detail}`
}

/** 暴露给 `loom_worktree` 工具：把 runId/taskId 组成宿主 label。 */
export { sanitizeRefSegment }
