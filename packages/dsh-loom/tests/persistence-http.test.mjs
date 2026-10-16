import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { LoomStore } from '../lib/store.js'
import { createHandler } from '../lib/http.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { knownCapabilities, normalizeWorkspaceId, FLOW_MAX_AGENTS } from '../lib/core/index.js'
import { requestWorkspace } from '../lib/workspace.js'
import { createTools } from '../lib/tools.js'
import { samplePlannerOutput } from './fixtures.mjs'

test('real HTTP persistence, ownership, locked revisions and prompt baseline', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'loom-http-regression-'))
  const store = new LoomStore(home)
  const sessions = { a: '/tmp/中文项目甲', b: '/tmp/中文项目乙' }
  const query = { readTitleSnapshot: async (id) => ({ session: { cwd: sessions[id] } }) }
  const handler = createHandler({ store, getConfig: () => DEFAULT_CONFIG, setConfig: () => DEFAULT_CONFIG,
    capabilities: knownCapabilities, resolveWorkspace: (req) => requestWorkspace(req, query),
    log: { warn() {}, error() {} } })
  const server = createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${server.address().port}/loom`
  const api = async (route, body, session = 'a', extra = {}) => {
    const res = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-loom-session': session, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, ...await res.json() }
  }
  const wf = samplePlannerOutput()
  const arch = (revision, title = '模块') => ({ schemaVersion: 1, architectureId: 'same-id', revision,
    createdAt: new Date().toISOString(), nodes: [{ id: 'api', kind: 'service', title, responsibility: 'API', locked: true },
      { id: 'web', kind: 'module', title: 'Web', responsibility: '页面' }], edges: [], constraints: ['WSL'] })
  try {
    await t.test('Chinese / punctuation / long paths cannot collide', () => {
      for (const [a, b] of [[sessions.a, sessions.b], ['/tmp/a b', '/tmp/a-b'], ['/tmp/' + 'a'.repeat(140) + 'b', '/tmp/' + 'a'.repeat(140) + 'c']]) {
        assert.notEqual(normalizeWorkspaceId(a), normalizeWorkspaceId(b))
      }
    })
    await t.test('client workspace headers cannot establish or override ownership', async () => {
      assert.equal((await api('/draft', { expectedRevision: null }, '', { 'x-loom-workspace': 'spoof' })).status, 409)
      const state = await api('/state', undefined, 'a', { 'x-loom-workspace': 'spoof' })
      assert.equal(state.data.workspaceId, normalizeWorkspaceId(sessions.a))
    })
    await t.test('first draft and unadopted edited graph survive a fresh store', async () => {
      const saved = await api('/draft', { workflowId: wf.workflowId, candidate: wf, expectedRevision: null })
      assert.equal(saved.status, 200)
      const edited = structuredClone(wf); edited.nodes[2].goal = '用户的新目标'
      assert.equal((await api('/draft', { workflowId: wf.workflowId, candidate: edited, expectedRevision: saved.data.draftRevision })).status, 200)
      assert.equal(new LoomStore(home).readDraft(normalizeWorkspaceId(sessions.a)).candidate.nodes[2].goal, '用户的新目标')
      assert.equal((await api('/state')).data.draft.candidate.nodes[2].goal, '用户的新目标')
      assert.equal((await api('/draft', { workflowId: wf.workflowId, candidate: wf, expectedRevision: saved.data.draftRevision })).status, 409)
    })
    await t.test('drafts and identical workflow IDs are partitioned', async () => {
      assert.equal((await api('/state', undefined, 'b')).data.draft, null)
      assert.equal((await api('/adopt', { workflowId: wf.workflowId, candidate: wf, expectedRevision: null })).status, 200)
      assert.equal((await api('/workflow?workflowId=' + wf.workflowId, undefined, 'b')).status, 404)
      const b = structuredClone(wf); b.title = 'B 项目'
      assert.equal((await api('/adopt', { workflowId: wf.workflowId, candidate: b, expectedRevision: null }, 'b')).status, 200)
      assert.notEqual((await api('/workflow?workflowId=' + wf.workflowId)).data.title, (await api('/workflow?workflowId=' + wf.workflowId, undefined, 'b')).data.title)
      assert.equal((await api('/adopt', { workflowId: wf.workflowId, candidate: b, expectedRevision: null })).status, 409)
    })
    await t.test('identical architecture IDs in other projects do not overlap', async () => {
      assert.equal((await api('/architecture', { architecture: arch(1), expectedRevision: null })).status, 200)
      assert.equal((await api('/architecture?architectureId=same-id', undefined, 'b')).status, 404)
      assert.equal((await api('/architecture', { architecture: arch(1, 'B 模块'), expectedRevision: null }, 'b')).status, 200)
      assert.equal((await api('/architecture?architectureId=same-id')).data.nodes[0].title, '模块')
    })
    await t.test('server rejects changed, deleted or unlocked locked nodes', async () => {
      for (const candidate of [arch(2, '非法更改'), { ...arch(2), nodes: arch(2).nodes.slice(1) },
        { ...arch(2), nodes: arch(2).nodes.map((n) => ({ ...n, locked: false })) }]) {
        const res = await api('/architecture', { architecture: candidate, expectedRevision: 1 })
        assert.equal(res.status, 409); assert.equal(res.code, 'LOCKED_CONFLICT')
      }
    })
    await t.test('immutable architecture versions, exact baseline, cumulative changes', async () => {
      const second = arch(2); second.nodes[1].responsibility = '变更一'
      assert.equal((await api('/architecture', { architecture: second, expectedRevision: 1 })).status, 200)
      const third = structuredClone(second); third.revision = 3; third.nodes[1].title = '变更二'
      assert.equal((await api('/architecture', { architecture: third, expectedRevision: 2 })).status, 200)
      assert.equal((await api('/architecture', { architecture: third, expectedRevision: 2 })).status, 409)
      const prompt = await api('/prompt', { kind: 'architecture', architectureId: 'same-id' })
      assert.equal(prompt.status, 200); assert.equal(prompt.data.baseRevision, 1)
      const payload = JSON.parse(prompt.data.text.match(/```json\n([\s\S]*?)\n```/)[1])
      assert.equal(payload.base.revision, 1); assert.equal(payload.draft.revision, 3)
      assert.equal(payload.userChanges.length, 2); assert.deepEqual(payload.lockedConstraints, ['WSL'])
      const tools = createTools({ store, getConfig: () => DEFAULT_CONFIG, log: { info() {}, warn() {}, error() {} } })
      const exported = await tools.find((t) => t.name === 'loom_prompt').execute({ kind: 'architecture', architectureId: 'same-id' }, { agent: { session: { header: { cwd: sessions.a } } } })
      const toolPayload = JSON.parse(exported.text.match(/```json\n([\s\S]*?)\n```/)[1])
      assert.equal(toolPayload.base.revision, 1); assert.equal(toolPayload.userChanges.length, 2)
      await assert.rejects(tools.find((t) => t.name === 'loom_prompt').execute({ kind: 'architecture', architectureId: 'same-id' }, {}), /WORKSPACE_UNRESOLVED/)
    })
    await t.test('force-remove requires trusted host approval before any IO', async () => {
      assert.equal((await api('/worktree/force-remove', { runId: 'r', taskId: 't' })).status, 403)
    })
    await t.test('AI optimization preview, scope guard, adoption and stale replies', async () => {
      const prompt = await api('/prompt', { kind: 'architecture', architectureId: 'same-id', nodeId: 'web' })
      const current = (await api('/architecture?architectureId=same-id')).data
      const reply = { baseRevision: 1, candidate: structuredClone(current) }
      reply.candidate.nodes[1].responsibility = 'AI 优化后的责任'
      const body = { payloadHash: prompt.data.payloadHash, reply }
      assert.equal((await api('/architecture/preview', body, 'b')).code, 'REQUEST_NOT_FOUND')
      assert.equal((await api('/architecture/preview', { ...body, reply: { ...reply, baseRevision: 99 } })).code, 'BASE_MISMATCH')
      assert.equal((await api('/architecture/preview', { ...body, reply: { ...reply, conflicts: ['尚有接口冲突'] } })).code, 'REPLY_CONFLICT')
      assert.equal((await api('/architecture/preview', { ...body, reply: { ...reply, unknownProtocolField: true } })).code, 'REPLY_SCHEMA')
      const outside = structuredClone(reply)
      outside.candidate.nodes.push({ id: 'outside', kind: 'module', title: '外部', responsibility: '超出范围' })
      assert.equal((await api('/architecture/preview', { ...body, reply: outside })).code, 'SCOPE_CONFLICT')
      const locked = structuredClone(reply); locked.candidate.nodes[0].title = '非法改动'
      assert.equal((await api('/architecture/preview', { ...body, reply: locked })).code, 'LOCKED_CONFLICT')
      const preview = await api('/architecture/preview', body)
      assert.equal(preview.status, 200); assert.equal(preview.data.changes.length, 1)
      assert.equal(store.latestArchitecture('same-id', normalizeWorkspaceId(sessions.a)).revision, 3)
      assert.equal((await api('/architecture/accept', { ...body, expectedRevision: 3, candidateHash: 'tampered' })).code, 'PREVIEW_CHANGED')
      const accepted = await api('/architecture/accept', { ...body, expectedRevision: 3, candidateHash: preview.data.candidateHash })
      assert.equal(accepted.status, 200); assert.equal(accepted.data.candidate.revision, 4)
      assert.equal((await api('/architecture/preview', body)).code, 'STALE_REPLY')
      const exported = await api('/prompt', { kind: 'architecture', architectureId: 'same-id' })
      assert.equal(exported.data.baseRevision, 4)
      assert.equal(store.architectureAt('same-id', 3, normalizeWorkspaceId(sessions.a)).nodes[1].responsibility, '变更一')
    })
    await t.test('mapping binds real node hashes, rejects malformed entries, and does not refresh other stale tasks', async () => {
      const sourceMap = { schemaVersion: 1, workflowId: wf.workflowId, architectureId: 'same-id',
        entries: ['frontend', 'backend'].map((workflowNodeId) => ({ workflowNodeId, architectureNodeIds: ['web'], decisionIds: [], workflowFingerprint: 'forged', basedOnArchitectureRevision: 999 })) }
      const body = { sourceMap, confirmedNodeIds: ['frontend', 'backend'], expectedWorkflowRevision: 1, expectedArchitectureRevision: 4 }
      assert.equal((await api('/sourcemap', { ...body, sourceMap: { ...sourceMap, entries: {} } })).status, 400)
      assert.equal((await api('/sourcemap', { ...body, sourceMap: { ...sourceMap, entries: [null] } })).status, 400)
      const saved = await api('/sourcemap', body)
      assert.equal(saved.status, 200)
      assert.notEqual(saved.data.entries[0].workflowFingerprint, 'forged')
      assert.equal(saved.data.entries[0].basedOnArchitectureRevision, 4)
      const next = (await api('/architecture?architectureId=same-id')).data
      next.revision = 5; next.nodes[1].responsibility = '新架构责任'
      assert.equal((await api('/architecture', { architecture: next, expectedRevision: 4 })).status, 200)
      assert.equal((await api('/state')).data.stale.stale.length, 2)
      const refreshed = await api('/sourcemap', { ...body, sourceMap: saved.data, confirmedNodeIds: ['frontend'], expectedArchitectureRevision: 5 })
      assert.equal(refreshed.status, 200)
      assert.equal(refreshed.data.entries.find((e) => e.workflowNodeId === 'backend').basedOnArchitectureRevision, 4)
      assert.deepEqual((await api('/state')).data.stale.stale.map((e) => e.workflowNodeId), ['backend'])
      assert.equal((await api('/sourcemap', { ...body, sourceMap: { ...sourceMap, entries: sourceMap.entries.slice(0, 1) }, confirmedNodeIds: ['frontend'], expectedArchitectureRevision: 5 })).status, 400)
    })
    await t.test('terminal run fact supersedes running without affecting another workspace', async () => {
      for (const state of ['running', 'validated']) store.appendRun({ workspaceId: normalizeWorkspaceId(sessions.a), runId: 'terminal', workflowId: wf.workflowId, revision: 1, state, startedAt: new Date().toISOString(), planHash: 'hash', attempt: 1 })
      assert.equal(store.latestRuns(10, normalizeWorkspaceId(sessions.a)).find((r) => r.runId === 'terminal').state, 'validated')
      assert.equal((await api('/state')).data.runs.find((r) => r.runId === 'terminal').state, 'validated')
      assert.equal((await api('/runs', undefined, 'b')).data.length, 0)
    })
    await t.test('explicit workflow and prompt revisions never fall back to latest', async () => {
      const next = structuredClone(wf); next.nodes.find((n) => n.id === 'frontend').goal = 'Only revision two goal'
      assert.equal((await api('/adopt', { workflowId: wf.workflowId, candidate: next, expectedRevision: 1 })).status, 200)
      assert.equal((await api('/workflow?workflowId=' + wf.workflowId + '&revision=999')).status, 404)
      assert.equal((await api('/workflow?workflowId=' + wf.workflowId + '&revision=1')).data.revision, 1)
      assert.equal((await api('/prompt', { kind: 'task', workflowId: wf.workflowId, nodeId: 'frontend', revision: 999 })).status, 404)
      const old = await api('/prompt', { kind: 'task', workflowId: wf.workflowId, nodeId: 'frontend', revision: 1 })
      assert.doesNotMatch(old.data.text, /Only revision two goal/)
      assert.match((await api('/prompt', { kind: 'task', workflowId: wf.workflowId, nodeId: 'frontend', revision: 2 })).data.text, /Only revision two goal/)
      const tools = createTools({ store, getConfig: () => DEFAULT_CONFIG, log: { info() {}, warn() {}, error() {} } })
      const exec = { agent: { session: { header: { cwd: sessions.a } } } }
      const tool = tools.find((t) => t.name === 'loom_prompt')
      await assert.rejects(tool.execute({ kind: 'task', workflowId: wf.workflowId, nodeId: 'frontend', revision: 999 }, exec), /找不到/)
      assert.doesNotMatch((await tool.execute({ kind: 'task', workflowId: wf.workflowId, nodeId: 'frontend', revision: 1 }, exec)).text, /Only revision two goal/)
    })
  } finally { await new Promise((resolve) => server.close(resolve)); rmSync(home, { recursive: true, force: true }) }
})

test('planning collect reads the plan file the model writes in the session directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-http-collect-'))
  const cwd = mkdtempSync(join(tmpdir(), 'loom-collect-cwd-'))
  const store = new LoomStore(home)
  const query = { readTitleSnapshot: async () => ({ session: { cwd } }) }
  const handler = createHandler({ store, getConfig: () => DEFAULT_CONFIG, setConfig: () => DEFAULT_CONFIG,
    capabilities: knownCapabilities, resolveWorkspace: (req) => requestWorkspace(req, query), resolveSessionCwd: () => cwd,
    log: { warn() {}, error() {} } })
  const server = createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${server.address().port}/loom`
  const get = async (route) => { const res = await fetch(url + route, { headers: { 'x-loom-session': 'collect-session' } }); return { status: res.status, ...await res.json() } }
  try {
    assert.equal((await get('/planning/collect')).data.text, null)
    mkdirSync(join(cwd, '.loom'), { recursive: true })
    writeFileSync(join(cwd, '.loom', 'plan.json'), '{"requestId":"hash-1"}')
    const found = await get('/planning/collect?t=1')
    assert.equal(found.status, 200)
    assert.equal(found.data.text, '{"requestId":"hash-1"}')
    assert.equal(found.data.path, '.loom/plan.json')
    assert.ok(found.data.mtimeMs > 0)
    assert.equal(found.data.requestId, null, '还没导出过规划请求时不能给出 requestId')
    // 窗口重开后客户端内存里没有导出记录，只能靠服务端记的这个 requestId
    // 判断项目里的计划文件是不是为最近一次请求写的。
    store.savePlanningRequest(normalizeWorkspaceId(cwd), { payloadHash: 'hash-1', goal: '目标', constraints: [], architectureId: 'loom-architecture',
      workflowId: 'loom-default', expectedArchitectureRevision: null, expectedWorkflowRevision: null, expectedDraftRevision: null, maxConcurrency: 2 })
    assert.equal((await get('/planning/collect?t=2')).data.requestId, 'hash-1')
  } finally { await new Promise((resolve) => server.close(resolve)); rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }) }
})

