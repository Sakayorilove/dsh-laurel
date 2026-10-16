import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectArchive, installProfile, rollbackProfile } from '../scripts/install-profile.mjs'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
function tar(entries) {
  const chunks = []
  for (const { name, type = '0', data = '' } of entries) {
    const bytes = Buffer.from(data), header = Buffer.alloc(512)
    const field = (at, width, text) => header.write(text.slice(0, width), at, width, 'utf8')
    field(0, 100, name); field(100, 8, '0000644\0'); field(108, 8, '0000000\0'); field(116, 8, '0000000\0')
    field(124, 12, bytes.length.toString(8).padStart(11, '0') + '\0'); field(136, 12, '00000000000\0')
    field(148, 8, '        '); field(156, 1, type); field(257, 6, 'ustar\0'); field(263, 2, '00')
    field(148, 8, [...header].reduce((s, n) => s + n, 0).toString(8).padStart(6, '0') + '\0 ')
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  chunks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(chunks))
}
const bundleEntries = [
  { name: 'package/package.json', data: JSON.stringify({ name: 'dsh-loom', version: '0.3.0-test.1', type: 'module', main: './lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }) },
  { name: 'package/lib/index.js', data: 'export function apply() {}\n' },
  { name: 'package/lib/client.js', data: '// client test bundle\n' },
  { name: 'package/cordis.patch.yml', data: '- insert:\n    id: loom\n    name: dsh-loom\n' },
]
const baseLock = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: false
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      laurel:
        specifier: link:D:/<工作区>/laurel
        version: link:D:/<工作区>/laurel
      unrelated:
        specifier: 1.0.0
        version: 1.0.0

packages:

  unrelated@1.0.0:
    resolution: {integrity: sha512-foreign-exact-bytes}

snapshots:

  unrelated@1.0.0: {}
`
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'loom-install-test-')), profile = join(root, 'profile'), archive = join(root, 'plugin.tgz')
  mkdirSync(join(profile, 'node_modules', 'laurel'), { recursive: true })
  writeFileSync(join(profile, 'node_modules', 'laurel', 'KEEP'), 'user plugin stays byte-for-byte\n')
  const manifest = JSON.stringify({ name: 'fixture-profile', private: true, dependencies: { laurel: 'link:D:/<工作区>/laurel', unrelated: '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'laurel', 'unrelated'], patchReload: 'live' } }, arbitrary: { mustStay: '  exact value  ' } }, null, 2) + '\n'
  writeFileSync(join(profile, 'package.json'), manifest); writeFileSync(join(profile, 'pnpm-lock.yaml'), baseLock)
  const bytes = tar(bundleEntries); writeFileSync(archive, bytes)
  return { root, profile, archive, bytes, options: { profile, archive, archiveNative: 'D:/<工作区>/安装包/dsh-loom-test.tgz', sha256: hash(bytes) }, manifest }
}
test('tarball boundary rejects hashes, traversal, links, duplicates and runtime dependencies', () => {
  const valid = tar(bundleEntries)
  assert.equal(inspectArchive(valid, hash(valid)).manifest.name, 'dsh-loom')
  assert.throws(() => inspectArchive(valid, '0'.repeat(64)), /HASH_MISMATCH/)
  for (const entry of [{ name: 'package/../escape', data: 'x' }, { name: '/tmp/escape', data: 'x' }, { name: 'package/link', type: '2' }, { name: 'package/device', type: '3' }, { name: 'package/lib/index.js', data: 'duplicate' }, { name: 'package/LIB/index.js', data: 'Windows case collision' }, { name: 'package/lib/CON.txt', data: 'Windows device' }, { name: 'package/lib/trailing.', data: 'Windows alias' }]) {
    const unsafe = tar([...bundleEntries, entry]); assert.throws(() => inspectArchive(unsafe, hash(unsafe)), /UNSAFE|DUPLICATE/)
  }
  const deps = tar(bundleEntries.map((e, i) => i ? e : { ...e, data: JSON.stringify({ ...JSON.parse(e.data), dependencies: { unwanted: '1.0.0' } }) }))
  assert.throws(() => inspectArchive(deps, hash(deps)), /DEPENDENCIES_UNSUPPORTED/)
})
test('real offline pnpm stages installation; preserves unrelated profile bytes and exact rollback', () => {
  const f = fixture()
  try {
    const result = installProfile(f.options)
    assert.equal(result.ok, true); assert.equal(result.activation, 'host-composer-required')
    const afterText = readFileSync(join(f.profile, 'package.json'), 'utf8'), after = JSON.parse(afterText)
    assert.equal(after.dependencies['dsh-loom'], 'file:D:/<工作区>/安装包/dsh-loom-test.tgz')
    assert.equal(after.dsh.profile.bundles.filter((n) => n === 'dsh-loom').length, 1)
    assert.match(afterText, /"laurel": "link:D:\/<工作区>\/laurel",\n    "unrelated": "1.0.0"/)
    assert.match(afterText, /"arbitrary": \{\n    "mustStay": "  exact value  "\n  \}/)
    const lock = readFileSync(join(f.profile, 'pnpm-lock.yaml'), 'utf8')
    assert.match(lock, /      laurel:\n        specifier: link:D:\/<工作区>\/laurel\n        version: link:D:\/<工作区>\/laurel/)
    assert.match(lock, /  unrelated@1.0.0:\n    resolution: \{integrity: sha512-foreign-exact-bytes\}/)
    assert.match(lock, /sha512-/)
    assert.equal(readFileSync(join(f.profile, 'node_modules', 'dsh-loom', 'lib/index.js'), 'utf8'), bundleEntries[1].data)
    assert.equal(readFileSync(join(f.profile, 'node_modules', 'laurel', 'KEEP'), 'utf8'), 'user plugin stays byte-for-byte\n')
    const rolled = rollbackProfile(result.record)
    assert.equal(rolled.ok, true); assert.equal(readFileSync(join(f.profile, 'package.json'), 'utf8'), f.manifest)
    assert.equal(readFileSync(join(f.profile, 'pnpm-lock.yaml'), 'utf8'), baseLock)
    assert.equal(existsSync(join(f.profile, 'node_modules', 'dsh-loom')), false)
    assert.equal(existsSync(join(result.backup, 'payload.after', 'package.json')), true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
test('rollback removes only this Loom installation and preserves later unrelated edits', () => {
  const f = fixture()
  try {
    const result = installProfile(f.options)
    const packageFile = join(f.profile, 'package.json'), lockFile = join(f.profile, 'pnpm-lock.yaml')
    const current = JSON.parse(readFileSync(packageFile, 'utf8')); current.dependencies.laterPlugin = '2.0.0'; current.dsh.profile.bundles.push('laterPlugin'); current.arbitrary.newKey = 'later user value'
    writeFileSync(packageFile, JSON.stringify(current, null, 4) + '\n')
    const changedLock = readFileSync(lockFile, 'utf8').replace('settings:\n', '# later user comment\nsettings:\n')
    writeFileSync(lockFile, changedLock)
    const resultRollback = rollbackProfile(result.record)
    assert.equal(resultRollback.preservedLaterChanges, true)
    const restored = JSON.parse(readFileSync(packageFile, 'utf8'))
    assert.equal(restored.dependencies.laterPlugin, '2.0.0'); assert.ok(restored.dsh.profile.bundles.includes('laterPlugin'))
    assert.equal(restored.arbitrary.newKey, 'later user value'); assert.equal(Object.hasOwn(restored.dependencies, 'dsh-loom'), false)
    assert.match(readFileSync(lockFile, 'utf8'), /# later user comment/)
    assert.doesNotMatch(readFileSync(lockFile, 'utf8'), /dsh-loom/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
test('installation failure after package write restores exact files and existing Loom payload', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.profile, 'node_modules', 'dsh-loom'))
    writeFileSync(join(f.profile, 'node_modules', 'dsh-loom', 'OLD'), 'old rollback payload\n')
    assert.throws(() => installProfile({ ...f.options, faultInjection(stage) { if (stage === 'afterPackage') throw new Error('SIMULATED_IO_FAILURE') } }), /SIMULATED_IO_FAILURE/)
    assert.equal(readFileSync(join(f.profile, 'package.json'), 'utf8'), f.manifest)
    assert.equal(readFileSync(join(f.profile, 'pnpm-lock.yaml'), 'utf8'), baseLock)
    assert.equal(readFileSync(join(f.profile, 'node_modules', 'dsh-loom', 'OLD'), 'utf8'), 'old rollback payload\n')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
test('rollback refuses overwritten Loom without disturbing later payload', () => {
  const f = fixture()
  try {
    const result = installProfile(f.options)
    writeFileSync(join(f.profile, 'node_modules', 'dsh-loom', 'lib/index.js'), 'later Loom edit\n')
    assert.throws(() => rollbackProfile(result.record), /ROLLBACK_LOOM_CHANGED/)
    assert.equal(readFileSync(join(f.profile, 'node_modules', 'dsh-loom', 'lib/index.js'), 'utf8'), 'later Loom edit\n')
    assert.equal(JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8')).dependencies['dsh-loom'], 'file:D:/<工作区>/安装包/dsh-loom-test.tgz')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

function withHoistedMetadata(f, format = 'json') {
  mkdirSync(join(f.profile, 'node_modules', '.pnpm'))
  writeFileSync(join(f.profile, 'node_modules', '.pnpm', 'lock.yaml'), baseLock)
  const modules = format === 'json' ? JSON.stringify({ nodeLinker: 'hoisted', hoistedLocations: { 'laurel@link:D:/<工作区>/laurel': ['node_modules\\laurel'], 'unrelated@1.0.0': ['node_modules\\unrelated'] }, layoutVersion: 5, virtualStoreDir: 'C:\\Users\\fixture\\node_modules\\.pnpm', packageManager: 'pnpm@11.7.0', allowBuilds: { foreign: true } }, null, 2) + '\n'
    : 'hoistedLocations:\n  unrelated@1.0.0:\n    - node_modules/unrelated\nlayoutVersion: 5\nnodeLinker: hoisted\nvirtualStoreDir: /tmp/fixture/node_modules/.pnpm\n'
  writeFileSync(join(f.profile, 'node_modules', '.modules.yaml'), modules)
  return modules
}
test('Windows JSON hoisted metadata and current lock change only Loom and preserve later user entries on rollback', () => {
  const f = fixture(), modules = withHoistedMetadata(f)
  try {
    const result = installProfile(f.options), modulesFile = join(f.profile, 'node_modules', '.modules.yaml'), currentLock = join(f.profile, 'node_modules', '.pnpm', 'lock.yaml')
    const installedText = readFileSync(modulesFile, 'utf8'), installed = JSON.parse(installedText)
    assert.deepEqual(installed.hoistedLocations['dsh-loom@file:D:/<工作区>/安装包/dsh-loom-test.tgz'], ['node_modules\\dsh-loom'])
    for (const [key, value] of Object.entries(JSON.parse(modules))) if (key !== 'hoistedLocations') assert.deepEqual(installed[key], value)
    assert.deepEqual(installed.hoistedLocations['unrelated@1.0.0'], ['node_modules\\unrelated'])
    assert.match(readFileSync(currentLock, 'utf8'), /dsh-loom/)
    installed.hoistedLocations['later-user-package@2.0.0'] = ['node_modules\\later-user-package']; installed.allowBuilds.later = true
    writeFileSync(modulesFile, JSON.stringify(installed, null, 4) + '\n')
    writeFileSync(currentLock, readFileSync(currentLock, 'utf8').replace('settings:\n', '# current-lock later comment\nsettings:\n'))
    const rolled = rollbackProfile(result.record)
    assert.equal(rolled.preservedLaterChanges, true)
    const after = JSON.parse(readFileSync(modulesFile, 'utf8'))
    assert.equal(after.allowBuilds.later, true); assert.deepEqual(after.hoistedLocations['later-user-package@2.0.0'], ['node_modules\\later-user-package'])
    assert.deepEqual(Object.keys(after.hoistedLocations).filter((key) => key.startsWith('dsh-loom@')), [])
    assert.match(readFileSync(currentLock, 'utf8'), /# current-lock later comment/)
    assert.doesNotMatch(readFileSync(currentLock, 'utf8'), /dsh-loom/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
test('YAML hoisted metadata exact rollback and both metadata failure positions restore every byte', () => {
  for (const fault of [null, 'afterMetadata:current-lock', 'afterMetadata:modules']) {
    const f = fixture(), modules = withHoistedMetadata(f, 'yaml')
    try {
      if (fault) assert.throws(() => installProfile({ ...f.options, faultInjection(stage) { if (stage === fault) throw new Error('METADATA_IO_FAILURE') } }), /METADATA_IO_FAILURE/)
      else { const installed = installProfile(f.options); assert.match(readFileSync(join(f.profile, 'node_modules', '.modules.yaml'), 'utf8'), /node_modules\/dsh-loom/); rollbackProfile(installed.record) }
      assert.equal(readFileSync(join(f.profile, 'package.json'), 'utf8'), f.manifest)
      assert.equal(readFileSync(join(f.profile, 'pnpm-lock.yaml'), 'utf8'), baseLock)
      assert.equal(readFileSync(join(f.profile, 'node_modules', '.pnpm', 'lock.yaml'), 'utf8'), baseLock)
      assert.equal(readFileSync(join(f.profile, 'node_modules', '.modules.yaml'), 'utf8'), modules)
      assert.equal(existsSync(join(f.profile, 'node_modules', 'dsh-loom')), false)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  }
})
test('rollback refuses later changed Loom hoisted mapping before mutating any profile file', () => {
  const f = fixture(); withHoistedMetadata(f)
  try {
    const result = installProfile(f.options), file = join(f.profile, 'node_modules', '.modules.yaml'), value = JSON.parse(readFileSync(file, 'utf8'))
    value.hoistedLocations['dsh-loom@file:D:/<工作区>/安装包/dsh-loom-test.tgz'] = ['node_modules\\later-owned-location']
    writeFileSync(file, JSON.stringify(value, null, 2))
    const files = ['package.json', 'pnpm-lock.yaml', 'node_modules/.modules.yaml', 'node_modules/.pnpm/lock.yaml'].map((relative) => [relative, readFileSync(join(f.profile, relative))])
    assert.throws(() => rollbackProfile(result.record), /ROLLBACK_LOOM_METADATA_CHANGED/)
    for (const [relative, before] of files) assert.deepEqual(readFileSync(join(f.profile, relative)), before)
    assert.equal(existsSync(join(f.profile, 'node_modules', 'dsh-loom')), true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
test('real hoisted pnpm accepts frozen lock and subsequently updates Loom while preserving another installed package', () => {
  const f = fixture()
  try {
    rmSync(join(f.profile, 'node_modules'), { recursive: true }); rmSync(join(f.profile, 'pnpm-lock.yaml'))
    const foreignArchive = join(f.root, 'foreign.tgz'), store = join(f.root, 'store')
    writeFileSync(foreignArchive, tar([{ name: 'package/package.json', data: JSON.stringify({ name: 'foreign-package', version: '1.0.0', main: 'index.js' }) }, { name: 'package/index.js', data: 'module.exports = "foreign exact bytes"\n' }]))
    writeFileSync(join(f.profile, 'package.json'), JSON.stringify({ private: true }))
    const pnpm = (...args) => { const result = spawnSync('pnpm', ['--offline', '--ignore-scripts', '--store-dir', store, '--config.node-linker=hoisted', '--config.auto-install-peers=false', ...args], { cwd: f.profile, encoding: 'utf8', env: { ...process.env, CI: 'true' } }); assert.equal(result.status, 0, result.stdout + result.stderr) }
    pnpm('add', foreignArchive)
    const packageFile = join(f.profile, 'package.json'), manifest = JSON.parse(readFileSync(packageFile, 'utf8')); manifest.dsh = { profile: { bundles: ['foreign-package'], patchReload: 'live' } }; writeFileSync(packageFile, JSON.stringify(manifest, null, 2))
    const foreignBefore = readFileSync(join(f.profile, 'node_modules', 'foreign-package', 'index.js'))
    const installed = installProfile({ ...f.options, archiveNative: f.archive })
    assert.equal(installed.ok, true)
    pnpm('install', '--frozen-lockfile')
    assert.deepEqual(readFileSync(join(f.profile, 'node_modules', 'foreign-package', 'index.js')), foreignBefore)
    assert.equal(JSON.parse(readFileSync(join(f.profile, 'node_modules', 'dsh-loom', 'package.json'), 'utf8')).version, '0.3.0-test.1')
    const upgrade = join(f.root, 'plugin-upgrade.tgz')
    writeFileSync(upgrade, tar(bundleEntries.map((entry, index) => index ? entry : { ...entry, data: JSON.stringify({ ...JSON.parse(entry.data), version: '0.3.0-test.2' }) })))
    pnpm('add', upgrade)
    assert.equal(JSON.parse(readFileSync(join(f.profile, 'node_modules', 'dsh-loom', 'package.json'), 'utf8')).version, '0.3.0-test.2')
    assert.deepEqual(readFileSync(join(f.profile, 'node_modules', 'foreign-package', 'index.js')), foreignBefore)
    assert.ok(JSON.parse(readFileSync(packageFile, 'utf8')).dsh.profile.bundles.includes('dsh-loom'))
    assert.throws(() => rollbackProfile(installed.record), /ROLLBACK_LOOM_CHANGED/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('rollback preserves a later user removal of the Loom activation entry', () => {
  const f = fixture()
  try {
    const installed = installProfile(f.options), file = join(f.profile, 'package.json'), value = JSON.parse(readFileSync(file, 'utf8'))
    value.dsh.profile.bundles = value.dsh.profile.bundles.filter((name) => name !== 'dsh-loom')
    writeFileSync(file, JSON.stringify(value, null, 2))
    const changed = readFileSync(file)
    assert.throws(() => rollbackProfile(installed.record), /ROLLBACK_LOOM_CHANGED/)
    assert.deepEqual(readFileSync(file), changed)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
