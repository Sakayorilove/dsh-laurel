import { type LoomStore } from './store.js';
import { type ArchitectureRevision } from './core/index.js';
export interface RefinementRequest {
    readonly payloadHash: string;
    readonly architectureId: string;
    readonly baseRevision: number;
    readonly draftRevision: number;
    readonly scope: 'all' | readonly string[];
}
/** Recheck the stored export and current graph each time, including adoption. */
export declare function previewRefinement(store: LoomStore, ws: string, hash: string, reply: any): {
    candidate: ArchitectureRevision;
    candidateHash: string;
    changes: import("./core/graphchange-types.js").GraphChange[];
    expectedRevision: number;
    payloadHash: string;
    warnings: readonly import("./core/validate.js").LoomIssue[];
    explanation: any;
};
