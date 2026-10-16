import { join } from 'node:path';
import type { PlanningRequest } from './core/initial-planner.js';
import type { RefinementRequest } from './refinement.js';
import type { ArchitectureRevision } from './core/index.js';
import type { WorkflowRevision } from './core/index.js';
import type { FlowPlan } from './core/flow-plan.js';
import type { Presentation } from './core/index.js';
import { type GraphChange } from './core/index.js';
import type { SourceMap } from './core/index.js';
import { type RevisionGuard } from './core/scope.js';
import { type LoomConfig, type LoomPaths, type LoomWorkspacePaths } from './config.js';
/** 原子写：先写 .tmp 再 rename。关键路径失败会抛。 */
export declare function atomicWrite(file: string, content: string): void;
export interface LoomEvent {
    readonly at: string;
    readonly kind: string;
    readonly detail?: string;
    /** 事件归属的工作区。分区写入的事件都应带上，便于按项目回溯。 */
    readonly workspaceId?: string;
    readonly workflowId?: string;
    readonly revision?: number;
    readonly nodeId?: string;
    readonly runId?: string;
}
/** Terminal receipt retained so users can locate and inspect delivered code. */
export interface RunReceipt {
    readonly completed: readonly string[];
    readonly artifacts: readonly {
        readonly nodeId: string;
        readonly port: string;
        readonly ref: string;
        readonly contentHash: string;
    }[];
    readonly checks: readonly {
        readonly argv: readonly string[];
        readonly cwd: string;
        readonly platform: string;
        readonly pid: number | null;
        readonly exitCode: number | null;
        readonly state: string;
        readonly stdoutHash: string;
        readonly stderrHash: string;
        readonly startedAt: string;
        readonly endedAt: string;
    }[];
    readonly worktrees: readonly {
        readonly taskId: string;
        readonly runId: string;
        readonly path: string;
        readonly repoPath: string;
        readonly baseSha: string;
        readonly branch: string;
        readonly state: string;
    }[];
    readonly execution?: import('./execution.js').ExecutionRecord;
    /** 审计组结论（0.6.1）：由 loom_run 的审计相位写入。 */
    readonly audits?: import('./execution.js').AuditRecord[];
    readonly integrated: false;
    readonly error?: string;
}
export interface RunRecord {
    readonly workspaceId?: string;
    readonly sessionId?: string;
    readonly runId: string;
    readonly workflowId: string;
    readonly revision: number;
    readonly planHash: string;
    readonly attempt: number;
    readonly state: 'queued' | 'running' | 'produced' | 'validating' | 'validated' | 'failed' | 'cancelled' | 'interrupted' | 'refused';
    readonly startedAt: string;
    readonly endedAt?: string;
    readonly reason?: string;
    readonly recoveryOf?: string;
    readonly executionRef?: string;
    readonly receipt?: RunReceipt;
}
export interface DraftState {
    readonly candidate?: WorkflowRevision;
    readonly mode: 'auto' | 'manual';
    readonly workflowId: string;
    readonly draftRevision: number;
    /** 用户锁定的约束。**只对所属工作区生效**（评审 09 F）。 */
    readonly lockedConstraints: readonly string[];
    readonly updatedAt: string;
    /**
     * 方案当前采用的架构 id 与 revision。
     * 评审 09 D 指出：改图回传必须读真实基线，不能硬造 `draft.revision - 1`。
     */
    readonly architectureId?: string;
    readonly architectureRevision?: number;
    /**
     * 归属的工作区。**必填** —— 缺了就无法安全读写。
     * 旧记录没有这个字段，读取时会被判为「旧版全局草案」，需要迁移。
     */
    readonly workspaceId?: string;
}
/** 草案写入的结果：要么成功带回新 revision，要么是可定位的冲突。 */
export type DraftWriteResult = {
    readonly ok: true;
    readonly draft: DraftState;
} | {
    readonly ok: false;
    readonly conflict: {
        readonly currentRevision: number | null;
        readonly expectedRevision: number | null;
        readonly detail: string;
    };
};
/**
 * 只读 + 追加的文件存储。
 * 每个写方法失败都会抛 —— 调用方决定要不要把它降级成可见错误。
 *
 * Graphs and mutable state are partitioned by workspace. Unowned legacy files
 * stay available to explicit migration tooling, never normal project reads.
 */
