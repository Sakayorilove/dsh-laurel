import { type ArchitectureRevision } from './architecture.js';
import { type WorkflowRevision } from './model.js';
import type { SourceMap } from './sourcemap.js';
import type { LoomStore } from '../store.js';
export interface PlanningRequest {
    readonly payloadHash: string;
    readonly goal: string;
    readonly constraints: readonly string[];
    readonly architectureId: string;
    readonly workflowId: string;
    readonly expectedArchitectureRevision: number | null;
    readonly expectedWorkflowRevision: number | null;
    readonly expectedDraftRevision: number | null;
    readonly maxConcurrency: number;
}
export declare function exportInitialPlanning(store: LoomStore, ws: string, input: unknown, maxConcurrency: number): {
    kind: "planning";
    text: string;
    prompt: string;
    payloadHash: string;
    request: PlanningRequest;
};
export declare function previewInitialPlanning(store: LoomStore, ws: string, hash: string, reply: unknown): {
    architecture: ArchitectureRevision;
    workflow: WorkflowRevision;
    sourceMap: SourceMap;
    candidateHash: string;
    payloadHash: string;
    expectedArchitectureRevision: number | null;
    expectedWorkflowRevision: number | null;
    expectedDraftRevision: number | null;
    warnings: import("./validate.js").LoomIssue[];
    blocked: readonly {
        readonly nodeId: string;
        readonly reason: string;
    }[];
    explanation: string;
};
