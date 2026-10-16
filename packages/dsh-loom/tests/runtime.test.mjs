import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { IsolatedTaskRuntime, TaskBudget } from '../lib/runtime.js'
import { executeWsl } from '../lib/bridge.js'
import { LoomStore } from '../lib/store.js'
import { createWorktreeManager } from '../lib/worktree.js'
import { adoptPlannerOutput, normalizeWorkspaceId, contentDigest } from '../lib/core/index.js'
import { samplePlannerOutput } from './fixtures.mjs'

const sha = (text) => createHash('sha256').update(text).digest('hex')
function graph() {
  const wf = samplePlannerOutput()
  wf.nodes = wf.nodes.slice(2, 4); wf.edges = []
  wf.executionProposal.requiredCapabilities = ['worktree', 'wsl-execution', 'artifact-verification']
  for (const n of wf.nodes) {
    n.inputs = []; n.execution.timeoutSeconds = 10
    const output = n.id === 'frontend' ? 'apps/web/artifact.txt' : 'apps/api/artifact.txt'
    n.acceptance.commands = [{ argv: [process.execPath, '-e', `if (require('fs').readFileSync('${output}','utf8') !== '${n.id}') process.exit(1)`], cwdRef: 'node-worktree', expectedExitCode: 0 }]
  }
  return adoptPlannerOutput(wf).workflow
}
test('real WSL worktrees and independent artifact checks (program fixture, zero model calls)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'loom-runtime-')); const repo = join(root, 'repo'); mkdirSync(repo)
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 'fixture@loom.local']); git(['config', 'user.name', 'Loom fixture'])
  writeFileSync(join(repo, 'baseline.txt'), 'frozen'); git(['add', '.']); git(['commit', '-qm', 'baseline'])
  const baseSha = git(['rev-parse', 'HEAD']); const store = new LoomStore(join(root, 'home'))
  const trees = createWorktreeManager({ paths: store.paths }); const runtime = new IsolatedTaskRuntime(store, trees, 2)
  const ws = normalizeWorkspaceId(repo)
  let active = 0, peak = 0
  const produce = async ({ node, cwd, signal }) => {
    active++; peak = Math.max(peak, active)
    const path = node.id === 'frontend' ? 'apps/web/artifact.txt' : 'apps/api/artifact.txt'
    try {
      const code = `const fs=require('fs'); fs.mkdirSync(require('path').dirname('${path}'),{recursive:true});setTimeout(()=>fs.writeFileSync('${path}','${node.id}'),100)`
      const receipt = await executeWsl([process.execPath, '-e', code], cwd, { signal })
      if (receipt.state !== 'passed') return { verdict: 'failed', artifactRefs: [] }
      return { verdict: 'ready', artifactRefs: [{ nodeId: node.id, port: node.outputs[0].name, ref: path, contentHash: sha(node.id) }] }
    } finally { active-- }
  }
  try {
    await t.test('two modules overlap, share a frozen SHA, and are independently validated', async () => {
      const result = await runtime.run(graph(), repo, ws, baseSha, produce)
      assert.equal(result.state, 'validated'); assert.equal(peak, 2); assert.equal(result.integrated, false)
      assert.equal(result.checks.length, 2); assert.equal(result.artifacts.length, 2)
      const saved = store.latestRuns(200, ws).find((r) => r.runId === result.runId)
      assert.deepEqual(saved.receipt.completed, result.completed); assert.deepEqual(saved.receipt.artifacts, result.artifacts)
      assert.equal(saved.receipt.worktrees.length, 2); assert.equal(saved.receipt.checks.length, 2)
      assert.equal(saved.receipt.integrated, false); assert.equal(Object.hasOwn(saved.receipt.checks[0], 'stdout'), false)
      assert.notEqual(result.worktrees[0].path, result.worktrees[1].path)
      assert.ok(result.worktrees.every((w) => w.baseSha === baseSha && existsSync(w.path)))
      assert.equal(git(['rev-parse', 'HEAD']), baseSha); assert.equal(git(['status', '--porcelain']), '')
    })
    await t.test('a forged artifact hash fails and keeps its worktree', async () => {
      const result = await runtime.run(graph(), repo, ws, baseSha, async (task) => {
        const result = await produce(task); result.artifactRefs[0].contentHash = '0'.repeat(64); return result
      })
      assert.equal(result.state, 'failed'); assert.match(result.error, /HASH_MISMATCH/)
      assert.ok(result.worktrees.every((w) => existsSync(w.path)))
    })
    await t.test('failed upstream cannot start a dependent module', async () => {
      const wf = graph(); wf.nodes[1].inputs = [{ name: 'upstream', artifactType: 'code-change', required: true }]
      wf.edges = [{ id: 'frontend-backend', source: 'frontend', sourcePort: wf.nodes[0].outputs[0].name,
        target: 'backend', targetPort: 'upstream', artifactType: 'code-change', require: 'validated' }]
      const called = []
      const result = await runtime.run(wf, repo, ws, baseSha, async (task) => { called.push(task.node.id); return { verdict: 'failed', artifactRefs: [] } })
      assert.equal(result.state, 'failed'); assert.deepEqual(called, ['frontend'])
    })
    await t.test('wrong ownership is refused even if declared tests pass', async () => {
      const result = await runtime.run(graph(), repo, ws, baseSha, async (task) => {
        const result = await produce(task); writeFileSync(join(task.cwd, 'shared-secret.txt'), 'unauthorized'); return result
      })
      assert.equal(result.state, 'failed'); assert.match(result.error, /OWNERSHIP_VIOLATION/)
    })
    await t.test('unsupported full pipeline refuses before creating any worktree', async () => {
      const before = trees.listLive().length
      await assert.rejects(runtime.run(adoptPlannerOutput(samplePlannerOutput()).workflow, repo, ws, baseSha, produce), /UNSUPPORTED_STAGE/)
      assert.equal(trees.listLive().length, before)
    })
    await t.test('global budget spans concurrent callers and removes cancelled waiters', async () => {
      const budget = new TaskBudget(1); const abort = new AbortController()
      const release = await budget.acquire(new AbortController().signal)
      const pending = budget.acquire(abort.signal); abort.abort()
      await assert.rejects(pending, /cancelled/); release()
      const next = await budget.acquire(new AbortController().signal); next()
    })
    await t.test('cancel a named run waits for all work and persists a cancelled receipt', async () => {
      let started; const dispatchStarted = new Promise((resolve) => { started = resolve })
      let active = 0
      const pending = runtime.run(graph(), repo, ws, baseSha, async (task) => {
        active++; started()
        try { await executeWsl(['node', '-e', 'setInterval(()=>{},1000)'], task.cwd, { signal: task.signal }) } finally { active-- }
        return { verdict: 'failed', artifactRefs: [] }
      }, { runId: 'cancel-owned-run', maxConcurrency: 1 })
      await dispatchStarted
      assert.equal(await runtime.cancel('cancel-owned-run'), true)
      const result = await pending
      assert.equal(result.state, 'cancelled'); assert.equal(active, 0)
      assert.equal(await runtime.cancel('missing-run'), false)
      const saved = store.latestRuns(200, ws).find((r) => r.runId === result.runId)
      assert.equal(saved.state, 'cancelled'); assert.equal(saved.receipt.integrated, false)
      assert.equal(saved.receipt.worktrees.length, 2)
    })
    await t.test('user concurrency cap bounds a graph with a higher proposal', async () => {
      let active = 0, peak = 0
      const result = await runtime.run(graph(), repo, ws, baseSha, async (task) => {
        active++; peak = Math.max(peak, active)
        try { return await produce(task) } finally { active-- }
      }, { maxConcurrency: 1 })
      assert.equal(result.state, 'validated'); assert.equal(peak, 1)
      runtime.setConcurrency(2)
    })
    await t.test('architecture or task drift rejects before worktree creation', async () => {
      const wf = graph()
      const arch = { schemaVersion: 1, architectureId: 'runtime-arch', revision: 1, createdAt: new Date().toISOString(), nodes: [{ id: 'web', kind: 'module', title: 'Web', responsibility: 'Web module' }], edges: [] }
      store.appendArchitecture(arch, ws)
      const before = trees.listLive().length
      await assert.rejects(runtime.run(wf, repo, ws, baseSha, produce), /SOURCE_MAP_REQUIRED/)
      const entries = wf.nodes.map((n) => ({ workflowNodeId: n.id, architectureNodeIds: ['web'], decisionIds: [], basedOnArchitectureRevision: 1, workflowFingerprint: contentDigest(n) }))
      store.writeSourceMap(ws, { schemaVersion: 1, architectureId: arch.architectureId, workflowId: wf.workflowId, entries })
      store.appendArchitecture({ ...arch, revision: 2 }, ws)
      await assert.rejects(runtime.run(wf, repo, ws, baseSha, produce), /STALE_TASKS/)
      store.writeSourceMap(ws, { schemaVersion: 1, architectureId: arch.architectureId, workflowId: wf.workflowId, entries: entries.map((e) => ({ ...e, basedOnArchitectureRevision: 2, workflowFingerprint: 'forged' })) })
      await assert.rejects(runtime.run(wf, repo, ws, baseSha, produce), /STALE_TASKS/)
      assert.equal(trees.listLive().length, before)
    })
  } finally { await runtime.cancelAll(); rmSync(root, { recursive: true, force: true }) }
})
