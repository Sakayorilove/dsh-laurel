import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as loom from '../lib/index.js'
import { createRemoteRequest, parseLoomRequest } from '../lib/remote.js'

const expectedVersion = createRequire(import.meta.url)('../package.json').version
// 宿主锚点可配置、可校验：只有第一个用例要真宿主。
import { hostRequire as host, hostTest, hostAnchor } from '../scripts/host-anchor.mjs'
hostTest('real Cordis + ToolRuntime + Typert Gateway mount, RPC persistence, unload; no model', async () => {
  const { Context } = host('@deepseek-ai/cordis')
  const { default: Registry } = host('@deepseek-ai/dsh-typert-registry')
  const { default: Gateway } = host('@deepseek-ai/dsh-api-gateway')
  const { default: Tools } = host('@deepseek-ai/dsh-tools')
  const root = mkdtempSync(join(tmpdir(), 'loom-native-host-'))
  const previous = process.env.DSH_HOME, entry = process.argv[1]
  process.env.DSH_HOME = root; process.argv[1] = hostAnchor
  const ctx = new Context()
  try {
    ctx.provide('sessionQuery', { readTitleSnapshot: async (id) => ({ session: { cwd: id === 'a' ? join(root, '项目甲') : id === 'b' ? join(root, '项目乙') : undefined } }) })
    await ctx.plugin(host('@deepseek-ai/dsh-system-prompt').default); await ctx.plugin(Registry); await ctx.plugin(Gateway, {}); await ctx.plugin(Tools, {})
    const fiber = await ctx.plugin(loom)
    const invoke = input => ctx.typertGateway.invoke({ namespace: 'loom', method: 'request', args: { input } })
    await new Promise(resolve => setTimeout(resolve, 50))
    const state = await invoke({ sessionId: 'a', method: 'GET', path: '/state' })
    const diagnostic=await invoke({sessionId:'',method:'GET',path:'/diagnostics'});assert.equal(diagnostic.payload.data.loadedVersion,expectedVersion);assert.equal(diagnostic.payload.data.installedVersion,expectedVersion);assert.equal(diagnostic.payload.data.services.remote,true);assert.equal(JSON.stringify(diagnostic).includes('current prompt'),false)
    assert.equal(state.status, 200); assert.equal(state.payload.ok, true)
    assert.ok(ctx.tools.get('loom_run'), 'real host registry admitted tools')
    const validation = await ctx.tools.execute({ name: 'loom_validate', arguments: { kind: 'architecture', document: '{}' }, callId: 'loom-output-contract', signal: new AbortController().signal })
    assert.equal(validation.isError, false, JSON.stringify(validation))
    assert.equal(validation.value.ok, false, 'invalid input has a valid structured tool result')
    assert.ok(Array.isArray(validation.value.errors))
    assert.match(JSON.stringify(validation.content), /校验未通过/)

    const saved = await invoke({ sessionId: 'a', method: 'POST', path: '/draft', body: { expectedRevision: null, mode: 'auto' } })
    assert.equal(saved.payload.ok, true, JSON.stringify(saved))
    assert.equal((await invoke({ sessionId: 'a', method: 'GET', path: '/state' })).payload.data.draft.mode, 'auto')
    assert.equal((await invoke({ sessionId: 'b', method: 'GET', path: '/state' })).payload.data.draft, null)
    assert.equal((await invoke({ sessionId: 'missing', method: 'POST', path: '/draft', body: { expectedRevision: null, mode: 'manual' } })).status, 409)
    await assert.rejects(invoke({ sessionId: 'a', method: 'POST', path: '/worktree/force-remove', body: {} }))
    // 0.7.2：新路由必须真的过网关（不是只过 parse 单测）——没任务图时是 404，不是边界拒绝。
    const flow = await invoke({ sessionId: 'a', method: 'GET', path: '/flow?workflowId=loom-default' })
    assert.equal(flow.status, 404, '经真实 Typert 网关读 /flow 应到达业务层（404＝没任务图），而不是被边界拦下')
    const planningMode = await invoke({ sessionId: 'a', method: 'GET', path: '/session/planning-mode' })
    assert.equal(planningMode.status, 200, '规划模式查询应经网关成功')
    assert.equal(planningMode.payload.data.planningMode, false)
    await assert.rejects(invoke({ sessionId: 'a', method: 'GET', path: '/state', workspaceId: 'forged' }))
    await fiber.dispose()
    assert.equal(ctx.tools.get('loom_run'), undefined, 'unload removes host tool registration')
    await assert.rejects(invoke({ sessionId: 'a', method: 'GET', path: '/state' }))
  } finally {
    await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true })
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    process.argv[1] = entry
  }
})

