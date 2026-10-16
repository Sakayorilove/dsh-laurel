export interface CommandReceipt {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly platform: 'linux';
    readonly pid: number | null;
    readonly exitCode: number | null;
    readonly signal?: string | null;
    readonly sandbox?: {
        readonly mode: string;
        readonly enforcement?: 'full';
        readonly denied: boolean;
    };
    readonly state: 'passed' | 'failed' | 'cancelled' | 'timed-out';
    readonly stdout: string;
    readonly stderr: string;
    readonly outputTruncated: boolean;
    readonly stdoutHash: string;
    readonly stderrHash: string;
    readonly startedAt: string;
    readonly endedAt: string;
}
export declare const DEFAULT_WSL_DISTRIBUTION = "Ubuntu-26.04";
/**
 * WSL 用户。默认**不指定**：不指定时由 `wsl.exe` 使用该发行版的默认用户，
 * 换一台机器不用改代码。需要指定时设环境变量 `DSH_LOOM_WSL_USER`。
 */
export declare const DEFAULT_WSL_USER: string | null;
export declare function windowsToWslPath(path: string, distribution?: string): string;
/** Windows filesystem identity for a path inside our selected Linux distribution. */
export declare function wslToWindowsPath(path: string, distribution?: string): string;
export declare function toExecutionPath(path: string): string;
export declare function toHostPath(path: string): string;
export interface WslSandboxPolicy {
    readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access';
    readonly workspaceRoot: string;
}
/** Execute an owned process group in WSL; stdin is its cancellation lease. */
export declare function executeWsl(argv: readonly string[], cwd: string, options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    maxOutputBytes?: number;
    distribution?: string;
    user?: string;
    stdin?: string;
    env?: Readonly<Record<string, string>>;
    sandboxPolicy?: WslSandboxPolicy;
    onOutput?: (stream: 'stdout' | 'stderr', data: Buffer) => void;
}): Promise<CommandReceipt>;
