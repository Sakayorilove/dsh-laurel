import type { TaskNode, WorkflowRevision } from './model.js';
import type { GraphChange } from './graphchange-types.js';
import type { ArchitectureRevision } from './architecture.js';
export declare const PROMPT_TEMPLATE_VERSION: "loom-prompt/2";
/** 提示词信封：进提示词包，但**不**参与内容 hash。 */
export interface PromptEnvelope {
    readonly requestId: string;
    readonly generatedAt: string;
    readonly templateVersion: string;
}
export interface PromptSource {
    readonly ref: string;
    readonly kind: 'file' | 'web' | 'note' | 'history';
    readonly content: string;
    readonly truncated?: boolean;
}
export interface ArchitecturePromptInput {
    readonly projectId: string;
    readonly proposalId: string;
    readonly baseRevision: number;
    readonly draftRevision: number;
    readonly inputDigest: string;
    readonly scope: 'all' | {
        readonly nodeIds: readonly string[];
    };
    readonly base?: ArchitectureRevision | undefined;
    readonly draft: ArchitectureRevision;
    readonly changes: readonly GraphChange[];
    readonly lockedConstraints: readonly string[];
    readonly sources: readonly PromptSource[];
}
export interface ArchitecturePromptPackage {
    readonly payloadHash: string;
    readonly text: string;
    readonly data: {
        readonly identity: Record<string, unknown>;
        readonly base: unknown;
        readonly draft: unknown;
        readonly userChanges: readonly GraphChange[];
        readonly lockedConstraints: readonly string[];
        readonly sources: readonly PromptSource[];
    };
}
export declare function snapshotArchitecture(a: ArchitectureRevision): unknown;
export declare function renderArchitecture(a: ArchitectureRevision): string;
/**
 * 生成架构优化请求的提示词包。
 *
 * 输出协议明确要求：返回 baseRevision、候选完整结构、解释和冲突/问题，**不开始实施**。
 */
export declare function compileArchitecturePrompt(input: ArchitecturePromptInput): ArchitecturePromptPackage;
/** 单个模块收到的有界任务包（02 §7.3）。 */
export interface TaskArtifactRef {
    readonly nodeId: string;
    readonly port: string;
    readonly type: string;
    readonly ref: string;
    readonly contentHash?: string;
    /**
     * 这条上游相对当前任务所在批次的时序（评审 09 B）。
     *
     * 任务包必须如实告诉子代理「这个输入此刻真的存在吗」：
     *   - `earlier`     → 更早批次已产出，可以信赖
     *   - `same-batch`  → 同批内有依赖，分层异常，产物未必就绪
     *   - `later`       → 更晚批次才产出，**此刻必然不可用**
     *   - `unknown`     → 无法判定（单独编译时），不要假定可用
     * 不写这个字段会让子代理把「更晚批次的产物」当成已有输入。
     */
    readonly origin?: 'earlier' | 'same-batch' | 'later' | 'unknown';
}
export interface TaskPackageInput {
    readonly workflow: Pick<WorkflowRevision, 'workflowId' | 'revision' | 'inputDigest'>;
    readonly node: TaskNode;
    readonly upstream: readonly TaskArtifactRef[];
    readonly contractHash?: string | undefined;
    /** 分配的绝对执行目录（worktree 或仓库根）。 */
    readonly cwd: string;
    readonly baseSha: string;
    readonly allowedChecks: readonly string[];
    /** Native structured delivery supplies its own schema instead of the generic receipt example. */
    readonly includeReceipt?: boolean;
}
export declare function buildTaskPackage(input: TaskPackageInput): string;
/** 图 → 协调总提示词。不是给所有会话发同一份完整任务。 */
export declare function compileCoordinatorPrompt(workflow: WorkflowRevision, batches: readonly (readonly string[])[]): string;
