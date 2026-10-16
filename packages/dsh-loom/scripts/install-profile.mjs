#!/usr/bin/env node
/** WSL-only local tarball installer. It edits only Loom-owned profile entries.
 * Bundle activation remains the host composer's responsibility. */
import { createHash, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, posix } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const NAME = 'dsh-loom'
const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex')
const fail = (message) => { throw new Error(message) }
const MAX_ARCHIVE = 16 * 1024 * 1024, MAX_EXPANDED = 64 * 1024 * 1024

/** Inspect every header before extraction; links and special files never land. */
export function inspectArchive(bytes, expectedHash) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || digest(bytes) !== expectedHash) fail('ARCHIVE_HASH_MISMATCH')
  if (bytes.length > MAX_ARCHIVE) fail('ARCHIVE_TOO_LARGE')
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED })
  const files = new Map(), pathKinds = new Map(); let offset = 0, count = 0, terminated = false
  const text = (buffer) => buffer.toString('utf8').replace(/\0.*$/s, '')
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) {
      if (offset + 1024 > tar.length || !tar.subarray(offset).every((b) => b === 0)) fail('ARCHIVE_BAD_TERMINATOR')
      terminated = true; break
    }
    if (++count > 2000) fail('ARCHIVE_TOO_MANY_ENTRIES')
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]
    if (parseInt(text(header.subarray(148, 156)).trim(), 8) !== sum) fail('ARCHIVE_BAD_CHECKSUM')
    const prefix = text(header.subarray(345, 500)), name = (prefix ? prefix + '/' : '') + text(header.subarray(0, 100))
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    if (!['0', '5'].includes(type)) fail('ARCHIVE_UNSAFE_TYPE: ' + type)
    if (!name.startsWith('package/') || name.includes('\\') || name.includes(':') || name.includes('\0') || posix.normalize(name).replace(/\/$/, '') !== name.replace(/\/$/, '') || name.split('/').some((p) => p === '..' || p === '.')) fail('ARCHIVE_UNSAFE_PATH: ' + name)
    const sizeField = text(header.subarray(124, 136)).trim()
    if (!/^[0-7]+$/.test(sizeField)) fail('ARCHIVE_BAD_SIZE')
    const size = parseInt(sizeField, 8)
    offset += 512
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_EXPANDED || offset + size > tar.length) fail('ARCHIVE_TRUNCATED')
    const relative = name.slice('package/'.length).replace(/\/$/, '')
    if (relative) {
      const parts = relative.split('/')
      if (parts.some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('ARCHIVE_UNSAFE_WINDOWS_PATH')
      const canonical = relative.toLowerCase(), prior = pathKinds.get(canonical)
      if (prior && (prior.name !== relative || prior.type !== type || type === '0')) fail('ARCHIVE_DUPLICATE_FILE')
      for (let index = 1; index < parts.length; index++) if (pathKinds.get(parts.slice(0, index).join('/').toLowerCase())?.type === '0') fail('ARCHIVE_FILE_PARENT')
      if (type === '0' && [...pathKinds.keys()].some((path) => path.startsWith(canonical + '/'))) fail('ARCHIVE_FILE_PARENT')
      pathKinds.set(canonical, { name: relative, type })
    }
    if (type === '0') {
      if (!relative || files.has(relative)) fail('ARCHIVE_DUPLICATE_FILE')
      files.set(relative, Buffer.from(tar.subarray(offset, offset + size)))
    } else if (size !== 0) fail('ARCHIVE_DIRECTORY_DATA')
    offset += Math.ceil(size / 512) * 512
  }
  if (!terminated) fail('ARCHIVE_BAD_TERMINATOR')
  const manifest = JSON.parse(files.get('package.json')?.toString('utf8') ?? 'null')
  if (manifest?.name !== NAME || typeof manifest.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(manifest.version)) fail('ARCHIVE_PACKAGE_INVALID')
  if (Object.keys(manifest.dependencies ?? {}).length || Object.keys(manifest.optionalDependencies ?? {}).length || Object.keys(manifest.peerDependencies ?? {}).length) fail('ARCHIVE_RUNTIME_DEPENDENCIES_UNSUPPORTED')
  if (manifest.main !== './lib/index.js' || manifest.dsh?.bundle?.patch !== './cordis.patch.yml' || !files.has('lib/index.js') || !files.has('lib/client.js') || !files.has('cordis.patch.yml')) fail('ARCHIVE_NOT_LOOM_BUNDLE')
  return { files, manifest }
}

