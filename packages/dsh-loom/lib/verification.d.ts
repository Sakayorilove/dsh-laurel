import type { VerifiedArtifact } from './runtime.js';
import type { CommandReceipt } from './bridge.js';
export declare function verificationSnapshot(cwd: string, baseSha: string, artifacts: readonly VerifiedArtifact[], checks: readonly CommandReceipt[]): Promise<{
    data: {
        baseSha: string;
        head: string;
        files: ({
            path: string;
            kind: string;
            sha256: null;
            mode?: undefined;
            content?: undefined;
        } | {
            path: string;
            kind: string;
            mode: number;
            sha256: string;
            content?: undefined;
        } | {
            path: string;
            kind: string;
            mode: number;
            sha256: string;
            content: string;
        })[];
        artifacts: {
            nodeId: string;
            port: string;
            ref: string;
            contentHash: string;
        }[];
        checks: {
            argv: readonly string[];
            cwd: string;
            exitCode: number | null;
            state: "passed" | "failed" | "cancelled" | "timed-out";
            stdoutHash: string;
            stderrHash: string;
        }[];
    };
    hash: string;
}>;
