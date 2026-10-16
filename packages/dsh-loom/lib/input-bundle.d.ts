import type { verificationSnapshot } from './verification.js';
export type VerifiedSnapshot = Awaited<ReturnType<typeof verificationSnapshot>>;
export type InputFile = VerifiedSnapshot['data']['files'][number];
/** Project reviewed text changes into another frozen worktree, never the user's checkout. */
export declare function materializeInputs(cwd: string, snapshots: readonly VerifiedSnapshot[]): Map<string, InputFile>;
/** An inherited input is exempt from ownership only while its bytes and mode are unchanged. */
export declare function unchangedInput(cwd: string, path: string, expected: InputFile | undefined): boolean;
