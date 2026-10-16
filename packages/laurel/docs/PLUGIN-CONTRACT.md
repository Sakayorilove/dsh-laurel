# DSH 客户端插件契约

Laurel 系列所有插件的施工图。**这里写的每一条都是在真机（DSH desktop profile）上验过的**，
不是从文档抄的 —— 浏览器半边没有报错的地方，静默失效是最常见的失败模式，
所以下面每条都标了「症状」和「怎么验」。

> 官方包：`@deepseek-ai/dsh-client-modules@0.2.0-rc.2`
> 抽样比对：`dshmarket@1.66.3`、`laurel@0.1.0`

---

## 0. 一张图：一个插件由两个半边组成

```
<插件包>/
├─ package.json          ← 声明两个半边各在哪、依赖哪些客户端服务
├─ cordis.patch.yml      ← 宿主侧：把自己插进 profile 的 loader 树（含默认配置）
├─ lib/
│  ├─ index.js           ← 宿主半边（cordis 插件，跑在 DSH 主进程）。**可选**
│  └─ client.js          ← 客户端半边（浏览器 bundle）。**可选**
└─ library/<id>/client.js ← 生成物（build 产物，别手改）
```

两个半边**互相独立可省**。只做 UI 的插件可以没有宿主半边；
只做后台的可以没有客户端半边。

---

## 1. package.json：三个字段决定一切

```jsonc
{
  "type": "module",
  "exports": {
    ".": "./lib/index.js",          // 宿主半边入口
    "./client": "./lib/client.js"   // ★ 客户端 bundle 路径 —— 就靠这一行
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },  // 宿主侧 patch 文件
    "client": {
      "platform": "web",            // 固定 web
      "inject": [                   // ★ 客户端服务依赖，见 §4
        "slots",
        "uiSession"
      ]
    }
  }
}
```

### 1.1 客户端 bundle 路径 = `exports["./client"]`

这是**唯一**的寻址方式，没有别的字段能指定它。

| 包 | `exports["./client"]` | 实际文件 |
|---|---|---|
| laurel | `./lib/client.js` | `lib/client.js` |
| dshmarket | `./client/client.js` | `client/client.js` |

所以**新插件想用自己的 bundle，就必须把这一行指过去**。
`library/<id>/client.js` 只是 Laurel 仓库里的生成物目录，不是宿主约定 ——
本仓库的 `lib/client.js` 是手写的正式 bundle，示例产物放 `library/` 是为了不覆盖它。

> ⚠️ 反模式：自己发明 `dsh.library` / `dsh.client.entry` 这类字段。
> 宿主不认，插件会「装上了但没有任何表现」。

### 1.2 `files` 要包含实际产物目录

发 npm 时漏了 `library/`（或 `client/`），会导致别人装下来没有 bundle。
`exports` 指向的文件必须在 `files` 里。

---

## 2. cordis.patch.yml：宿主侧挂载

```yaml
- insert:
    - id: laurel
      name: ./lib/index.js        # 相对本文件解析，包被 link 到哪都能跑
      config:                     # 这里是默认值
        notifyOnQuestion: true
```

- `name` 用**相对路径**（宿主 `composeEntries` 会转成 file URL）→ 包里不能有绝对路径。
- 这份 `config` 是**优先级最低的一层**：会被 `$DSH_HOME/<插件>/settings.json` 覆盖。
  优先级：`patch 默认值` < `settings.json`。
- profile 里的 `cordis.yml` 是空数组，**不要改它** —— 官方注释明说「Edit cordis.patch.yml, not this file」。

---

## 3. 客户端半边：四条硬约束

产物是 classic script 里的 **CJS factory**，不是 ESM。所以：

### 3.1 不许出现模块语法

| 写法 | 结果 |
|---|---|
| 顶层 `import` | ✗ 产物当 classic script 解析 → 直接语法错误 |
| `export default` | ✗ 同上 |
| 动态 `import()` | ✗ 同上 |
| `export function apply` | ✓ 打包器会剥掉 `export` 修饰符 |

