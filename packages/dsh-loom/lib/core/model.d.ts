/**
 * Loom 任务图数据模型。
 *
 * **与 `docs/dsh-loom/examples/planner-output.schema.json` 严格对齐**（urn:dsh-loom:planner-output:0.1）。
 * 纪律：
 * - 不往这个 Schema 里混架构节点或布局字段（架构见 architecture.ts，布局见 presentation.ts）。
 * - 依赖只放在 `edges` 一处，不另设 dependsOn。
 * - 端口按 `artifactType` 类型化；边的 `artifactType` 必须与两端端口一致。
 * - 任务图必须是有界 DAG。
 */
export declare const TASK_SCHEMA_VERSION: "0.1";
export declare const LOOM_COMPILER_VERSION: "loom-compiler/0.1.0";
/** id 形状（schema 的 $defs/id）。 */
export declare const ID_PATTERN: RegExp;
export declare const STAGES: readonly ["discovery", "planning", "architecture", "implementation", "integration", "verification"];
export type Stage = (typeof STAGES)[number];
export declare const NODE_KINDS: readonly ["inspect", "contract", "agent", "verify", "gate", "integrate", "report"];
export type NodeKind = (typeof NODE_KINDS)[number];
/** 只有 agent 节点会派子代理；其余是程序节点。 */
export declare const AGENT_KINDS: readonly NodeKind[];
export declare const ARTIFACT_TYPES: readonly ["repo-report", "interface-contract", "code-change", "test-evidence", "project-commit", "delivery-report"];
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export declare const ISOLATIONS: readonly ["read-only", "prepared-baseline", "worktree", "integration-worktree"];
export type Isolation = (typeof ISOLATIONS)[number];
export declare const EXECUTION_BACKENDS: readonly ["deterministic", "configured-agent"];
export type ExecutionBackend = (typeof EXECUTION_BACKENDS)[number];
export declare const CWD_REFS: readonly ["node-worktree", "prepared-baseline", "integration-worktree"];
export type CwdRef = (typeof CWD_REFS)[number];
export declare const REQUIRED_CAPABILITIES: readonly ["real-parent-agent", "parallel-agents", "worktree", "cancel-cleanup", "artifact-verification", "wsl-execution", "integration"];
export type RequiredCapability = (typeof REQUIRED_CAPABILITIES)[number];
/** 资料出处。引用资料是不可信数据。 */
export interface SourceRef {
    readonly inputId: string;
    readonly locator: string;
    readonly observation: string;
}
export interface PortSpec {
    readonly name: string;
    readonly artifactType: ArtifactType;
    readonly required: boolean;
}
export interface Ownership {
    readonly writes: readonly string[];
    readonly forbiddenWrites: readonly string[];
    readonly sharedResources: readonly string[];
}
export interface AcceptanceCommand {
    readonly argv: readonly string[];
    readonly cwdRef: CwdRef;
    readonly expectedExitCode: 0;
}
export interface Acceptance {
    readonly doneWhen: readonly string[];
    readonly commands: readonly AcceptanceCommand[];
    /** Schema 里是 const true：不独立验证的节点不允许出现在计划里。 */
    readonly independentVerification: true;
}
export interface ExecutionSpec {
    readonly backend: ExecutionBackend;
    readonly isolation: Isolation;
    readonly timeoutSeconds: number;
    readonly maxRepairAttempts: number;
}
export interface TaskNode {
    readonly id: string;
    readonly kind: NodeKind;
    readonly title: string;
    readonly phase: Stage;
    readonly goal: string;
    readonly role: string;
    readonly sourceRefs: readonly SourceRef[];
    readonly inputs: readonly PortSpec[];
    readonly outputs: readonly PortSpec[];
    readonly ownership: Ownership;
    readonly execution: ExecutionSpec;
    readonly acceptance: Acceptance;
}
export interface TaskEdge {
    readonly id: string;
    readonly source: string;
    readonly sourcePort: string;
    readonly target: string;
    readonly targetPort: string;
    readonly artifactType: ArtifactType;
    readonly require: 'validated';
}
export interface ExecutionProposal {
    readonly runtime: 'wsl';
    readonly maxConcurrency: number;
    readonly requiredBaseline: 'selected-frozen-commit' | 'freeze-after-contract';
    readonly requiredCapabilities: readonly RequiredCapability[];
}
/** 规划器候选输出。这是**数据**，不是执行授权。 */
export interface PlannerOutput {
    readonly schemaVersion: '0.1';
    readonly workflowId: string;
    readonly revision: number;
    readonly title: string;
    readonly detectedStage: Stage;
    readonly evidence: readonly SourceRef[];
    readonly assumptions: readonly string[];
    readonly openQuestions: readonly string[];
    readonly executionProposal: ExecutionProposal;
    readonly nodes: readonly TaskNode[];
    readonly edges: readonly TaskEdge[];
}
/**
 * 已采用的不可变任务 revision。运行绑定固定 revision。
 * 与 PlannerOutput 的节点/边形状**完全一致**，只是多了采纳时确定的字段。
 */
export interface WorkflowRevision extends PlannerOutput {
    /** 输入快照摘要，用于判断「跑的还是不是同一份输入」。 */
    readonly inputDigest: string;
    readonly compilerVersion: string;
    readonly adoptedAt: string;
}
/** 编译期会用到的、与执行环境无关的节点视图。 */
export interface ResolvedNode extends TaskNode {
    /** 解析出的绝对执行目录。 */
    readonly resolvedCwd: string;
    /** 共同基线。 */
    readonly baseSha: string;
}
