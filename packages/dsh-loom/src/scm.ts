import type { LoomStore } from './store.js'
import { normalizeWorkspaceId } from './core/index.js'
import { toHostPath } from './bridge.js'
import { git } from './worktree.js'

/** Observe the selected repository, using the same identity for approval and execution. */
export async function readScmFacts(store:LoomStore,cwd:string,sessionId?:string) {
  const ws=normalizeWorkspaceId(cwd)
  const target=sessionId&&ws?store.readExecutionTarget(sessionId,ws):null
  const path=toHostPath(target??cwd)
  const top=await git(path,['rev-parse','--show-toplevel'])
  const head=await git(path,['rev-parse','HEAD'])
  const status=await git(path,['status','--porcelain=v1','--untracked-files=all'])
  if(top.code||head.code||status.code)throw new Error('SCM_UNAVAILABLE: 请先准备独立项目的 Git 基线')
  return{repo:top.stdout.trim(),head:head.stdout.trim(),dirty:!!status.stdout.trim()}
}
