import { type LoomStore } from './store.js';
import { type WorkflowRevision } from './core/index.js';
import type { LoomConfig } from './config.js';
import { type ResolutionBaseline } from './preflight.js';
export declare function agentSessionId(agent: any): string | null;
export declare const PLANNING_READ_TOOLS: Set<string>;
interface SessionPlan {
    resolution?: ResolutionBaseline;
    resolutionRejected?: {
        resolutionId: string;
        document: any;
        error: string;
        at: string;
    };
    request?: {
        id: string;
        messageId: string;
        workspaceId: string;
        prompt: string;
    };
    candidate?: {
        turn?: number;
        callId?: string;
        id: string;
        workspaceId: string;
        document: any;
        preview: any;
        markdown: string;
        at: string;
    };
    history: {
        turn?: number;
        callId?: string;
        id: string;
        workspaceId: string;
        document: any;
        markdown: string;
        at: string;
    }[];
    rejected?: {
        requestId: string;
        document: any;
        error: string;
        at: string;
    };
    waitingApproval?: boolean;
    approval?: {
        id: string;
        hash: string;
        baseSha: string;
        workflowId: string;
        revision: number;
        workspaceId: string;
        commandId: string;
        consumed: boolean;
        at: string;
        snapshot?: unknown;
    };
}
export declare function readablePlan(workflow: WorkflowRevision, flow?: any): string;
export declare class PlanningController {
    readonly store: LoomStore;
    readonly config: () => LoomConfig;
    readonly service: (name: string) => any;
    guardReady: boolean;
    constructor(store: LoomStore, config: () => LoomConfig, service: (name: string) => any);
    private file;
    read(id: string): SessionPlan;
    private update;
    private native;
    selected(id: string, agent?: any): boolean;
    held(id: string, agent?: any): boolean;
    status(id: string): {
        sessionId: string;
        planningMode: boolean;
        waitingApproval: boolean;
        guardReady: boolean;
        nativeAvailable: boolean;
        nativeState: any;
        pending: boolean;
        source: string;
    };
    select(id: string, active: boolean): {
        sessionId: string;
        planningMode: boolean;
        waitingApproval: boolean;
        guardReady: boolean;
        nativeAvailable: boolean;
        nativeState: any;
        pending: boolean;
        source: string;
    };
    guard(exec: any): string | undefined;
    beforeStep(agent: any, messages: any[], step: number): string | null;
    private checkResolution;
    prepareResolution(id: string, ws: string, input: any, facts: unknown): {
        kind: string;
        payloadHash: string;
        text: string;
    };
    resolveQuestions(agent: any, input: unknown, callId?: string): {
        candidateId: string;
        markdown: string;
        waitingApproval: boolean;
    };
    submit(agent: any, document: unknown, callId?: string, fromResolution?: boolean): {
        candidateId: string;
        markdown: string;
        waitingApproval: boolean;
    };
    adopt(id: string, ws: string, candidateId: string): {
        draft: import("./store.js").DraftState;
        workflow: WorkflowRevision;
    };
    snapshot(id: string, ws: string, workflow: WorkflowRevision, baseSha: string): {
        hash: string;
        flowHash: string;
        workflowId: string;
        revision: number;
        executionTarget: string | null;
        flow: import("./core/flow-plan.js").FlowPlan;
        markdown: string;
        baseSha: string;
    };
    approve(id: string, ws: string, workflow: WorkflowRevision, baseSha: string, hash: string, commandId: string): void;
    cancel(id: string, commandId: string): void;
    consume(agent: any, ws: string, workflow: WorkflowRevision, baseSha: string): {
        hash: string;
        flowHash: string;
        workflowId: string;
        revision: number;
        executionTarget: string | null;
        flow: import("./core/flow-plan.js").FlowPlan;
        markdown: string;
        baseSha: string;
    };
}
export {};
