import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoomStore } from '../lib/store.js'
import { createRemoteRequest } from '../lib/remote.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { knownCapabilities, normalizeWorkspaceId, contentDigest } from '../lib/core/index.js'
import { samplePlannerOutput } from './fixtures.mjs'

const architecture = (id, rev = 1) => ({ schemaVersion: 1, architectureId: id, revision: rev, createdAt: '2026-10-02T01:00:00Z',
  constraints: ['WSL'], nodes: [{ id: 'api', kind: 'service', title: 'API', responsibility: '后端服务', locked: true }, { id: 'web', kind: 'module', title: 'Web', responsibility: '页面' }], edges: [] })
const replyFor = (request) => {
  const all = samplePlannerOutput()
  const wf = { ...all, workflowId: request.workflowId, revision: (request.expectedWorkflowRevision ?? 0) + 1,
    detectedStage: 'implementation', executionProposal: { ...all.executionProposal, maxConcurrency: request.maxConcurrency, requiredBaseline: 'selected-frozen-commit', requiredCapabilities: ['real-parent-agent', 'parallel-agents', 'worktree', 'cancel-cleanup', 'artifact-verification', 'wsl-execution'] },
    nodes: all.nodes.filter((n) => ['frontend', 'backend'].includes(n.id)).map((n) => ({ ...n, inputs: [] })), edges: [] }
  return { requestId: request.payloadHash, architecture: architecture(request.architectureId, (request.expectedArchitectureRevision ?? 0) + 1), workflow: wf,
    mappings: [{ workflowNodeId: 'frontend', architectureNodeIds: ['web'] }, { workflowNodeId: 'backend', architectureNodeIds: ['api'], decisionIds: [] }], explanation: '依据真实用户输入拆分' }
}

