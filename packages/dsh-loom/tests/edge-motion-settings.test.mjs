import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, normalizeConfig, validateConfigPatch } from '../lib/config.js'

test('arrow settings have safe defaults, normalization and validation', () => {
  assert.equal(DEFAULT_CONFIG.edgeArrows, true)
  assert.equal(DEFAULT_CONFIG.edgeMotion, 'auto')
  assert.equal(normalizeConfig({}).edgeArrows, true)
  assert.equal(normalizeConfig({}).edgeMotion, 'auto')
  assert.equal(normalizeConfig({ edgeArrows: false }).edgeArrows, false)
  assert.equal(normalizeConfig({ edgeMotion: 'on' }).edgeMotion, 'on')
  assert.equal(normalizeConfig({ edgeMotion: 'off' }).edgeMotion, 'off')
  assert.equal(normalizeConfig({ edgeMotion: 'bogus' }).edgeMotion, 'auto', '未知取值回落到默认')
  validateConfigPatch({ edgeArrows: false })
  validateConfigPatch({ edgeMotion: 'off' })
  assert.throws(() => validateConfigPatch({ edgeArrows: 'yes' }), /布尔值/)
  assert.throws(() => validateConfigPatch({ edgeMotion: 'fast' }), /edgeMotion/)
})
