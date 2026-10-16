/**
 * 实测「宿主同时能跑几个子代理」（S5 / P1-6）。
 *
 * 为什么实测：流程视图的「子代理数量」下拉给到 4，而 `compileFlowSchedule` 里宿主
 * 上限是**写死的 3**、任务图 schema 也把 maxConcurrency 限在 1..3 —— 这个 3 从来
 * 没有实测依据。这里用真实官方宿主 + 离线受控 adapter（零外部模型调用）跑一次
 * **最小真实运行**：4 个互相独立的任务、并发上限 3，然后从 adapter 的请求时间戳
 * 量出真正同时开着的子代理数。
 *
 * 说明（必须写进证据，不能含糊）：并发数 >3 无法通过 Loom 自己的运行路径测 ——
 * schema 就把 maxConcurrency 卡在 1..3。所以本探针能证明的是「3 并发在真实宿主上
 * 确实跑得起来、且是真并行」；上限到底在哪由宿主自己决定，不由本探针宣布。
 *
 * 用法：node --expose-internals scripts/probe-subagent-limit.mjs
 * 证据：.verification/subagent-limit-probe.json
 */
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdirSync, appendFileSync } from 'node:fs'
import { format } from 'node:util'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { LoomStore } from '../lib/store.js'
import { normalizeWorkspaceId } from '../lib/core/index.js'
import { samplePlannerOutput } from '../tests/fixtures.mjs'
import { resolveHostAnchor, hostSkipReason } from './host-anchor.mjs'

const sourceRoot = fileURLToPath(new URL('..', import.meta.url))
const anchor = resolveHostAnchor()
if (anchor === null) { console.error(hostSkipReason); process.exit(2) }
const host = createRequire(anchor)
const evidence = join(sourceRoot, '.verification')
mkdirSync(evidence, { recursive: true })
const logPath = join(evidence, 'subagent-limit-probe.log')
await writeFile(logPath, '')
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console)
  console[level] = (...args) => { appendFileSync(logPath, format(...args) + '\n'); original(...args) }
}

/** 每个子代理的 LLM 请求停这么久：不制造重叠就量不出并发。 */
const HOLD_MS = 400
/** 并发上限：schema（validate.ts MAX_CONCURRENCY_RANGE）只允许 1..3。 */
const TASKS = 4
const CAP = 3

