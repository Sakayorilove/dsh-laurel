/**
 * 交付守卫：证据文件不许串版本（2026-10-06 实测事故的回归用例）。
 *
 * `.verification/` 会被 `write-manifest.mjs` 整个拷进 `evidence/<版本>/`，
 * 里面的 installation-record / desktop-activation 是上一版留下的。若 manifest
 * 不核对版本，就会出现「新版证据目录里躺着旧版安装记录」——发布证据自相矛盾。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertEvidenceVersion } from '../scripts/manifest-guard.mjs'

test('evidence records must belong to the version being released', () => {
  // 版本一致：原样返回，manifest 可以继续。
  const ok = { version: '0.7.6', transactionId: 'tx' }
  assert.equal(assertEvidenceVersion('0.7.6', 'installation-record.json', ok), ok)
  // 没有这份证据：返回空，交给 manifest 的 notVerified 逻辑（不是错误）。
  assert.equal(assertEvidenceVersion('0.7.6', 'installation-record.json', null), null)
  // 串版本：必须挡住，且错误信息里点名是哪一份、哪个版本。
  assert.throws(() => assertEvidenceVersion('0.7.6', 'installation-record.json', { version: '0.7.5' }), /installation-record\.json 属于版本 0\.7\.5/)
  assert.throws(() => assertEvidenceVersion('0.7.6', 'desktop-activation.json', { version: '0.7.5' }), /desktop-activation\.json 属于版本 0\.7\.5/)
})
