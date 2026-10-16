import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { windowsToWslPath, DEFAULT_WSL_DISTRIBUTION, DEFAULT_WSL_USER } from './bridge.js';
/** Never remove the lock file: every process must lock the same inode. */
export async function acquireExecutionLease(root) {
    mkdirSync(root, { recursive: true });
    const token = randomUUID(), lock = join(root, 'execution.lock'), worker = fileURLToPath(new URL('./lease-worker.js', import.meta.url));
    const proc = process.platform === 'win32'
        ? spawn('wsl.exe', ['-d', DEFAULT_WSL_DISTRIBUTION, ...(DEFAULT_WSL_USER ? ['--user', DEFAULT_WSL_USER] : []), '--exec', 'bash', '-lc',
            'exec flock --no-fork -n -E 73 "$1" node "$2" "$3"', 'loom-lease', windowsToWslPath(lock), windowsToWslPath(worker), token], { stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn('flock', ['--no-fork', '-n', '-E', '73', lock, process.execPath, worker, token], { stdio: ['pipe', 'pipe', 'pipe'] });
    let ready = false, normalRelease = false, stderr = '', buffer = '', lose;
    const lost = new Promise(resolve => { lose = resolve; });
    let finish;
    const closed = new Promise(resolve => { finish = resolve; });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { proc.stdin.end(); reject(new Error('COORDINATOR_UNAVAILABLE: WSL 文件锁未响应')); }, 10_000);
        proc.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1200); });
        proc.stdout.on('data', chunk => {
            buffer += String(chunk);
            if (buffer.length > 4096) {
                clearTimeout(timer);
                proc.stdin.end();
                reject(new Error('LEASE_PROTOCOL_INVALID'));
                return;
            }
            if (!buffer.includes('\n'))
                return;
            try {
                const message = JSON.parse(buffer.split('\n')[0]);
                if (message.ready !== true || message.token !== token)
                    throw new Error('LEASE_PROTOCOL_INVALID');
                ready = true;
                clearTimeout(timer);
                resolve();
            }
            catch (error) {
                clearTimeout(timer);
                proc.stdin.end();
                reject(error);
            }
        });
        proc.on('error', error => { clearTimeout(timer); finish(); lose(); reject(error); });
        proc.on('close', code => {
            clearTimeout(timer);
            finish();
            if (!normalRelease)
                lose();
            if (!ready)
                reject(new Error(code === 73 ? 'COORDINATOR_BUSY: 另一个 Loom 实例正在执行，请等待它停止后重试' : `COORDINATOR_UNAVAILABLE: ${stderr || code}`));
        });
    });
    return { token, lost, async release() { if (!normalRelease) {
            normalRelease = true;
            proc.stdin.end();
        } ; await closed; } };
}
/** Concurrent runs in this runtime share one native lock and one task budget. */
export class ExecutionCoordinator {
    root;
    users = 0;
    pending = null;
    closing = Promise.resolve();
    constructor(root) {
        this.root = root;
    }
    async acquire() {
        for (;;) {
            const closing = this.closing;
            await closing;
            if (closing === this.closing)
                break;
        }
        this.users++;
        const pending = this.pending ??= acquireExecutionLease(this.root);
        let lease;
        try {
            lease = await pending;
        }
        catch (error) {
            this.users--;
            if (this.pending === pending)
                this.pending = null;
            throw error;
        }
        let released = false;
        return { token: lease.token, lost: lease.lost, release: async () => {
                if (released)
                    return;
                released = true;
                if (--this.users === 0) {
                    this.pending = null;
                    this.closing = lease.release();
                    await this.closing;
                }
            } };
    }
}
