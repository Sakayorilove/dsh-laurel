import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerCommands } from '../lib/commands.js'
import { LoomStore } from '../lib/store.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { normalizeWorkspaceId, adoptPlannerOutput } from '../lib/core/index.js'
import { samplePlannerOutput } from './fixtures.mjs'
// 宿主锚点可配置、可校验；本文件两个用例都要真宿主。
import { hostRequire as host, hostTest } from '../scripts/host-anchor.mjs'

hostTest('real CommandRuntime and Session log: admitted job, actual receiver, cancellation, scope and switch', async () => {
  const { Context } = host('@deepseek-ai/cordis'), { Session } = host('@deepseek-ai/dsh-session')
  const root = mkdtempSync(join(tmpdir(), 'loom-command-')), ctx = new Context()
  const store = new LoomStore(root), cwd = join(root, 'repo'), ws = normalizeWorkspaceId(cwd)
  const workflow = adoptPlannerOutput(samplePlannerOutput()).workflow
  store.appendRevision(workflow, ws)
  const receiver = { ctx, session: Session.create('command-a', undefined, { version: 4, id: 'command-a', cwd, createdAt: Date.now(), isSeeded: false }) }
  const other = { ctx, session: Session.create('command-b', undefined, { version: 4, id: 'command-b', cwd: join(root, 'other'), createdAt: Date.now(), isSeeded: false }) }
  const sha = 'a'.repeat(40)
  let config = { ...DEFAULT_CONFIG }, received, running, cancelled = false
  await ctx.plugin(host('@deepseek-ai/dsh-commands').default)
  const fiber = await ctx.plugin({ inject: ['commands'], apply(child) {
    registerCommands(child, { store, getConfig: () => config, scmFacts: async () => ({ repo: cwd, head: sha, dirty: false }), log: { warn() {} },
      runWorkflow: async (wf, exec, args) => {
        received = exec.agent; running = args.runId
        await new Promise(resolve => { exec.signal.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true }) })
        store.appendRun({ workspaceId: ws, runId: args.runId, workflowId: wf.workflowId, revision: wf.revision, planHash: 'cancel', attempt: 1, state: 'cancelled', startedAt: new Date().toISOString() })
      }, cancelRun: async () => false })
  } })
  const command = (line, agent = receiver) => ctx.get('commands').execute(agent, line, [], new AbortController().signal)
  try {
    assert.equal((await command('/loom status')).result.kind, 'success')
    await command('/loom off')
    assert.equal((await command(`/loom run ${workflow.workflowId} 1 ${sha}`)).result.kind, 'error')
    await command('/loom on')
    config.enabled = false
    assert.equal((await command(`/loom run ${workflow.workflowId} 1 ${sha}`)).result.kind, 'error')
    config.enabled = true
    assert.equal((await command(`/loom run ${workflow.workflowId} 1 ${'b'.repeat(40)}`)).result.kind, 'error')
    const admitted = await command(`/loom run ${workflow.workflowId} 1 ${sha}`)
    assert.equal(admitted.result.kind, 'success'); assert.equal(received, receiver)
    assert.ok(store.latestRuns(10, ws).some(r => r.state === 'queued' && r.runId === running))
    assert.equal((await command(`/loom cancel ${running}`, other)).result.kind, 'error')
    await command(`/loom cancel ${running}`); assert.equal(cancelled, true)
    assert.equal(store.latestRuns(10, ws).find(r => r.runId === running).state, 'cancelled')
    assert.ok(receiver.session.snapshotEvents().some(e => e.type === 'command/run'))
    assert.ok(receiver.session.snapshotEvents().some(e => e.type === 'command/done'))
    await fiber.dispose()
    assert.equal(await command('/loom status'), undefined)
  } finally { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) }
})


