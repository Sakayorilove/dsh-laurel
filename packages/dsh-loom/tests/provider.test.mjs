import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoomStore } from '../lib/store.js'
import { createWorktreeStore } from '../lib/worktree.js'
import { LoomWorktreeProvider } from '../lib/provider.js'
import { dispatchLabel } from '../lib/core/index.js'

test('provider contract: real parent, exact cwd, durable descriptor and quiescent disposal (host fixture)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'loom-provider-'))
  const repo = join(root, 'repo'), tree = join(root, 'tree'); mkdirSync(repo); mkdirSync(tree)
  const store = new LoomStore(join(root, 'home'))
  createWorktreeStore(store.paths).append({ runId: 'r', taskId: 'api', path: tree, repoPath: repo, baseSha: 'a'.repeat(40), branch: 'loom/r/api', state: 'created', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  const helpers = { childSessionMeta: () => ({ cwd: repo }), resolveChildDepth: () => 1,
    resolveChildAgentOptions: () => ({}), assertSubagentMaxDepth() {}, captureDelegatedPolicyOverrides: () => ({}), appendDelegatedPolicyOverrides() {}, applyChildComposition() {},
    createUserMessage: (m) => m, sessionLogOffset: (n) => n, foldConsumedWork: () => ({ end: { data: { reason: { kind: 'completed' } } } }), finalAssistantOutput: () => [{ type: 'text', text: 'done' }] }
  try {
    await t.test('published child uses assigned tree, descriptor once, then disposal waits', async () => {
      let created = 0, disposed = false, hook; const events = []
      const child = { session: { header: { cwd: tree }, append: (type, data) => events.push({ type, data }), snapshotEvents: () => events },
        followup() {}, cancel() {}, whenIdle: async () => { await hook({ agent: child }, async () => ({ kind: 'enter' })); await hook({ agent: child }, async () => ({ kind: 'enter' })) } }
      const parent = { session: { header: { cwd: repo } }, ctx: { agents: { create: async (opts) => {
        created++; assert.equal(opts.meta.cwd, tree); assert.equal(opts.parentAgent, parent)
        await opts.setup({ on: (name, fn) => { assert.equal(name, 'agent/pre-step'); hook = fn } }, child)
        return { agent: child, dispose: async () => { disposed = true } }
      } } } }
      const provider = new LoomWorktreeProvider({ paths: store.paths, helpers })
      const descriptor = { fixture: 'opaque host-resolved descriptor' }
      const run = await provider.start({ label: dispatchLabel('r', 'api'), parent, signal: new AbortController().signal, prompt: [], descriptor })
      assert.equal((await run.result).stopReason, 'completed'); await run.dispose()
      assert.equal(created, 1); assert.equal(disposed, true)
      assert.deepEqual(events, [{ type: 'subagent/descriptor', data: descriptor }])
    })
    await t.test('foreign parent, missing descriptor and pre-start abort never create children', async () => {
      let created = 0
      const parent = { session: { header: { cwd: repo } }, ctx: { agents: { create: async () => { created++; throw new Error('unexpected create') } } } }
      const provider = new LoomWorktreeProvider({ paths: store.paths, helpers })
      const request = { label: dispatchLabel('r', 'api'), parent, signal: new AbortController().signal, prompt: [], descriptor: {} }
      await assert.rejects(provider.start({ ...request, parent: { ...parent, session: { header: { cwd: root } } } }), /WORKSPACE_MISMATCH/)
      await assert.rejects(provider.start({ ...request, descriptor: undefined }), /DESCRIPTOR_REQUIRED/)
      const abort = new AbortController(); abort.abort()
      await assert.rejects(provider.start({ ...request, signal: abort.signal }), /aborted/)
      assert.equal(created, 0)
    })
    await t.test('host rewriting child cwd is rejected during creation', async () => {
      const parent = { session: { header: { cwd: repo } }, ctx: { agents: { create: async (opts) => {
        await opts.setup({ on() {} }, { session: { header: { cwd: repo } } }); throw new Error('must refuse in setup')
      } } } }
      const provider = new LoomWorktreeProvider({ paths: store.paths, helpers })
      await assert.rejects(provider.start({ label: dispatchLabel('r', 'api'), parent, signal: new AbortController().signal, prompt: [], descriptor: {} }), /CHILD_CWD_MISMATCH/)
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('structured delivery is committed only by successful tool results, including enclosing PTC result',async t=>{
 const root=mkdtempSync(join(tmpdir(),'loom-capture-')),repo=join(root,'repo'),tree=join(root,'tree');mkdirSync(repo);mkdirSync(tree)
 const store=new LoomStore(join(root,'home'));createWorktreeStore(store.paths).append({runId:'capture',taskId:'task',path:tree,repoPath:repo,baseSha:'a'.repeat(40),branch:'loom/capture/task',state:'created',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})
 const helpers={childSessionMeta:()=>({cwd:repo}),resolveChildDepth:()=>1,resolveChildAgentOptions:()=>({}),assertSubagentMaxDepth(){},captureDelegatedPolicyOverrides:()=>({}),appendDelegatedPolicyOverrides(){},applyChildComposition(){},createUserMessage:m=>m,foldConsumedWork:()=>({end:{data:{reason:{kind:'completed'}}}}),finalAssistantOutput:()=>[{type:'text',text:'I claim success in prose'}],assertOutputSchema(){},validateOutput:(schema,value)=>value.verdict==='ready'?[]:[{message:'bad verdict'}],ToolArgsError:class extends Error{}}
 try{for(const mode of ['direct','direct-failure','nested','nested-failure','missing','invalid'])await t.test(mode,async()=>{
  const hooks=new Map(),guards=[];let tool,ended=false
  const child={session:{header:{cwd:tree},append(){},snapshotEvents:()=>[]},followup(){},cancel(){},whenIdle:async()=>{
   if(mode==='missing')return
   const execution={name:'structured_output',token:Symbol('capture'),...(mode.startsWith('nested')?{parent:'outer-token'}:{}),concludeTurn(){ended=true}}
   if(mode==='invalid'){await assert.rejects(tool.execute({verdict:'bad'},execution),helpers.ToolArgsError);return}
   const value={verdict:'ready'};await tool.execute(value,execution);value.verdict='mutated-after-execute'
   hooks.get('tools/result')(execution,{isError:mode==='direct-failure'})
   if(mode.startsWith('nested')){assert.match(guards[0](),/DELIVERY_RECORDED/);hooks.get('tools/result')({name:'ptc',token:'outer-token'},{isError:mode==='nested-failure'})}
  }}
  const context={tools:{register:def=>{tool=def},guard:fn=>guards.push(fn)},systemPrompt:{section(){},getSectionOrder:()=>1},on:(name,fn)=>hooks.set(name,fn)}
  const parent={session:{header:{cwd:repo}},ctx:{agents:{create:async opts=>{await opts.setup(context,child);return{agent:child,dispose:async()=>{}}}}}}
  const provider=new LoomWorktreeProvider({paths:store.paths,helpers}),run=await provider.start({label:dispatchLabel('capture','task'),parent,signal:new AbortController().signal,prompt:[],descriptor:{},outputSchema:{type:'object'}})
  const result=await run.result;await run.dispose()
  if(mode==='direct'||mode==='nested'){assert.equal(ended,true);assert.deepEqual(result.structured,{verdict:'ready'});assert.equal(result.stopReason,'completed')}
  else{assert.equal(result.structured,undefined);assert.equal(result.stopReason,'refusal');assert.match(result.diagnostic,/STRUCTURED_OUTPUT_MISSING/)}
 })}finally{rmSync(root,{recursive:true,force:true})}
})
