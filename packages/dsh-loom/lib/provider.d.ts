import { sanitizeRefSegment, type WorktreeRecord } from './core/worktree-plan.js';
import type { LoomPaths } from './config.js';
import { type WorktreeStore } from './worktree.js';
/** 宿主 `Session` 的窄视图。 */
export interface HostSession {
    readonly id: string;
    readonly header: {
        readonly cwd?: string;
        readonly id?: string;
    };
    append(type: string, data: unknown): void;
}
/** 宿主 `Agent` 的窄视图。 */
export interface HostAgent {
    readonly session: HostSession;
    readonly ctx: HostAgentContext;
    cancel(cause: {
        readonly kind: string;
    }, options?: unknown): void;
    whenIdle(): Promise<void>;
    followup(message: unknown): void;
}
/** 宿主 agent-scoped `Context` 的窄视图。 */
export interface HostAgentContext {
    readonly agents: {
        create(options: {
            readonly sessionId: string;
            readonly parentAgent: HostAgent;
            readonly meta?: Readonly<Record<string, unknown>>;
            readonly agentOptions?: unknown;
            readonly signal?: AbortSignal;
            readonly setup?: (childCtx: unknown, child: HostAgent) => unknown;
        }): Promise<{
            readonly agent: HostAgent;
            dispose(): Promise<void>;
        }>;
    };
    on?(event: string, handler: (...args: never[]) => unknown): void;
}
/** 宿主 provider 请求的窄视图（对应 `ResolvedSubagentStartRequest`）。 */
export interface HostStartRequest {
    readonly label?: string;
    readonly prompt: readonly unknown[];
    readonly parent: HostAgent;
    readonly signal: AbortSignal;
    readonly agentOptions?: unknown;
    readonly outputSchema?: unknown;
    readonly maxDepth?: number;
    readonly toolFilter?: unknown;
    readonly persona?: string;
    readonly descriptor?: unknown;
}
/** 宿主 `SubagentRun` 的窄视图。 */
export interface HostRun {
    readonly id: string;
    readonly localAgent: HostAgent | undefined;
    readonly result: Promise<HostRunResult>;
    dispose(): Promise<void>;
}
export interface HostRunResult {
    readonly output: readonly unknown[];
    readonly structured?: unknown;
    readonly diagnostic?: string;
    readonly stopReason: string;
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
    readonly childSessionMeta: (parent: HostAgent, childDepth: number, isSeeded: boolean) => Record<string, unknown>;
    /** `resolveChildDepth(parent, maxDepth)` */
    readonly resolveChildDepth: (parent: HostAgent, maxDepth: number | undefined) => number;
    /** `resolveChildAgentOptions(parent, requested, childDepth)` */
    readonly resolveChildAgentOptions: (parent: HostAgent, requested: unknown, childDepth: number) => unknown;
    /** `assertSubagentMaxDepth(maxDepth)` */
    readonly assertSubagentMaxDepth: (maxDepth: number | undefined) => void;
    /** `captureDelegatedPolicyOverrides(parent)` */
    readonly captureDelegatedPolicyOverrides: (parent: HostAgent) => unknown;
    /** `appendDelegatedPolicyOverrides(childSession, overrides)` */
    readonly appendDelegatedPolicyOverrides: (childSession: HostSession, overrides: unknown) => void;
    /** `applyChildComposition(childCtx, parent, { persona, toolFilter })` */
    readonly applyChildComposition: (childCtx: unknown, parent: HostAgent, composition: {
        readonly persona?: string;
        readonly toolFilter?: unknown;
    }) => void;
    /** `createUserMessage({ content, source })` */
    readonly createUserMessage: (input: {
        readonly content: readonly unknown[];
        readonly source: unknown;
    }) => unknown;
    /** `brandString(raw)` —— 把裸字符串铸成 brand 类型。 */
    readonly brandString?: (raw: string) => unknown;
    /** `foldConsumedWork(events)` —— 从事件里取本轮结束原因。 */
    readonly foldConsumedWork?: (events: readonly unknown[]) => {
        readonly end?: {
            readonly data?: {
                readonly reason?: unknown;
            };
        };
    };
    /** `finalAssistantOutput(events)` */
    readonly finalAssistantOutput?: (events: readonly unknown[]) => readonly unknown[] | undefined;
    /** `SessionLogOffset(n)` */
    readonly sessionLogOffset?: (n: number) => unknown;
    readonly assertOutputSchema?: (schema: unknown) => void;
    readonly validateOutput?: (schema: unknown, value: unknown) => readonly unknown[];
    readonly ToolArgsError?: new (violations: any) => Error;
}
/** 缺哪个 helper 就说哪个，别让人猜。 */
export declare function assertHostHelpers(helpers: Partial<HostHelpers>): asserts helpers is HostHelpers;
/** provider 注册名。`loom_run` 与文档都用这个字符串。 */
export declare const LOOM_PROVIDER_NAME = "loom-worktree";
export interface LoomProviderOptions {
    readonly resolveExecutionRepo?: (parent: HostAgent) => string | null;
    readonly paths: LoomPaths;
    readonly helpers: Partial<HostHelpers>;
    readonly log?: {
        info(msg: string): void;
        warn(msg: string): void;
        error(msg: string): void;
    };
}
/**
 * 派发前的归属解析：**唯一**决定子代理落在哪棵树的函数。
 *
 * 抽出来是为了它可测：不碰 git、不碰宿主，纯读 store + 纯裁决。
 * 返回 `DispatchRefusal` 时调用方必须抛 —— 绝不回落父 cwd。
 */
export declare function resolveTaskWorktree(store: WorktreeStore, label: string | undefined): WorktreeRecord | {
    readonly refuse: string;
};
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
export declare class LoomWorktreeProvider {
    readonly name = "loom-worktree";
    get capabilities(): {
        readonly agentOptions: true;
        readonly outputSchema: boolean;
        readonly depthLimit: true;
        readonly toolFilter: true;
        readonly persona: true;
    };
    readonly inheritsParentContext = false;
    private readonly store;
    private readonly helpers;
    private readonly log;
    private readonly resolveExecutionRepo?;
    constructor(options: LoomProviderOptions);
    /** 本次 run 用哪棵树 —— 供测试与 `loom_run` 共用。 */
    locate(label: string | undefined): WorktreeRecord | {
        readonly refuse: string;
    };
    start(request: HostStartRequest): Promise<HostRun>;
    /**
     * 把已发布的子代理包成单个 run 生命周期：信号交接、一轮对话、结果读取、
     * 静默销毁。形状与 `drivePublishedRun()` 一致 —— 顺序是契约的一部分。
     */
    private drive;
    /**
     * 从子会话事件里读结果。
     *
     * `foldConsumedWork` / `finalAssistantOutput` 是可选的 —— 宿主没给时
     * 退化成「空输出 + 粗粒度 stopReason」，而不是编一个假的 completed。
     */
    private readResult;
}
/** 把会话轮次结果映射到 subagent 缝的终态词汇（与官方 driver 同表）。 */
export declare function toStopReason(reason: unknown): string;
/** 派发前的自检：给定 label 与已登记记录，会落在哪 / 为什么拒绝。 */
export declare function describeDispatch(label: string | undefined, records: readonly WorktreeRecord[]): string;
/** 暴露给 `loom_worktree` 工具：把 runId/taskId 组成宿主 label。 */
export { sanitizeRefSegment };
