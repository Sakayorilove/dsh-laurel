import { execFileSync } from 'node:child_process'
import { mkdirSync,writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { adoptPlannerOutput,normalizeWorkspaceId } from '../lib/core/index.js'
import { samplePlannerOutput } from './fixtures.mjs'
import { LoomStore } from '../lib/store.js'
import { IsolatedTaskRuntime } from '../lib/runtime.js'
import { createWorktreeManager } from '../lib/worktree.js'
export const sha=text=>createHash('sha256').update(text).digest('hex')
export function graph(){const w=samplePlannerOutput();w.nodes=w.nodes.slice(2,4);w.edges=[];w.executionProposal.requiredCapabilities=['worktree','wsl-execution','artifact-verification'];for(const n of w.nodes){n.inputs=[];n.ownership.writes=[n.id+'.txt'];n.ownership.forbiddenWrites=[];n.execution.timeoutSeconds=10;n.acceptance.commands=[{argv:[process.execPath,'-e',`if(require('fs').readFileSync('${n.id}.txt','utf8')!=='${n.id}')process.exit(1)`],cwdRef:'node-worktree',expectedExitCode:0}]}return adoptPlannerOutput(w,{adoptedAt:'2026-10-04T00:00:00Z'}).workflow}
export function fixture(root,init=true){const repo=join(root,'repo');if(init){mkdirSync(repo);for(const a of [['init','-q','-b','main'],['config','user.email','fixture@loom.local'],['config','user.name','Loom fixture']])execFileSync('git',a,{cwd:repo});writeFileSync(join(repo,'baseline.txt'),'base');execFileSync('git',['add','.'],{cwd:repo});execFileSync('git',['commit','-qm','base'],{cwd:repo})}const base=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),store=new LoomStore(join(root,'home')),trees=createWorktreeManager({paths:store.paths});return {repo,base,store,trees,ws:normalizeWorkspaceId(repo),runtime:new IsolatedTaskRuntime(store,trees,2)}}
export async function produce(t){if(t.phase==='review')return{verdict:'pass',attemptId:t.attemptId,snapshotHash:t.snapshotHash,findings:[],artifactRefs:[]};writeFileSync(join(t.cwd,t.node.id+'.txt'),t.node.id);return{verdict:'ready',attemptId:t.attemptId,artifactRefs:[{nodeId:t.node.id,port:t.node.outputs[0].name,ref:t.node.id+'.txt',contentHash:sha(t.node.id)}]}}
