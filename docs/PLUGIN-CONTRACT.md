# Laurel-Center · 插件合同

这份文件是「Laurel 系列插件怎么写才不会被 DSH 静默拒掉」的单一真相源。
文中每条都在 2026-10-11 用本机 `app.asar`（`@deepseek-ai/dsh-desktop-runtime@0.2.0-rc.2`，
asar SHA256 `983ca711…`）实测过，来源与命令见各节末尾。

---

## §1 包名与寻址

一个 DSH 插件的包名在**三处必须完全一致**：

| 位置 | 例子 |
|---|---|
| `package.json` 的 `name` | `laurel-center` |
| `cordis.patch.yml` 里那一行的 `name`（宿主半边入口） | `./lib/index.js` 或纯包名 |
| 客户端 bundle 里 `__ModuleLoader__.load({ id })` 的 `id` | `laurel-center` |

⚠ **`dsh.client.inject` 写的是包名，客户端 `exports.inject` 写的是服务名。**
两者是两回事，混写会让整台前端起不来 —— 见 §3。

---

## §2 客户端模块只能 `require` 到宿主给的模块表

客户端半边**不能** `require` 任意 npm 包。解析顺序写死在
`@deepseek-ai/dsh-client-modules`：

```
platform seed 表（React / Cordis / 静态 UI 库）
  → 已物化的模块
  → boot graph 的行
  → 已注册的 factory
其余一律抛 require("x") missed the module table
```

所以系列共享的 `lib/client-kit.js` 是在**打包时内联**进 bundle 的，不是运行时依赖。
打包器：`scripts/build-client.mjs`（剥注释、剥 `export` 关键字、按清单拼进一个 CJS factory）。

---

## §3 两份 inject，别写混

| 文件 | 字段 | 值域 | 作用 |
|---|---|---|---|
| `package.json` | `dsh.client.inject` | **包名**，如 `@deepseek-ai/dsh-api-remotes` | 只影响 boot graph 的加载先后 |
| `lib/client/index.mjs` | `exports.inject` | **服务名**，如 `slots`、`locale`、`remote.pluginManager` | 这一行 fiber 的**等待依赖** |

`exports.inject` 里只要有一个 `ctx.get()` 不到的名字，这一行就永远停在 `pending`，
整个 web boot 直接失败：

```
Error: web boot: 1 entry did not activate
laurel-center: pending (waiting for service: uiSettings)
```

⚠ `uiSettings` **不是**服务名，是包名 `@deepseek-ai/dsh-client-ui-settings` 的尾巴。
`uiSlots`、`uiLocale` 同样不存在。服务名白名单（含来源与局限）见
`scripts/client-services.mjs`，由 `check.mjs` 与 `bootgraph-probe.mjs` 共用。

Laurel-Center 当前实际用到的服务名：

```
slots                  注册设置页插槽
locale                 文案与语言
remote                 原生认证 RPC 通道
remote.pluginManager   宿主插件管理（listPlugins / setPluginEnabled）
remote.pluginInventory fiber 相位（list）
```

---

## §4 设置页是插槽，不是路由

```js
ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'laurel-center',
  order: 15,
  label: () => t('section.title'),
}, Component)), 'laurel-center: settings')
```

用 `ctx.effect` 包起来，插件停用时这块 UI 会跟着干净撤掉。

---

## §5 与宿主通信：走原生认证 RPC，不要自建 HTTP

**不要**往 `webServer` 注册 prefix 来当控制接口。宿主 WebServer 会把任意注册路由分发给
调用者，而认证只封在原生 `/api` 通道里 —— 注册 prefix **不继承认证**。
2026-10-11 评审已实测：无凭据、`Origin: https://untrusted.example` 的裸
`POST /laurel-center/toggle` 能真实改变开关。该端点已删除。

正确做法是客户端注入 `remote` 并调用宿主已有服务：

```js
const res = await ctx.remote.pluginManager.listPlugins()   // → { ok, value }
const out = await ctx.remote.pluginManager.setPluginEnabled(entryId, enabled)
ctx.remote.$on('plugin-manager/changed', refresh)
```

