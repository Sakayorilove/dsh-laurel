/** WSL-side lease owner. All commands are argv; no prompt text is evaluated. */
import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { createInterface } from 'node:readline'

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let started = false
let child: ReturnType<typeof spawn> | null = null
let cancelled = false
let timedOut = false
let done = false
let timeout: ReturnType<typeof setTimeout> | undefined
let sandbox: { mode: string; enforcement?: 'full'; denied: boolean } | undefined
let stderrTail = ''
let forceTimer: ReturnType<typeof setTimeout> | undefined
const send = (data: unknown) => process.stdout.write(JSON.stringify(data) + '\n')

function killGroup(signal: NodeJS.Signals): void {
  if (!child?.pid) return
  try { process.kill(-child.pid, signal) } catch { /* already quiescent */ }
}
function stop(): void {
  if (done) return
  killGroup('SIGTERM')
  forceTimer ??= setTimeout(() => killGroup('SIGKILL'), 300)
}
function finish(code: number | null, signal: string | null, error?: string): void {
  if (done) return
  done = true
  if (timeout) clearTimeout(timeout)
  if (forceTimer) clearTimeout(forceTimer)
  // No surviving background descendants in this invocation's process group.
  killGroup('SIGKILL')
  if (sandbox && code !== 0 && /(?:Read-only file system|Permission denied|Operation not permitted)/i.test(stderrTail)) sandbox.denied = true
  send({ kind: 'result', code, signal, cancelled, timedOut, error: error ?? null, sandbox })
  input.close(); process.stdin.destroy()
}

input.on('line', (line) => {
  if (line.length > 6 * 1024 * 1024) { cancelled = true; stop(); return }
  try {
    const request = JSON.parse(line)
    if (request.kind === 'cancel') { cancelled = true; stop(); return }
    if (started || request.kind !== 'start' || process.platform !== 'linux') throw new Error('invalid worker request')
    started = true
    const { cwd, timeoutMs } = request
    let argv = request.argv
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || !statSync(cwd).isDirectory()) throw new Error('invalid WSL cwd')
    if (!Array.isArray(argv) || argv.length < 1 || argv.some((v: unknown) => typeof v !== 'string' || v.includes('\0')) || !argv[0]) throw new Error('invalid argv')
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error('invalid timeout')
    const actualCwd = realpathSync(cwd)
    if (request.stdin !== undefined && (typeof request.stdin !== 'string' || Buffer.byteLength(request.stdin) > 4 * 1024 * 1024)) throw new Error('invalid stdin')
    const explicitEnv = request.env ?? {}
    if (!explicitEnv || typeof explicitEnv !== 'object' || Array.isArray(explicitEnv) || Object.entries(explicitEnv).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.includes('\0'))) throw new Error('invalid env')
    const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_') && !/(?:TOKEN|PASSWORD|SECRET|API_KEY|CREDENTIAL)/i.test(key)))
    if (request.sandboxPolicy !== undefined) {
      const policy = request.sandboxPolicy
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy?.mode) || typeof policy.workspaceRoot !== 'string' || !isAbsolute(policy.workspaceRoot)) throw new Error('invalid sandbox policy')
      const workspaceRoot = realpathSync(policy.workspaceRoot)
      const rel = relative(workspaceRoot, actualCwd)
      if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('command cwd outside policy workspace')
      sandbox = { mode: policy.mode, denied: false }
      if (policy.mode !== 'danger-full-access') {
        // A mount namespace enforces Linux file effects. Missing/broken bwrap fails closed.
        argv = ['bwrap', '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', policy.mode === 'workspace-write' ? '--bind' : '--ro-bind', workspaceRoot, workspaceRoot, '--chdir', actualCwd, '--', ...argv]
        sandbox.enforcement = 'full'
      }
    }
    child = spawn(argv[0], argv.slice(1), { cwd: actualCwd, shell: false, detached: true,
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...ambient, ...explicitEnv, GIT_TERMINAL_PROMPT: '0' } })
    child.stdin!.on('error', () => {})
    child.stdin!.end(request.stdin)
    child.on('spawn', () => send({ kind: 'started', pid: child!.pid, cwd: actualCwd, platform: process.platform }))
    child.stdout!.on('data', (data: Buffer) => send({ kind: 'stdout', data: data.toString('base64') }))
    child.stderr!.on('data', (data: Buffer) => { stderrTail = (stderrTail + data.toString('utf8')).slice(-8192); send({ kind: 'stderr', data: data.toString('base64') }) })
    child.on('error', (error) => finish(null, null, error.message))
    child.on('close', (code, signal) => finish(code, signal))
    timeout = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    if (cancelled) stop()
  } catch (error) { finish(null, null, (error as Error).message) }
})
input.on('close', () => { if (!done) { cancelled = true; stop() } })
process.on('SIGTERM', () => { cancelled = true; stop() })
