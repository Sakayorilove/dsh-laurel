/**
 * 步骤 2 的测试。
 *
 * B —— 编译器把前序批次的输入丢掉了
 * G —— 全图与局部优化得到相同的 payloadHash
 */
import { describe, it } from 'node:test'
import { expect } from './helpers.mjs'
import { sampleWorkflow, samplePlannerOutput } from './fixtures.mjs'
import {
  compileWorkflow,
  compileArchitecturePrompt,
  buildTaskPackage,
  renderBatchScript,
  knownCapabilities,
} from '../lib/core/index.js'

/**
 * 把自建与宿主侧能力都拧成「可派发」，让编译闸门放行。
 * 只影响本文件的编译用例；能力模型的诚实性由 core.test.mjs 负责。
 */
function knownCapsFull() {
  const c = structuredClone(knownCapabilities())
  for (const key of ['parallel', 'worktreeIsolation', 'wslExecution', 'cancel', 'realParentAgent']) {
    c[key].implementedByLoom = true
    c[key].availableInEnv = true
  }
  c.worktreeIsolation.declaredByHost = true
  return c
}

const opts = { resolveCwd: (n) => `/w/${n.id}`, baseSha: 'a'.repeat(40) }
const arch = (extra = {}) => ({
  schemaVersion: 1,
  architectureId: 'proj-01',
  revision: 3,
  createdAt: '2026-10-02T04:00:00.000Z',
  nodes: [
    { id: 'm-web', kind: 'module', title: '前端', responsibility: '界面' },
    { id: 'm-api', kind: 'module', title: '后端', responsibility: 'API' },
  ],
  edges: [{ id: 'e1', from: 'm-web', to: 'm-api', kind: 'call' }],
  ...extra,
})
const archInput = (patch = {}) => ({
  projectId: 'p',
  proposalId: 'prop',
  baseRevision: 2,
  draftRevision: 3,
  inputDigest: 'b'.repeat(64),
  scope: 'all',
  base: undefined,
  draft: arch(),
  changes: [],
  lockedConstraints: [],
  sources: [],
  ...patch,
})

/* ─────────────────── B：前序批次输入不能丢 ─────────────────── */