export declare class LoomStore {
    readonly paths: LoomPaths;
    private readonly eventLogEnabled;
    constructor(home: string | undefined, options?: {
        eventLog?: boolean;
    });
    /** 取某个工作区的分区路径。id 不合法会抛（不回落全局）。 */
    workspacePaths(workspaceId: string): LoomWorkspacePaths;
    /** Explicit local project preparation; scoped to one conversation, never all sessions. */
    readExecutionTarget(sessionId: string, workspaceId: string): string | null;
    writeExecutionTarget(sessionId: string, workspaceId: string, repo: string): void;
    /** 列出已经分区的所有工作区 id（扫描 `workspaces/` 目录）。 */
    listWorkspaces(): string[];
    listRevisions(workspaceId?: string): WorkflowRevision[];
    latestRevision(workflowId: string, workspaceId?: string): WorkflowRevision | null;
    revisionAt(workflowId: string, revision: number, workspaceId?: string): WorkflowRevision | null;
    /** 追加一条不可变 revision。已存在同 (workflowId, revision) 时抛。 */
    appendRevision(workflow: WorkflowRevision, workspaceId?: string): void;
    private architectureEntries;
    listArchitectures(workspaceId?: string): ArchitectureRevision[];
    latestArchitecture(architectureId: string, workspaceId?: string): ArchitectureRevision | null;
    architectureAt(architectureId: string, revision: number, workspaceId?: string): ArchitectureRevision | null;
    architectureContext(architectureId: string, workspaceId?: string): ArchitectureEntry | null;
    appendArchitecture(architecture: ArchitectureRevision, workspaceId?: string, adopted?: boolean): void;
    /** Only the human CommandRuntime entry calls this capability. One rename
     * commits the new immutable architecture, its baseline, draft and audit fact.
     * Task revisions and SourceMap stay unchanged so their old mapping is stale. */
    unlockArchitectureNode(workspaceId: string, architectureId: string, nodeId: string, expectedRevision: number, evidence: {
        sessionId: string;
        commandId: string;
        cwd: string;
        command: string;
    }): ArchitectureRevision;
    /** 读某个工作区的草案。工作区不存在或 id 非法时返回 null（不抛）。 */
    readDraft(workspaceId: string): DraftState | null;
    /**
     * 写草案。**带乐观并发闸门**（评审 09 步骤 1 第 4 条）。
     *
     * `guard.expectedRevision === null` 表示「我认为现在还没有草案」。
     * 若磁盘上已有，返回冲突而不是覆盖 —— 那正是「旧窗口更新静默覆盖新稿」。
     *
     * 返回 `DraftWriteResult` 而不是抛：冲突是**预期内**的正常结果，
     * 调用方要把它转成可定位的 UI 提示，不是当成异常上报。
     * 只有 IO 失败（磁盘满、权限）才抛。
     */
    writeDraft(draft: DraftState, guard: RevisionGuard): DraftWriteResult;
    readPresentation(workspaceId: string): Presentation | null;
    writePresentation(workspaceId: string, p: Presentation): void;
    /** 流程计划：按工作区分区、按 workflowId 存放（读不到就是 null）。 */
    readFlowPlan(workspaceId: string, workflowId: string): FlowPlan | null;
    writeFlowPlan(workspaceId: string, workflowId: string, plan: FlowPlan): FlowPlan;
    readSourceMap(workspaceId: string): SourceMap | null;
    writeSourceMap(workspaceId: string, map: SourceMap): void;
    /** 旧版全局草案。**只用于迁移预览**，新代码不该调用。 */
    readLegacyDraft(): DraftState | null;
    /** 旧版全局文件是否还在。 */
    legacyFilesPresent(): {
        drafts: boolean;
        presentation: boolean;
        sourcemap: boolean;
    };
    saveRefinementRequest(ws: string, request: RefinementRequest): void;
    readRefinementRequest(ws: string, hash: string): RefinementRequest | null;
    readConfig(base?: LoomConfig): LoomConfig;
    writeConfig(patch: unknown, base?: LoomConfig): LoomConfig;
    /** 每会话「规划模式」（只规划不做执行动作）。与总开关/会话开关分开存。 */
    readSessionPlanningMode(sessionId: string): boolean;
    /** 会话自己有没有记过规划模式（null = 没记过，该用全局默认）。 */
    readSessionPlanningModeExplicit(sessionId: string): boolean | null;
    writeSessionPlanningMode(sessionId: string, enabled: boolean): boolean;
    readSessionActivation(sessionId: string): boolean;
    writeSessionActivation(sessionId: string, enabled: boolean): {
        sessionId: string;
        enabled: boolean;
    };
    private checkSessionId;
    savePlanningRequest(ws: string, request: PlanningRequest): void;
    readPlanningRequest(ws: string, hash: string): PlanningRequest | null;
    /** 最近一次导出的规划请求。窗口重开后客户端内存里的导出记录会丢，
     * 但项目里的 `.loom/plan.json` 还在：用它记的 requestId 认领那份文件，
     * 才能判断「这个文件是不是为本次请求写的」，而不是见到文件就当候选。 */
    latestPlanningRequest(ws: string): PlanningRequest | null;
    /** One atomic rename commits the architecture, DAG, mapping and draft together.
     * Legacy per-file records are preserved and included in the initial snapshot.
     * Subsequent edits keep this snapshot authoritative, avoiding half-adopted plans. */
    adoptPlanningBundle(ws: string, bundle: {
        architecture: ArchitectureRevision;
        workflow: WorkflowRevision;
        sourceMap: SourceMap;
    }, expected: {
        architecture: number | null;
        workflow: number | null;
        draft: number | null;
    }, mode: 'auto' | 'manual'): DraftState;
    private readPlanningState;
    private updatePlanningState;
    listRuns(limit?: number, workspaceId?: string): RunRecord[];
    appendRun(record: RunRecord): void;
    /** Status is the last fact for a run, not any historical running record. */
    latestRuns(limit?: number, workspaceId?: string): RunRecord[];
    /** 事件是排错用的，写失败不抛。 */
    event(e: Omit<LoomEvent, 'at'>): void;
    readEvents(limit?: number, workspaceId?: string): LoomEvent[];
    /** 给设置页用的摘要。 */
    stats(workspaceId?: string): {
        revisions: number;
        architectures: number;
        runs: number;
        events: number;
    };
}
export { join };
export interface ArchitectureEntry {
    readonly document: ArchitectureRevision;
    readonly baseRevision: number;
    readonly changes: readonly GraphChange[];
}
/** Derive changes from stored snapshots; request-supplied change lists are not authoritative. */
export declare function architectureDiff(base: ArchitectureRevision, draft: ArchitectureRevision): GraphChange[];
