/** Public filesystem seam backed by package-owned native Linux IO. */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { posix } from 'node:path'
import { executeWsl, toExecutionPath, toHostPath, type WslSandboxPolicy } from './bridge.js'
import { loadHostFsBindings } from './host-helpers.js'

export function createWslFileSystemClass(FileSystem: any, FsError: any, cwd: string): any {
  return class LoomWslFileSystem extends FileSystem {
    private readonly locks = new Map<string, Promise<unknown>>()
    private readonly active = new Set<{ abort: AbortController; settled: Promise<unknown> }>()
    constructor(ctx: any) {
      super(ctx)
      ctx.effect(() => async () => {
        const active = [...this.active]
        for (const request of active) request.abort.abort(new Error('filesystem disposed'))
        await Promise.allSettled(active.map(request => request.settled))
      }, 'loom.wsl-fs')
    }
    get sandboxMode(): string { return this.ctx.get('sandboxPolicy')?.defaultMode ?? 'workspace-write' }
    private async request(operation: string, path: string, extra: any = {}, signal?: AbortSignal): Promise<any> {
      if (signal?.aborted) throw new FsError('filesystem request aborted', 'FS_ABORTED')
      const abort = new AbortController(), relay = () => abort.abort(signal?.reason)
      signal?.addEventListener('abort', relay, { once: true })
      const worker = toExecutionPath(fileURLToPath(new URL('./wsl-fs-worker.js', import.meta.url)))
      const policy: WslSandboxPolicy | undefined = ['write','edit'].includes(operation) ? extra.policy : undefined
      const settled = executeWsl(['node', worker], cwd, { signal: abort.signal, timeoutMs: 30_000,
        maxOutputBytes: 4 * 1024 * 1024, stdin: JSON.stringify({ operation, path, ...extra }), sandboxPolicy: policy })
      const owned = { abort, settled }; this.active.add(owned)
      try {
        const receipt = await settled
        if (receipt.state === 'cancelled') throw new FsError('filesystem request aborted', 'FS_ABORTED')
        if (receipt.state !== 'passed' || receipt.outputTruncated) throw new FsError(`WSL filesystem transport failed: ${receipt.stderr}`, 'FS_IO_ERROR')
        const result = JSON.parse(receipt.stdout)
        if (!result.ok) throw new FsError(result.message, result.code)
        return result.value
      } finally { this.active.delete(owned); signal?.removeEventListener('abort', relay) }
    }
    private async locked(path: string, action: () => Promise<any>): Promise<any> {
      const previous = this.locks.get(path) ?? Promise.resolve()
      const current = previous.catch(() => {}).then(action)
      this.locks.set(path, current)
      try { return await current } finally { if (this.locks.get(path) === current) this.locks.delete(path) }
    }
    private policy(policy?: any): WslSandboxPolicy {
      const current = policy ?? this.ctx.get('sandboxPolicy')?.resolve() ?? { mode: 'workspace-write', workspaceRoot: cwd }
      return { mode: current.mode, workspaceRoot: toExecutionPath(current.workspaceRoot) }
    }
    async resolve(path: string, options: any = {}): Promise<any> {
      const base = toExecutionPath(options.cwd ?? cwd)
      const absolute = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path) ? toExecutionPath(path) : posix.resolve(base, path)
      return this.request('resolve', absolute, {}, options.signal)
    }
    processPath(target: any): string { return target.targetKey }
    processPathFromHostPath(path: string): string | undefined { try { return toExecutionPath(path) } catch { return undefined } }
    fileUrl(target: any): string { return pathToFileURL(toHostPath(target.targetKey)).href }
    contains(parent: any, child: any): boolean { const path = posix.relative(parent.targetKey, child.targetKey); return path !== '..' && !path.startsWith('../') && !posix.isAbsolute(path) }
    async stat(target: any, signal?: AbortSignal): Promise<any> { return (await this.request('stat', target.targetKey, {}, signal)) ?? undefined }
    async lstat(path: string, options: any = {}, signal?: AbortSignal): Promise<any> {
      const absolute = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path) ? toExecutionPath(path) : posix.resolve(toExecutionPath(options.cwd ?? cwd), path)
      return (await this.request('lstat', absolute, {}, signal)) ?? undefined
    }
    readText(target: any, signal?: AbortSignal): Promise<string> { return this.request('read', target.targetKey, {}, signal) }
    async streamText(target: any, signal?: AbortSignal): Promise<AsyncIterable<string>> {
      const metadata = await this.stat(target, signal)
      if (!metadata || metadata.type !== 'file') throw new FsError('not a regular file', 'FS_NOT_REGULAR_FILE')
      const service = this
      return (async function* () {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let offset = 0
        while (offset < metadata.size) {
          const data = await service.readByteRange(target, { offset, length: 64 * 1024 }, signal)
          if (!data.length) break
          if (data.includes(0)) throw new FsError('binary file is not text', 'FS_NOT_TEXT')
          offset += data.length
          try { yield decoder.decode(data, { stream: true }) } catch { throw new FsError('invalid UTF-8', 'FS_NOT_TEXT') }
        }
        try { const tail = decoder.decode(); if (tail) yield tail } catch { throw new FsError('invalid UTF-8', 'FS_NOT_TEXT') }
      })()
    }
    async readBytes(target: any, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> { return Buffer.from(await this.request('bytes', target.targetKey, { maxBytes }, signal), 'base64') }
    async readByteRange(target: any, range: any, signal?: AbortSignal): Promise<Uint8Array> { return Buffer.from(await this.request('range', target.targetKey, { range }, signal), 'base64') }
    listDir(target: any, signal?: AbortSignal): Promise<any> { return this.request('list', target.targetKey, {}, signal) }
    writeText(target: any, content: string, expected?: any, signal?: AbortSignal, policy?: any): Promise<any> { return this.locked(target.targetKey, () => this.request('write', target.targetKey, { content, expected, policy: this.policy(policy) }, signal)) }
    editText(target: any, edit: any, expected?: any, signal?: AbortSignal, policy?: any): Promise<any> { return this.locked(target.targetKey, () => this.request('edit', target.targetKey, { edit, expected, policy: this.policy(policy) }, signal)) }
  }
}

export async function installWslChildFileSystem(childCtx: any, cwd: string): Promise<void> {
  const bindings = loadHostFsBindings()
  const scoped = childCtx.isolate('fs')
  const provider = scoped.plugin(createWslFileSystemClass(bindings.FileSystem, bindings.FsError, cwd))
  await provider.await()
  await scoped.plugin(bindings.fileTools).await()
}
