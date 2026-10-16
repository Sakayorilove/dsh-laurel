import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
let loaded
const window = { __loomAllowTestHooks: true, __ModuleLoader__: { load: x => { loaded = x } } }
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window })
const clientExports = loaded.factory(() => ({}))
const flowEdgeColors = clientExports.flowEdgeColors
const motionOn = clientExports.edgeMotionEnabled

const node = (id, x, y) => ({ id, x, y })
const hex = /^#[0-9a-f]{6}$/i

test('flow colours follow whole routes and split at fan-out', () => {
  const nodes = [node('a', 0, 0), node('b', 200, 0), node('c', 200, 100), node('d', 400, 50)]
  const edges = [
    { id: 'ab', from: 'a', to: 'b' },
    { id: 'ac', from: 'a', to: 'c' },
    { id: 'bd', from: 'b', to: 'd' },
    { id: 'cd', from: 'c', to: 'd' },
  ]
  const colors = flowEdgeColors(nodes, edges)
  assert.equal(colors.get('ab'), colors.get('bd'), 'the a-b route keeps one colour')
  assert.equal(colors.get('ac'), colors.get('cd'), 'the a-c route keeps one colour')
  assert.notEqual(colors.get('ab'), colors.get('ac'), 'the two routes are visibly different')
  assert.ok([...colors.values()].every((c) => hex.test(c)))
})

test('task edges (source/target) work, chains keep one colour and cycles are covered', () => {
  const nodes = [node('a', 0, 0), node('b', 100, 0), node('c', 200, 0)]
  const edges = [
    { id: 'ab', source: 'a', target: 'b' },
    { id: 'bc', source: 'b', target: 'c' },
    { id: 'ca', source: 'c', target: 'a' },
  ]
  const first = flowEdgeColors(nodes, edges)
  assert.equal(first.get('ab'), first.get('bc'), 'a plain chain is one colour')
  assert.equal(first.get('ca'), first.get('ab'), 'the cycle member continues the same flow colour')
  assert.equal(first.size, 3)
  assert.deepEqual([...flowEdgeColors(nodes, edges).entries()].sort(), [...first.entries()].sort(), 'deterministic')
})

test('more than eight flows wrap the palette without losing coverage', () => {
  const nodes = [node('root', 0, 0)]
  const edges = []
  for (let i = 0; i < 10; i += 1) {
    nodes.push(node('m' + i, 200, i * 60))
    edges.push({ id: 'e' + i, from: 'root', to: 'm' + i })
  }
  const colors = flowEdgeColors(nodes, edges)
  assert.equal(colors.size, 10)
  assert.equal(colors.get('e0'), colors.get('e8'), 'palette wraps after eight distinct colours')
  assert.notEqual(colors.get('e0'), colors.get('e1'))
})

test('motion setting overrides the system reduced-motion preference', () => {
  assert.equal(motionOn('auto', true), false)
  assert.equal(motionOn('auto', false), true)
  assert.equal(motionOn('on', true), true)
  assert.equal(motionOn('off', false), false)
  assert.equal(motionOn(undefined, false), true)
  assert.equal(motionOn(undefined, true), false)
})

test('step routes follow the flow orientation (vertical first, then horizontal)', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 300, y: 200 }
  const edgePath = clientExports.edgePathFor
  const vertical = edgePath(a, b, 'step', 0, 'vertical')
  const horizontal = edgePath(a, b, 'step', 0, 'horizontal')
  assert.match(vertical, /^M 0 0 L 0 /, '竖排应先竖直走：第一条线段 x 不变')
  assert.match(horizontal, /^M 0 0 L \d+ 0/, '横排应先水平走：第一条线段 y 不变')
  assert.notEqual(vertical, horizontal)
})

test('centred offsets spread symmetrically and stay zero for one item', () => {
  const centered = clientExports.centeredOffset
  assert.equal(centered(0, 1, 50), 0)
  assert.equal(centered(0, 2, 40), -20)
  assert.equal(centered(1, 2, 40), 20)
  assert.equal(centered(1, 3, 40), 0)
  assert.equal(centered(0, 3, 40) + centered(2, 3, 40), 0)
  assert.equal(centered(0, 3, 0), 0, 'zero span means no offset')
})