打包器用的是**剥掉注释后**的源码做校验 ——
否则注释里写「不许用 `import()`」这种说明文字会把插件自己判死。

### 3.2 `require` 只能解析到两张表里有的东西

宿主 `lib/client.js` 的解析顺序：

1. **platform seed 表**（冻结的）：`react`、`cordis`、静态 UI 库等
2. 已物化的模块
3. **boot graph 行**：由 `dsh.client.external` 点名的、另一个 client 插件行提供的模块
4. 已注册的 factory

都不命中 → 抛 `... missed the module table`。

**共享代码的唯一安全做法是打包时内联**（Laurel 的 kit 就是这么进来的 ——
`lib/client-kit.js` 和入口被拼进同一个 factory 作用域，不经过 `require`）。

### 3.3 必须导出 `apply`

```js
export function apply(ctx) { /* ... */ }
```

没有 `apply` → 插件不会被激活（打包器会拦，日志里也能看到）。

### 3.4 bundle 执行只注册 factory

副作用**在物化时才跑**。所以 bundle 顶层不许有依赖执行顺序的代码，
一切逻辑放进 `apply`。

---

## 4. `dsh.client.inject`：不加会「有时候不出现」

`exports.inject = ['slots', 'uiSession']`（bundle 内）说的是
**「我要用哪些客户端服务」**；`dsh.client.inject`（package.json）说的是
**「我等哪些包先就绪」**，也就是给 boot graph 加顺序边。

**两处都要写。** 只写 bundle 里那份 → 没有顺序边 → 插槽可能还没注册你就去用了。

症状非常有迷惑性：**设置页有时候出现、有时候不出现**（取决于加载竞态）。
排查时先看 `dsh.client.inject` 是不是空的。

对照：

| 包 | `dsh.client.inject` |
|---|---|
| dshmarket | `@deepseek-ai/dsh-client-locale`、`-ui-settings`、`-ui-theme`（3 个） |
| laurel（修复前） | **缺这个字段** ← 唯一一个没声明的 client 插件 |

用 `slots` 就必须至少等到 `@deepseek-ai/dsh-client-ui-settings`。

---

## 5. 两个最容易静默失效的坑

这两个都不会报错，只是「什么都不发生」—— 所以列在最前面。

### 5.1 跨 realm：`instanceof` 判内建类型恒为 false

bundle 跑在 `vm` / 宿主 realm 里，宿主传进来的 `Map`：

```js
snapshot instanceof Map   // false ← 陷阱！即使 size 是 1
```

于是 `snapshot instanceof Map ? snapshot : new Map(Object.entries(snapshot ?? {}))`
会把一个**有内容的 Map 换成空 Map**，循环不执行，永远不触发，**且不报错**。

**规矩**：判容器一律走 kit 的 `toMap(value)`。
`tests/kit-client.mjs` 里有静态守卫，产物里出现
`instanceof (Map|Set|Array|Promise|Error)` 会直接测试失败。

### 5.2 `uiSession.sessionStatus` 是可观察对象，**不是** Map，也没有事件名

官方 `ui-conversation` 的用法（`vendor/dsh/ui-conversation/lib/client.js`）：

```js
uiSession.sessionStatus.getSnapshot()             // 拿当前快照
uiSession.sessionStatus.subscribe(changed)        // 订阅变化
```

- **没有** `uiSession/session-status` 这种事件名（一度按事件名写 → 永远不触发）
- 快照内容是 `Map<sessionId, status>`，`status.pendingInteraction` 表示「在等你」
- 想区分「新出现的交互」，要**自己拿前后两代快照做 diff**，
  否则每次快照都会响

---

## 6. 宿主半边（cordis）纪律

```js
export const inject = []          // 顶层留空

export function apply(ctx, config) {
  ctx.inject(['webServer'], (routeCtx) => {   // 用子插件等 webServer 就绪
    const webServer = routeCtx.get('webServer')
    return routeCtx.effect(() => webServer.register({
      kind: 'prefix', path: '/laurel', handler,
    }), 'laurel.routes')
  })
}
```