test('Remote boundary rejects external paths, unsupported operations, unknown keys and large body', () => {
  for (const path of ['//evil/state', '/draft/../state', '/state#x', '/%73tate', '/worktree/force-remove']) {
    assert.throws(() => parseLoomRequest({ sessionId: 'a', method: 'POST', path }))
  }
  assert.equal(parseLoomRequest({ sessionId: '', method: 'GET', path: '/config' }).path, '/config')
  assert.equal(parseLoomRequest({ sessionId: '', method: 'POST', path: '/config', body: { enabled: true } }).path, '/config')
  assert.throws(() => parseLoomRequest({ sessionId: '', method: 'GET', path: '/workflow' }), /LOOM_SESSION_REQUIRED/)
  assert.throws(() => parseLoomRequest({ sessionId: 'a', method: 'GET', path: '/state', body: {} }))
  assert.throws(() => parseLoomRequest({ sessionId: 'a', method: 'POST', path: '/draft', body: { text: 'x'.repeat(600000) } }))
  // 客户端在真宿主里只用 RPC、没有 HTTP 回退 —— 凡是客户端会调的路由都必须在白名单里，
  // 少一条就是整条功能不可达（0.7.2 修的正是 /flow 等五条）。
  assert.equal(parseLoomRequest({ sessionId: 'a', method: 'GET', path: '/flow?workflowId=loom-default' }).path, '/flow?workflowId=loom-default')
  assert.equal(parseLoomRequest({ sessionId: 'a', method: 'POST', path: '/flow', body: { workflowId: 'loom-default', plan: {} } }).path, '/flow')
  assert.equal(parseLoomRequest({ sessionId: 'a', method: 'POST', path: '/flow/apply', body: {} }).path, '/flow/apply')
  assert.equal(parseLoomRequest({ sessionId: 'a', method: 'GET', path: '/session/planning-mode' }).path, '/session/planning-mode')
  assert.equal(parseLoomRequest({ sessionId: 'a', method: 'POST', path: '/session/planning-mode', body: { planningMode: true } }).path, '/session/planning-mode')
  assert.equal(parseLoomRequest({ sessionId: 'a', method: 'POST', path: '/planning/stage', body: { text: 'x' } }).path, '/planning/stage')
  assert.equal(parseLoomRequest({ sessionId: 'a', method: 'GET', path: '/planning/collect' }).path, '/planning/collect')
})

test('cancelled RPC after delayed workspace resolution cannot save a draft', async () => {
  const { LoomStore } = await import('../lib/store.js')
  const { DEFAULT_CONFIG } = await import('../lib/config.js')
  const { knownCapabilities } = await import('../lib/core/index.js')
  const root = mkdtempSync(join(tmpdir(), 'loom-rpc-cancel-')), store = new LoomStore(root)
  let release;const waiting = new Promise(resolve => { release = resolve })
  const request = createRemoteRequest({store,getConfig:()=>DEFAULT_CONFIG,setConfig:()=>DEFAULT_CONFIG,capabilities:knownCapabilities,
    resolveWorkspace:async()=>{await waiting;return 'project-a'},log:{warn(){},error(){}}})
  try {
    const controller=new AbortController()
    const saving=request({sessionId:'a',path:'/draft',method:'POST',body:{expectedRevision:null,mode:'auto'}},controller.signal)
    controller.abort();release()
    const result=await saving
    assert.equal(result.payload.ok,false)
    assert.equal(store.readDraft('project-a'),null)
  } finally {rmSync(root,{recursive:true,force:true})}
})