test('planning stage writes the request document into the session directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-http-stage-'))
  const cwd = mkdtempSync(join(tmpdir(), 'loom-stage-cwd-'))
  const store = new LoomStore(home)
  const query = { readTitleSnapshot: async () => ({ session: { cwd } }) }
  const handler = createHandler({ store, getConfig: () => DEFAULT_CONFIG, setConfig: () => DEFAULT_CONFIG,
    capabilities: knownCapabilities, resolveWorkspace: (req) => requestWorkspace(req, query), resolveSessionCwd: () => cwd,
    log: { warn() {}, error() {} } })
  const server = createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${server.address().port}/loom`
  const post = async (route, body) => { const res = await fetch(url + route, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-loom-session': 'stage-session' }, body: JSON.stringify(body) })
    return { status: res.status, ...await res.json() } }
  try {
    assert.equal((await post('/planning/stage', { text: '' })).status, 400)
    const staged = await post('/planning/stage', { text: '# 规划请求\n读取我' })
    assert.equal(staged.status, 200)
    assert.equal(staged.data.path, '.loom/plan-request.md')
    assert.equal(readFileSync(join(cwd, '.loom', 'plan-request.md'), 'utf8'), '# 规划请求\n读取我')
  } finally { await new Promise((resolve) => server.close(resolve)); rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }) }
})

test('session planning mode survives a fresh store and validates input', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-http-planning-mode-'))
  const cwd = mkdtempSync(join(tmpdir(), 'loom-planning-mode-cwd-'))
  const store = new LoomStore(home)
  const query = { readTitleSnapshot: async () => ({ session: { cwd } }) }
  const handler = createHandler({ store, getConfig: () => DEFAULT_CONFIG, setConfig: () => DEFAULT_CONFIG,
    capabilities: knownCapabilities, resolveWorkspace: (req) => requestWorkspace(req, query), resolveSessionCwd: () => cwd,
    log: { warn() {}, error() {} } })
  const server = createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${server.address().port}/loom`
  const get = async () => { const res = await fetch(url + '/session/planning-mode', { headers: { 'x-loom-session': 'mode-session' } }); return { status: res.status, ...await res.json() } }
  const post = async (body) => { const res = await fetch(url + '/session/planning-mode', { method: 'POST', headers: { 'content-type': 'application/json', 'x-loom-session': 'mode-session' }, body: JSON.stringify(body) }); return { status: res.status, ...await res.json() } }
  try {
    assert.equal((await get()).data.planningMode, false, '默认不是规划模式')
    assert.equal((await post({ planningMode: true })).data.planningMode, true)
    assert.equal((await get()).data.planningMode, true, '写入后读回仍是 true')
    assert.equal(new LoomStore(home).readSessionPlanningMode('mode-session'), true, '新存储实例里也在（落盘）')
    assert.equal((await post({ planningMode: false })).data.planningMode, false)
    assert.equal((await post({ planningMode: 'yes' })).status, 400, '非布尔值必须拒绝')
    assert.equal((await post({ planningMode: true, extra: 1 })).status, 400, '多余字段必须拒绝')
  } finally { await new Promise((resolve) => server.close(resolve)); rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }) }
})

