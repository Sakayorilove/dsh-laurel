export const STORAGE_KEY = 'dsh.claude-parchment.v1';
/** Own one theme layer, a scoped stylesheet, and one local preference. */
export function createRuntime(ctx, css, tokens) {
  const root = document.documentElement;
  const listeners = new Set();
  let disposed = false;
  let retract;
  let syncing = false;
  let enabled = false;
  let theme = 'parchment';
  let appliedTheme;
  const validTheme = value => typeof value === 'string' && Object.hasOwn(tokens, value) ? value : 'parchment';
  let error = '';
  const read = () => {
    try {
      const preference = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      enabled = preference?.enabled === true;
      theme = validTheme(preference?.theme);
      error = '';
    } catch (cause) {
      enabled = false;
      theme = 'parchment';
      error = 'storageRead';
    }
  };
  read();
  const style = document.createElement('style');
  style.dataset.claudeParchmentStyle = '';
  style.textContent = css;
  document.head.append(style);
  const snapshot = () => ({ enabled, theme, active: !!retract, error,
    mode: ctx.theme.getTheme().active.colorScheme });
  let state = snapshot();
  const notify = () => {
    state = snapshot();
    for (const listener of listeners) listener();
  };
  const sync = () => {
    if (disposed || syncing) return;
    syncing = true;
    try {
      const wanted = enabled;
      if (retract && (!wanted || appliedTheme !== theme)) {
        const remove = retract;
        retract = undefined;
        appliedTheme = undefined;
        remove();
      }
      if (wanted && !retract) {
        root.setAttribute('data-cp-active', '');
        root.setAttribute('data-cp-theme', theme);
        retract = ctx.theme.overrideTokens('dsh-claude-parchment', tokens[theme]);
        appliedTheme = theme;
      } else if (!wanted) {
        root.removeAttribute('data-cp-active');
        root.removeAttribute('data-cp-theme');
      }
      notify();
    } finally { syncing = false; }
  };
  const onStorage = event => {
    if (event.key === STORAGE_KEY || event.key === null) { read(); sync(); }
  };
  window.addEventListener('storage', onStorage);
  const offTheme = ctx.on('theme/change', sync);
  sync();
  const save = (nextEnabled, nextTheme) => {
    if (disposed) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: nextEnabled, theme: nextTheme })); }
    catch (cause) { error = 'storageWrite'; notify(); return; }
    enabled = nextEnabled;
    theme = nextTheme;
    error = '';
    sync();
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setEnabled(value) {
      save(value === true, theme);
    },
    setTheme(value) { save(enabled, validTheme(value)); },
    dispose() {
      if (disposed) return;
      disposed = true;
      offTheme();
      window.removeEventListener('storage', onStorage);
      root.removeAttribute('data-cp-active');
      root.removeAttribute('data-cp-theme');
      const remove = retract;
      retract = undefined;
      remove?.();
      style.remove();
      listeners.clear();
    },
  };
}