function treeHash(path) {
  if (!existsSync(path)) return null
  const facts = []
  const visit = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const current = join(dir, name), relative = prefix + name, stat = lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) fail('PAYLOAD_UNSAFE_ENTRY: ' + relative)
      if (stat.isDirectory()) { facts.push([relative + '/', 'directory']); visit(current, relative + '/') }
      else facts.push([relative, digest(readFileSync(current))])
    }
  }
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) fail('EXISTING_PAYLOAD_NOT_DIRECTORY')
  visit(path, '')
  return digest(JSON.stringify(facts))
}

function atomicWrite(file, bytes) {
  const temp = file + '.loom-tmp-' + randomUUID()
  writeFileSync(temp, bytes, { flag: 'wx', mode: existsSync(file) ? statSync(file).mode & 0o777 : 0o600 })
  try { renameSync(temp, file) } finally { if (existsSync(temp)) rmSync(temp) }
}

// JSON source spans preserve every unrelated key/value byte and indentation.
function valueEnd(text, start) {
  let i = start
  if (text[i] === '"') { for (i++; i < text.length; i++) { if (text[i] === '\\') i++; else if (text[i] === '"') return i + 1 } }
  if (text[i] === '{' || text[i] === '[') {
    const close = text[i] === '{' ? '}' : ']'; i++
    while (i < text.length) { if (text[i] === close) return i + 1; if (/\s|,|:/.test(text[i])) i++; else i = valueEnd(text, i) }
  }
  while (i < text.length && !/[\s,}\]]/.test(text[i])) i++
  if (i <= start) fail('MANIFEST_INVALID_JSON')
  return i
}
function objectProperties(text, start) {
  if (text[start] !== '{') fail('MANIFEST_OBJECT_REQUIRED')
  const entries = []; let i = start + 1, previousComma = null
  while (i < text.length) {
    while (/\s/.test(text[i] ?? '')) i++
    if (text[i] === '}') return { entries, end: i }
    const propertyStart = i, keyEnd = valueEnd(text, i), key = JSON.parse(text.slice(i, keyEnd)); i = keyEnd
    while (/\s/.test(text[i] ?? '')) i++; if (text[i++] !== ':') fail('MANIFEST_INVALID_JSON')
    while (/\s/.test(text[i] ?? '')) i++; const startValue = i, endValue = valueEnd(text, i); i = endValue
    while (/\s/.test(text[i] ?? '')) i++
    const comma = text[i] === ',' ? i++ : null
    entries.push({ key, propertyStart, startValue, endValue, comma, previousComma }); previousComma = comma
  }
  fail('MANIFEST_INVALID_JSON')
}
function property(text, path) {
  let start = text.search(/\S/), found
  for (const key of path) { found = objectProperties(text, start).entries.find((p) => p.key === key); if (!found) return null; start = found.startValue }
  return found
}
function setProperty(text, path, value, remove = false) {
  const parent = property(text, path.slice(0, -1)), start = parent ? parent.startValue : text.search(/\S/)
  const object = objectProperties(text, start), item = object.entries.find((p) => p.key === path.at(-1))
  if (item) {
    if (!remove) return text.slice(0, item.startValue) + JSON.stringify(value) + text.slice(item.endValue)
    const from = item.comma !== null ? item.propertyStart : item.previousComma ?? item.propertyStart
    const to = item.comma !== null ? item.comma + 1 : item.endValue
    return text.slice(0, from) + text.slice(to)
  }
  if (remove) return text
  const indentation = text.slice(0, start).match(/(?:^|\n)([ \t]*)[^\n]*$/)?.[1] ?? ''
  const insert = `${object.entries.length ? ',' : ''}\n${indentation}  ${JSON.stringify(path.at(-1))}: ${JSON.stringify(value)}\n${indentation}`
  const at = object.entries.at(-1)?.endValue ?? start + 1
  return text.slice(0, at) + insert + text.slice(at)
}
function modifyBundle(text, enabled) {
  const slot = property(text, ['dsh', 'profile', 'bundles'])
  if (!slot || text[slot.startValue] !== '[') fail('PROFILE_BUNDLES_REQUIRED')
  const items = []; let i = slot.startValue + 1
  while (i < slot.endValue - 1) { while (/[\s,]/.test(text[i] ?? '')) i++; if (i >= slot.endValue - 1) break; const end = valueEnd(text, i); items.push({ start: i, end, value: JSON.parse(text.slice(i, end)) }); i = end }
  const existing = items.filter((x) => x.value === NAME)
  if (existing.length > 1) fail('PROFILE_DUPLICATE_LOOM_BUNDLE')
  if (enabled === Boolean(existing.length)) return text
  if (enabled) {
    const at = items.at(-1)?.end ?? slot.startValue + 1
    return text.slice(0, at) + (items.length ? ',' : '') + '\n        "dsh-loom"' + text.slice(at)
  }
  const item = existing[0], index = items.indexOf(item)
  const from = index ? text.lastIndexOf(',', item.start) : item.start
  const to = index ? item.end : items.length > 1 ? text.indexOf(',', item.end) + 1 : item.end
  return text.slice(0, from) + text.slice(to)
}

