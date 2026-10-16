export const PARCHMENT_PACKAGE = 'dsh-claude-parchment';

function releaseParts(version) {
  return /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version || '') ? version.split('.').map(Number) : null;
}
function compareRelease(a, b) {
  const left = releaseParts(a), right = releaseParts(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
function unwrapAnswer(answer) {
  if (answer?.ok === true) return answer.value;
  throw new Error(answer?.error?.message || 'Invalid response from Harness');
}

/** Uses the official installer only; the compiled version describes this running bundle. */
export function createUpdater(getManager, loadedVersion) {
  let disposed = false;
  let state = { loadedVersion, installedVersion: null, phase: 'idle', message: '', detail: '', failed: false, restart: false };
  const listeners = new Set();
  const publish = patch => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const problem = (key, detail = '') => publish({ phase: 'idle', message: key, detail: String(detail).slice(-4000), failed: true });
  function manager() {
    const service = getManager();
    if (!service || typeof service.listBundles !== 'function' || typeof service.inspect !== 'function' || typeof service.installBundle !== 'function') return null;
    return service;
  }
  async function readInstalled(service) {
    const bundles = unwrapAnswer(await service.listBundles());
    if (!Array.isArray(bundles)) throw new Error('Invalid bundle list from Harness');
    const bundle = bundles.find(item => item.name === PARCHMENT_PACKAGE && item.installed);
    if (!bundle?.version || !releaseParts(bundle.version)) throw new Error('Harness did not report the installed plugin version');
    return bundle.version;
  }
  async function refresh() {
    if (disposed || state.phase !== 'idle') return;
    publish({ phase: 'checking', message: 'checking', detail: '', failed: false });
    try {
      const service = manager();
      if (!service) { publish({ installedVersion: null }); problem('updateUnavailable'); return; }
      const version = await readInstalled(service);
      publish({ installedVersion: version, phase: 'idle', restart: version !== loadedVersion,
        message: version === loadedVersion ? 'versionReady' : 'restartRequired', detail: '', failed: false });
    } catch (cause) { publish({ installedVersion: null }); problem('versionFailed', cause.message); }
  }
  async function install(input) {
    if (disposed || state.phase !== 'idle') return;
    const path = String(input || '').trim().replace(/^"(.*)"$/, '$1');
    const version = /(?:^|[\\/])dsh-claude-parchment-(\d{1,6}\.\d{1,6}\.\d{1,6})\.tgz$/.exec(path)?.[1];
    const absolute = /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/.test(path) || path.startsWith('/');
    if (!absolute || !version || /[\r\n\0]/.test(path)) { problem('invalidPackage'); return; }
    publish({ phase: 'installing', message: 'installing', detail: '', failed: false });
    let installed = false;
    try {
      const service = manager();
      if (!service) { problem('updateUnavailable'); return; }
      // Re-read immediately before mutation, so another installation cannot leave a stale comparison.
      const current = await readInstalled(service);
      if (disposed) return;
      publish({ installedVersion: current, restart: current !== loadedVersion });
      if (compareRelease(version, current) === 0) { problem('alreadyInstalled'); return; }
      if (compareRelease(version, current) < 0 || compareRelease(version, loadedVersion) < 0) { problem('olderPackage'); return; }
      const inspection = unwrapAnswer(await service.inspect(path));
      if (disposed) return;
      if (inspection?.status !== 'accepted' || inspection.kind !== 'tarball') {
        problem('packageRefused', inspection?.reason || 'Invalid package inspection'); return;
      }
      const result = unwrapAnswer(await service.installBundle(path, { enabled: false }));
      if (!['applied', 'restart-required'].includes(result?.application) || result.packageResult?.exitCode || result.packageResult?.timedOut || result.pendingBuilds?.length || (result.bundle && result.bundle !== PARCHMENT_PACKAGE)) {
        problem('installFailed', result?.error?.diagnostic || result?.error?.message || result?.packageResult?.output || result?.application || 'Invalid install result'); return;
      }
      installed = true;
      // Existing bundles need a restart even when an installer reports a live application.
      publish({ restart: true, installedVersion: null });
      const actual = await readInstalled(service);
      if (actual !== version) { problem('installUnverified', `Expected ${version}; Harness reported ${actual}`); return; }
      publish({ installedVersion: actual, phase: 'idle', message: 'installComplete', detail: '', failed: false, restart: true });
    } catch (cause) { problem(installed ? 'installUnverified' : 'installFailed', cause.message); }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh, install,
    dispose() { disposed = true; listeners.clear(); },
  };
}