- **顶层 `inject` 留空**：cordis 的 `Context` 是受控代理，没写进 `inject` 的服务
  用 `ctx.X` 访问会**直接抛**。用 `ctx.get(name)` + try/catch 更安全。
- 顶层别强制依赖 `webServer`：非 Web 组合（CLI / 无头）也该能激活，
  而且 `ctx.get()` 不会等待异步启动中的服务 —— 用子插件让 cordis 管等待和清理。
- **所有 IO 都吞异常**。第 3 条尤其重要：

  > 通知类插件坏掉，不许连带影响宿主里的任何别的东西。

- 家目录只认 `DSH_HOME`。**不要从 `DSH_PROFILE_DIR` 往上推** —— 布局会变。

---

## 7. 配置的三层归一化

```
patch 默认值  →  settings.json 覆盖  →  浏览器半边读到生效值
   (最低)                                        (权威)
```

宿主 `apply(ctx, config)` 拿到的就是 patch 那份，当**默认值**用：

```js
const fromPatch = normalizeConfig(config, DEFAULT_CONFIG)   // patch 当 base
let current = (() => {
  const stored = loadSettings(home)
  return stored.config ? normalizeConfig(stored.config, fromPatch) : fromPatch
})()
```

归一化语义（`lib/core/config.js` 的 `createNormalizer`）：

- **只认声明过的键** —— 未知键直接丢掉，防止设置页塞进奇怪东西
- 类型不对 → 退回 base 值，不抛
- `number` 四舍五入并夹在区间内
- `seconds` 同 number 但下界 0

客户端读配置用 `loadConfig(api, log)`：**读不到返回 `null`，不抛**。
调用方必须退回内置默认值继续工作 ——
「配置读不到就整个哑掉」是这类插件最糟的失败模式。

---

## 8. 数据面：`{ ok, data }` / `{ ok, error }`

所有端点的响应统一是这个形状。客户端**不要**自己判断 `res.ok`：

```js
// kit 已经处理好了：失败抛真正的 Error（带后端 error 文本）
await requestJSON('/laurel', '/config', { method: 'POST', body: { config: patch } })
```

宿主侧路由（`lib/core/http.js` 的 `createRouter`）：

| 情况 | 行为 |
|---|---|
| 未声明的端点 | 404 |
| 方法不支持 | 405 |
| handler 抛异常 | 转 500（不让异常穿透） |

事件日志（`lib/core/events.js`）：一行一个 JSON；超 512KB 只留最后 200 行；
`detail`/`body` 截断 400 字符；**IO 失败全部吞掉**。

---

## 9. 自查清单（新插件发出去之前逐条过）

- [ ] `exports["./client"]` 指向真实产物，且该目录在 `files` 里
- [ ] `dsh.client.platform === "web"`
- [ ] `dsh.client.inject` 列全了客户端服务**供给方包**（用 `slots` 就要 `-ui-settings`）
- [ ] bundle 里没有顶层 `import` / `export default` / 动态 `import()`
- [ ] `export function apply(ctx)` 存在
- [ ] 产物里没有 `instanceof Map`（跑 `npm run test:kit`，有静态守卫）
- [ ] 订阅用 `getSnapshot()` + `subscribe()`，不是事件名
- [ ] 快照做了 diff，不是每次变化都动手
- [ ] 宿主半边顶层 `inject` 为空；Web 路由走子插件 + `effect` 清理
- [ ] 所有 IO 失败都吞掉，不让插件坏掉影响宿主
- [ ] `npm test` 全绿（宿主 52 项 + kit 21 项）

---

## 10. 命令

```bash
npm test                    # 两套测试：宿主半边 + 客户端 kit 契约
npm run test:host           # 只跑宿主半边（52 项）
npm run test:kit            # 只跑客户端契约（真跑打包 + vm 里执行产物）
npm run build:client        # 打包示例插件 → library/laurel-sample/client.js
node scripts/create-plugin.mjs <id>   # 生成一个带全套契约的新插件骨架
```

客户端半边支持**热替换：刷新页面即生效，不用重启 DSH**。
宿主半边（`lib/index.js`）改了要重启。
