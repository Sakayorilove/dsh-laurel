import type { LoomStore } from './store.js';
/** Observe the selected repository, using the same identity for approval and execution. */
export declare function readScmFacts(store: LoomStore, cwd: string, sessionId?: string): Promise<{
    repo: string;
    head: string;
    dirty: boolean;
}>;