⚠ **RPC 返回的是结果封套 `{ ok, value }`**（失败是 `{ ok: false, error }`），
不是裸值。官方 `dsh-client-ui-plugin-manager` 也是这么解包的。

`setPluginEnabled` 的返回（`ChangeResult`）：

```ts
{
  changed: boolean
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  stage: 'enable'
  target: string
  enabled?: boolean
  error?: { code: string; diagnostic?: string }
  warnings?: string[]
}
```

**`application !== 'applied'` 就不算「已生效」**：`restart-required` 是配置已存但本进程
没应用，`failed` / `cancelled` 是没成。别把 `ok:true` 当成应用成功。

---

## §6 开关的权威在 profile 的用户层

宿主的 `pluginManager.setPluginEnabled(entryId, enabled)`：

1. 写 **profile 的 `cordis.patch.yml`（用户层，优先级最高）**；
2. 在 `withFileLock(profile/package.json)` 里执行；HMR 存在时还走 `hmr.runExclusive`；
3. 再按宿主自己的流程应用（有 HMR 就 live 应用，否则等重启）。

插件**不要**自己：
- 调 `loader.update()` 改行（会触发 `Include.write()` 把组合后的整棵树写回基础
  `cordis.yml`，再挂载时又叠一次 insert → 重复行）；
- 另建一份 `state.json` 当开关权威并在每次开机同步回 loader（会盖掉用户层显式决定）。

要 `entryId` 就先 `listPlugins()`，并用 **`patchId` 精确匹配**自己的稳定 id，
同时核对 `moduleName` 等于声明的包名、且唯一；对不上就报错，**不要猜第一个**。

---

## §7 目录与构建

```
Laurel-Center/
├─ lib/                宿主半边 + 客户端源码 + 构建产物
│   ├─ index.js        宿主入口（apply / inject）
│   ├─ host.js         原生管理适配层
│   ├─ migrate.js      一次性迁移
│   ├─ result.js       统一结果合同
│   ├─ store.js        家目录 / 流水
│   ├─ registry.js     五个子插件注册表
│   ├─ config.js       常量
│   ├─ client-kit.js   系列共享 kit（打包时内联）
│   ├─ client/index.mjs 客户端源码
│   └─ client.js       客户端构建产物（不要手改）
├─ packages/<dir>/     五个子插件的自包含源码副本
├─ scripts/            离线自检与探针
├─ cordis.patch.yml    插 5 行进 loader 树
└─ docs/PLUGIN-CONTRACT.md  ← 本文
```

**开发、构建、测试一律在 WSL**（Ubuntu-26.04 / Clelia，Node 24，pnpm）。
唯一例外是「装进 Windows profile」——那交给宿主自己的安装事务，不要从 WSL 对着
`/mnt/c` 的 profile 跑 pnpm（会写出 Windows 解析不了的 Linux 风格相对链接，`realpath` EACCES）。

---

## §8 实测来源

| 结论 | 依据 |
|---|---|
| 客户端模块解析顺序、`{ok,value}` 封套 | 本机 asar 提取的 `@deepseek-ai/dsh-client-modules`、`dsh-client-ui-plugin-manager/lib/client.js`、`dsh-api-remotes` |
| `setPluginEnabled` 写 profile patch + 文件锁 | `@deepseek-ai/dsh-plugin-manager/lib/index.js`（`writePluginEnabled`、`change`、`configure`） |
| `listPlugins` 的 `entryId` / `patchId` / `readOnlyReason` | 同上（`listPlugins`）与其类型声明 `typert.host.js` |
| `fiberPhase` 取值 | `@deepseek-ai/dsh-host-plugin-inventory/lib/index.js` |
| 裸 HTTP 端点可被无凭据调用 | 2026-10-11 隔离官方 Web 宿主实测（评审证据 `full-host-results.json`） |
| 开关后基础 `cordis.yml` 不被污染、无重复行 | 2026-10-11 隔离宿主 + 浏览器实测（本次 `s1-host-*.json`、`s3-browser.json`） |