const home = await mkdtemp('/tmp/loom-subagent-probe-'), cwd = join(home, 'project')
await mkdir(cwd); process.chdir(cwd); process.env.DSH_HOME = home
process.env.DSH_AGENTS_HOME = join(home, 'agents'); process.env.DSH_BUNDLED_SKILL_DIR = join(home, 'skills')
process.argv[1] = anchor
const app = host('@deepseek-ai/dsh-app-boot')
await mkdir(join(home, 'node_modules'))
await symlink(sourceRoot, join(home, 'node_modules', 'dsh-loom'))
app.initProfile(home, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-loom'])
const patches = [...app.loadOverlayPatches('loom-probe', host.resolve('@deepseek-ai/dsh-base/cordis.patch.yml')),
  ...app.bundlePatchPaths(dirname(host.resolve('@deepseek-ai/dsh-web-app/package.json')), host('@deepseek-ai/dsh-web-app/package.json').dsh.bundle).flatMap((file) => app.loadOverlayPatches('loom-probe', file)),
  { id: 'hmr', disabled: true }, { id: 'llm-deepseek', disabled: true }, { id: 'llm-pi-ai', disabled: true }, { id: 'session-title-llm', disabled: true },
  { id: 'session-log-deepseek', config: { enabled: false } }, { id: 'session-telemetry-otel', disabled: true },
  { id: 'agent-instructions', disabled: true }, { id: 'open-in-app', disabled: true }, { id: 'ui-open-in-app', disabled: true },
  { id: 'agent-default-model', config: { provider: 'loom-controlled', model: 'controlled' } },
  { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: false } },
  { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions') } },
  { id: 'storage-json', config: { root: join(home, 'storages') } },
  { id: 'session-query-sqlite', config: { path: ':memory:', openAt: 'never' } },
  { id: 'credentials', config: { dshHome: home } },
  { id: 'workspace-controller', config: { documentsDirectory: join(home, 'Documents') } },
  { id: 'skill-filesystem', config: { dshHome: home, agentsHome: join(home, 'agents'), bundledSkillDir: join(home, 'skills'), watch: false } },
  { insert: [{ id: 'loom', name: pathToFileURL(join(sourceRoot, 'lib/index.js')).href }] }]
const config = join(home, 'cordis.yml'); await writeFile(config, '[]\n')

const ctx = await app.boot('loom-subagent-probe', config, patches, async ctx => {
  const profile = { name: 'loom-probe', dir: home, layers: [{ packageName: 'dsh-loom', packageDir: sourceRoot, patchPaths: [join(sourceRoot, 'cordis.patch.yml')], patches: [] }], skippedBundles: [], patchPath: join(home, 'cordis.patch.yml'), patches: [] }
  ctx.provide('profileContext', { name: profile.name, dir: home, patchPath: profile.patchPath, installAnchor: anchor, cwd, home, startedBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-loom'], overlays: patches, telemetryDisabledEnv: undefined })
  ctx.provide('appReady', { onReady: listener => { listener(); return () => {} } })
  const resolution = await app.createRuntimeResolution({ installAnchor: anchor, home, profile })
  await ctx.plugin(app.PluginPackages, { resolution })
  host('@deepseek-ai/dsh-cmdline').provideCmdline(ctx, { args: [], exit: code => { throw Error('unexpected exit ' + code) } })
}, pathToFileURL(anchor).href)

const streams = []
const children = new Map()
let planningReply
class ProbeAdapter extends host('@deepseek-ai/dsh-llm').LlmAdapter {
  async listModels() { return [{ id: 'controlled', name: 'Probe offline' }] }
  async resolveModel(provider, id) { return { provider, id, name: id } }
  async *stream(options) {
    const record = { session: String(options.sessionId), startedAt: Date.now(), endedAt: null }
    streams.push(record)
    try {
      const session = record.session
      let value, reason = 'stop', blockType = 'text', block
      if (session === 'loom-probe-parent') {
        value = JSON.stringify(planningReply)
      } else {
        let owned = children.get(session)
        if (!owned) {
          const texts = []
          const collect = (v) => { if (typeof v === 'string') texts.push(v); else if (Array.isArray(v)) v.forEach(collect); else if (v && typeof v === 'object') Object.values(v).forEach(collect) }
          collect(options.messages)
          const serialized = texts.join('\n')
          const match = serialized.match(/LOOM_EXECUTION_CONTRACT (\{[^\n]+\})/)
          if (!match) throw Error('missing execution contract')
          const contract = JSON.parse(match[1])
          const id = (serialized.match(/task-(\d+)/) || [])[1] ? 'task-' + (serialized.match(/task-(\d+)/) || [])[1] : 'task-1'
          owned = { id, called: false, ...contract }
          children.set(session, owned)
        }
        if (owned.phase === 'review' && !owned.called) {
          owned.called = true; reason = 'tool-calls'; blockType = 'tool-call'
          block = { type: 'tool-call', id: 'deny-' + owned.id, name: 'write', arguments: JSON.stringify({ file_path: 'denied-review.txt', content: 'must never be written' }) }
        } else if (owned.phase === 'review') {
          value = JSON.stringify({ verdict: 'pass', attemptId: owned.attemptId, snapshotHash: owned.snapshotHash, findings: [], artifactRefs: [] })
        } else if (!owned.called) {
          owned.called = true; reason = 'tool-calls'; blockType = 'tool-call'
          block = { type: 'tool-call', id: 'owned-' + owned.id, name: 'write', arguments: JSON.stringify({ file_path: owned.id + '.txt', content: owned.id }) }
        } else {
          value = JSON.stringify({ verdict: 'ready', attemptId: owned.attemptId, artifactRefs: [{ nodeId: owned.id, port: 'changes', ref: owned.id + '.txt', contentHash: createHash('sha256').update(owned.id).digest('hex') }] })
        }
      }
      // 关键：每个请求都先停住，让并发的子代理真的重叠在一起。
      await new Promise(resolve => setTimeout(resolve, HOLD_MS))
      yield { type: 'block-start', index: 0, blockType }
      if (block) { yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }; yield { type: 'block-end', index: 0, block } }
      else { yield { type: 'text-delta', index: 0, text: value }; yield { type: 'block-end', index: 0, block: { type: 'text', text: value } } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
      yield { type: 'finish', reason: { kind: reason } }
    } finally { record.endedAt = Date.now() }
  }
}
ctx.llm.registerAdapter(['loom-controlled'], new ProbeAdapter())

for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'probe@loom.local'], ['config', 'user.name', 'Loom probe']]) execFileSync('git', args, { cwd })
await writeFile(join(cwd, 'baseline.txt'), 'baseline'); execFileSync('git', ['add', '.'], { cwd }); execFileSync('git', ['commit', '-qm', 'baseline'], { cwd })
const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
const workspace = await ctx.workspaceRegistry.create(cwd, 'Loom probe workspace')
const sessionId = (await ctx.sessionController.create({ workspaceId: workspace.id, sessionId: 'loom-probe-parent' })).sessionId
const ws = normalizeWorkspaceId(cwd), store = new LoomStore(home)
const invoke = async (method, path, body) => {
  const result = await ctx.typertGateway.invoke({ namespace: 'loom', method: 'request', args: { input: { sessionId, method, path, ...(body ? { body } : {}) } } })
  assert.equal(result.payload.ok, true, JSON.stringify(result))
  return result.payload.data
}
// 规划请求会钉住当时的 defaultMaxConcurrency；要测 3 并发就得先把它设成 3
// （默认是 2，AI 不允许自行提高）。
await invoke('POST', '/config', { defaultMaxConcurrency: CAP })
const exported = await invoke('POST', '/planning/export', { goal: `${TASKS} 个互相独立的模块并行交付`, constraints: ['WSL'], expectedArchitectureRevision: null, expectedWorkflowRevision: null })
const request = exported.request
const all = samplePlannerOutput()
const wf = all
// 夹具里只有 3 个可执行任务（frontend/backend/worker）；克隆第一个凑成 4 个
// 互相独立的任务，用来观察并发上限。
const impl = all.nodes.filter((n) => n.phase === 'implementation')
const sources = [impl[0], impl[1], impl[2], impl[0]]
wf.detectedStage = 'implementation'
wf.nodes = sources.map((n, i) => ({ ...n, id: 'task-' + (i + 1), inputs: [], ownership: { ...n.ownership, writes: ['task-' + (i + 1) + '.txt'], forbiddenWrites: [], sharedResources: [] },
  acceptance: { doneWhen: ['文件写入且内容正确'], commands: [{ argv: ['node', '-e', `if(require('fs').readFileSync('task-${i + 1}.txt','utf8')!=='task-${i + 1}')process.exit(1)`], cwdRef: 'node-worktree', expectedExitCode: 0 }], independentVerification: true },
  execution: { ...n.execution, backend: 'configured-agent', isolation: 'worktree', timeoutSeconds: 30, maxRepairAttempts: 0 } }))
