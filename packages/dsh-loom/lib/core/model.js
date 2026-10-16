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
export const TASK_SCHEMA_VERSION = '0.1';
export const LOOM_COMPILER_VERSION = 'loom-compiler/0.1.0';
/** id 形状（schema 的 $defs/id）。 */
export const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const STAGES = [
    'discovery',
    'planning',
    'architecture',
    'implementation',
    'integration',
    'verification',
];
export const NODE_KINDS = ['inspect', 'contract', 'agent', 'verify', 'gate', 'integrate', 'report'];
/** 只有 agent 节点会派子代理；其余是程序节点。 */
export const AGENT_KINDS = ['agent'];
export const ARTIFACT_TYPES = [
    'repo-report',
    'interface-contract',
    'code-change',
    'test-evidence',
    'project-commit',
    'delivery-report',
];
export const ISOLATIONS = ['read-only', 'prepared-baseline', 'worktree', 'integration-worktree'];
export const EXECUTION_BACKENDS = ['deterministic', 'configured-agent'];
export const CWD_REFS = ['node-worktree', 'prepared-baseline', 'integration-worktree'];
export const REQUIRED_CAPABILITIES = [
    'real-parent-agent',
    'parallel-agents',
    'worktree',
    'cancel-cleanup',
    'artifact-verification',
    'wsl-execution',
    'integration',
];
