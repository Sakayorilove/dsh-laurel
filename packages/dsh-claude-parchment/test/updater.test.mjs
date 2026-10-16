import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdater, PARCHMENT_PACKAGE } from '../src/updater.mjs';

const ok = value => ({ ok: true, value });
const path = version => `D:\\<你的目录>\\<插件目录>\\dsh-claude-parchment-${version}.tgz`;
function fixture(version = '1.2.0') {
  const calls = [];
  const service = {
    version,
    async listBundles() { return ok([{ name: PARCHMENT_PACKAGE, installed: true, version: this.version }]); },
    async inspect(spec) { calls.push(['inspect', spec]); return ok({ status: 'accepted', kind: 'tarball' }); },
    async installBundle(spec, options) {
      calls.push(['install', spec, options]); this.version = /-(\d+\.\d+\.\d+)\.tgz$/.exec(spec)[1];
      return ok({ application: 'restart-required', changed: true, bundle: PARCHMENT_PACKAGE, packageResult: { exitCode: 0 } });
    },
  };
  return { service, calls, updater: createUpdater(() => service, '1.2.0') };
}

test('loaded version is fixed; installed mismatch and a verified install require restart', async () => {
  const { updater, service, calls } = fixture('1.1.0');
  await updater.refresh();
  assert.equal(updater.getSnapshot().message, 'restartRequired');
  await updater.install(path('1.3.0'));
  assert.equal(service.version, '1.3.0');
  assert.equal(updater.getSnapshot().installedVersion, '1.3.0');
  assert.equal(updater.getSnapshot().loadedVersion, '1.2.0');
  assert.equal(updater.getSnapshot().message, 'installComplete');
  assert.equal(updater.getSnapshot().restart, true);
  assert.deepEqual(calls, [['inspect', path('1.3.0')], ['install', path('1.3.0'), { enabled: false }]]);
  const afterRestart = createUpdater(() => service, '1.3.0');
  await afterRestart.refresh();
  assert.equal(afterRestart.getSnapshot().message, 'versionReady');
  assert.equal(afterRestart.getSnapshot().restart, false);
});

test('wrong packages, relative paths, URL sources, duplicate versions and downgrades never install', async () => {
  const { updater, calls } = fixture();
  for (const spec of ['other.tgz', 'dsh-claude-parchment-1.3.0.tgz', 'https://example.com/dsh-claude-parchment-1.3.0.tgz', 'D:\\other-1.3.0.tgz', path('1.3.0') + '\nextra']) {
    await updater.install(spec); assert.equal(updater.getSnapshot().message, 'invalidPackage');
  }
  await updater.install(path('1.2.0')); assert.equal(updater.getSnapshot().message, 'alreadyInstalled');
  await updater.install(path('1.1.0')); assert.equal(updater.getSnapshot().message, 'olderPackage');
  assert.deepEqual(calls, []);
});

test('refused inspection, remote errors and supply-chain failures do not claim a successful install', async () => {
  for (const outcome of ['refused', 'remote', 'policy', 'cancelled', 'overridden', 'malformed']) {
    const { updater, service, calls } = fixture();
    if (outcome === 'refused') service.inspect = async () => ok({ status: 'refused', reason: 'file missing' });
    else service.installBundle = async () => outcome === 'remote' ? { ok: false, error: { message: 'Disconnected' } }
      : outcome === 'policy' ? ok({ application: 'failed', packageResult: { exitCode: 1, output: 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION' } })
      : outcome === 'malformed' ? {} : ok({ application: outcome });
    await updater.install(path('1.3.0'));
    assert.equal(updater.getSnapshot().failed, true, outcome);
    assert.equal(updater.getSnapshot().installedVersion, '1.2.0', outcome);
    assert.equal(updater.getSnapshot().restart, false, outcome);
    assert.notEqual(updater.getSnapshot().message, 'installComplete', outcome);
    if (outcome === 'policy') assert.match(updater.getSnapshot().detail, /MINIMUM_RELEASE_AGE/);
    if (outcome === 'refused') assert.deepEqual(calls, []);
  }
});

test('cannot verify a returned install: installed version stays unconfirmed and restart is explicit', async () => {
  const { updater, service } = fixture();
  service.installBundle = async () => {
    service.listBundles = async () => { throw new Error('Connection lost'); };
    return ok({ application: 'restart-required', bundle: PARCHMENT_PACKAGE });
  };
  await updater.install(path('1.3.0'));
  assert.equal(updater.getSnapshot().installedVersion, null);
  assert.equal(updater.getSnapshot().message, 'installUnverified');
  assert.equal(updater.getSnapshot().restart, true);
});

test('a changed on-disk version is checked again before installing', async () => {
  const { updater, service, calls } = fixture();
  await updater.refresh(); service.version = '1.4.0';
  await updater.install(path('1.3.0'));
  assert.equal(updater.getSnapshot().message, 'olderPackage');
  assert.equal(updater.getSnapshot().installedVersion, '1.4.0');
  assert.deepEqual(calls, []);
});

test('in-flight installs reject duplicate clicks; disposal prevents later UI notifications', async () => {
  const { updater, service } = fixture();
  let release, count = 0, notified = 0;
  service.installBundle = async () => { count++; await new Promise(resolve => { release = resolve; }); service.version = '1.3.0'; return ok({ application: 'restart-required' }); };
  updater.subscribe(() => { notified++; });
  const first = updater.install(path('1.3.0'));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await updater.install(path('1.3.0')); await updater.refresh();
  assert.equal(count, 1);
  updater.dispose(); const before = notified;
  release(); await first;
  assert.equal(notified, before);
});

test('absent installer and failed version lookup produce recoverable state', async () => {
  const updater = createUpdater(() => undefined, '1.2.0');
  await updater.refresh(); assert.equal(updater.getSnapshot().message, 'updateUnavailable');
  assert.equal(updater.getSnapshot().loadedVersion, '1.2.0');
  const other = fixture();
  other.service.listBundles = async () => ({ ok: false, error: { message: 'Offline' } });
  await other.updater.refresh(); assert.equal(other.updater.getSnapshot().message, 'versionFailed');
  assert.equal(other.updater.getSnapshot().installedVersion, null);
});