describe('编译器 · 前序批次输入', () => {
  const wf = sampleWorkflow()

  it('批次确实超过一层（否则本条测试无意义）', () => {
    const plan = compileWorkflow(wf, { ...knownCapsFull() }, opts)
    expect(plan.batches.length).toBeGreaterThan(2)
  })

  it('frontend 的脚本里带上了 contract 这个上游（评审 B 的核心断言）', () => {
    const plan = compileWorkflow(wf, knownCapsFull(), opts)
    // frontend 在 implementation 层，contract 在更早的 architecture 层。
    const batch = plan.batches.find((b) => b.nodeIds.includes('frontend'))
    expect(batch !== undefined).toBe(true)
    // 旧实现在这里恒为假：上游全被 inBatch 过滤掉了。
    expect(batch.script).toContain('artifact://contract/contract')
    // 且必须进 prompt 正文的「输入产物」段，而不是只存在于某个元数据里。
    expect(batch.script).toContain('## 输入产物')
    expect(batch.script).toContain('更早计划批次；仍须核验产物回执与内容 hash')
  })

  it('integrate 同时拿到三个前序模块的产物路径', () => {
    const plan = compileWorkflow(wf, knownCapsFull(), opts)
    const batch = plan.batches.find((b) => b.nodeIds.includes('integrate'))
    const dep = batch.dependencies.find((d) => d.nodeId === 'integrate')
    const refs = dep.upstream.map((u) => u.ref)
    expect(refs).toContain('artifact://frontend/changes')
    expect(refs).toContain('artifact://backend/changes')
    expect(refs).toContain('artifact://worker/changes')
    // 三条都必须是「更早批次」，integrate 才能真正拿到产物。
    for (const u of dep.upstream) expect(u.origin, u.nodeId).toBe('earlier')
  })

  it('★ 非 agent 节点（integrate/report）的依赖也进了产物 —— 第二层修复', () => {
    const plan = compileWorkflow(wf, knownCapsFull(), opts)
    // integrate 是 deterministic 节点，旧实现里它**根本不进 calls**，
    // 于是它的三条入边在脚本里一处都不出现。
    const integrateBatch = plan.batches.find((b) => b.nodeIds.includes('integrate'))
    expect(integrateBatch.script).toContain('artifact://frontend/changes')
    expect(integrateBatch.script).toContain('artifact://backend/changes')
    expect(integrateBatch.script).toContain('artifact://worker/changes')
    // 消费端还要知道它的验收命令，否则没法执行这个确定性节点。
    expect(integrateBatch.script).toContain('pnpm')
    expect(integrateBatch.script).toContain('test:integration')
  })

  it('report 拿到 integrate 的产物', () => {
    const plan = compileWorkflow(wf, knownCapsFull(), opts)
    const batch = plan.batches.find((b) => b.nodeIds.includes('report'))
    expect(batch.script).toContain('artifact://integrate/integrated')
    const dep = batch.dependencies.find((d) => d.nodeId === 'report')
    expect(dep.upstream[0].origin).toBe('earlier')
  })

  it('每个批次的 dependencies 覆盖该批次全部节点（含非 agent）', () => {
    const plan = compileWorkflow(wf, knownCapsFull(), opts)
    for (const b of plan.batches) {
      expect(b.dependencies.length, `batch ${b.index}`).toBe(b.nodeIds.length)
      const ids = b.dependencies.map((d) => d.nodeId).sort()
      expect(ids).toEqual([...b.nodeIds].sort())
    }
  })

  it('非 agent 节点的 doneWhen 与 commands 也带上了', () => {
    const plan = compileWorkflow(wf, knownCapsFull(), opts)
    const integ = plan.batches.find((b) => b.nodeIds.includes('integrate')).dependencies.find((d) => d.nodeId === 'integrate')
    expect(integ.doneWhen.length > 0).toBe(true)
    expect(integ.commands.length).toBe(2)
    expect(integ.commands[0].argv[0]).toBe('pnpm')
  })

  it('inspect（无上游）仍然如实写「（无）」', () => {
    const plan = compileWorkflow(wf, knownCapsFull(), opts)
    const batch = plan.batches.find((b) => b.nodeIds.includes('inspect'))
    const dep = batch.dependencies.find((d) => d.nodeId === 'inspect')
    expect(dep.upstream).toHaveLength(0)
  })

  it('上游都标为更早批次，没有一条被标成更晚/未判定', () => {
    const plan = compileWorkflow(wf, knownCapsFull(), opts)
    const withUpstream = plan.batches.filter((b) =>
      ['contract', 'frontend', 'backend', 'worker', 'integrate', 'report'].some((id) => b.nodeIds.includes(id)),
    )
    for (const b of withUpstream) {
      expect(b.script, `batch ${b.index}`).not.toContain('此刻不可用')
      expect(b.script, `batch ${b.index}`).not.toContain('批次未判定')
    }
  })

  it('任务包里点明输入可用性，缺输入要返回 blocked', () => {
    const text = buildTaskPackage({
      workflow: { workflowId: 'w', revision: 1, inputDigest: 'x' },
      node: wf.nodes.find((n) => n.id === 'frontend'),
      upstream: [{ nodeId: 'contract', port: 'contract', type: 'interface-contract', ref: 'artifact://contract/contract', origin: 'earlier' }],
      cwd: '/w/frontend',
      baseSha: 'a'.repeat(40),
      allowedChecks: [],
    })
    expect(text).toContain('artifact://contract/contract')
    expect(text).toContain('更早计划批次；仍须核验产物回执与内容 hash')
  })

  it('更晚批次的输入被明确标为不可用，并提示返回 blocked', () => {
    const text = buildTaskPackage({
      workflow: { workflowId: 'w', revision: 1, inputDigest: 'x' },
      node: wf.nodes.find((n) => n.id === 'frontend'),
      upstream: [{ nodeId: 'late', port: 'x', type: 'code-change', ref: 'artifact://late/x', origin: 'later' }],
      cwd: '/w/frontend',
      baseSha: 'a'.repeat(40),
      allowedChecks: [],
    })
    expect(text).toContain('此刻不可用')
    expect(text).toContain('blocked')
    // 不许鼓励伪造
    expect(text).toContain('不要伪造')
  })

  it('批次号相同的依赖边（分层异常）要暴露，不当作正常', () => {
    const script = renderBatchScript({
      workflow: wf,
      nodes: wf.nodes.filter((n) => ['frontend', 'backend'].includes(n.id)),
      index: 2,
      options: opts,
      // 人为把 contract 也标成本批次 —— 模拟分层被破坏。
      batchOf: new Map([['frontend', 2], ['backend', 2], ['contract', 2]]),
    })
    expect(script).toContain('同批次内依赖')
    expect(script).toContain('分层异常')
    // 并且要把它算进「不可用输入」，提示 blocked。
    expect(script).toContain('不要伪造')
  })

  it('没有 batchOf 信息时不猜，标「批次未判定」', () => {
    const script = renderBatchScript({
      workflow: wf,
      nodes: wf.nodes.filter((n) => n.id === 'frontend'),
      index: 1,
      options: opts,
    })
    expect(script).toContain('批次未判定')
    expect(script).toContain('不要假定已就绪')
  })

  it('上游数量随入边数变化，不再被 inBatch 吞掉', () => {
    const plan = compileWorkflow(wf, knownCapsFull(), opts)
    const batch = plan.batches.find((b) => b.nodeIds.includes('integrate'))
    // integrate 有三条入边，必须三条都在脚本里出现。
    const occurrences = batch.script.split('artifact://').length - 1
    expect(occurrences >= 3).toBe(true)
  })

  it('单节点渲染（无 batchOf）时仍能列出真实上游 —— 不再恒为空', () => {
    // 这是旧 bug 的最直接反证：单独渲染 frontend，上游依然要在。
    const script = renderBatchScript({
      workflow: wf,
      nodes: wf.nodes.filter((n) => n.id === 'frontend'),
      index: 0,
      options: opts,
    })
    expect(script).toContain('artifact://contract/contract')
  })
})

