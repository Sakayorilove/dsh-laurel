/**
 * Laurel-Center · 子插件注册表
 *
 * 这里是装载机认识的全部子插件。每一条都指向**本包内**的一份源码副本
 * （`packages/<dir>/`），不引用任何外部目录 —— 整个装载机是自包含的。
 *
 * ── 三个字段的约定 ──────────────────────────────────────────────────────
 *   id        loader 行 id，同时是总控台 UI 里那一行开关的键。
 *             必须是稳定的字符串：profile 的 patch 靠它定位要禁用的行。
 *   dir       packages/ 下的目录名。
 *   entry     loader 行的 name —— **必须是纯包名**（laurel / dsh-strata / ...）。
 *             ⚠ 不能写成 `laurel-center/packages/laurel`：DSH 的 client-modules
 *             用 `exactPackageSpecifier` 判包名，带斜杠的非 scope 包名既不是
 *             合法包名、也不是 path-like（不以 `.`/`file:`/绝对路径开头），
 *             `resolveMeta` 会**直接返回 null**，那一行就不产出 boot graph row，
 *             前端永远加载不到 —— 而且全程不报错，只是「什么都不发生」。
 *             所以五个子包各自要在 profile 的 node_modules 里有一个链接
 *             指向本包内的 `packages/<dir>`（安装步骤见 README）。
 *   clientId  子插件 client bundle 里 `__ModuleLoader__.load({ id })` 用的 id，
 *             也就是子包 package.json 的 name。三处必须一致，这里显式写出来
 *             是为了让「哪个子包出问题了」一眼可查。
 *   label     总控台里显示的名字。
 *   desc      一句话说明它干嘛。
 *   defaultOn 首次加载（还没有 state.json）时的默认开关。
 *   settingsId 该模块设置页在客户端插槽里的条目 id —— 也就是它自己调
 *             `registerSettingsSection({ id })` 时写的那个值。
 *             ⚠ 它跟上面的 id **在五个模块里都是同值**，但它不是 id 的别名：它描述的是
 *             子包**客户端文件**里那一行 `slots.register({ id })` 实际写的东西。两者
 *             漂开过一次（laurel 的示例产物用 `laurel-sample`、真正加载的 `lib/client.js`
 *             用 `laurel`），而漂开的症状是「卡片能展开、里面是空的」，不报错。
 *             改任一处的设置页 id 时，必须同时改这里。
 *             总控台要把「某个模块的设置内容」渲染进「某个模块的卡片」里，就得
 *             靠这个字段对上号；手抄一份映射表到客户端正是这一层要避免的事
 *             （见 lib/client/index.mjs 顶上那段注释）。改模块的设置页 id 时，
 *             必须同时改这里，否则总控台里那张卡片会空着。
 *
 * ── 顺序有意义 ──────────────────────────────────────────────────────────
 *   clientModules 按 loader 扫描顺序组 boot graph，但会用模块图拓扑排序修正
 *   依赖顺序。这里的顺序只影响总控台的显示次序。
 */

/** @typedef {{ id: string, dir: string, entry: string, clientId: string, label: string, desc: string, defaultOn: boolean, settingsId: string }} SubPlugin */

/** @type {SubPlugin[]} */
export const SUB_PLUGINS = [
  {
    id: 'laurel',
    dir: 'laurel',
    entry: 'laurel',
    clientId: 'laurel',
    settingsId: 'laurel',
    label: '通知',
    desc: 'agent 提问、等你批准、干完活时弹一条 Windows 通知并响一声，不看窗口也不会错过。',
    defaultOn: false,
  },
  {
    id: 'claude-parchment',
    dir: 'dsh-claude-parchment',
    entry: 'dsh-claude-parchment',
    clientId: 'dsh-claude-parchment',
    settingsId: 'claude-parchment',
    label: 'Claude主题',
    desc: 'Claude 风格的米色/深色主题与会话字体排版，带冲突保护。',
    defaultOn: false,
  },
  {
    id: 'strata',
    dir: 'dsh-strata',
    entry: 'dsh-strata',
    clientId: 'dsh-strata',
    settingsId: 'strata',
    label: '记忆与上下文',
    desc: '让 DSH 跨会话记住事：本会话 → 本工作区 → 全局三级作用域，跨工作区读取逐次授权。',
    defaultOn: false,
  },
  {
    id: 'warden',
    dir: 'dsh-warden',
    entry: 'dsh-warden',
    clientId: 'dsh-warden',
    settingsId: 'warden',
    label: '内耗护栏',
    desc: '给子代理套上等待上限、把结论赶去写文件、按文件计返工次数、给上下文加水位提醒、给共享目录加锁。',
    defaultOn: false,
  },
  {
    id: 'loom',
    dir: 'dsh-loom',
    entry: 'dsh-loom',
    clientId: 'dsh-loom',
    settingsId: 'loom',
    label: '可视化规划模式',
    desc: '把项目拆成可编辑的节点图，再编译成可并行执行的批次脚本。体积大，默认关闭。',
    defaultOn: false,
  },
];

/** 按 id 取一条。 */
export function subPlugin(id) {
  return SUB_PLUGINS.find((p) => p.id === id) ?? null;
}

/** 全部 id。 */
export const SUB_IDS = SUB_PLUGINS.map((p) => p.id);

/** 首次加载时的默认开关表。 */
export function defaultEnabled() {
  return Object.fromEntries(SUB_PLUGINS.map((p) => [p.id, p.defaultOn]));
}

/** 把任意输入规整成完整、布尔化的开关表。 */
export function normalizeEnabled(input) {
  const out = defaultEnabled();
  if (input && typeof input === 'object') {
    for (const p of SUB_PLUGINS) {
      if (typeof input[p.id] === 'boolean') out[p.id] = input[p.id];
    }
  }
  return out;
}
