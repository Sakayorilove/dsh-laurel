import { type Isolation, type TaskNode, type WorkflowRevision } from './model.js';
import type { LoomCapabilities } from './capabilities.js';
import { type LoomIssue } from './validate.js';
import { type TaskArtifactRef } from './prompt.js';
export declare class CompileError extends Error {
    readonly issues: readonly LoomIssue[];
    constructor(message: string, issues?: readonly LoomIssue[]);
}
export interface CompileOptions {
    /** 每个 agent 调用的 provider 覆盖。缺省用引擎默认。 */
    readonly provider?: string;
    readonly model?: string;
    /** 是否请求结构化输出。 */
    readonly structuredOutput?: boolean;
    /** 本次运行的总子代理上限；宿主硬上限是 1000。 */
    readonly maxTotalAgents?: number;
    /** nodeId → 绝对执行目录。必须由调用方解析（工作树 / 仓库根）。 */
    readonly resolveCwd: (node: TaskNode) => string;
    readonly baseSha: string;
    readonly contractHash?: string;
    /** 允许执行的验收命令白名单；缺省取节点 acceptance.commands 的 argv。 */
    readonly allowedChecks?: readonly string[];
}
export interface BatchExpectation {
    readonly nodeId: string;
    readonly produces: readonly {
        readonly port: string;
        readonly artifactType: string;
    }[];
    /** 下游节点 id：产物必须由它们独立核验。 */
    readonly verifiedBy: readonly string[];
    /** 该节点声明的验收命令（写进任务包，由 Loom 在消费端执行）。 */
    readonly commands: readonly (readonly string[])[];
}
export interface CompiledBatch {
    readonly index: number;
    readonly nodeIds: readonly string[];
    /** 交给 workflow 引擎的脚本体。 */
    readonly script: string;
    readonly scriptHash: string;
    /** 该批次的 agent() 调用数。 */
    readonly agentCalls: number;
    readonly expectations: readonly BatchExpectation[];
    /**
     * 本批次每个节点（含非 agent）的依赖清单（评审 09 B）。
     * 与脚本里的 `__loom_deps` 同源，方便消费端与测试直接取用，不必解析脚本。
     */
    readonly dependencies: readonly BatchDependencies[];
}
/** 一个节点在编译产物里的完整依赖与验收信息。 */
export interface BatchDependencies {
    readonly nodeId: string;
    readonly kind: string;
    readonly phase: string;
    readonly declaredIsolation: string;
    readonly expects: readonly {
        name: string;
        artifactType: string;
        required: boolean;
    }[];
    readonly produces: readonly {
        name: string;
        artifactType: string;
    }[];
    readonly upstream: readonly TaskArtifactRef[];
    readonly doneWhen: readonly string[];
    readonly commands: readonly {
        argv: readonly string[];
        cwdRef: string;
        expectedExitCode: number;
    }[];
}
export interface CompiledPlan {
    readonly workflowId: string;
    readonly revision: number;
    readonly compilerVersion: string;
    /** 整份计划的语义 hash。布局变化不影响它。 */
    readonly planHash: string;
    readonly batches: readonly CompiledBatch[];
    readonly warnings: readonly LoomIssue[];
    readonly capabilityNotes: readonly string[];
    /** 每个批次的并发上限（min(计划 maxConcurrency, 批内 agent 数)）。 */
    readonly concurrency: readonly number[];
}
/** 把任意字符串安全嵌进 JS 源码的 JSON 字面量（转义 U+2028/U+2029）。 */
export declare function embedJson(value: unknown): string;
/**
 * 宿主 workflow-ptc 的 `ChildStartRequest` **真正接受**的键。
 * 出处：`dsh-workflow-ptc/lib/types/types.d.ts`。
 * 这里多写一个键，宿主不会报错 —— 它会静默忽略，而我们会误以为隔离生效了。
 */
export declare const ACCEPTED_AGENT_OPTIONS: readonly string[];
/**
 * 派发前的能力闸门。
 * 计划里声明 `isolation: worktree` 但运行时没有工作树能力时**必须拒绝**，
 * 绝不能悄悄退化成「共享 cwd 多代理写代码」。
 *
 * ⚠ 用 `isUsable()` 而不是 `available`（评审 09 E）：
 * `available` 只表示「探测到了」，`isUsable` 要求
 * `implementedByLoom && availableInEnv === true`。
 * 用前者会让「宿主有入口但 Loom 没接线」通过闸门 —— 那正是原实现的漏洞。
 */
export declare function assertIsolationSupported(caps: LoomCapabilities, isolation: Isolation): void;
/** 校验计划里声明的能力是否都被运行时满足。 */
export declare function missingCapabilities(caps: LoomCapabilities, workflow: WorkflowRevision): string[];
export declare function compileWorkflow(workflow: WorkflowRevision, caps: LoomCapabilities, options: CompileOptions): CompiledPlan;
interface RenderBatchArgs {
    readonly workflow: WorkflowRevision;
    readonly nodes: readonly TaskNode[];
    readonly index: number;
    readonly options: CompileOptions;
    /**
     * 节点 id → 所属批次号。用于标注上游来源的可信度。
     *
     * 由 `compileWorkflow` 传入（它才知道完整分层）。单独调用
     * `renderBatchScript` 时省略 —— 那时无法判断批次，标 `unknown` 而不是猜。
     */
    readonly batchOf?: ReadonlyMap<string, number>;
}
/**
 * 生成一个批次的 PTC 脚本。
 *
 * 脚本只做两件事：把每个 agent 节点的任务包发给 `agent()`，把结果原样返回。
 * 它**不**做验收、不做合并 —— 那些在消费端（Loom 宿主半边）做。
 */
export declare function renderBatchScript(args: RenderBatchArgs): string;
/**
 * 渲染一个批次：脚本 + 依赖清单。
 *
 * 拆成两个导出是因为 `renderBatchScript` 是既有公开 API（返回字符串）；
 * 内部与 `compileWorkflow` 需要额外拿到 `dependencies`，共用同一次渲染，
 * 避免「脚本里有一份依赖、返回值里另算一份」导致两者不一致。
 */
export declare function renderBatch(args: RenderBatchArgs): {
    readonly script: string;
    readonly dependencies: readonly BatchDependencies[];
};
export {};
