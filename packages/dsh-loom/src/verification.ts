import { createHash } from 'node:crypto'
import { readFileSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { git } from './worktree.js'
import { contentDigest } from './core/index.js'
import { toHostPath } from './bridge.js'
import type { VerifiedArtifact } from './runtime.js'
import type { CommandReceipt } from './bridge.js'

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
export async function verificationSnapshot(cwd: string, baseSha: string, artifacts: readonly VerifiedArtifact[], checks: readonly CommandReceipt[]) {
  const run = async (args: string[]) => { const result = await git(cwd, args, 30_000); if (result.code !== 0) throw new Error('REVIEW_GIT_FAILED: '+result.stderr); return result.stdout }
  const changed = [...new Set([...(await run(['diff','--no-renames','--name-only','-z',baseSha])).split('\0'),...(await run(['ls-files','--others','--exclude-standard','-z'])).split('\0')].filter(Boolean))].sort()
  const root = realpathSync(cwd)
  const files = changed.map(path => {
    const file = resolve(root, path), rel = relative(root, file)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('REVIEW_PATH_ESCAPE')
    let stat
    try { stat = lstatSync(file) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, kind:'deleted', sha256:null }; throw error }
    if (stat.isSymbolicLink()) return { path, kind:'symlink', mode:stat.mode, sha256:hash(readlinkSync(file)) }
    if (!stat.isFile()) throw new Error('REVIEW_FILE_UNSUPPORTED')
    const real = relative(root, realpathSync(file))
    if (real.startsWith('..') || isAbsolute(real)) throw new Error('REVIEW_PATH_ESCAPE')
    const bytes=readFileSync(file)
    if(bytes.length>256*1024)throw new Error('REVIEW_EVIDENCE_TOO_LARGE: 文件超过只读内联证据上限，需先拆分任务')
    const content=bytes.includes(0)?null:bytes.toString('utf8')
    if(content===null)throw new Error('REVIEW_BINARY_UNSUPPORTED: 二进制变更需显式独立验收，不猜测内容')
    return {path,kind:'file',mode:stat.mode,sha256:hash(bytes),content}
  })
  for (const artifact of artifacts) if (hash(readFileSync(toHostPath(artifact.ref))) !== artifact.contentHash) throw new Error('ARTIFACT_CHANGED: 已验产物内容改变')
  if(JSON.stringify(files).length>1024*1024)throw new Error('REVIEW_EVIDENCE_TOO_LARGE: 组证据需拆分')
  const data = {baseSha,head:(await run(['rev-parse','HEAD'])).trim(),files,artifacts:artifacts.map(({nodeId,port,ref,contentHash})=>({nodeId,port,ref,contentHash})),checks:checks.map(({argv,cwd,exitCode,state,stdoutHash,stderrHash})=>({argv,cwd,exitCode,state,stdoutHash,stderrHash}))}
  return { data, hash: contentDigest(data) }
}
