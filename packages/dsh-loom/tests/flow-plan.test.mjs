import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultFlowPlan, validateFlowPlan, applyFlowOrder, flowPlanDigest, compileFlowSchedule, FLOW_MAX_AGENTS } from '../lib/core/index.js'

const port = (name, artifactType, required = true) => ({ name, artifactType, required })
const node = (id, inputs, outputs) => ({
  id, kind: 'agent', title: id, phase: 'implementation', goal: '目标 ' + id, role: 'module-developer', sourceRefs: [],
  inputs, outputs,
  ownership: { writes: ['src/' + id + '/**'], forbiddenWrites: [], sharedResources: [] },
  execution: { backend: 'configured-agent', isolation: 'worktree', timeoutSeconds: 60, maxRepairAttempts: 0 },
  acceptance: { doneWhen: ['产物可检查'], commands: [], independentVerification: true },
})
const workflow = (nodes, edges) => ({
  schemaVersion: '0.1', workflowId: 'wf-flow', revision: 1, title: '流程测试', detectedStage: 'implementation',
  evidence: [], assumptions: [], openQuestions: [], executionProposal: null, nodes, edges,
})
const auditAgents = () => [
  { id: 'audit-1', label: '审计 1', groupId: null },
  { id: 'audit-2', label: '审计 2', groupId: null },
]
/** 用户手动摆出来的两步计划（a 一步、b 一步）。 */
const twoStepPlan = (over = {}) => ({
  workflowId: 'wf-flow', revision: 1,
  steps: [{ id: 'step-1', taskIds: ['a'], agents: 2 }, { id: 'step-2', taskIds: ['b'], agents: 2 }],
  order: ['step-1', 'step-2'], groups: [], auditAgents: auditAgents(), updatedAt: '2026-10-05T00:00:00.000Z',
  ...over,
})

const openPair = workflow(
  [node('a', [], [port('x', 'code-change', false)]), node('b', [port('y', 'code-change')], [])],
  [],
)
const chained = workflow(openPair.nodes, [{ id: 'ab', source: 'a', sourcePort: 'x', target: 'b', targetPort: 'y', artifactType: 'code-change', require: 'validated' }])

test('default plan mirrors dependency layers with two audit agents', () => {
  const plan = defaultFlowPlan(chained)
  assert.deepEqual(plan.steps.map((s) => s.taskIds), [['a'], ['b']])
  assert.deepEqual(plan.order, plan.steps.map((s) => s.id))
  assert.equal(plan.steps[0].agents, 2)
  assert.equal(plan.auditAgents.length, 2)
  assert.ok(plan.auditAgents.every((agent) => agent.groupId === null))
  assert.equal(flowPlanDigest(plan).length, 64)
})

test('validation accepts a hand-made plan and warns about uncovered tasks', () => {
  const ok = validateFlowPlan(twoStepPlan(), openPair)
  assert.equal(ok.ok, true, JSON.stringify(ok.errors))
  assert.equal(ok.plan.steps.length, 2)
  const gap = validateFlowPlan(twoStepPlan({ steps: [{ id: 'step-1', taskIds: ['a'], agents: 2 }], order: ['step-1'] }), openPair)
  assert.equal(gap.ok, true, JSON.stringify(gap.errors))
  assert.ok(gap.warnings.some((w) => /未纳入/.test(w.message)), JSON.stringify(gap.warnings))
})

test('validation rejects duplicate tasks, bad agent counts, order mismatches and group overlap', () => {
  const dup = validateFlowPlan(twoStepPlan({ steps: [{ id: 'step-1', taskIds: ['a', 'a'], agents: 2 }], order: ['step-1'] }), openPair)
  assert.equal(dup.ok, false)
  const ghost = validateFlowPlan(twoStepPlan({ steps: [{ id: 'step-1', taskIds: ['ghost'], agents: 2 }], order: ['step-1'] }), openPair)
  assert.equal(ghost.ok, false)
  const zero = validateFlowPlan(twoStepPlan({ steps: [{ id: 'step-1', taskIds: ['a'], agents: 0 }], order: ['step-1'] }), openPair)
  assert.equal(zero.ok, false)
  const over = validateFlowPlan(twoStepPlan({ steps: [{ id: 'step-1', taskIds: ['a'], agents: FLOW_MAX_AGENTS + 1 }], order: ['step-1'] }), openPair)
  assert.equal(over.ok, false)
  const shortOrder = validateFlowPlan(twoStepPlan({ order: ['step-1'] }), openPair)
  assert.equal(shortOrder.ok, false)
  const overlapped = validateFlowPlan(twoStepPlan({
    groups: [
      { id: 'group-1', stepIds: ['step-1', 'step-2'], auditAgentId: 'audit-1' },
      { id: 'group-2', stepIds: ['step-2'], auditAgentId: 'audit-2' },
    ],
  }), openPair)
  assert.equal(overlapped.ok, false)
  assert.ok(overlapped.errors.some((e) => /分进多个审计组/.test(e.message)), JSON.stringify(overlapped.errors))
})