test('a fresh session follows planningModeDefault until it is changed for that session (S7)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-http-plan-default-'))
  const cwd = mkdtempSync(join(tmpdir(), 'loom-plan-default-cwd-'))
  const store = new LoomStore(home)
  let config = { ...DEFAULT_CONFIG, planningModeDefault: true }
  const query = { readTitleSnapshot: async () => ({ session: { cwd } }) }
  const handler = createHandler({ store, getConfig: () => config, setConfig: (next) => (config = next),
    capabilities: knownCapabilities, resolveWorkspace: (req) => requestWorkspace(req, query), resolveSessionCwd: () => cwd,
    log: { warn() {}, error() {} } })
  const server = createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${server.address().port}/loom`
  const call = async (route, body) => {
    const res = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-loom-session': 'default-session' },
      body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, ...await res.json() }
  }
  try {
    const fresh = await call('/session/planning-mode')
    assert.equal(fresh.data.planningMode, true, '没记过的会话用全局默认')
    assert.equal(fresh.data.source, 'default')
    // 用户在这个会话里关掉 → 必须真的关掉，不能又被默认值拉回去。
    assert.equal((await call('/session/planning-mode', { planningMode: false })).data.planningMode, false)
    const off = await call('/session/planning-mode')
    assert.equal(off.data.planningMode, false)
    assert.equal(off.data.source, 'session')
    // 另一个会话仍走默认。
    const other = await fetch(url + '/session/planning-mode', { headers: { 'content-type': 'application/json', 'x-loom-session': 'other-session' } })
    const otherBody = await other.json()
    assert.equal(otherBody.data.planningMode, true)
    assert.equal(otherBody.data.source, 'default')
    // 关掉默认值后，没记过的会话回到 false。
    config = { ...config, planningModeDefault: false }
    const again = await fetch(url + '/session/planning-mode', { headers: { 'content-type': 'application/json', 'x-loom-session': 'third-session' } })
    assert.equal((await again.json()).data.planningMode, false)
  } finally { await new Promise((resolve) => server.close(resolve)); rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }) }
})

test('planning mode is a session switch, not a project write: it works before a workspace exists', async () => {
  // 用户反馈：新对话（还没选工作区）里点「规划模式」，聊天框挂出
  // 「会话已切换，请等待项目加载后再保存」。根因是这条端点被错归进
  // 「需要工作区」的路由集。规划模式只按 sessionId 读写，不碰工作区 ——
  // 而且它恰恰是「还没有项目时最该能用」的开关，所以必须放行。
  const home = mkdtempSync(join(tmpdir(), 'loom-http-plan-nows-'))
  const cwd = mkdtempSync(join(tmpdir(), 'loom-plan-nows-cwd-'))
  const store = new LoomStore(home)
  const handler = createHandler({ store, getConfig: () => DEFAULT_CONFIG, setConfig: () => DEFAULT_CONFIG,
    capabilities: knownCapabilities,
    // 关键：拿不到工作区（等价于新会话、还没选目录）。
    resolveWorkspace: () => null,
    resolveSessionCwd: () => cwd,
    log: { warn() {}, error() {} } })
  const server = createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${server.address().port}/loom`
  const call = async (route, body) => {
    const res = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-loom-session': 'blank-session' },
      body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, ...await res.json() }
  }
  try {
    const read = await call('/session/planning-mode')
    assert.equal(read.status, 200, `没有工作区也应读得到规划模式，实际 ${read.status} ${JSON.stringify(read)}`)
    assert.equal(read.data.planningMode, false)
    const on = await call('/session/planning-mode', { planningMode: true })
    assert.equal(on.status, 200, `没有工作区也应写得进规划模式，实际 ${on.status} ${JSON.stringify(on)}`)
    assert.equal(on.data.planningMode, true)
    assert.equal((await call('/session/planning-mode')).data.planningMode, true, '写入后读回仍是 true')
    // 对照组：真正需要工作区的写入仍必须被拦下（不能顺手把闸门拆了）。
    const projectWrite = await call('/draft', { mode: 'manual' })
    assert.equal(projectWrite.status, 409, '项目写入在没有工作区时仍要 409')
    assert.equal(projectWrite.code, 'WORKSPACE_UNRESOLVED')
  } finally { await new Promise((resolve) => server.close(resolve)); rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }) }
})