wf.edges = []
wf.workflowId = request.workflowId
wf.executionProposal = { ...wf.executionProposal, maxConcurrency: CAP, requiredBaseline: 'selected-frozen-commit', requiredCapabilities: ['real-parent-agent', 'parallel-agents', 'worktree', 'cancel-cleanup', 'artifact-verification', 'wsl-execution'] }
const archNodes = wf.nodes.map((n, i) => ({ id: 'mod-' + (i + 1), kind: 'module', title: '模块 ' + (i + 1), responsibility: '独立模块' }))
planningReply = { requestId: request.payloadHash,
  architecture: { schemaVersion: 1, architectureId: request.architectureId, revision: 1, createdAt: new Date().toISOString(), nodes: archNodes, edges: [], constraints: request.constraints },
  workflow: wf,
  mappings: wf.nodes.map((n, i) => ({ workflowNodeId: n.id, architectureNodeIds: ['mod-' + (i + 1)], decisionIds: [] })),
  explanation: `${TASKS} 个独立模块并行` }
await ctx.sessionController.prompt({ sessionId, requestId: 'probe-planning', mode: 'queue', content: [{ type: 'text', text: exported.text ?? exported.prompt ?? JSON.stringify(request) }] }, new AbortController().signal)
const parent = (await ctx.sessionController.resolveAgent(sessionId)).agent
await parent.whenIdle()
const preview = await invoke('POST', '/planning/preview', { payloadHash: request.payloadHash, reply: planningReply })
await invoke('POST', '/planning/accept', { payloadHash: request.payloadHash, reply: planningReply, candidateHash: preview.candidateHash, expectedArchitectureRevision: null, expectedWorkflowRevision: null })
await ctx.commands.execute(parent, '/loom on', [], new AbortController().signal)
const streamsBeforeRun = streams.length
const admitted = await ctx.commands.execute(parent, `/loom run ${wf.workflowId} 1 ${baseSha}`, [], new AbortController().signal)
console.log(JSON.stringify({ admitted }))
let run
for (let i = 0; i < 400; i += 1) { run = store.latestRuns(10, ws)[0]; if (run && ['validated', 'failed', 'cancelled'].includes(run.state)) break; await new Promise(r => setTimeout(r, 100)) }
assert.ok(run, '没有运行记录')

