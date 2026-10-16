/* A preview of the published rc.2 services, not a running harness session. */
(() => {
  const search = new URLSearchParams(location.search);
  const layers = new Map();
  const events = new Map();
  const effects = [];
  const dictionaries = new Map();
  const entries = new Map();
  let mode = search.get('mode') === 'dark' ? 'dark' : 'light';
  let revision = 0;
  let applied = [];
  let system = false;
  let media = matchMedia('(prefers-color-scheme: dark)');
  let mounted;
  const locale = search.get('lang') === 'en' ? 'en' : 'zh';
  const installer = {
    installedVersion: search.get('installed') || '1.3.1', calls: [], hold: false,
    refusal: '', failure: null, listFailure: false,
    async listBundles() {
      if (this.listFailure) return { ok: false, error: { message: 'Preview connection failed' } };
      return { ok: true, value: [{ name: 'dsh-claude-parchment', installed: true, version: this.installedVersion }] };
    },
    async inspect(path) {
      this.calls.push({ method: 'inspect', path });
      return { ok: true, value: this.refusal ? { status: 'refused', reason: this.refusal } : { status: 'accepted', kind: 'tarball', bundle: null } };
    },
    async installBundle(path, options) {
      this.calls.push({ method: 'installBundle', path, options });
      if (this.hold) await new Promise(resolve => { this.release = resolve; });
      if (this.failure) return this.failure;
      this.installedVersion = /dsh-claude-parchment-(\d+\.\d+\.\d+)\.tgz$/.exec(path)[1];
      return { ok: true, value: { changed: true, application: 'restart-required', bundle: 'dsh-claude-parchment', packageResult: { exitCode: 0 } } };
    },
  };
  // Emulate the host's ResizeObserver-published conversation width axis.
  const column = document.querySelector('[data-conversation-content]');
  new ResizeObserver(([entry]) => column.style.setProperty('--dsh-conversation-column-width', `${entry.contentRect.width}px`)).observe(column);
  const emit = name => { for (const fn of events.get(name) || []) fn(theme.getTheme()); };
  const present = () => {
    document.documentElement.style.colorScheme = mode;
    document.body.toggleAttribute('data-ds-dark-theme', mode === 'dark');
    for (const name of applied) document.body.style.removeProperty(name);
    const tokens = theme.getTheme().active.tokens;
    applied = Object.keys(tokens);
    for (const [name, value] of Object.entries(tokens)) document.body.style.setProperty(name, value);
    document.querySelector('#light').setAttribute('aria-pressed', String(mode === 'light'));
    document.querySelector('#dark').setAttribute('aria-pressed', String(mode === 'dark'));
  };
  const theme = {
    getTheme: () => ({ preference: system ? 'system' : mode, active: { id: mode, colorScheme: mode,
      tokens: Object.assign({}, ...[...layers.values()].map(layer => Object.fromEntries(Object.entries(layer.tokens).map(([name, pair]) => [name, pair[mode]])))) }, revision }),
    setTheme(value) { system = value === 'system'; mode = system ? media.matches ? 'dark' : 'light' : value; revision++; present(); emit('theme/change'); },
    overrideTokens(source, tokens) {
      for (const pair of Object.values(tokens)) if (typeof pair.light !== 'string' || typeof pair.dark !== 'string') throw new TypeError('Theme overrides require light/dark pairs');
      const layer = { tokens };
      layers.delete(source); layers.set(source, layer); revision++; present(); emit('theme/change');
      return () => { if (layers.get(source) !== layer) return; layers.delete(source); revision++; present(); emit('theme/change'); };
    },
  };
  // 这个预览宿主里「已声明」的插槽。真实宿主里 settings.section 由
  // dsh-client-ui-settings 声明；聚合插槽 laurel-center.module 要装载机在才有，
  // 这里没有，所以插件应当走兜底路径。
  const declared = new Set(['settings.section']);
  const ctx = {
    theme,
    get(name) { return name === 'remote.pluginManager' && !search.has('no-remote') ? installer : undefined; },
    on(name, listener) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(listener); return () => events.get(name).delete(listener); },
    effect(fn) { const off = fn(); if (typeof off === 'function') effects.push(off); },
    locale: {
      register(namespace, dicts) { dictionaries.set(namespace, dicts); return () => dictionaries.delete(namespace); },
      bind(namespace) { return key => dictionaries.get(namespace)[locale][key]; },
    },
    slots: {
      // 只对**已声明**的插槽回调 —— 真实的 slots.inject 就是这个语义（声明已存在时
      // 同步跑一遍，否则等声明出现再跑）。
      //
      // 必须**返回 disposer**：inject 的契约就是返回一个取消等待/撤销贡献的函数。
      // 之前这里返回 undefined，插件卸载时调用它就会抛
      // 「offGroup is not a function」，把整个卸载流程带塌。
      inject(name, factory) {
        if (!declared.has(name)) return () => {};
        const dispose = factory();
        let live = true;
        const off = () => {
          if (!live) return;
          live = false;
          if (typeof dispose === 'function') dispose();
          const at = effects.indexOf(off);
          if (at >= 0) effects.splice(at, 1);
        };
        effects.push(off);
        return off;
      },
      register(options, Component) {
        entries.set(options.id, { options, Component });
        const target = document.querySelector('#settings-root');
        mounted = ReactDOM.createRoot(target);
        mounted.render(React.createElement(Component, { t: ctx.locale.bind(options.locale) }));
        return () => { mounted.unmount(); entries.delete(options.id); };
      },
    },
  };
  window.__ModuleLoader__ = {
    load({ id, factory }) {
      window.__previewPluginId = id;
      const plugin = factory(name => { if (name === 'react') return React; throw new Error(`Unknown host import: ${name}`); });
      plugin.apply(ctx);
      window.__previewPlugin = plugin;
    },
  };
  if (!search.has('test')) localStorage.setItem('dsh.claude-parchment.v1', JSON.stringify({ enabled: true, theme: search.get('theme') || 'parchment' }));
  document.querySelector('#light').onclick = () => theme.setTheme('light');
  document.querySelector('#dark').onclick = () => theme.setTheme('dark');
  document.querySelector('#open-settings').onclick = () => document.querySelector('#settings-dialog').showModal();
  document.querySelector('#close-settings').onclick = () => document.querySelector('#settings-dialog').close();
  document.querySelector('.mobile-menu').onclick = () => document.querySelector('.pI_x6G_frame').toggleAttribute('data-show-sidebar');
  document.querySelector('.mobile-sidebar-close').onclick = () => document.querySelector('.pI_x6G_frame').removeAttribute('data-show-sidebar');
  media.addEventListener('change', () => { if (system) theme.setTheme('system'); });
  window.__host = { ctx, layers, entries, installer, dispose() { for (const off of effects.splice(0).reverse()) off(); }, mode(value) { theme.setTheme(value); } };
  present();
})();