test('apply adds an artifact-carrying edge for the visual order', () => {
  const applied = applyFlowOrder(openPair, twoStepPlan())
  assert.equal(applied.ok, true, JSON.stringify(applied.errors))
  assert.equal(applied.addedEdges.length, 1)
  const edge = applied.addedEdges[0]
  assert.equal(edge.source, 'a')
  assert.equal(edge.target, 'b')
  assert.equal(edge.targetPort, 'y')
  assert.equal(edge.artifactType, 'code-change')
  assert.ok(edge.id.length <= 64)
})

test('apply refuses to reorder against an existing dependency and points at the edge', () => {
  const applied = applyFlowOrder(chained, twoStepPlan({ order: ['step-2', 'step-1'] }))
  assert.equal(applied.ok, false)
  assert.ok(applied.errors.some((e) => /顺序冲突/.test(e.message) && /ab/.test(e.path)), JSON.stringify(applied.errors))
})

test('apply refuses when adjacent steps share no artifact type', () => {
  const mismatch = workflow(
    [node('a', [], [port('x', 'code-change', false)]), node('b', [port('y', 'interface-contract')], [])],
    [],
  )
  const applied = applyFlowOrder(mismatch, twoStepPlan())
  assert.equal(applied.ok, false)
  assert.ok(applied.errors.some((e) => /interface-contract/.test(e.message)), JSON.stringify(applied.errors))
})

test('compileFlowSchedule covers tasks, clamps agents and rejects unbound groups', () => {
  const wf = workflow([node('a', [], [port('x', 'code-change', false)]), node('b', [], [port('y', 'code-change', false)])], [])
  // 计划里的 agents 现在最多 FLOW_MAX_AGENTS（=3，实测并发上限）；封顶发生在
  // **宿主上限更低**时（例如 defaultMaxConcurrency=2）。
  const ok = compileFlowSchedule(wf, twoStepPlan({ steps: [{ id: 'step-1', taskIds: ['a', 'b'], agents: FLOW_MAX_AGENTS }], order: ['step-1'] }), 2)
  assert.equal(ok.ok, true, JSON.stringify(ok.errors))
  assert.equal(ok.schedule.steps[0].agents, 2, '超过宿主上限要封顶')
  assert.equal(ok.schedule.clamped, true)
  assert.equal(ok.schedule.concurrency, 2)
  assert.equal(ok.schedule.groups.length, 0)

  const grouped = compileFlowSchedule(wf, twoStepPlan({
    steps: [{ id: 'step-1', taskIds: ['a', 'b'], agents: 2 }], order: ['step-1'],
    groups: [{ id: 'group-1', stepIds: ['step-1'], auditAgentId: 'audit-1' }],
    auditAgents: [{ id: 'audit-1', label: '审计 1', groupId: 'group-1' }, { id: 'audit-2', label: '审计 2', groupId: null }],
  }), 3)
  assert.equal(grouped.ok, true, JSON.stringify(grouped.errors))
  assert.equal(grouped.schedule.groups.length, 1)
  assert.deepEqual([...grouped.schedule.groups[0].taskIds].sort(), ['a', 'b'])
  assert.equal(grouped.schedule.groups[0].auditAgentId, 'audit-1')
  assert.equal(grouped.schedule.groups[0].label, '审计 1')

  const unbound = compileFlowSchedule(wf, twoStepPlan({
    steps: [{ id: 'step-1', taskIds: ['a', 'b'], agents: 2 }], order: ['step-1'],
    groups: [{ id: 'group-1', stepIds: ['step-1'], auditAgentId: null }],
  }), 3)
  assert.equal(unbound.ok, false)
  assert.equal(unbound.schedule, null, '缺少主审的流程必须阻断执行')
  assert.ok(unbound.errors.some((w) => /主审/.test(w.message)))

  const missing = compileFlowSchedule(wf, twoStepPlan({ steps: [{ id: 'step-1', taskIds: ['a'], agents: 2 }], order: ['step-1'] }), 3)
  assert.equal(missing.ok, false, '漏掉任务不能当运行顺序')
  assert.ok(missing.errors.some((e) => /没有覆盖全部任务/.test(e.message)))
})

test('the agent cap is the measured host concurrency, not a guess', () => {
  // 实测依据：scripts/probe-subagent-limit.mjs 在真实官方宿主上跑 4 个独立任务、
  // 声明并发 3 → 峰值同时 3 个子代理、全部验收通过（证据
  // .verification/subagent-limit-probe.json）。任务图 schema 与配置项同样限 1..3。
  assert.equal(FLOW_MAX_AGENTS, 3)
  // 默认分层不会给出超过上限的代理数。
  const plan = defaultFlowPlan(workflow([node('a', [], []), node('b', [], [])], []))
  assert.ok(plan.steps.every((s) => s.agents >= 1 && s.agents <= FLOW_MAX_AGENTS))
  // 上限 +1 一律被拒（下拉不可能给出这个数）。
  const over = validateFlowPlan(twoStepPlan({ steps: [{ id: 'step-1', taskIds: ['a'], agents: FLOW_MAX_AGENTS + 1 }], order: ['step-1'] }), openPair)
  assert.equal(over.ok, false)
  assert.ok(over.errors.some((e) => /子代理数量必须是 1\.\.3/.test(e.message)), JSON.stringify(over.errors))
})
