/** Published DSH ModuleLoader registration protocol; React comes from the host. */
window.__ModuleLoader__.load({
  id: 'dsh-claude-parchment',
  factory(require) {
    const React = require('react');
    const version = '__PARCHMENT_VERSION__';
    const css = '__PARCHMENT_CSS__';
    const tokens = '__PARCHMENT_TOKENS__';
    const themeOptions = '__PARCHMENT_THEMES__';
    /* __PARCHMENT_RUNTIME__ */
    /* __PARCHMENT_UPDATER__ */
    const dictionaries = {
      zh: {
        title: '羊皮纸与交易主题', description: '温暖纸面，或简约交易终端。四套外观随通用设置切换明暗。',
        enable: '启用所选主题', disabled: '主题已关闭，保留当前外观。',
        chooseTheme: '选择主题', themeHelp: '切换后立即生效；关闭时只记住选择。',
        parchmentName: 'Claude 羊皮纸', parchmentDetail: '暖纸与陶土 · 衬线阅读',
        robinhoodName: 'Robinhood · 荧绿', robinhoodDetail: '直角与薄影 · 清爽直接',
        binanceName: '币安 · 石墨金', binanceDetail: '小圆角与短影 · 沉稳紧凑',
        bitgetName: 'Bitget · 冰青', bitgetDetail: '错角气泡与柔影 · 干净利落',
        activeTheme: '当前主题',
        activeLight: '日间 · 奶油羊皮纸', activeDark: '夜间 · 暖炭与旧纸',
        modeHelp: '切换日间 / 夜间：设置 → 通用 → 外观，选择浅色、深色或跟随系统。',
        storageRead: '无法读取本机主题偏好，已保持关闭。请检查浏览器存储权限。',
        storageWrite: '无法保存本机主题偏好，本次选择未生效。请检查浏览器存储权限后重试。',
        light: '日间', dark: '夜间',
        loadedVersion: '已加载版本', installedVersion: '已安装版本', versionUnknown: '尚未确认',
        checkVersion: '检查版本', manualUpdate: '手动更新', packagePath: '新版安装包路径',
        pathPlaceholder: '粘贴新版 tgz 安装包的完整路径', installUpdate: '安装更新', closeUpdate: '收起',
        updateHelp: '选择新版 dsh-claude-parchment-x.y.z.tgz 本地包。安装完成后，完全退出 Harness 并重新打开；“已加载版本”变为新版才表示生效。',
        checking: '正在读取已安装版本…', versionReady: '已加载与已安装版本一致。',
        restartRequired: '版本不一致：请完全退出 Harness 后重新打开，再检查已加载版本。',
        installing: '正在安装更新，请保持窗口打开。', installComplete: '新版已安装，请完全退出 Harness 后重新打开以生效。',
        updateUnavailable: '无法连接插件安装器。请在“设置 → 插件”中安装新版包，再重启 Harness；也可稍后检查版本。',
        versionFailed: '无法确认已安装版本。请重试“检查版本”，或到“设置 → 插件”查看。',
        invalidPackage: '请填写 dsh-claude-parchment-x.y.z.tgz 的完整绝对路径。',
        alreadyInstalled: '这个版本已经安装。若已加载版本不同，请完整重启 Harness。',
        olderPackage: '所选安装包版本较旧，请改用新版安装包。',
        packageRefused: '安装包无法使用。请检查文件是否存在、路径是否正确。',
        installFailed: '更新未完成。请查看下方原因；也可在“设置 → 插件”中重试。',
        installUnverified: '安装器已返回，但新版尚未确认。请检查版本，或在“设置 → 插件”核实后完整重启。',
      },
      en: {
        title: 'Parchment & Trading Themes', description: 'Warm paper or a minimal trading terminal. All four themes follow General appearance settings.',
        enable: 'Enable selected theme', disabled: 'Theme is off. Your current appearance is preserved.',
        chooseTheme: 'Choose a theme', themeHelp: 'Applies immediately when enabled; remembers your choice when off.',
        parchmentName: 'Claude Parchment', parchmentDetail: 'Warm paper & terracotta · Serif reading',
        robinhoodName: 'Robinhood · Lime', robinhoodDetail: 'Square corners & thin shadows · Direct',
        binanceName: 'Binance · Gold', binanceDetail: 'Small corners & short shadows · Compact',
        bitgetName: 'Bitget · Cyan', bitgetDetail: 'Asymmetric bubbles & soft shadows · Clean',
        activeTheme: 'Active theme',
        activeLight: 'Light · Cream parchment', activeDark: 'Dark · Warm charcoal and old paper',
        modeHelp: 'Switch modes in Settings → General → Appearance: Light, Dark, or System.',
        storageRead: 'Could not read the local preference. The theme is off. Check browser storage permissions.',
        storageWrite: 'Could not save the local preference. This change was not applied. Check browser storage permissions and retry.',
        light: 'Light', dark: 'Dark',
        loadedVersion: 'Loaded version', installedVersion: 'Installed version', versionUnknown: 'Not confirmed',
        checkVersion: 'Check version', manualUpdate: 'Manual update', packagePath: 'New package path',
        pathPlaceholder: 'Paste the full path to the new tgz package', installUpdate: 'Install update', closeUpdate: 'Close',
        updateHelp: 'Choose a local dsh-claude-parchment-x.y.z.tgz package. Fully quit and reopen Harness after installation. The loaded version confirms which release is active.',
        checking: 'Reading the installed version…', versionReady: 'Loaded and installed versions match.',
        restartRequired: 'Versions differ. Fully quit and reopen Harness, then check the loaded version.',
        installing: 'Installing the update. Keep this window open.', installComplete: 'New version installed. Fully quit and reopen Harness to activate it.',
        updateUnavailable: 'The plugin installer is unavailable. Install the package in Settings → Plugins and restart Harness, or check the version again later.',
        versionFailed: 'Could not confirm the installed version. Retry Check version or view Settings → Plugins.',
        invalidPackage: 'Enter the full absolute path to a dsh-claude-parchment-x.y.z.tgz package.',
        alreadyInstalled: 'This version is already installed. Restart Harness fully if the loaded version differs.',
        olderPackage: 'This package is older. Choose a newer release.',
        packageRefused: 'Cannot use this package. Check that the file exists and the path is correct.',
        installFailed: 'Update did not complete. See the reason below, or retry in Settings → Plugins.',
        installUnverified: 'The installer returned, but the new version is unconfirmed. Check the version or verify it in Settings → Plugins before restarting.',
      },
    };
    return {
      inject: ['theme', 'slots', 'locale'],
      apply(ctx) {
        let runtime, updater;
        ctx.effect(() => ctx.locale.register('claudeParchment', dictionaries));
        ctx.effect(() => { runtime = createRuntime(ctx, css, tokens); return () => runtime.dispose(); });
        ctx.effect(() => {
          // Cordis get() supports an optional service without suspending the theme when absent.
          updater = createUpdater(() => ctx.get('remote.pluginManager'), version);
          void updater.refresh();
          return () => updater.dispose();
        });
        function Settings({ t }) {
          const state = React.useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
          const update = React.useSyncExternalStore(updater.subscribe, updater.getSnapshot);
          const [editingUpdate, setEditingUpdate] = React.useState(false);
          const [packagePath, setPackagePath] = React.useState('');
          const pathId = React.useId();
          const themeGroup = React.useId();
          const busy = update.phase !== 'idle';
          const status = !state.enabled ? 'disabled' : state.mode === 'dark' ? 'activeDark' : 'activeLight';
          return React.createElement('section', { 'data-cp-settings': '', 'aria-label': t('title') },
            React.createElement('div', { className: 'cp-heading' }, React.createElement('h2', null, t('title')),
              React.createElement('span', { className: 'cp-version', 'data-cp-loaded': '' }, `v${version}`)),
            React.createElement('p', { className: 'lc-embedded-description' }, t('description')),
            React.createElement('fieldset', { className: 'cp-themes', 'aria-describedby': `${themeGroup}-help` },
              React.createElement('legend', null, t('chooseTheme')),
              ...themeOptions.map(option => React.createElement('label', { key: option.id, className: 'cp-theme-option', 'data-selected': state.theme === option.id ? '' : undefined },
                React.createElement('input', { type: 'radio', name: themeGroup, value: option.id, checked: state.theme === option.id,
                  'aria-label': t(`${option.id}Name`), onChange: () => runtime.setTheme(option.id) }),
                React.createElement('span', { className: 'cp-theme-copy' },
                  React.createElement('span', { className: 'cp-theme-name' }, t(`${option.id}Name`)),
                  React.createElement('span', { className: 'cp-theme-detail' }, t(`${option.id}Detail`))),
                React.createElement('span', { className: 'cp-theme-colors', 'aria-hidden': true },
                  ...option.swatches[state.mode === 'dark' ? 'dark' : 'light'].map((color, index) =>
                    React.createElement('span', { key: index, style: { backgroundColor: color } }))))),
              React.createElement('p', { id: `${themeGroup}-help`, className: 'cp-theme-help' }, t('themeHelp'))),
            React.createElement('label', { className: 'cp-toggle' }, React.createElement('span', null, t('enable')),
              React.createElement('input', { type: 'checkbox', role: 'switch', checked: state.enabled, onChange: event => runtime.setEnabled(event.target.checked) })),
            React.createElement('p', { className: 'cp-status', role: 'status', 'aria-live': 'polite' },
              state.enabled && state.theme !== 'parchment' ? `${t('activeTheme')} · ${t(`${state.theme}Name`)} · ${t(state.mode === 'dark' ? 'dark' : 'light')}` : t(status)),
            state.error ? React.createElement('p', { role: 'alert' }, t(state.error)) : null,
            React.createElement('p', null, t('modeHelp')),
            React.createElement('div', { className: 'cp-update' },
              React.createElement('dl', { className: 'cp-versions' },
                React.createElement('dt', null, t('loadedVersion')), React.createElement('dd', null, `v${update.loadedVersion}`),
                React.createElement('dt', null, t('installedVersion')), React.createElement('dd', { 'data-cp-installed': '' }, update.installedVersion ? `v${update.installedVersion}` : t('versionUnknown'))),
              React.createElement('div', { 'aria-live': 'polite', 'aria-atomic': true, 'data-cp-update-status': '' },
                update.message ? React.createElement('p', { className: 'cp-update-message', role: update.failed ? 'alert' : undefined }, t(update.message)) : null,
                update.restart && update.message !== 'restartRequired' && update.message !== 'installComplete' ? React.createElement('p', { className: 'cp-update-message' }, t('restartRequired')) : null,
                update.detail ? React.createElement('pre', { className: 'cp-update-error' }, update.detail) : null),
              React.createElement('div', { className: 'cp-actions' },
                React.createElement('button', { type: 'button', disabled: busy, onClick: () => void updater.refresh() }, t('checkVersion')),
                React.createElement('button', { type: 'button', disabled: busy, 'aria-expanded': editingUpdate, onClick: () => setEditingUpdate(value => !value) }, t(editingUpdate ? 'closeUpdate' : 'manualUpdate'))),
              editingUpdate ? React.createElement('form', { className: 'cp-update-form', 'aria-busy': busy, onSubmit: event => { event.preventDefault(); void updater.install(packagePath); } },
                React.createElement('label', { htmlFor: pathId }, t('packagePath')),
                React.createElement('input', { id: pathId, type: 'text', value: packagePath, disabled: busy, placeholder: t('pathPlaceholder'), spellCheck: false, autoComplete: 'off', autoFocus: true,
                  onChange: event => setPackagePath(event.target.value) }),
                React.createElement('p', { className: 'cp-update-help' }, t('updateHelp')),
                React.createElement('button', { type: 'submit', className: 'cp-install', disabled: busy || !packagePath.trim() }, t(update.phase === 'installing' ? 'installing' : 'installUpdate'))) : null));
        }
        // 两路注册：装载机在就聚合进「Laurel总控」，不在就照旧单独占一条设置页。
        // 插槽系统「声明即独占渲染权」—— 聚合插槽是装载机声明的，所以只留聚合
        // 那条路的话，用户单独装 parchment 时设置页会整块消失。两个 inject 同时
        // 挂着，谁先成立谁生效；聚合成立就把独立那份撤掉，免得同时出现两处。
        const settingsSpec = {
          id: 'claude-parchment', order: 16,
          locale: 'claudeParchment', label: () => ctx.locale.bind('claudeParchment')('title'),
        };
        ctx.effect(() => {
          let grouped = null;
          let standalone = null;
          const put = name => ctx.slots.register({ ...settingsSpec, name }, Settings);
          const offGroup = ctx.slots.inject('laurel-center.module', () => {
            if (grouped) return () => {};
            if (standalone) { standalone(); standalone = null; }
            grouped = put('laurel-center.module');
            return () => { grouped?.(); grouped = null; };
          });
          const offStandalone = ctx.slots.inject('settings.section', () => {
            if (grouped) return () => {};
            if (standalone) return () => {};
            standalone = put('settings.section');
            return () => { standalone?.(); standalone = null; };
          });
          // `?.()`：inject 的契约是返回 disposer，但测试替身/更早的宿主未必给 ——
          // 卸载时抛「offGroup is not a function」会把整个卸载流程带塌。
          return () => { offGroup?.(); offStandalone?.(); };
        });
      },
    };
  },
});