test('flow GET publishes the agent cap so the client cannot drift from the host', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-http-flowcap-'))
  const cwd = mkdtempSync(join(tmpdir(), 'loom-flowcap-cwd-'))
  const store = new LoomStore(home)
  const query = { readTitleSnapshot: async () => ({ session: { cwd } }) }
  const handler = createHandler({ store, getConfig: () => DEFAULT_CONFIG, setConfig: () => DEFAULT_CONFIG,
    capabilities: knownCapabilities, resolveWorkspace: (req) => requestWorkspace(req, query), resolveSessionCwd: () => cwd,
    log: { warn() {}, error() {} } })
  const server = createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${server.address().port}/loom`
  const call = async (route, body) => {
    const res = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-loom-session': 'flow-session' },
      body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, ...await res.json() }
  }
  try {
    const wf = samplePlannerOutput()
    assert.equal((await call('/adopt', { workflowId: wf.workflowId, candidate: wf, expectedRevision: null })).status, 200)
    const flow = await call('/flow?workflowId=' + encodeURIComponent(wf.workflowId))
    assert.equal(flow.status, 200)
    // 上限与宿主调度同源：客户端下拉读它，不该自己写死（实测值见 flow-plan.test.mjs）。
    assert.equal(flow.data.maxAgents, 3)
    assert.equal(FLOW_MAX_AGENTS, flow.data.maxAgents)
    // 超过上限的计划不许落盘。
    const tooMany = { workflowId: wf.workflowId, revision: wf.revision,
      steps: wf.nodes.map((n) => ({ id: 'step-' + n.id.replace(/[^a-z0-9_-]/g, ''), taskIds: [n.id], agents: 4 })),
      order: wf.nodes.map((n) => 'step-' + n.id.replace(/[^a-z0-9_-]/g, '')),
      groups: [], auditAgents: [{ id: 'audit-1', label: '审计 1', groupId: null }], updatedAt: new Date().toISOString() }
    const rejected = await call('/flow', { workflowId: wf.workflowId, plan: tooMany })
    assert.equal(rejected.status, 400, JSON.stringify(rejected))
  } finally { await new Promise((resolve) => server.close(resolve)); rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }) }
})
