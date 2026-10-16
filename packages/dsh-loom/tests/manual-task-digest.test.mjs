import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { samplePlannerOutput } from './fixtures.mjs'
let loaded
const window = { __loomAllowTestHooks: true, __ModuleLoader__: { load: value => { loaded = value } } }
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window })
const digest = loaded.factory(() => ({})).semanticDigest

test('manual executable edits always make adopted task semantics dirty; presentation/order stays irrelevant', () => {
  const workflow = samplePlannerOutput(), initial = digest(workflow)
  const cases = [
    node => { node.ownership.writes.push('new/module/**') },
    node => { node.ownership.forbiddenWrites.push('private/**') },
    node => { node.acceptance.doneWhen.push('actual result condition') },
    node => { node.acceptance.commands[0].argv.push('--runInBand') },
    node => { node.acceptance.commands[0].cwdRef = 'prepared-baseline' },
    node => { node.acceptance.commands[0].expectedExitCode = 1 },
    node => { node.execution.timeoutSeconds += 60 },
    node => { node.execution.maxRepairAttempts += 1 },
    node => { node.execution.isolation = 'read-only' },
    node => { node.execution.backend = 'deterministic' },
  ]
  for (const mutate of cases) { const copy=structuredClone(workflow);mutate(copy.nodes[2]);assert.notEqual(digest(copy),initial) }
  const ordered=structuredClone(workflow);ordered.nodes.reverse();ordered.edges.reverse()
  for (const node of ordered.nodes) { node.x=800;node.y=500;node.ownership.writes.reverse();node.ownership.forbiddenWrites.reverse() }
  assert.equal(digest(ordered),initial,'layout and stable set order do not require a new adopted task revision')
})