function lines(text) {
  const out = []; let offset = 0
  for (const line of text.split(/(?<=\n)/)) { out.push({ text: line.replace(/[\r\n]+$/, ''), start: offset, end: offset + line.length }); offset += line.length }
  return out
}
function yamlKey(raw) {
  if (raw.startsWith('"')) return JSON.parse(raw)
  if (raw.startsWith("'")) return raw.slice(1, -1).replace(/''/g, "'")
  return raw
}
function blocks(text, start = 0, end = text.length, indent = 0) {
  const source = lines(text).filter((l) => l.start >= start && l.start < end)
  const result = []
  for (let i = 0; i < source.length; i++) {
    const line = source[i], match = new RegExp('^ {' + indent + '}([^ ].*?):(?:[ \\t].*)?$').exec(line.text)
    if (!match) continue
    let j = i + 1
    while (j < source.length && (!source[j].text.trim() || source[j].text.trimStart().startsWith('#') || source[j].text.search(/\S/) > indent)) j++
    let last = j - 1; while (last > i && !source[last].text.trim()) last--
    result.push({ key: yamlKey(match[1]), start: line.start, end: source[last].end, scopeEnd: source[j]?.start ?? end, content: text.slice(line.start, source[last].end) })
  }
  return result
}
function section(text, key) { const found = blocks(text).find((b) => b.key === key); if (!found) fail('LOCK_SECTION_MISSING: ' + key); return found }
function importerDeps(text) {
  const root = section(text, 'importers'), importer = blocks(text, root.start + 'importers:'.length, root.scopeEnd, 2).find((b) => b.key === '.')
  if (!importer) fail('LOCK_ROOT_IMPORTER_REQUIRED')
  const deps = blocks(text, importer.start + 1, importer.scopeEnd, 4).find((b) => b.key === 'dependencies')
  if (!deps) fail('LOCK_DEPENDENCIES_REQUIRED')
  return deps
}
function ownedLock(text) {
  if (!/^lockfileVersion: ['"]?9\.0['"]?\s*$/m.test(text)) fail('LOCK_VERSION_UNSUPPORTED')
  const deps = importerDeps(text), importer = blocks(text, deps.start + 1, deps.scopeEnd, 6).filter((b) => b.key === NAME).map((b) => b.content)
  const bySection = (name) => { const root = section(text, name); return blocks(text, root.start + 1, root.scopeEnd, 2).filter((b) => b.key.startsWith(NAME + '@')).map((b) => b.content) }
  return { importer, packages: bySection('packages'), snapshots: bySection('snapshots') }
}
function replaceOwnedLock(text, desired) {
  for (const name of ['importer', 'packages', 'snapshots']) {
    let scope = name === 'importer' ? importerDeps(text) : section(text, name)
    const indent = name === 'importer' ? 6 : 2
    const owned = blocks(text, scope.start + 1, scope.scopeEnd, indent).filter((b) => name === 'importer' ? b.key === NAME : b.key.startsWith(NAME + '@'))
    for (const block of owned.reverse()) text = text.slice(0, block.start) + text.slice(block.end)
    scope = name === 'importer' ? importerDeps(text) : section(text, name)
    if (desired[name].length) { const at = scope.scopeEnd; const addition = desired[name].join(''); text = text.slice(0, at) + (at && text[at - 1] !== '\n' ? '\n' : '') + addition + text.slice(at) }
  }
  return text
}

// pnpm keeps a second current lock and hoisted placement map. Update only Loom
// there too, preserving native Windows paths and every other package entry.
function ownedModules(text) {
  if (text.trimStart().startsWith('{')) {
    const value = JSON.parse(text)
    if (value.nodeLinker !== 'hoisted' || !value.hoistedLocations || typeof value.hoistedLocations !== 'object' || Array.isArray(value.hoistedLocations)) fail('MODULES_LAYOUT_UNSUPPORTED')
    return { format: 'json', entries: Object.entries(value.hoistedLocations).filter(([key]) => key.startsWith(NAME + '@')) }
  }
  if (!/^nodeLinker: ['"]?hoisted['"]?\s*$/m.test(text)) fail('MODULES_LAYOUT_UNSUPPORTED')
  const scope = section(text, 'hoistedLocations')
  if (scope.content.split('\n')[0].trim() !== 'hoistedLocations:') fail('MODULES_LOCATIONS_UNSUPPORTED')
  return { format: 'yaml', entries: blocks(text, scope.start + 1, scope.scopeEnd, 2).filter((b) => b.key.startsWith(NAME + '@')).map((b) => b.content) }
}
function replaceOwnedModules(text, desired) {
  const current = ownedModules(text)
  if (current.format !== desired.format) fail('MODULES_FORMAT_CHANGED')
  if (current.format === 'json') {
    for (const [key] of current.entries) text = setProperty(text, ['hoistedLocations', key], null, true)
    for (const [key, value] of desired.entries) text = setProperty(text, ['hoistedLocations', key], value)
    return text
  }
  let scope = section(text, 'hoistedLocations')
  for (const block of blocks(text, scope.start + 1, scope.scopeEnd, 2).filter((b) => b.key.startsWith(NAME + '@')).reverse()) text = text.slice(0, block.start) + text.slice(block.end)
  scope = section(text, 'hoistedLocations')
  return text.slice(0, scope.scopeEnd) + desired.entries.join('') + text.slice(scope.scopeEnd)
}
function nativeHoistedPath(text) {
  if (text.trimStart().startsWith('{')) return JSON.parse(text).virtualStoreDir?.includes('\\') ? 'node_modules\\dsh-loom' : 'node_modules/dsh-loom'
  return /(?:virtualStoreDir|storeDir):.*(?:[A-Za-z]:|\\)/m.test(text) ? 'node_modules\\dsh-loom' : 'node_modules/dsh-loom'
}
function metadataPlans(profile, nextOwned, key) {
  const plans = []
  const currentLock = join(profile, 'node_modules', '.pnpm', 'lock.yaml')
  if (existsSync(currentLock)) {
    const before = readFileSync(currentLock), owned = ownedLock(before.toString('utf8'))
    plans.push({ relative: 'node_modules/.pnpm/lock.yaml', name: 'current-lock', kind: 'lock', before, after: Buffer.from(replaceOwnedLock(before.toString('utf8'), nextOwned)), beforeOwned: owned, afterOwned: nextOwned })
  }
  const modules = join(profile, 'node_modules', '.modules.yaml')
  if (existsSync(modules)) {
    const before = readFileSync(modules), text = before.toString('utf8'), owned = ownedModules(text), location = nativeHoistedPath(text)
    const desired = { format: owned.format, entries: owned.format === 'json' ? [[key, [location]]] : ['  ' + JSON.stringify(key) + ': ' + JSON.stringify([location]) + '\n'] }
    plans.push({ relative: 'node_modules/.modules.yaml', name: 'modules', kind: 'modules', before, after: Buffer.from(replaceOwnedModules(text, desired)), beforeOwned: owned, afterOwned: desired })
  }
  return plans
}
function metadataOwned(plan, bytes) { return plan.kind === 'lock' ? ownedLock(bytes.toString('utf8')) : ownedModules(bytes.toString('utf8')) }
function metadataReplace(plan, bytes, desired) { return plan.kind === 'lock' ? replaceOwnedLock(bytes.toString('utf8'), desired) : replaceOwnedModules(bytes.toString('utf8'), desired) }

function validateProfile(text) {
  const manifest = JSON.parse(text)
  if (!manifest.dependencies || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies) || !Array.isArray(manifest.dsh?.profile?.bundles)) fail('PROFILE_SHAPE_UNSUPPORTED')
  return manifest
}
function assertSame(file, expected) { if (digest(readFileSync(file)) !== digest(expected)) fail('PROFILE_CHANGED_DURING_INSTALL: ' + file) }

export function installProfile({ profile, archive, archiveNative, sha256, pnpm = 'pnpm', faultInjection }) {
  if (process.platform !== 'linux' || !/microsoft/i.test(readFileSync('/proc/sys/kernel/osrelease', 'utf8'))) fail('WSL_REQUIRED')
  profile = resolve(profile); archive = resolve(archive)
  if (typeof archiveNative !== 'string' || !archiveNative || /[\r\n\0]/.test(archiveNative)) fail('ARCHIVE_NATIVE_REQUIRED')
  const bytes = readFileSync(archive), inspected = inspectArchive(bytes, sha256), nativeSpec = archiveNative.startsWith('file:') ? archiveNative : 'file:' + archiveNative
  const packageFile = join(profile, 'package.json'), lockFile = join(profile, 'pnpm-lock.yaml'), target = join(profile, 'node_modules', NAME)
  const beforePackage = readFileSync(packageFile), beforeLock = readFileSync(lockFile), manifest = validateProfile(beforePackage.toString('utf8'))
  const beforeOwned = ownedLock(beforeLock.toString('utf8')), beforeTreeHash = treeHash(target)
  const stage = mkdtempSync(join(tmpdir(), 'loom-profile-stage-'))
  let backupDir, stagedPayload
  try {
    writeFileSync(join(stage, 'package.json'), JSON.stringify({ private: true }))
    const installed = spawnSync(pnpm, ['--offline', '--ignore-scripts', '--store-dir', join(stage, 'store'), 'add', archive, '--config.auto-install-peers=false'], { cwd: stage, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, env: { ...process.env, CI: 'true' } })
    if (installed.status !== 0) fail('STAGING_PNPM_FAILED: ' + (installed.stderr || installed.stdout).slice(-2000))
    const stagedLock = readFileSync(join(stage, 'pnpm-lock.yaml'), 'utf8'), stagedOwned = ownedLock(stagedLock)
    if (stagedOwned.importer.length !== 1 || stagedOwned.packages.length !== 1 || stagedOwned.snapshots.length !== 1) fail('STAGING_LOCK_UNEXPECTED')
    const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
    if (!stagedOwned.packages[0].includes(integrity)) fail('STAGING_INTEGRITY_MISMATCH')
    const key = NAME + '@' + nativeSpec
    const stagedMetadataLines = stagedOwned.packages[0].split('\n')
    if (!/^    resolution: /.test(stagedMetadataLines[1] ?? '')) fail('STAGING_RESOLUTION_UNEXPECTED')
    const metadataTail = stagedMetadataLines.slice(2).join('\n')
    const nextOwned = { importer: [`      dsh-loom:\n        specifier: ${JSON.stringify(nativeSpec)}\n        version: ${JSON.stringify(nativeSpec)}\n`],
      packages: [`  ${JSON.stringify(key)}:\n    resolution: {integrity: ${JSON.stringify(integrity)}, tarball: ${JSON.stringify(nativeSpec)}}\n${metadataTail}`], snapshots: [`  ${JSON.stringify(key)}: {}\n`] }
    const nextLock = Buffer.from(replaceOwnedLock(beforeLock.toString('utf8'), nextOwned))
    const metadata = metadataPlans(profile, nextOwned, key)
    let nextText = setProperty(beforePackage.toString('utf8'), ['dependencies', NAME], nativeSpec)
    nextText = modifyBundle(nextText, true)
    const nextPackage = Buffer.from(nextText), nextManifest = validateProfile(nextText)
    if (nextManifest.dependencies[NAME] !== nativeSpec || !nextManifest.dsh.profile.bundles.includes(NAME)) fail('MANIFEST_EDIT_FAILED')
    const transactionId = new Date().toISOString().replace(/[^0-9T]/g, '') + '-' + randomUUID()
    backupDir = join(profile, '.loom-install-backups', transactionId); mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(backupDir, 'package.before.json'), beforePackage, { mode: 0o600 }); writeFileSync(join(backupDir, 'lock.before.yaml'), beforeLock, { mode: 0o600 })
    writeFileSync(join(backupDir, 'package.after.json'), nextPackage, { mode: 0o600 }); writeFileSync(join(backupDir, 'lock.after.yaml'), nextLock, { mode: 0o600 })
    mkdirSync(dirname(target), { recursive: true })
    stagedPayload = join(dirname(target), '.dsh-loom-staged-' + transactionId); mkdirSync(stagedPayload, { mode: 0o755 })
    for (const [relative, data] of inspected.files) { const file = join(stagedPayload, relative); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data, { flag: 'wx', mode: 0o644 }) }
    const installedTreeHash = treeHash(stagedPayload)
    const record = { format: 2, transactionId, profile, archive, archiveNative: nativeSpec, archiveSha256: sha256, version: inspected.manifest.version,
      metadata: metadata.map(({ before, after, ...plan }) => ({ ...plan, beforeSha256: digest(before), afterSha256: digest(after) })),
      before: { packageSha256: digest(beforePackage), lockSha256: digest(beforeLock), treeHash: beforeTreeHash, dependency: { present: Object.hasOwn(manifest.dependencies, NAME), value: manifest.dependencies[NAME] ?? null }, bundle: manifest.dsh.profile.bundles.includes(NAME), lock: beforeOwned },
      after: { packageSha256: digest(nextPackage), lockSha256: digest(nextLock), treeHash: installedTreeHash, dependency: nativeSpec, lock: nextOwned }, state: 'prepared' }
    for (const plan of metadata) { writeFileSync(join(backupDir, plan.name + '.before'), plan.before, { mode: 0o600 }); writeFileSync(join(backupDir, plan.name + '.after'), plan.after, { mode: 0o600 }) }
    const recordFile = join(backupDir, 'transaction.json'); atomicWrite(recordFile, JSON.stringify(record, null, 2))
    assertSame(packageFile, beforePackage); assertSame(lockFile, beforeLock); if (treeHash(target) !== beforeTreeHash) fail('PAYLOAD_CHANGED_DURING_INSTALL')
    for (const plan of metadata) assertSame(join(profile, plan.relative), plan.before)
    const metadataChanged = []
    let payloadChanged = false, oldMoved = false, packageChanged = false, lockChanged = false
    try {
      if (beforeTreeHash !== null) { renameSync(target, join(backupDir, 'payload.before')); oldMoved = true }
      renameSync(stagedPayload, target); stagedPayload = null; payloadChanged = true
      faultInjection?.('afterPayload')
      assertSame(packageFile, beforePackage); atomicWrite(packageFile, nextPackage); packageChanged = true
      faultInjection?.('afterPackage')
      assertSame(lockFile, beforeLock); atomicWrite(lockFile, nextLock); lockChanged = true
      for (const plan of metadata) { assertSame(join(profile, plan.relative), plan.before); atomicWrite(join(profile, plan.relative), plan.after); metadataChanged.push(plan); faultInjection?.('afterMetadata:' + plan.name) }
      record.state = 'installed'; atomicWrite(recordFile, JSON.stringify(record, null, 2))
      return { ok: true, version: inspected.manifest.version, transactionId, backup: backupDir, record: recordFile, treeHash: installedTreeHash, activation: 'host-composer-required', rollback: `node scripts/install-profile.mjs --rollback ${JSON.stringify(recordFile)}` }
    } catch (error) {
      let restored = false
      try {
        if (packageChanged) assertSame(packageFile, nextPackage); else assertSame(packageFile, beforePackage)
        if (lockChanged) assertSame(lockFile, nextLock); else assertSame(lockFile, beforeLock)
        for (const plan of metadata) assertSame(join(profile, plan.relative), metadataChanged.includes(plan) ? plan.after : plan.before)
        if (payloadChanged && treeHash(target) !== installedTreeHash) fail('PAYLOAD_CHANGED_DURING_RECOVERY')
        for (const plan of metadataChanged.toReversed()) atomicWrite(join(profile, plan.relative), plan.before)
        if (lockChanged) atomicWrite(lockFile, beforeLock)
        if (packageChanged) atomicWrite(packageFile, beforePackage)
        if (payloadChanged) rmSync(target, { recursive: true })
        if (oldMoved) { if (existsSync(target)) fail('PAYLOAD_CHANGED_DURING_RECOVERY'); renameSync(join(backupDir, 'payload.before'), target) }
        restored = true
      } finally { record.state = restored ? 'failed-restored' : 'failed-needs-review'; record.failure = String(error.message); atomicWrite(recordFile, JSON.stringify(record, null, 2)) }
      throw error
    }
  } finally {
    if (stagedPayload && existsSync(stagedPayload)) rmSync(stagedPayload, { recursive: true })
    rmSync(stage, { recursive: true, force: true })
  }
}

export function rollbackProfile(recordFile) {
  recordFile = resolve(recordFile)
  const backupDir = dirname(recordFile), record = JSON.parse(readFileSync(recordFile, 'utf8'))
  if (![1, 2].includes(record.format) || record.state !== 'installed' || resolve(backupDir) !== join(record.profile, '.loom-install-backups', record.transactionId)) fail('ROLLBACK_RECORD_INVALID')
  const packageFile = join(record.profile, 'package.json'), lockFile = join(record.profile, 'pnpm-lock.yaml'), target = join(record.profile, 'node_modules', NAME)
  const currentPackage = readFileSync(packageFile), currentLock = readFileSync(lockFile), manifest = validateProfile(currentPackage.toString('utf8'))
  if (manifest.dependencies[NAME] !== record.after.dependency || !manifest.dsh.profile.bundles.includes(NAME) || treeHash(target) !== record.after.treeHash || JSON.stringify(ownedLock(currentLock.toString('utf8'))) !== JSON.stringify(record.after.lock)) fail('ROLLBACK_LOOM_CHANGED: Loom 已被后续修改，保留现状')
  const beforePackage = readFileSync(join(backupDir, 'package.before.json')), beforeLock = readFileSync(join(backupDir, 'lock.before.yaml'))
  if (digest(beforePackage) !== record.before.packageSha256 || digest(beforeLock) !== record.before.lockSha256 || (record.before.treeHash !== null && treeHash(join(backupDir, 'payload.before')) !== record.before.treeHash)) fail('ROLLBACK_BACKUP_CORRUPT')
  const metadata = (record.metadata ?? []).map((plan) => {
    if (!['node_modules/.pnpm/lock.yaml', 'node_modules/.modules.yaml'].includes(plan.relative) || !['current-lock', 'modules'].includes(plan.name) || !['lock', 'modules'].includes(plan.kind)) fail('ROLLBACK_RECORD_INVALID')
    const file = join(record.profile, plan.relative), current = readFileSync(file), before = readFileSync(join(backupDir, plan.name + '.before'))
    if (digest(before) !== plan.beforeSha256) fail('ROLLBACK_BACKUP_CORRUPT')
    if (JSON.stringify(metadataOwned(plan, current)) !== JSON.stringify(plan.afterOwned)) fail('ROLLBACK_LOOM_METADATA_CHANGED')
    const restored = digest(current) === plan.afterSha256 ? before : Buffer.from(metadataReplace(plan, current, plan.beforeOwned))
    return { ...plan, file, current, restored }
  })
  let nextText = setProperty(currentPackage.toString('utf8'), ['dependencies', NAME], record.before.dependency.value, !record.before.dependency.present)
  nextText = modifyBundle(nextText, record.before.bundle)
  const nextLock = replaceOwnedLock(currentLock.toString('utf8'), record.before.lock)
  const exactBaseline = digest(currentPackage) === record.after.packageSha256 && digest(currentLock) === record.after.lockSha256
  const restoredPackage = exactBaseline ? beforePackage : Buffer.from(nextText), restoredLock = exactBaseline ? beforeLock : Buffer.from(nextLock)
  assertSame(packageFile, currentPackage); assertSame(lockFile, currentLock)
  for (const plan of metadata) assertSame(plan.file, plan.current)
  const metadataChanged = []
  const retained = join(backupDir, 'payload.after')
  if (existsSync(retained)) fail('ROLLBACK_ALREADY_STARTED')
  renameSync(target, retained)
  let packageChanged = false, lockChanged = false, restoredOld = false
  try {
    if (record.before.treeHash !== null) { renameSync(join(backupDir, 'payload.before'), target); restoredOld = true }
    assertSame(packageFile, currentPackage); atomicWrite(packageFile, restoredPackage); packageChanged = true
    assertSame(lockFile, currentLock); atomicWrite(lockFile, restoredLock); lockChanged = true
    for (const plan of metadata) { assertSame(plan.file, plan.current); atomicWrite(plan.file, plan.restored); metadataChanged.push(plan) }
    record.state = 'rolled-back'; record.rolledBackAt = new Date().toISOString(); atomicWrite(recordFile, JSON.stringify(record, null, 2))
    return { ok: true, state: record.state, profile: record.profile, preservedLaterChanges: !exactBaseline || metadata.some((plan) => digest(plan.current) !== plan.afterSha256), backup: backupDir }
  } catch (error) {
    for (const plan of metadataChanged.toReversed()) { assertSame(plan.file, plan.restored); atomicWrite(plan.file, plan.current) }
    if (lockChanged) { assertSame(lockFile, restoredLock); atomicWrite(lockFile, currentLock) }
    if (packageChanged) { assertSame(packageFile, restoredPackage); atomicWrite(packageFile, currentPackage) }
    if (restoredOld) renameSync(target, join(backupDir, 'payload.before'))
    renameSync(retained, target)
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = Object.create(null)
    for (let i = 2; i < process.argv.length; i += 2) { const key = process.argv[i]; if (!['--profile', '--archive', '--archive-native', '--sha256', '--rollback'].includes(key) || !process.argv[i + 1] || args[key]) fail('USAGE: --profile PATH --archive TGZ --archive-native NATIVE_PATH --sha256 HASH | --rollback TRANSACTION_JSON'); args[key] = process.argv[i + 1] }
    const result = args['--rollback'] ? rollbackProfile(args['--rollback']) : installProfile({ profile: args['--profile'], archive: args['--archive'], archiveNative: args['--archive-native'], sha256: args['--sha256'] })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1 }
}
