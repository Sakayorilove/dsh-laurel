/** Native Linux file IO for the public FileSystem seam; no Windows ACL calls. */
import { readFile, writeFile, stat, lstat, realpath, readdir, mkdir, mkdtemp, open, rename, link, unlink, rm, chmod } from 'node:fs/promises'
import { dirname, basename, resolve, relative, isAbsolute, join } from 'node:path'
import { TextDecoder } from 'node:util'

const MAX_BYTES = 2 * 1024 * 1024
let aborted = false
process.on('SIGTERM', () => { aborted = true })
const checkAbort = (): void => { if (aborted) fail('FS_ABORTED', 'filesystem request aborted') }
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }) }
async function canonical(path: string): Promise<string> {
  try { return await realpath(path) } catch (error: any) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await canonical(parent), basename(path))
  }
}
const version = (s: any) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
async function info(path: string, follow = true): Promise<any> {
  try {
    const s = await (follow ? stat : lstat)(path, { bigint: true })
    return { version: version(s), type: s.isFile() ? 'file' : s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'other', size: Number(s.size), mode: Number(s.mode) & 0o777 }
  } catch (error: any) { if (['ENOENT','ENOTDIR'].includes(error.code)) return null; throw error }
}
async function bytes(path: string, max = MAX_BYTES): Promise<Buffer> {
  if (!Number.isInteger(max) || max < 0 || max > MAX_BYTES) fail('FS_TOO_LARGE', 'invalid read byte budget')
  checkAbort()
  const s = await info(path)
  if (!s) fail('FS_NOT_FOUND', 'file not found')
  if (s.type !== 'file') fail('FS_NOT_REGULAR_FILE', 'target is not a regular file')
  if (s.size > max) fail('FS_TOO_LARGE', 'file exceeds WSL IO limit')
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(max + 1)
    const read = await handle.read(buffer, 0, max + 1, 0)
    if (read.bytesRead > max) fail('FS_TOO_LARGE', 'file grew beyond WSL IO limit')
    return buffer.subarray(0, read.bytesRead)
  } finally { await handle.close() }
}
function text(data: Buffer): string {
  if (data.includes(0)) fail('FS_NOT_TEXT', 'binary file is not UTF-8 text')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { return fail('FS_NOT_TEXT', 'file is not valid UTF-8') }
}
function checkVersion(existing: any, expected: any): void {
  if (expected?.kind === 'createIfAbsent' && existing) fail('FS_NOT_OBSERVED', 'existing file must be read before replacement')
  if ((expected?.kind === 'replaceIfVersion' || expected?.version) && (!existing || existing.version !== expected.version)) fail('FS_STALE_VERSION', 'file changed since it was read')
}
async function atomic(path: string, content: string, existing: any, expected: any): Promise<void> {
  if (Buffer.byteLength(content) > MAX_BYTES) fail('FS_TOO_LARGE', 'write exceeds WSL IO limit')
  await mkdir(dirname(path), { recursive: true })
  const staging = await mkdtemp(join(dirname(path), '.loom-write-'))
  await chmod(staging, 0o700)
  const pending = join(staging, 'content')
  try {
    await writeFile(pending, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const handle = await open(pending, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    await chmod(pending, existing?.mode ?? 0o644)
    checkVersion(await info(path), expected)
    checkAbort()
    if (expected?.kind === 'createIfAbsent') {
      try { await link(pending, path) } catch (error: any) { if (error.code === 'EEXIST') fail('FS_NOT_OBSERVED', 'file appeared before publication'); throw error }
      await unlink(pending)
    } else await rename(pending, path)
  } finally { await rm(staging, { recursive: true, force: true }) }
}
async function run(request: any): Promise<any> {
  if (process.platform !== 'linux') fail('FS_IO_ERROR', 'filesystem worker requires Linux')
  const { operation } = request
  const path = typeof request.path === 'string' && isAbsolute(request.path) && !request.path.includes('\0') ? request.path : fail('FS_IO_ERROR', 'invalid absolute file path')
  const resolved = await canonical(path)
  if (operation === 'resolve') return { targetKey: resolved, displayPath: path }
  if (operation === 'stat' || operation === 'lstat') return info(path, operation === 'stat')
  if (operation === 'list') {
    const entries = await readdir(resolved, { withFileTypes: true })
    if (entries.length > 10000) fail('FS_TOO_LARGE', 'directory listing exceeds limit')
    return Promise.all(entries.sort((a,b) => a.name.localeCompare(b.name)).map(async entry => {
      const target = await canonical(join(resolved, entry.name)), metadata = await info(target)
      return { name: entry.name, type: metadata?.type ?? 'other', target: { targetKey: target, displayPath: join(path, entry.name) }, version: metadata?.version, size: metadata?.size }
    }))
  }
  if (operation === 'read' || operation === 'bytes') {
    const data = await bytes(resolved, request.maxBytes ?? MAX_BYTES)
    return operation === 'read' ? text(data) : data.toString('base64')
  }
  if (operation === 'range') {
    const { offset, length } = request.range ?? {}
    if (![offset,length].every(n => Number.isInteger(n) && n >= 0) || length > MAX_BYTES) fail('FS_TOO_LARGE', 'invalid read window')
    const handle = await open(resolved, 'r')
    try { const buffer = Buffer.alloc(length), data = await handle.read(buffer,0,length,offset); return buffer.subarray(0,data.bytesRead).toString('base64') } finally { await handle.close() }
  }
  if (!['write','edit'].includes(operation)) fail('FS_IO_ERROR', 'unsupported filesystem operation')
  const policy = request.policy
  if (!policy || !['read-only','workspace-write','danger-full-access'].includes(policy.mode) || typeof policy.workspaceRoot !== 'string') fail('FS_SANDBOX_DENIED', 'no valid mutation policy')
  if (policy.mode === 'read-only') fail('FS_SANDBOX_DENIED', 'read-only denies file mutation')
  const workspace = await canonical(policy.workspaceRoot), rel = relative(workspace,resolved)
  if (policy.mode === 'workspace-write' && (rel === '..' || rel.startsWith('../') || isAbsolute(rel))) fail('FS_SANDBOX_DENIED', 'target escapes assigned workspace')
  const existing = await info(resolved)
  if (existing && existing.type !== 'file') fail('FS_NOT_REGULAR_FILE', 'target is not a regular file')
  checkVersion(existing, request.expected)
  const original = existing ? text(await bytes(resolved)) : null
  const before = original?.replace(/\r\n/g, '\n') ?? null
  let content: string
  if (operation === 'write') {
    if (typeof request.content !== 'string') fail('FS_NOT_TEXT', 'write requires UTF-8 text')
    content = request.content
  } else {
    if (!existing) fail('FS_STALE_VERSION', 'file disappeared before edit')
    const edit = request.edit
    if (typeof edit?.oldString !== 'string' || !edit.oldString || typeof edit.newString !== 'string') fail('FS_EDIT_NOT_FOUND', 'invalid literal edit')
    const old = edit.oldString.replace(/\r\n/g,'\n'), replacement = edit.newString.replace(/\r\n/g,'\n')
    const chunks = before!.split(old)
    if (chunks.length < 2) fail('FS_EDIT_NOT_FOUND', 'literal text not found')
    if (!edit.replaceAll && chunks.length !== 2) fail('FS_AMBIGUOUS_EDIT', 'literal text matched more than once')
    content = chunks.join(replacement)
    if (original!.includes('\r\n') && !original!.replace(/\r\n/g,'').includes('\n')) content = content.replace(/\n/g,'\r\n')
  }
  await atomic(resolved,content,existing,request.expected)
  const after = await info(resolved)
  return { ...(operation === 'write' ? { operation: existing ? 'update' : 'create' } : {}), version: after.version, before, after: content.replace(/\r\n/g,'\n') }
}

try {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 4 * 1024 * 1024) fail('FS_TOO_LARGE', 'filesystem request exceeds limit'); chunks.push(chunk) }
  const result = await run(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  process.stdout.write(JSON.stringify({ ok: true, value: result })+'\n')
} catch (error: any) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code?.startsWith('FS_') ? error.code : ['EACCES','EPERM'].includes(error.code) ? 'FS_PERMISSION_DENIED' : 'FS_IO_ERROR', message: error.message })+'\n')
}
