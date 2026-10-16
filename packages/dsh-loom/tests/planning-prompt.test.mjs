import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoomStore } from '../lib/store.js'
import { exportInitialPlanning } from '../lib/core/initial-planner.js'

test('initial planning prompt requests a complete candidate through the guarded submit tool', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-prompt-'))
  try {
    const store = new LoomStore(home)
    const goal = '把现在的报告流程改成可并行执行的三段式流水线，并保留现有命令'
    const exported = exportInitialPlanning(store, 'ws-prompt', {
      goal, constraints: ['WSL'], architectureId: 'loom-architecture', workflowId: 'loom-default',
      expectedArchitectureRevision: null, expectedWorkflowRevision: null,
    }, 2)
    assert.match(exported.text, /loom_submit_plan/)
    assert.match(exported.text, /完整文字计划/)
    assert.match(exported.text, /停止|等待/)
    assert.doesNotMatch(exported.text, /只写 1–3 句中文说明/)
    assert.ok(exported.text.length <= 3700, `prompt should stay compact, got ${exported.text.length}`)
    assert.equal(exported.payloadHash.length, 64)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
