import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { executeWsl, windowsToWslPath } from '../lib/bridge.js'

test('WSL process receipts, cancellation, timeout, output budget, argv safety', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'loom-bridge-'))
  const node = (code, options) => executeWsl([process.execPath, '-e', code], cwd, options)
  try {
    await t.test('real cwd/platform and output hash', async () => {
      const r = await node('console.log(process.platform); console.log(process.cwd())')
      assert.equal(r.state, 'passed'); assert.equal(r.cwd, cwd); assert.equal(r.platform, 'linux')
      assert.equal(r.stdoutHash, createHash('sha256').update(r.stdout).digest('hex'))
      assert.match(r.stdout, /linux/)
    })
    await t.test('shell metacharacters remain literal arguments', async () => {
      const marker = '$(touch /tmp/loom-should-not-exist);`id`'
      const r = await executeWsl([process.execPath, '-e', 'console.log(process.argv[1])', marker], cwd)
      assert.equal(r.stdout.trim(), marker)
    })
    await t.test('nonzero exits are failed', async () => { assert.equal((await node('process.exit(7)')).state, 'failed') })
    await t.test('timeout kills the owned command group', async () => {
      const r = await node('setInterval(() => {}, 1000)', { timeoutMs: 80 })
      assert.equal(r.state, 'timed-out'); assert.throws(() => process.kill(r.pid, 0))
    })
    await t.test('cancellation waits for command quiescence', async () => {
      const abort = new AbortController()
      const pending = node('setInterval(() => {}, 1000)', { signal: abort.signal })
      setTimeout(() => abort.abort(), 150)
      const r = await pending
      assert.equal(r.state, 'cancelled'); assert.throws(() => process.kill(r.pid, 0))
    })
    await t.test('large output is bounded while its full content hash is retained', async () => {
      const r = await node("process.stdout.write('a'.repeat(50000))", { maxOutputBytes: 1000 })
      assert.equal(r.stdout.length, 1000); assert.equal(r.outputTruncated, true)
      assert.equal(r.stdoutHash, createHash('sha256').update('a'.repeat(50000)).digest('hex'))
    })
    await t.test('Windows path conversion is deterministic and rejects UNC', () => {
      assert.equal(windowsToWslPath('D:\\example\\lib\\wsl-worker.js'), '/mnt/d/example/lib/wsl-worker.js')
      assert.throws(() => windowsToWslPath('\\\\host\\share\\worker.js'))
    })
    await t.test('already aborted signals refuse before process creation', async () => {
      const abort = new AbortController(); abort.abort()
      await assert.rejects(node('process.exit(0)', { signal: abort.signal }), /cancelled before start/)
    })
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