test('initial planning uses real project scope, preview, atomic adoption and settings persistence', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loom-planning-'))
  const store = new LoomStore(home)
  let config = { ...DEFAULT_CONFIG }
  const sessions = { a: '/tmp/项目甲', b: '/tmp/项目乙' }
  let scmCalls = []
  const rpc = createRemoteRequest({ store, getConfig: () => config, setConfig: (next) => (config = next), capabilities: knownCapabilities,
    resolveWorkspace: (req) => sessions[req.headers['x-loom-session']] ? normalizeWorkspaceId(sessions[req.headers['x-loom-session']]) : null,
    resolveSessionId: (req) => sessions[req.headers['x-loom-session']] ? req.headers['x-loom-session'] : null,
    resolveSessionCwd: (req) => sessions[req.headers['x-loom-session']] ?? null,
    scmFacts: async (cwd) => { scmCalls.push(cwd); return { repo: cwd, head: 'a'.repeat(40), dirty: false } },
    log: { warn() {}, error() {} } })
  const call = async (path, body, sessionId = 'a') => { const out = await rpc({ sessionId, path, method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body }) }); return { status: out.status, ...out.payload } }
  const input = { goal: '原创任务管理项目，包括前后端', constraints: ['WSL'], expectedArchitectureRevision: null, expectedWorkflowRevision: null }
  const ws = normalizeWorkspaceId(sessions.a)
  try {
    await t.test('settings are typed, persistent, and total/session switches stop writes', async () => {
      assert.equal((await call('/config')).data.enabled, true)
      assert.equal((await call('/config', undefined, '')).data.enabled, true)
      assert.equal((await call('/config', { defaultMode: 'auto' }, '')).status, 200)
      await assert.rejects(call('/draft', { expectedRevision: null }, ''), /LOOM_SESSION_REQUIRED/)
      assert.equal((await call('/config', { enabled: 'false' })).status, 400)
      assert.equal((await call('/config', { defaultMaxConcurrency: 20 })).status, 400)
      assert.equal((await call('/config', { unknown: true })).status, 400)
      assert.equal((await call('/config', { constructor: true })).status, 400)
      assert.equal((await call('/config', { enabled: false, defaultMode: 'manual', defaultMaxConcurrency: 3 })).status, 200)
      const fresh = new LoomStore(home).readConfig()
      assert.equal(fresh.enabled, false); assert.equal(fresh.defaultMode, 'manual'); assert.equal(fresh.defaultMaxConcurrency, 3)
      assert.equal((await call('/planning/export', input)).code, 'LOOM_DISABLED')
      assert.equal((await call('/draft', { expectedRevision: null })).code, 'LOOM_DISABLED')
      await call('/config', { enabled: true })
      await call('/session/activation', { enabled: false })
      assert.equal(new LoomStore(home).readSessionActivation('a'), false)
      assert.equal((await call('/state')).data.sessionEnabled, false)
      assert.equal((await call('/session/activation', undefined, 'b')).data.enabled, true)
      assert.equal((await call('/planning/export', input)).code, 'LOOM_DISABLED')
      await call('/session/activation', { enabled: true })
    })
    await t.test('SCM facts receive host session cwd and never request-controlled cwd', async () => {
      const facts = await call('/scm?cwd=/tmp/forged')
      assert.equal(facts.data.repo, sessions.a); assert.deepEqual(scmCalls, [sessions.a])
      assert.equal((await call('/scm', undefined, 'missing')).status, 409)
    })
    const exported = await call('/planning/export', input)
    assert.equal(exported.status, 200)
    const request = exported.data.request
    const reply = replyFor(request)
    const body = { payloadHash: request.payloadHash, reply }
    let preview
    await t.test('request-bound schema and explicit full mappings reject wrong or fabricated replies', async () => {
      assert.match(exported.data.text, /只规划/); assert.match(exported.data.prompt, /requestId/)
      assert.equal((await call('/planning/preview', body, 'b')).code, 'REQUEST_NOT_FOUND')
      assert.equal((await call('/planning/preview', { ...body, reply: { ...reply, requestId: 'other' } })).code, 'REQUEST_MISMATCH')
      assert.equal((await call('/planning/preview', { ...body, reply: { ...reply, ignored: true } })).code, 'PLANNING_SCHEMA')
      assert.equal((await call('/planning/preview', { ...body, reply: { ...reply, mappings: reply.mappings.slice(1) } })).code, 'MAPPING_INVALID')
      const missing = structuredClone(reply); missing.mappings[0].architectureNodeIds = ['fake']
      assert.equal((await call('/planning/preview', { ...body, reply: missing })).code, 'MAPPING_INVALID')
      const constraints = structuredClone(reply); constraints.architecture.constraints = []
      assert.equal((await call('/planning/preview', { ...body, reply: constraints })).code, 'LOCKED_CONFLICT')
      const phase = structuredClone(reply); phase.workflow.nodes[0].execution.isolation = 'prepared-baseline'
      assert.equal((await call('/planning/preview', { ...body, reply: phase })).code, 'UNSUPPORTED_PHASE')
    })
    await t.test('preview is read-only, hash is stable across previews, and one atomic write adopts all state', async () => {
      preview = await call('/planning/preview', body); assert.equal(preview.status, 200)
      assert.equal((await call('/planning/preview', body)).data.candidateHash, preview.data.candidateHash)
      assert.equal(store.listArchitectures(ws).length, 0); assert.equal(store.listRevisions(ws).length, 0); assert.equal(store.readDraft(ws), null)
      const accept = { ...body, candidateHash: preview.data.candidateHash, expectedArchitectureRevision: null, expectedWorkflowRevision: null }
      assert.equal((await call('/planning/accept', { ...accept, candidateHash: 'forged' })).code, 'PREVIEW_CHANGED')
      const temp = store.workspacePaths(ws).dir
      chmodSync(temp,0o555)
      let failed
      try {failed=await call('/planning/accept',accept)}finally{chmodSync(temp,0o755)}
      assert.notEqual(failed.status, 200)
      assert.equal(store.listArchitectures(ws).length, 0); assert.equal(store.listRevisions(ws).length, 0); assert.equal(store.readSourceMap(ws), null)
      const accepted = await call('/planning/accept', accept); assert.equal(accepted.status, 200)
      const fresh = new LoomStore(home)
      assert.equal(fresh.latestArchitecture(request.architectureId, ws).revision, 1)
      assert.equal(fresh.latestRevision(request.workflowId, ws).nodes.length, 2)
      assert.equal(fresh.readDraft(ws).architectureId, request.architectureId)
      assert.equal(fresh.readDraft(ws).mode, 'manual')
      assert.equal(fresh.readSourceMap(ws).entries[0].workflowFingerprint, contentDigest(reply.workflow.nodes[0]))
      assert.equal(fresh.readSourceMap(ws).entries[0].basedOnArchitectureRevision, 1)
      assert.equal((await call('/planning/preview', body)).code, 'STALE_REPLY')
      assert.equal((await call('/state', undefined, 'b')).data.architectures.length, 0)
    })
    await t.test('post-adoption draft, source-map and immutable revisions remain writable via the same store', async () => {
      const draft = store.readDraft(ws)
      assert.equal(store.writeDraft({ ...draft, draftRevision: draft.draftRevision + 1 }, { expectedRevision: draft.draftRevision }).ok, true)
      const nextArch = structuredClone(store.latestArchitecture(request.architectureId, ws)); nextArch.revision = 2; nextArch.nodes[1].responsibility = '用户编辑的职责'
      store.appendArchitecture(nextArch, ws)
      const nextWf = { ...store.latestRevision(request.workflowId, ws), revision: 2 }
      store.appendRevision(nextWf, ws)
      store.writeSourceMap(ws, { ...store.readSourceMap(ws), entries: [] })
      const fresh = new LoomStore(home)
      assert.equal(fresh.latestArchitecture(request.architectureId, ws).revision, 2)
      assert.equal(fresh.architectureAt(request.architectureId, 1, ws).nodes[1].responsibility, '页面')
      assert.equal(fresh.latestRevision(request.workflowId, ws).revision, 2)
      assert.equal(fresh.readSourceMap(ws).entries.length, 0)
      assert.equal(JSON.parse(readFileSync(join(fresh.workspacePaths(ws).dir, 'planning-state.json'), 'utf8')).revisions.length, 2)
    })
    await t.test('later initial planning pins draft changes and existing locks', async () => {
      const next = await call('/planning/export', { ...input, architectureId: request.architectureId, workflowId: request.workflowId, expectedArchitectureRevision: 2, expectedWorkflowRevision: 2 })
      assert.equal(next.status, 200)
      const altered = replyFor(next.data.request); altered.architecture.nodes[0].title = '改锁定节点'
      assert.equal((await call('/planning/preview', { payloadHash: next.data.payloadHash, reply: altered })).code, 'LOCKED_CONFLICT')
      const current = store.readDraft(ws); store.writeDraft({ ...current, draftRevision: current.draftRevision + 1 }, { expectedRevision: current.draftRevision })
      assert.equal((await call('/planning/preview', { payloadHash: next.data.payloadHash, reply: replyFor(next.data.request) })).code, 'STALE_REPLY')
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('global settings remain readable and writable with a blocked selected session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-global-settings-'))
  let calls = 0
  const blocked = () => { calls++; return new Promise(() => {}) }
  const store = new LoomStore(home)
  const rpc = createRemoteRequest({store, resolveWorkspace: blocked, resolveSessionId: blocked, getConfig: () => ({...DEFAULT_CONFIG}), setConfig: patch => store.writeConfig(patch), log: {warn(){},error(){}}})
  const call = async (body) => {
    let timer
    try { return await Promise.race([
      rpc({sessionId:'corrupt-session',path:'/config',method:body ? 'POST' : 'GET',...(body ? {body} : {})}),
      new Promise((_,reject) => {timer=setTimeout(() => reject(Error('global settings waited for session')),500)})
    ]) } finally {clearTimeout(timer)}
  }
  try {
    const read = await call(); assert.equal(read.status,200); assert.equal(read.payload.data.enabled,true)
    const write = await call({defaultMode:'manual'}); assert.equal(write.status,200)
    assert.equal(new LoomStore(home).readConfig().defaultMode,'manual'); assert.equal(calls,0)
  } finally {rmSync(home,{recursive:true,force:true})}
})
