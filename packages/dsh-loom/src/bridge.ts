import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export interface CommandReceipt {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly platform: 'linux'
  readonly pid: number | null
  readonly exitCode: number | null
  readonly signal?: string | null
  readonly sandbox?: { readonly mode: string; readonly enforcement?: 'full'; readonly denied: boolean }
  readonly state: 'passed' | 'failed' | 'cancelled' | 'timed-out'
  readonly stdout: string
  readonly stderr: string
  readonly outputTruncated: boolean
  readonly stdoutHash: string
  readonly stderrHash: string
  readonly startedAt: string
  readonly endedAt: string
}

export const DEFAULT_WSL_DISTRIBUTION = 'Ubuntu-26.04'
/**
 * WSL 用户。默认**不指定**：不指定时由 `wsl.exe` 使用该发行版的默认用户，
 * 换一台机器不用改代码。需要指定时设环境变量 `DSH_LOOM_WSL_USER`。
 */
export const DEFAULT_WSL_USER: string | null = process.env.DSH_LOOM_WSL_USER ?? null

export function windowsToWslPath(path: string, distribution = DEFAULT_WSL_DISTRIBUTION): string {
  const unc = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)$/i.exec(path)
  if (unc) {
    if (unc[1]!.toLowerCase() !== distribution.toLowerCase()) throw new Error('WSL distribution mismatch')
    return unc[2]!.replace(/\\/g, '/')
  }
  const match = /^([a-z]):[\\/](.*)$/i.exec(path)
  if (!match) throw new Error('WSL worker must be on a local Windows drive')
  return `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, '/')}`
}

/** Windows filesystem identity for a path inside our selected Linux distribution. */
export function wslToWindowsPath(path: string, distribution = DEFAULT_WSL_DISTRIBUTION): string {
  if (!path.startsWith('/') || path.includes('\0') || /[\\]/.test(path)) throw new Error('invalid Linux path')
  const drive = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(path)
  if (drive) return `${drive[1]!.toUpperCase()}:\\${(drive[2] ?? '').replace(/\//g, '\\')}`
  if (!/^[A-Za-z0-9._-]+$/.test(distribution)) throw new Error('invalid WSL distribution')
  return `\\\\wsl.localhost\\${distribution}${path.replace(/\//g, '\\')}`
}

export function toExecutionPath(path: string): string {
  return process.platform === 'win32' && !path.startsWith('/') ? windowsToWslPath(path) : path
}

export function toHostPath(path: string): string {
  return process.platform === 'win32' && path.startsWith('/') ? wslToWindowsPath(path) : path
}

export interface WslSandboxPolicy { readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'; readonly workspaceRoot: string }

/** Execute an owned process group in WSL; stdin is its cancellation lease. */
export function executeWsl(argv: readonly string[], cwd: string, options: {
  signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; distribution?: string; user?: string; stdin?: string; env?: Readonly<Record<string, string>>; sandboxPolicy?: WslSandboxPolicy; onOutput?: (stream: 'stdout' | 'stderr', data: Buffer) => void
} = {}): Promise<CommandReceipt> {
  if (options.signal?.aborted) return Promise.reject(new Error('command cancelled before start'))
  if (process.platform === 'win32' && !cwd.startsWith('/')) cwd = windowsToWslPath(cwd, options.distribution)
  if (!cwd.startsWith('/') || cwd.includes('\0')) return Promise.reject(new Error('cwd must be an absolute Linux path'))
  if (!argv.length || argv.some((a) => typeof a !== 'string' || a.includes('\0')) || !argv[0]) return Promise.reject(new Error('argv must be nonempty strings'))
  const timeoutMs = options.timeoutMs ?? 120_000
  const limit = options.maxOutputBytes ?? 256 * 1024
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000 || !Number.isInteger(limit) || limit < 1 || limit > 4 * 1024 * 1024) return Promise.reject(new Error('invalid command budget'))
  const worker = fileURLToPath(new URL('./wsl-worker.js', import.meta.url))
  let command: string; let args: string[]
  if (process.platform === 'win32') {
    const workerPath = windowsToWslPath(worker)
    // Only the package-owned worker path is shell quoted; task argv travels as JSON.
    const quoted = "'" + workerPath.replace(/'/g, "'\\''") + "'"
    command = 'wsl.exe'
    const wslUser = options.user ?? DEFAULT_WSL_USER
    args = ['--distribution', options.distribution ?? DEFAULT_WSL_DISTRIBUTION, ...(wslUser ? ['--user', wslUser] : []), '--exec', 'bash', '-lc', `exec node ${quoted}`]
  } else if (process.platform === 'linux') { command = process.execPath; args = [worker] }
  else return Promise.reject(new Error('WSL execution requires Windows or Linux'))
  const startedAt = new Date().toISOString()
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''; let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let truncated = false
    const outHash = createHash('sha256'); const errHash = createHash('sha256')
    let result: any = null; let actualCwd = ''; let pid: number | null = null
    let protocolError: Error | null = null
    const abort = () => { if (!proc.stdin.destroyed) proc.stdin.write('{"kind":"cancel"}\n') }
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { protocolError = new Error('WSL worker did not settle its lease'); proc.stdin.end(); proc.kill() }, timeoutMs + 10_000)
    proc.stdin.on('error', () => {})
    proc.stderr.on('data', () => { /* helper errors must be protocol failures, not exposed raw host output */ })
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > 256 * 1024) { protocolError = new Error('invalid worker frame size'); proc.stdin.end(); proc.kill(); return }
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        try {
          const frame = JSON.parse(line)
          if (frame.kind === 'started') { actualCwd = frame.cwd; pid = frame.pid }
          else if (frame.kind === 'result') result = frame
          else if (frame.kind === 'stdout' || frame.kind === 'stderr') {
            const data = Buffer.from(frame.data, 'base64')
            options.onOutput?.(frame.kind, data)
            const hash = frame.kind === 'stdout' ? outHash : errHash; hash.update(data)
            const current = frame.kind === 'stdout' ? stdout : stderr
            const remaining = Math.max(0, limit - current.length)
            if (data.length > remaining) truncated = true
            const next = Buffer.concat([current, data.subarray(0, remaining)])
            if (frame.kind === 'stdout') stdout = next; else stderr = next
          } else throw new Error('unknown worker frame')
        } catch { protocolError = new Error('invalid worker protocol'); proc.stdin.end(); proc.kill() }
      }
    })
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
    proc.on('error', (error) => { cleanup(); reject(error) })
    proc.on('close', () => {
      cleanup()
      if (protocolError || !result || result.error || !actualCwd) return reject(protocolError ?? new Error(result?.error ?? 'missing WSL command receipt'))
      resolve({ argv: [...argv], cwd: actualCwd, platform: 'linux', pid, exitCode: result.code, signal: result.signal, ...(result.sandbox ? { sandbox: result.sandbox } : {}),
        state: result.timedOut ? 'timed-out' : result.cancelled ? 'cancelled' : result.code === 0 ? 'passed' : 'failed',
        stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), outputTruncated: truncated,
        stdoutHash: outHash.digest('hex'), stderrHash: errHash.digest('hex'), startedAt, endedAt: new Date().toISOString() })
    })
    proc.stdin.write(JSON.stringify({ kind: 'start', argv, cwd, timeoutMs, stdin: options.stdin, env: options.env, sandboxPolicy: options.sandboxPolicy ? { ...options.sandboxPolicy, workspaceRoot: toExecutionPath(options.sandboxPolicy.workspaceRoot) } : undefined }) + '\n')
    if (options.signal?.aborted) abort()
  })
}