const childStreams = streams.slice(streamsBeforeRun).filter((s) => s.session !== 'loom-probe-parent')
const events = []
for (const s of childStreams) { events.push([s.startedAt, 1], [s.endedAt ?? Date.now(), -1]) }
events.sort((a, b) => a[0] - b[0] || a[1] - b[1])
let live = 0, peak = 0
for (const [, delta] of events) { live += delta; peak = Math.max(peak, live) }

const report = {
  generatedAt: new Date().toISOString(),
  hostAnchor: anchor,
  scope: 'Real installed official host (same boot as verify-live-host), offline controlled adapter with 400ms hold, real worktrees and production dispatch path. No external model calls, no user profile changes.',
  holdMs: HOLD_MS,
  workflow: { tasks: TASKS, taskIds: wf.nodes.map(n => n.id), schemaMaxConcurrency: CAP, declaredMaxConcurrency: wf.executionProposal.maxConcurrency },
  run: { runId: run.runId, state: run.state, completed: run.receipt?.completed ?? [], auditGroups: (run.receipt?.audits ?? []).length },
  childLlmRequests: childStreams.length,
  peakConcurrentChildren: peak,
  measuredAt: { note: 'peak 由子代理 LLM 请求的起止时间戳算出（每个请求被刻意停 400ms）' },
  conclusion: `并发上限 ${CAP} 时，真实宿主上观测到同时开着的子代理 = ${peak}；` + (run.state === 'validated' ? '全部任务验收通过' : `运行状态 ${run.state}`),
  limitAboveCap: '未测：Loom 的 schema 把 maxConcurrency 限在 1..3，>3 的档位无法通过运行路径到达，因此本探针不宣布宿主的绝对上限。',
}
await writeFile(join(evidence, 'subagent-limit-probe.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ peakConcurrentChildren: peak, state: run.state, childLlmRequests: childStreams.length }))
console.log(report.conclusion)
await ctx.dispose?.()
