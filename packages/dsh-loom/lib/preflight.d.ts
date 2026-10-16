/** Compact, reviewable answers. The server retains the user's task graph. */
import type { ArchitectureRevision } from './core/architecture.js';
import type { WorkflowRevision } from './core/model.js';
export declare const resolutionLabels: Record<string, string>;
export interface ResolutionBaseline {
    id: string;
    requestId: string;
    workspaceId: string;
    flowHash: string;
    prompt: string;
    outgoingText: string;
    architecture: ArchitectureRevision;
    workflow: WorkflowRevision;
    mappings: {
        workflowNodeId: string;
        architectureNodeIds: readonly string[];
        decisionIds: readonly string[];
    }[];
    questions: string[];
    gitAvailable: boolean | null;
}
export declare function resolutionDocument(base: ResolutionBaseline, input: any): {
    requestId: string;
    architecture: any;
    workflow: any;
    mappings: {
        workflowNodeId: string;
        architectureNodeIds: readonly string[];
        decisionIds: readonly string[];
    }[];
    explanation: string;
};
