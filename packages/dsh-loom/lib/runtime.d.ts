import { ExecutionJournal, type AuditRecord, type ExecutionRecord } from './execution.js';
import { type CommandReceipt } from './bridge.js';
import { type TaskNode, type WorkflowRevision } from './core/index.js';
import { type IWorktreeManager } from './worktree.js';
import type { FlowSchedule } from './core/flow-plan.js';
import type { LoomStore } from './store.js';
export interface VerifiedArtifact {
    readonly nodeId: string;
    readonly port: string;
    readonly ref: string;
    readonly contentHash: string;
    readonly attemptId?: string;
}
export interface DispatchContext {
    readonly node: TaskNode | null;
    readonly cwd: string;
    readonly runId: string;
    readonly baseSha: string;
    readonly prompt: string;
    readonly signal: AbortSignal;
    readonly attemptId: string;
    readonly phase: 'implementation' | 'review' | 'audit' | 'supervision' | 'coordination';
    readonly snapshotHash?: string;
    readonly targetTaskId?: string;
    readonly memberId?: string;
}
export type TaskDispatcher = (context: DispatchContext) => Promise<{
    readonly verdict: string;
    readonly artifactRefs: readonly VerifiedArtifact[];
    readonly attemptId?: string;
    readonly snapshotHash?: string;
    readonly findings?: readonly string[];
    readonly messages?: readonly {
        to: string;
        body: string;
    }[];
}>;
/** One limiter is shared by every session/run in the plugin process. */
export declare class TaskBudget {
    limit: number;
    private active;
    private readonly waiting;
    constructor(limit: number);
    setLimit(limit: number): void;
    acquire(signal: AbortSignal): Promise<() => void>;
}
/** A fresh approval may repair acceptance wording, never reuse drafts under changed ownership or execution permissions. */
export declare function compatibleRecoveryWorkflow(previous: WorkflowRevision, current: WorkflowRevision): boolean;
export declare class IsolatedTaskRuntime {
    private readonly store;
    private readonly trees;
    readonly journal: ExecutionJournal;
    private readonly coordinator;
    readonly budget: TaskBudget;
    private readonly activeOwnership;
    private readonly activeRuns;
    constructor(store: LoomStore, trees: IWorktreeManager, concurrency?: number);
    run(workflow: WorkflowRevision, repoPath: string, ws: string, baseSha: string, dispatch: TaskDispatcher, options?: {
        sessionId?: string;
        signal?: AbortSignal;
        runId?: string;
        maxConcurrency?: number;
        maxRepairRounds?: number;
        recoveryOf?: string;
        approvedPlan?: ExecutionRecord['approvedPlan'];
        schedule?: FlowSchedule;
    }): Promise<{
        stepConcurrency?: {
            id: string;
            agents: number;
            peak: number;
        }[] | undefined;
        runId: string;
        state: "validated";
        completed: string[];
        artifacts: VerifiedArtifact[];
        checks: CommandReceipt[];
        audits: AuditRecord[];
        communications: {
            id: string;
            runId: string;
            groupId: string;
            attemptId: string;
            snapshotHash: string;
            from: string;
            to: string;
            body: string;
            round: number;
        }[];
        supervisionReports: {
            groupId: string;
            memberId: string;
            findings: readonly string[];
            snapshotHash: string;
        }[];
        worktrees: import("./core/worktree-plan.js").WorktreeRecord[];
        integrated: boolean;
        error?: undefined;
    } | {
        runId: string;
        state: "failed" | "cancelled";
        completed: string[];
        artifacts: VerifiedArtifact[];
        checks: CommandReceipt[];
        audits: AuditRecord[];
        error: string;
        communications: any;
        supervisionReports: any;
        worktrees: import("./core/worktree-plan.js").WorktreeRecord[];
        integrated: boolean;
    }>;
    private recoverWithLease;
    recoverInactiveRuns(): Promise<number>;
    cancel(runId: string): Promise<boolean>;
    setConcurrency(limit: number): void;
    cancelAll(): Promise<void>;
}
export declare function createHostDispatcher(subagents: any, parent: any): TaskDispatcher;
