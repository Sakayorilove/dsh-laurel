/** Child-owned WSL shell composed through the installed public DSH tool API. */
import { executeWsl, toExecutionPath, type CommandReceipt, type WslSandboxPolicy } from './bridge.js'
import { loadHostShellBindings } from './host-helpers.js'

type StreamState = { data: Buffer; total: number }

export class WslShellExecution {
  status: 'running' | 'completed' | 'killed' = 'running'
  exitCode: number | null = null
  signal: string | null = null
  sandbox: CommandReceipt['sandbox']
  readonly done: Promise<void>
  readonly observed: { stdout: { readFrom(offset: number): unknown }; stderr: { readFrom(offset: number): unknown } }
  private readonly controller = new AbortController()
  private readonly stdout: StreamState = { data: Buffer.alloc(0), total: 0 }
  private readonly stderr: StreamState = { data: Buffer.alloc(0), total: 0 }
  private readonly resultPromise: Promise<any>
  private outCursor = 0
  private errCursor = 0

  constructor(readonly spec: any) {
    const cap = Math.min(spec.stdoutMaxBytes ?? 64_000, 4 * 1024 * 1024)
    const read = (stream: StreamState, fromByte: number) => {
      const first = stream.total - stream.data.length
      const lossy = fromByte < first
      return { text: stream.data.subarray(Math.max(0, fromByte - first)).toString('utf8'), nextOffset: stream.total, lossy }
    }
    this.observed = { stdout: { readFrom: (offset) => read(this.stdout, offset) }, stderr: { readFrom: (offset) => read(this.stderr, offset) } }
    const onAbort = () => this.controller.abort(spec.signal?.reason)
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    if (spec.signal?.aborted) onAbort()
    const command = executeWsl(['bash', '-c', spec.command], spec.workdir, {
      signal: this.controller.signal, timeoutMs: spec.timeoutMs, maxOutputBytes: cap,
      stdin: spec.stdin, env: { ...spec.env, ...spec.dshEnv }, sandboxPolicy: spec.sandboxPolicy,
      onOutput: (name, bytes) => {
        const stream = name === 'stdout' ? this.stdout : this.stderr
        stream.total += bytes.length
        stream.data = Buffer.concat([stream.data, bytes]).subarray(-cap)
      },
    })
    this.resultPromise = command.then((receipt) => {
      this.exitCode = receipt.exitCode
      this.signal = receipt.signal ?? null
      this.status = receipt.state === 'cancelled' || receipt.state === 'timed-out' ? 'killed' : 'completed'
      this.sandbox = receipt.sandbox
      const output = (stream: StreamState) => ({ text: stream.data.toString('utf8'), truncated: stream.total > stream.data.length })
      return { exitCode: receipt.exitCode, signal: receipt.signal ?? null, timedOut: receipt.state === 'timed-out',
        aborted: receipt.state === 'cancelled', timeoutMs: spec.timeoutMs,
        stdout: output(this.stdout), stderr: output(this.stderr), ...(receipt.sandbox ? { sandbox: receipt.sandbox } : {}) }
    }, (error: Error) => {
      this.status = 'killed'
      const note = Buffer.from(`WSL spawn failed: ${error.message}`)
      this.stderr.data = note; this.stderr.total = note.length
      throw error
    }).finally(() => spec.signal?.removeEventListener('abort', onAbort))
    // Background consumers observe failure through the read path; no unhandled rejection.
    this.done = this.resultPromise.then(() => undefined, () => undefined)
  }

  result(): Promise<any> { return this.resultPromise }
  kill(): boolean { if (this.status !== 'running') return false; this.controller.abort(new Error('shell disposed')); return true }
  readOutput(): { delta: string; lossy: boolean } {
    const out = this.observed.stdout.readFrom(this.outCursor) as any
    const err = this.observed.stderr.readFrom(this.errCursor) as any
    this.outCursor = out.nextOffset; this.errCursor = err.nextOffset
    return { delta: out.text + (err.text ? `\n[stderr]\n${err.text}` : ''), lossy: out.lossy || err.lossy }
  }
}

/** Independently implement the public shell contract, retaining the host's tool/policy layer. */
export function createWslShellClass(ShellExecutor: any, cwd: string): any {
  return class LoomWslShell extends ShellExecutor {
    private readonly processes = new Set<WslShellExecution>()
    constructor(ctx: any) {
      super(ctx)
      ctx.effect(() => async () => {
        const active = [...this.processes]
        for (const process of active) process.kill()
        await Promise.all(active.map((process) => process.done))
      }, 'loom.wsl-shell')
    }
    get sandboxMode(): string { return this.ctx.get('sandboxPolicy')?.defaultMode ?? 'workspace-write' }
    resolve(request: any): any {
      if (typeof request?.command !== 'string' || !request.command.trim()) throw new Error('invalid WSL shell command')
      if (request.onExpiry === 'none') throw new Error('LOOM_FOREGROUND_ONLY: WSL 子任务使用可回收的前台命令')
      const timeoutMs = request.timeoutMs ?? 120_000
      const stdoutMaxBytes = request.stdoutMaxBytes ?? 64_000
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000 || !Number.isInteger(stdoutMaxBytes) || stdoutMaxBytes < 1 || stdoutMaxBytes > 4 * 1024 * 1024) throw new Error('invalid WSL shell budget')
      const sandboxPolicy: WslSandboxPolicy = request.sandboxPolicy ?? this.ctx.get('sandboxPolicy')?.resolve() ?? { mode: 'workspace-write', workspaceRoot: cwd }
      return { ...request, workdir: request.workdir ?? cwd, timeoutMs, stdoutMaxBytes, onExpiry: 'kill', sandboxPolicy }
    }
    async execute(spec: any): Promise<WslShellExecution> {
      if (spec.signal?.aborted) spec.signal.throwIfAborted()
      const execution = new WslShellExecution(spec)
      this.processes.add(execution)
      void execution.done.then(() => this.processes.delete(execution))
      return execution
    }
  }
}

export async function installWslChildShell(childCtx: any, cwd: string): Promise<void> {
  const bindings = loadHostShellBindings()
  if (!childCtx?.isolate || !childCtx?.plugin || !childCtx?.get?.('tools')?.register || !childCtx?.get?.('tools')?.restrict) throw new Error('WSL_CHILD_COMPOSITION_UNAVAILABLE')
  const scoped = childCtx.isolate('shell')
  const shell = scoped.plugin(createWslShellClass(bindings.ShellExecutor, cwd))
  await shell.await()
  await scoped.plugin(bindings.bashTools, { enableRunInBackground: false, promoteOnTimeout: false }).await()
  const known = childCtx.get('tools').schemas?.() ?? []
  const names = known.map((item: any) => typeof item === 'string' ? item : item.name)
  const deny = names.filter((name: string) => /^(?:pwsh|powershell|bash_persistent|pwsh_persistent)$/.test(name))
  if (deny.length) childCtx.get('tools').restrict({ deny })
  childCtx.get('systemPrompt').section({ name: 'loom:wsl-execution', order: childCtx.get('systemPrompt').getSectionOrder('TOOL_BASH'),
    text: `本子任务在 WSL Linux 工作树 ${toExecutionPath(cwd)} 开发。shell 只能调用 bash 工具（实际在 WSL 执行）；read/write/edit 使用相对路径，由宿主映射至本工作树。禁止调用 PowerShell/CMD/Git Bash。验收命令和构建都使用 WSL 工具链。` })
}
