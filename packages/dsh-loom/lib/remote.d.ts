import { type HandlerDeps } from './http.js';
export interface LoomRequest {
    sessionId: string;
    path: string;
    method: 'GET' | 'POST';
    body?: unknown;
}
export declare function parseLoomRequest(value: unknown): LoomRequest;
/** Translate carrier DTOs into the existing handler's stream contract, in memory.
 * Route and business validation remain shared with HTTP; no second write path. */
export declare function createRemoteRequest(deps: HandlerDeps): (input: unknown, signal?: AbortSignal) => Promise<any>;
/** Owned registrations use public Cordis and Typert contracts from the host. */
export declare function installRemote(ctx: any, deps: HandlerDeps): void;
