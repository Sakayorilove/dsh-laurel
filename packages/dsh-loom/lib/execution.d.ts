export interface TaskAttempt {
    nodeId: string;
    number: number;
    attemptId: string;
    phase: 'implementation' | 'verification' | 'review' | 'validated' | 'failed' | 'cancelled' | 'interrupted';
    active: boolean;
    cwd: string;
    snapshotHash?: string;
    review?: {
        verdict: 'pass' | 'fail';
        snapshotHash: string;
        findings: string[];
    };
    error?: string;
}
export interface AuditRecord {
    groupId: string;
    auditAgentId: string;
    label: string;
    taskIds: string[];
    snapshotHash: string;
    verdict: 'pass' | 'fail';
    findings: string[];
    at: string;
}
export interface ExecutionRecord {
    schemaVersion: 1;
    sequence: number;
    runId: string;
    workspaceId: string;
    workflowId: string;
    revision: number;
    planHash: string;
    approvedPlan?: {
        hash: string;
        flowHash: string;
        markdown: string;
        flow: unknown;
        baseSha: string;
        workflowId: string;
        revision: number;
    };
    baseSha: string;
    repoPath: string;
    ownerToken: string;
    startedAt: string;
    state: 'running' | 'validated' | 'failed' | 'cancelled' | 'interrupted';
    tasks: TaskAttempt[];
    recoveryOf?: string;
    reason?: string;
    /** 审计组结论（只有跑过审计的运行才有）。 */
    audits?: AuditRecord[];
}
/** Checksummed per-run snapshots; backup fallback is visibly interrupted. */
export declare class ExecutionJournal {
    readonly root: string;
    constructor(root: string);
    path(runId: string): string;
    private decode;
    read(runId: string): ExecutionRecord | null;
    list(): ExecutionRecord[];
    write(record: ExecutionRecord): void;
    assertAttempt(record: ExecutionRecord, attempt: TaskAttempt): void;
    recover(ownerToken: string): ExecutionRecord[];
    summary(workspaceId: string): ExecutionRecord[];
}
