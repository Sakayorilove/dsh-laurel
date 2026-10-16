import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

let loaded
const window = { __loomAllowTestHooks: true, __ModuleLoader__: { load: (x) => { loaded = x } } }
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window })
const clientExports = loaded.factory(() => ({}))
const arrange = clientExports.autoArrangeGraph
const edgePath = clientExports.edgePathFor
const laneMoves = clientExports.flowLaneMoves
const auditText = clientExports.auditReportText

test('audit receipts turn into a self-contained copyable report', () => {
  const text = auditText({ groupId: 'group-1', label: '审计 1', verdict: 'pass', taskIds: ['inspect', 'contract'], findings: ['接口契约与实现一致', '  缺一条边界用例  '] })
  assert.match(text, /审计组 group-1 · 主审 审计 1 · 通过/)
  assert.match(text, /覆盖任务：inspect、contract/)
  assert.match(text, /- 接口契约与实现一致/)
  assert.match(text, /- 缺一条边界用例/) // 首尾空白被去掉
  assert.equal(text.split('\n').filter((l) => l.startsWith('- ')).length, 2)
  // 缺字段不抛错：未通过 + 没有结论 + 没有覆盖任务
  const bare = auditText({ verdict: 'fail' })
  assert.match(bare, /审计组 \(未命名\) · 主审 \(未指定\) · 未通过/)
  assert.match(bare, /覆盖任务：无/)
  assert.match(bare, /- 无额外结论/)
  assert.match(auditText(null), /未通过/)
})

test('lane step-order buttons follow the orientation and skip the ends', () => {
  // 注意：client.js 跑在独立 vm 上下文里，跨 realm 的数组不能 deepStrictEqual，比较序列化结果。
  const moves = (orientation, index, total) => JSON.stringify(laneMoves(orientation, index, total).map((m) => [m.glyph, m.delta]))
  // 竖排：▲ 往前、▼ 往后；第一条没有 ▲，最后一条没有 ▼。
  assert.equal(moves('vertical', 0, 3), '[["▼",1]]')
  assert.equal(moves('vertical', 1, 3), '[["▲",-1],["▼",1]]')
  assert.equal(moves('vertical', 2, 3), '[["▲",-1]]')
  // 横排：◀ ▶，方向与「自左而右」一致。
  assert.equal(moves('horizontal', 1, 3), '[["◀",-1],["▶",1]]')
  // 只有一条步骤时两头都没有按钮。
  assert.equal(moves('vertical', 0, 1), '[]')
})

test('layered auto layout puts dependencies into increasing columns', () => {
  const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id, x: 0, y: 0 }))
  arrange(nodes, [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'a', target: 'd' }], 'task')
  const at = Object.fromEntries(nodes.map((n) => [n.id, n]))
  assert.ok(at.a.x < at.b.x && at.b.x < at.c.x, 'chain occupies three columns')
  assert.equal(at.d.x, at.b.x, 'same depth shares one column')
  assert.notEqual(at.b.y, at.d.y, 'same-column nodes stay apart')
})

test('diamond graphs keep the middle column before the join node', () => {
  const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id, x: 0, y: 0 }))
  arrange(nodes, [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }, { source: 'b', target: 'd' }, { source: 'c', target: 'd' }], 'task')
  const at = Object.fromEntries(nodes.map((n) => [n.id, n]))
  assert.equal(at.b.x, at.c.x)
  assert.ok(at.b.x < at.d.x)
})

test('architecture cycles do not break the layout', () => {
  const nodes = ['a', 'b', 'c'].map((id) => ({ id, x: 0, y: 0 }))
  arrange(nodes, [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'b', to: 'c' }], 'architecture')
  const at = Object.fromEntries(nodes.map((n) => [n.id, n]))
  for (const n of nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y))
  assert.ok(at.a.x < at.b.x && at.b.x < at.c.x)
})

test('empty and unknown-edge graphs are no-ops', () => {
  assert.deepEqual(arrange([], [], 'task'), [])
  const nodes = [{ id: 'solo', x: 0, y: 0 }]
  arrange(nodes, [{ source: 'solo', target: 'missing' }], 'task')
  assert.ok(Number.isFinite(nodes[0].x))
})

test('ordering passes reduce avoidable crossings', () => {
  const nodes = ['a1', 'a2', 'b1', 'b2'].map((id) => ({ id, x: 0, y: 0 }))
  arrange(nodes, [{ source: 'a1', target: 'b2' }, { source: 'a2', target: 'b1' }], 'task')
  const at = Object.fromEntries(nodes.map((n) => [n.id, n]))
  assert.ok(at.b2.y < at.b1.y, 'targets follow their sources order to avoid a crossing')
})
test('edge styles produce distinct, valid paths', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 300, y: 120 }
  const curve = edgePath(a, b, 'curve')
  const step = edgePath(a, b, 'step')
  const straight = edgePath(a, b, 'straight')
  const mind = edgePath(a, b, 'mindmap')
  for (const d of [curve, step, straight, mind]) assert.match(d, /^M /)
  assert.notEqual(curve, step)
  assert.notEqual(step, straight)
  assert.notEqual(straight, mind)
  assert.notEqual(curve, mind)
})
