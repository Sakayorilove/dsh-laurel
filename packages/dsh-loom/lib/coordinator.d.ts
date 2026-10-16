export interface ExecutionLease {
    readonly token: string;
    readonly lost: Promise<void>;
    release(): Promise<void>;
}
/** Never remove the lock file: every process must lock the same inode. */
export declare function acquireExecutionLease(root: string): Promise<ExecutionLease>;
/** Concurrent runs in this runtime share one native lock and one task budget. */
export declare class ExecutionCoordinator {
    private readonly root;
    private users;
    private pending;
    private closing;
    constructor(root: string);
    acquire(): Promise<ExecutionLease>;
}