hostTest('human unlock: actual CommandRuntime logs, atomic new baseline, old tasks/map, CAS and workspace isolation', async () => {
  const { Context } = host('@deepseek-ai/cordis'), { Session } = host('@deepseek-ai/dsh-session')
  const root = mkdtempSync(join(tmpdir(), 'loom-unlock-')), ctx = new Context(), store = new LoomStore(root)
  const cwd = join(root, 'project'), ws = normalizeWorkspaceId(cwd)
  const architecture = { schemaVersion: 1, architectureId: 'arch', revision: 1, createdAt: new Date().toISOString(),
    nodes: [{ id: 'core', kind: 'module', title: 'Core', responsibility: 'API contract', locked: true },
      { id: 'data', kind: 'data', title: 'Data', responsibility: 'Persistence', locked: true }], edges: [], constraints: ['原创'] }
  const workflow = adoptPlannerOutput(samplePlannerOutput()).workflow
  const sourceMap = { schemaVersion: 1, architectureId: 'arch', workflowId: workflow.workflowId,
    entries: [{ architectureNodeIds: ['core'], decisionIds: [], workflowNodeId: workflow.nodes[0].id, basedOnArchitectureRevision: 1, workflowFingerprint: 'original' }] }
  store.adoptPlanningBundle(ws, { architecture, workflow, sourceMap }, { architecture: null, workflow: null, draft: null }, 'manual')
  const receiver = { ctx, session: Session.create('human', undefined, { version: 4, id: 'human', cwd, createdAt: Date.now(), isSeeded: false }) }
  const other = { ctx, session: Session.create('other', undefined, { version: 4, id: 'other', cwd: join(root, 'other'), createdAt: Date.now(), isSeeded: false }) }
  await ctx.plugin(host('@deepseek-ai/dsh-commands').default)
  await ctx.plugin({ inject: ['commands'], apply(child) { registerCommands(child, { store, getConfig: () => DEFAULT_CONFIG,
    scmFacts: async () => { throw Error('unlock never executes Git or worktree') }, runWorkflow: async () => { throw Error('unlock never executes a task') }, cancelRun: async () => false, log: { warn() {} } }) } })
  const command = (line, agent = receiver) => ctx.get('commands').execute(agent, line, [], new AbortController().signal)
  try {
    assert.throws(() => store.appendArchitecture({ ...architecture, revision: 2, nodes: architecture.nodes.map(n => ({ ...n, locked: false })) }, ws), /LOCKED_CONFLICT/)
    assert.equal((await command('/loom unlock arch core 1', other)).result.kind, 'error')
    assert.equal(store.latestArchitecture('arch', ws).revision, 1)
    const accepted = await command('/loom unlock arch core 1')
    assert.equal(accepted.result.kind, 'success')
    const next = store.latestArchitecture('arch', ws), context = store.architectureContext('arch', ws), draft = store.readDraft(ws)
    assert.equal(next.revision, 2); assert.equal(next.nodes[0].locked, false); assert.equal(next.nodes[1].locked, true)
    assert.equal(context.baseRevision, 2); assert.deepEqual(context.changes, [])
    assert.equal(store.architectureAt('arch', 1, ws).nodes[0].locked, true, 'old immutable record remains frozen')
    assert.equal(draft.architectureRevision, 2); assert.equal(draft.draftRevision, 2)
    assert.deepEqual(store.listRevisions(ws), [workflow]); assert.deepEqual(store.readSourceMap(ws), sourceMap, 'mapping remains at old architecture revision')
    const persisted = JSON.parse(readFileSync(join(store.workspacePaths(ws).dir, 'planning-state.json'), 'utf8'))
    assert.equal(persisted.humanActions.length, 1); assert.equal(persisted.humanActions[0].commandId, accepted.commandId)
    assert.equal(persisted.humanActions[0].sessionId, 'human'); assert.equal(persisted.humanActions[0].cwd, cwd)
    const events = receiver.session.snapshotEvents()
    assert.ok(events.some(e => e.type === 'command/run' && e.data.commandId === accepted.commandId && e.data.source.kind === 'user'))
    assert.ok(events.some(e => e.type === 'command/done' && e.data.commandId === accepted.commandId && e.data.kind === 'success'))
    assert.equal((await command('/loom unlock arch data 1')).result.kind, 'error', 'old window cannot unlock current revision')
    assert.equal((await command('/loom unlock arch core 2')).result.kind, 'error', 'already unlocked action never adds revision')
    assert.equal(store.latestArchitecture('arch', ws).revision, 2)
    assert.throws(() => store.appendArchitecture({ ...next, revision: 3, nodes: next.nodes.map(n => ({ ...n, locked: false })) }, ws), /LOCKED_CONFLICT/, 'other frozen nodes stay protected')
    assert.throws(() => store.unlockArchitectureNode(ws, 'arch', 'data', 2, { sessionId: 'other', commandId: 'cmd-valid-1', cwd: other.session.header.cwd, command: '/loom unlock arch data 2' }), /WORKSPACE_MISMATCH/)
    const unlocked = structuredClone(next); unlocked.revision = 3; unlocked.nodes[0].responsibility = 'Updated API'
    store.appendArchitecture(unlocked, ws)
    assert.equal(store.latestArchitecture('arch', ws).nodes[0].responsibility, 'Updated API', 'explicit human release permits subsequent ordinary edits')
    // A legacy project promotes to one snapshot without rewriting old records.
    const legacyCwd=join(root,'legacy'), legacyWs=normalizeWorkspaceId(legacyCwd)
    store.appendArchitecture(architecture,legacyWs);store.appendRevision(workflow,legacyWs);store.writeSourceMap(legacyWs,sourceMap)
    store.writeDraft({workspaceId:legacyWs,workflowId:workflow.workflowId,candidate:workflow,mode:'manual',draftRevision:1,
      lockedConstraints:['原创'],architectureId:'arch',architectureRevision:1,updatedAt:new Date().toISOString()},{expectedRevision:null})
    const legacyFiles=[store.workspacePaths(legacyWs).architectures,store.workspacePaths(legacyWs).revisions,store.workspacePaths(legacyWs).drafts,store.workspacePaths(legacyWs).sourcemap]
    const bytes=legacyFiles.map(file=>readFileSync(file,'utf8'))
    const legacyAgent={ctx,session:Session.create('legacy-human',undefined,{version:4,id:'legacy-human',cwd:legacyCwd,createdAt:Date.now(),isSeeded:false})}
    assert.equal((await command('/loom unlock arch core 1',legacyAgent)).result.kind,'success')
    assert.deepEqual(legacyFiles.map(file=>readFileSync(file,'utf8')),bytes,'old JSONL and mutable files remain recoverable')
    assert.equal(store.latestArchitecture('arch',legacyWs).revision,2);assert.deepEqual(store.listRevisions(legacyWs),[workflow])
    assert.equal(store.readDraft(legacyWs).architectureRevision,2);assert.deepEqual(store.readSourceMap(legacyWs),sourceMap)
    const adoptedArch = { ...unlocked, revision: 4 }, adoptedTask = { ...workflow, revision: 2 }
    store.adoptPlanningBundle(ws, { architecture: adoptedArch, workflow: adoptedTask, sourceMap }, { architecture: 3, workflow: 1, draft: 2 }, 'auto')
    assert.equal(JSON.parse(readFileSync(join(store.workspacePaths(ws).dir, 'planning-state.json'), 'utf8')).humanActions.length, 1, 'later plan adoption preserves mandatory audit history')
  } finally { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) }
})
