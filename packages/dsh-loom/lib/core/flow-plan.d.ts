/**
 * 流程计划（Flow Plan）：流程视图上的**可编辑计划**。
 *
 * 它是计划、不是语义：用户拖动步骤、勾选任务、设置子代理数量、两两分组、
 * 指定审计代理 —— 这些都存在这里；只有点「应用为新依赖」时才把顺序
 * 换算成真实的任务依赖边（并仍要经过校验、写成草案、由用户采纳）。
 */
import { type TeamPlan } from './team.js';
import { type TaskEdge, type WorkflowRevision } from './model.js';
export interface FlowStepPlan {
    readonly id: string;
    readonly taskIds: string[];
    /** 该步子代理数量（1..maxAgents；真正的并发还会被宿主上限封顶）。 */
    readonly agents: number;
}
export interface FlowAuditAgentPlan {
    readonly id: string;
    readonly label: string;
    readonly groupId: string | null;
}
export interface FlowGroupPlan {
    readonly id: string;
    readonly stepIds: string[];
    readonly auditAgentId: string | null;
}
export interface FlowPlan {
    readonly organization?: TeamPlan;
    readonly workflowId: string;
    readonly revision: number;
    readonly steps: FlowStepPlan[];
    readonly order: string[];
    readonly groups: FlowGroupPlan[];
    readonly auditAgents: FlowAuditAgentPlan[];
    readonly updatedAt: string;
}
export interface FlowPlanIssue {
    readonly path: string;
    readonly message: string;
}
export interface FlowPlanCheck {
    readonly ok: boolean;
    readonly plan: FlowPlan | null;
    readonly errors: FlowPlanIssue[];
    readonly warnings: FlowPlanIssue[];
}
export interface FlowApplyResult {
    readonly ok: boolean;
    readonly addedEdges: TaskEdge[];
    readonly errors: FlowPlanIssue[];
}
/**
 * 流程视图里「每步子代理数量」的上限。
 *
 * 2026-10-06 实测（`scripts/probe-subagent-limit.mjs`，真实官方宿主 + 离线 adapter，
 * 4 个独立任务、声明并发 3）：**峰值同时开着 3 个子代理、全部验收通过**，证据见
 * `.verification/subagent-limit-probe.json`。同时任务图 schema 也把
 * `executionProposal.maxConcurrency` 限在 1..3（validate.ts 的 MAX_CONCURRENCY_RANGE），
 * 配置项 `defaultMaxConcurrency` 同样 1..3。
 *
 * 所以这里取 3 而不是 4：下拉给到 4 只是让用户选一个**永远不会被调度**的数字。
 * 并发 >3 无法通过 Loom 的运行路径到达（schema 先卡住），因此不宣称宿主绝对上限。
 */
export declare const FLOW_MAX_AGENTS = 3;
export declare const FLOW_MAX_AUDIT_AGENTS = 3;
/** 默认流程计划：按依赖分层，一层一步；每步 2 个子代理；两个审计代理待分组。 */
export declare function defaultFlowPlan(workflow: WorkflowRevision, now?: string): FlowPlan;
/** 校验用户提交的流程计划。错误（errors）不可落盘；告警（warnings）可落盘但会提示。 */
export declare function validateFlowPlan(input: unknown, workflow: WorkflowRevision, options?: {
    maxAgents?: number;
}): FlowPlanCheck;
/** 摘要：给审计/回执用的稳定指纹（不含 updatedAt）。 */
export declare function flowPlanDigest(plan: FlowPlan): string;
/**
 * 把「流程顺序」换算成**任务依赖边**（应用为新依赖）。
 *
 * 规则（都写进错误信息，用户能照着修）：
 * 1. 视觉顺序必须是当前依赖图的合法拓扑序 —— 步骤 i 的任务依赖了更靠后的步骤时直接拒绝，
 *    并指出是哪条边；
 * 2. 相邻两步之间：后一步每个「输入尚未被满足」的任务，尝试从前一步里找一个
 *    产物类型匹配的输出，补一条边；
 * 3. 找不到匹配产物类型时拒绝，指出任务、输入名与类型（提示手工连线或调整分块）。
 */
export declare function applyFlowOrder(workflow: WorkflowRevision, plan: FlowPlan): FlowApplyResult;
/** 运行用调度表：由流程计划编译而来，只含可执行信息。 */
export interface FlowScheduleStep {
    readonly id: string;
    readonly taskIds: string[];
    readonly agents: number;
}
export interface FlowScheduleGroup {
    readonly supervisorId?: string;
    readonly supervisorLabel?: string;
    readonly supervisorResponsibility?: string;
    readonly id: string;
    readonly stepIds: string[];
    readonly taskIds: string[];
    readonly auditAgentId: string;
    readonly label: string;
}
export interface FlowSchedule {
    readonly organization?: TeamPlan;
    readonly workflowId: string;
    readonly revision: number;
    readonly steps: FlowScheduleStep[];
    readonly groups: FlowScheduleGroup[];
    readonly concurrency: number;
    readonly clamped: boolean;
}
/**
 * 把流程计划编译成运行调度表：
 * - 计划必须整体合法（validateFlowPlan），且**覆盖全部任务**（漏掉的任务不会被调度）；
 * - 每步子代理数量按宿主上限封顶（clamped 标记供回执展示）；
 * - 只有绑定了主审的审计组才进入调度；未绑定主审的组给出告警并被跳过。
 */
export declare function compileFlowSchedule(workflow: WorkflowRevision, plan: unknown, hostCap: number): {
    ok: boolean;
    schedule: FlowSchedule | null;
    errors: FlowPlanIssue[];
    warnings: FlowPlanIssue[];
};
