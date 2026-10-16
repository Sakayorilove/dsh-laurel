/**
 * 流程调度与审计相位（0.6.1）：真实 worktree + 假子代理，零模型调用。
 *
 * 验的是：编译好的调度表能驱动运行（并发封顶），审计组在全部任务验收后
 * 派一次只读审计子代理，结论写进运行收据（供会话主 AI 与运行视图读取）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { IsolatedTaskRuntime } from '../lib/runtime.js'
import { executeWsl } from '../lib/bridge.js'
import { LoomStore } from '../lib/store.js'
import { createWorktreeManager } from '../lib/worktree.js'
import { adoptPlannerOutput, normalizeWorkspaceId, compileFlowSchedule, defaultFlowPlan } from '../lib/core/index.js'
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

test('flow schedule drives the run and audit groups report into the receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-schedule-'))
  const repo = join(root, 'repo'); mkdirSync(repo)
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 'fixture@loom.local']); git(['config', 'user.name', 'Loom fixture'])
  writeFileSync(join(repo, 'baseline.txt'), 'frozen'); git(['add', '.']); git(['commit', '-qm', 'baseline'])
  const baseSha = git(['rev-parse', 'HEAD'])
  const store = new LoomStore(join(root, 'home'))
  const trees = createWorktreeManager({ paths: store.paths })
  const runtime = new IsolatedTaskRuntime(store, trees, 2)
  const ws = normalizeWorkspaceId(repo)
  const wf = graph()
  const plan = defaultFlowPlan(wf)
  const withGroup = {
    ...plan,
    groups: [{ id: 'group-1', stepIds: ['step-1'], auditAgentId: 'audit-1' }],
    auditAgents: [{ id: 'audit-1', label: '审计 1', groupId: 'group-1' }, { id: 'audit-2', label: '审计 2', groupId: null }],
  }
  const compiled = compileFlowSchedule(wf, withGroup, 3)
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors))
  assert.equal(compiled.schedule.groups.length, 1)

  const auditCalls = []
  const phases = []
  const produce = async ({ node, cwd, signal, phase, attemptId, snapshotHash }) => {
    phases.push(phase)
    if (phase === 'audit') {
      auditCalls.push({ attemptId, snapshotHash })
      return { verdict: 'pass', attemptId, snapshotHash, findings: ['整体证据一致'], artifactRefs: [] }
    }
    const path = node.id === 'frontend' ? 'apps/web/artifact.txt' : 'apps/api/artifact.txt'
    const code = `const fs=require('fs'); fs.mkdirSync(require('path').dirname('${path}'),{recursive:true});setTimeout(()=>fs.writeFileSync('${path}','${node.id}'),60)`
    const receipt = await executeWsl([process.execPath, '-e', code], cwd, { signal })
    if (receipt.state !== 'passed') return { verdict: 'failed', artifactRefs: [] }
    return { verdict: 'ready', artifactRefs: [{ nodeId: node.id, port: node.outputs[0].name, ref: path, contentHash: sha(node.id) }] }
  }
  try {
    const result = await runtime.run(wf, repo, ws, baseSha, produce, { schedule: compiled.schedule })
    assert.equal(result.state, 'validated')
    assert.equal(auditCalls.length, 1, '应派出一次审计')
    assert.equal(result.audits.length, 1)
    assert.equal(result.audits[0].verdict, 'pass')
    assert.equal(result.audits[0].auditAgentId, 'audit-1')
    assert.deepEqual([...result.audits[0].taskIds].sort(), ['backend', 'frontend'])
    assert.ok(phases.includes('audit'), JSON.stringify(phases))
    const saved = store.latestRuns(200, ws).find((r) => r.runId === result.runId)
    assert.equal(saved.receipt.audits.length, 1)
    assert.equal(saved.receipt.audits[0].label, '审计 1')
    assert.deepEqual(saved.receipt.audits[0].findings, ['整体证据一致'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('per-step concurrency: step k only spends step k agents (S6)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-stepwise-'))
  const repo = join(root, 'repo'); mkdirSync(repo)
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 'fixture@loom.local']); git(['config', 'user.name', 'Loom fixture'])
  writeFileSync(join(repo, 'baseline.txt'), 'frozen'); git(['add', '.']); git(['commit', '-qm', 'baseline'])
  const baseSha = git(['rev-parse', 'HEAD'])
  const store = new LoomStore(join(root, 'home'))
  const trees = createWorktreeManager({ paths: store.paths })
  const runtime = new IsolatedTaskRuntime(store, trees, 2)
  const ws = normalizeWorkspaceId(repo)

  // 四个互相独立的任务，分两步：step-1 每步 1 个代理、step-2 每步 2 个代理。
  const base = samplePlannerOutput()
  const impl = base.nodes.filter((n) => n.phase === 'implementation')
  const wf = { ...base, detectedStage: 'implementation', edges: [] }
  wf.executionProposal = { ...base.executionProposal, requiredCapabilities: ['worktree', 'wsl-execution', 'artifact-verification'] }
  wf.nodes = [impl[0], impl[1], impl[0], impl[1]].map((n, i) => ({
    ...n, id: 'task-' + (i + 1), inputs: [],
    ownership: { ...n.ownership, writes: ['apps/task-' + (i + 1) + '/**'], forbiddenWrites: [], sharedResources: [] },
    execution: { ...n.execution, timeoutSeconds: 10 },
    acceptance: { ...n.acceptance, commands: [{ argv: [process.execPath, '-e', `if (require('fs').readFileSync('apps/task-${i + 1}/artifact.txt','utf8') !== 'task-${i + 1}') process.exit(1)`], cwdRef: 'node-worktree', expectedExitCode: 0 }] },
  }))
  const adopted = adoptPlannerOutput(wf).workflow
  const plan = {
    workflowId: adopted.workflowId, revision: adopted.revision,
    steps: [{ id: 'step-1', taskIds: ['task-1', 'task-2'], agents: 1 }, { id: 'step-2', taskIds: ['task-3', 'task-4'], agents: 2 }],
    order: ['step-1', 'step-2'], groups: [], auditAgents: [{ id: 'audit-1', label: '审计 1', groupId: null }], updatedAt: new Date().toISOString(),
  }
  const compiled = compileFlowSchedule(adopted, plan, 3)
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors))

  const stepOf = { 'task-1': 'step-1', 'task-2': 'step-1', 'task-3': 'step-2', 'task-4': 'step-2' }
  const live = { 'step-1': 0, 'step-2': 0 }
  const peak = { 'step-1': 0, 'step-2': 0 }
  const overlap = [] // 每条任务进来时，此刻同时跑着哪些任务（用来判断跨步抢额度）
  const running = new Set()
  const dispatch = async ({ node, cwd, signal }) => {
    const step = stepOf[node.id]
    running.add(node.id)
    live[step] += 1; peak[step] = Math.max(peak[step], live[step])
    overlap.push({ node: node.id, step, simultaneous: [...running] })
    try {
      const dir = `apps/${node.id}`
      const code = `const fs=require('fs'); fs.mkdirSync('${dir}',{recursive:true}); setTimeout(()=>fs.writeFileSync('${dir}/artifact.txt','${node.id}'),120)`
      const receipt = await executeWsl([process.execPath, '-e', code], cwd, { signal })
      if (receipt.state !== 'passed') return { verdict: 'failed', artifactRefs: [] }
      return { verdict: 'ready', artifactRefs: [{ nodeId: node.id, port: node.outputs[0].name, ref: `${dir}/artifact.txt`, contentHash: sha(node.id) }] }
    } finally { running.delete(node.id); live[step] -= 1 }
  }
  try {
    const result = await runtime.run(adopted, repo, ws, baseSha, dispatch, { schedule: compiled.schedule, maxConcurrency: 3 })
    assert.equal(result.state, 'validated', JSON.stringify(result))
    assert.equal(peak['step-1'], 1, `step-1 只有 1 个代理额度，实测峰值 ${peak['step-1']}`)
    assert.equal(peak['step-2'], 2, `step-2 有 2 个代理额度，实测峰值 ${peak['step-2']}`)
    // 跨步不抢额度：step-2 的任务开跑时，不该还有 step-1 的任务在跑。
    for (const entry of overlap) {
      if (entry.step !== 'step-2') continue
      assert.ok(!entry.simultaneous.some((id) => stepOf[id] === 'step-1'), `step-2 开跑时 step-1 应已收工：${JSON.stringify(entry)}`)
    }
    // 收据记录每步实际并发。
    assert.deepEqual(result.stepConcurrency, [
      { id: 'step-1', agents: 1, peak: 1 },
      { id: 'step-2', agents: 2, peak: 2 },
    ])
    const saved = store.latestRuns(200, ws).find((r) => r.runId === result.runId)
    assert.deepEqual(saved.receipt.stepConcurrency, result.stepConcurrency, '落盘收据也要有每步并发')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
