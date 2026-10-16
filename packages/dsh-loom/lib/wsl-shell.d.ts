/** Child-owned WSL shell composed through the installed public DSH tool API. */
import { type CommandReceipt } from './bridge.js';
export declare class WslShellExecution {
    readonly spec: any;
    status: 'running' | 'completed' | 'killed';
    exitCode: number | null;
    signal: string | null;
    sandbox: CommandReceipt['sandbox'];
    readonly done: Promise<void>;
    readonly observed: {
        stdout: {
            readFrom(offset: number): unknown;
        };
        stderr: {
            readFrom(offset: number): unknown;
        };
    };
    private readonly controller;
    private readonly stdout;
    private readonly stderr;
    private readonly resultPromise;
    private outCursor;
    private errCursor;
    constructor(spec: any);
    result(): Promise<any>;
    kill(): boolean;
    readOutput(): {
        delta: string;
        lossy: boolean;
    };
}
/** Independently implement the public shell contract, retaining the host's tool/policy layer. */
export declare function createWslShellClass(ShellExecutor: any, cwd: string): any;
export declare function installWslChildShell(childCtx: any, cwd: string): Promise<void>;