/* ─────────────────── G：scope 必须进 payloadHash ─────────────────── */

describe('架构提示词 · scope 参与语义 hash', () => {
  it('全图与局部优化**必须**得到不同的 payloadHash', () => {
    const all = compileArchitecturePrompt(archInput({ scope: 'all' }))
    const partial = compileArchitecturePrompt(archInput({ scope: { nodeIds: ['m-web'] } }))
    expect(all.payloadHash).not.toBe(partial.payloadHash)
  })

  it('不同局部范围得到不同 hash', () => {
    const a = compileArchitecturePrompt(archInput({ scope: { nodeIds: ['m-web'] } }))
    const b = compileArchitecturePrompt(archInput({ scope: { nodeIds: ['m-web', 'm-api'] } }))
    const c = compileArchitecturePrompt(archInput({ scope: { nodeIds: ['m-api'] } }))
    expect(a.payloadHash).not.toBe(b.payloadHash)
    expect(b.payloadHash).not.toBe(c.payloadHash)
  })

  it('nodeIds 顺序不同但集合相同 → 同一个 hash（去重排序）', () => {
    const a = compileArchitecturePrompt(archInput({ scope: { nodeIds: ['m-web', 'm-api'] } }))
    const b = compileArchitecturePrompt(archInput({ scope: { nodeIds: ['m-api', 'm-web'] } }))
    expect(a.payloadHash).toBe(b.payloadHash)
  })

  it('重复的 nodeIds 不影响 hash', () => {
    const a = compileArchitecturePrompt(archInput({ scope: { nodeIds: ['m-web'] } }))
    const b = compileArchitecturePrompt(archInput({ scope: { nodeIds: ['m-web', 'm-web'] } }))
    expect(a.payloadHash).toBe(b.payloadHash)
  })

  it('payloadHash 只依赖 templateVersion + data，与 scope 已进 data', () => {
    const r = compileArchitecturePrompt(archInput({ scope: { nodeIds: ['m-web'] } }))
    expect(r.data.identity.scope).toEqual(['m-web'])
    const all = compileArchitecturePrompt(archInput({ scope: 'all' }))
    expect(all.data.identity.scope).toBe('all')
  })

  it('scope 变了，提示词正文也要跟着变（不只是 hash）', () => {
    const all = compileArchitecturePrompt(archInput({ scope: 'all' })).text
    const partial = compileArchitecturePrompt(archInput({ scope: { nodeIds: ['m-web'] } })).text
    expect(all).toContain('整份方案')
    expect(partial).toContain('m-web')
    expect(partial).not.toBe(all)
  })

  it('锁定约束不同 → hash 不同（用户约束必须影响语义）', () => {
    const a = compileArchitecturePrompt(archInput({ lockedConstraints: ['不改 DB'] }))
    const b = compileArchitecturePrompt(archInput({ lockedConstraints: [] }))
    expect(a.payloadHash).not.toBe(b.payloadHash)
  })

  it('baseRevision 不同 → hash 不同', () => {
    const a = compileArchitecturePrompt(archInput({ baseRevision: 1 }))
    const b = compileArchitecturePrompt(archInput({ baseRevision: 2 }))
    expect(a.payloadHash).not.toBe(b.payloadHash)
  })

  it('信封元数据（时间/requestId）**不**进 hash —— 同内容必同 hash', () => {
    const a = compileArchitecturePrompt(archInput())
    const b = compileArchitecturePrompt(archInput())
    expect(a.payloadHash).toBe(b.payloadHash)
  })
})
