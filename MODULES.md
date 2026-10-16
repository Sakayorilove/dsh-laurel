# 装载机与模块

本仓库是 Laurel 套件的**单一开发仓库**，形状是**一个装载机 + N 个模块**：

```text
laurel-suite/
├── package.json            ← 装载机 laurel-center（唯一挂进 DSH profile 的包）
├── cordis.patch.yml        ← 总闸：往 loader 树插「自己 + 每个模块」各一行
├── lib/                    ← 装载机宿主半边 + 总控台客户端半边（client/ 是源码，client.js 是构建产物）
├── packages/               ← ★ 模块的完整源码（每个模块一个目录、一个独立包、独立版本）
│   ├── laurel/             ← 通知
│   ├── dsh-claude-parchment/ ← Claude 主题
│   ├── dsh-strata/         ← 记忆与上下文
│   └── dsh-loom/           ← 可视化规划模式
├── scripts/                ← release / 安装事务 / 装配校验 / 模块落点工具 / 离线探针
├── docs/                   ← 装载机的契约文档
└── MODULES.md              ← 本文
```

**为什么是这个形状**：装载机和每个模块都是**独立的 npm 包**，各自有自己的版本号、
自己的 `package.json`、自己的 `LICENSE`。所以「只更新某一个」不会牵动其它；
增删模块是**加/删一个目录 + 一处注册表条目**。

**唯一真相是 `lib/registry.js`**。客户端清单在构建期从同一处内联
（`scripts/build-client.mjs` 的清单里有 `lib/registry.js`），装配校验也从同一处推导
（`scripts/assembly-check.mjs` 不再手抄一份）。这就是「两份不一致」这个老坑的堵法：
**加模块只需要登记一次。**

---

## 1. 当前清单

版本以各 `package.json` 为准（下表写的是本文件落笔时的值，实跑 `node scripts/module.mjs list` 看实时值）。

| 角色 | id（loader 行 id） | 目录 | 包名 | 版本 | 出厂默认 |
|---|---|---|---|---|---|
| 装载机 | `laurel-center` | `.`（本仓库根） | `laurel-center` | 1.1.2 | 自启（它自己不参与开关） |
| 模块 | `laurel` | `packages/laurel` | `laurel` | 0.1.0 | 关 |
| 模块 | `claude-parchment` | `packages/dsh-claude-parchment` | `dsh-claude-parchment` | 1.2.0 | 关 |
| 模块 | `strata` | `packages/dsh-strata` | `dsh-strata` | 0.2.0 | 关 |
| 模块 | `loom` | `packages/dsh-loom` | `dsh-loom` | 0.8.6 | 关（客户端 bundle 大，开着拖首屏） |

出厂默认全关：装载机自己在跑，四个模块待总控台（设置 → 功能管理）逐个打开。

**宿主侧的形状**：装载机在 profile 的 `dependencies`，四个模块在 `devDependencies`
（`link:` 指向 `<装载机>/packages/<目录>`）。**每个包在两段依赖里只能出现一处** ——
两段都有同名时，`assembly-check` 的合并口径是 `devDependencies` 盖掉 `dependencies`，
于是「以为改了、其实读的是另一处」。`scripts/install-profile.mjs` 会规范化成一处。

---

## 2. 一个模块的落点（增删改都必须一起动的地方）

| # | 落点 | 作用 | 漏改的后果 |
|---|---|---|---|
| 1 | `lib/registry.js` → `SUB_PLUGINS` | **唯一真相**：id / dir / entry（纯包名）/ clientId / label / desc / defaultOn | 什么都不发生（模块不存在） |
| 2 | `packages/<dir>/` | 模块实体源码 + `package.json`（name / main / exports["./client"] / version） | 宿主解析不到入口 |
| 3 | `cordis.patch.yml` 的 `insert:` | 往 loader 树插一行：`id` + **纯包名** `name` + `disabled: true` | 前端永远看不到它（`name` 带斜杠会**静默**失效） |
| 4 | `lib/client/index.mjs` 的 locale | `plugin.<id>` 与 `plugin.<id>.desc`，zh 与 en 各一条 | 界面上显示成裸键名 |
| 5 | profile 的 `package.json` | 子包 link 指向 `<装载机>/packages/<dir>` | 宿主按裸包名解析不到那个模块 |
| 6 | ~~`scripts/assembly-check.mjs`~~ | **已不需要**：它由落点 1 推导 | —— |

装载机自己另有一处：`package.json` 的 `dsh.bundle.patch`、`exports`、`version`。

**落点 2–4 由 `node scripts/module.mjs check` 逐条核对**（只读，不改文件）。
落点 5 给它一个 profile 目录就会一起查（形状 + realpath）：

```bash
node scripts/module.mjs list                      # 看实时清单
node scripts/module.mjs check                     # 只查仓库内落点
node scripts/module.mjs check /path/to/profile     # 连 profile 指向一起查
```

> 为什么 `module.mjs` **不去自动改** `cordis.patch.yml`：那个文件里的注释是这个项目
> 防止重犯 `uiSettings` / 带斜杠包名那类事故的主要手段，脚本改写会毁掉它们。
> 工具只负责说清「还差哪一处」，真正动手改的是人。

---

## 3. 只更新装载机

1. 改 `lib/`（宿主半边 `index.js`/`host.js`/…；客户端半边改 `lib/client/index.mjs`，**不要手改构建产物 `lib/client.js`**）。
2. 改了客户端源码就跑 `node scripts/build-client.mjs`（它会把 `lib/client.js` 重建；`--check` 只校验）。
3. `package.json` 的 `version` +1（装载机自己的版本）。
4. 跑门禁：`node scripts/check.mjs && node scripts/integration-probe.mjs && node scripts/bootgraph-probe.mjs`
   （端到端另跑 `node scripts/e2e-real-cordis.mjs`）。
5. `node scripts/module.mjs check` 必须通过。
6. 提交 + 打标签（见 §6）：`laurel-center@1.1.2`。

**四个模块一个字都不用动。**

---

## 4. 只更新某一个模块

以 `packages/dsh-strata/` 为例：

1. 只改 `packages/dsh-strata/` 里的源码（它的 `lib/client.js` 是构建产物：改 `lib/client/index.mjs` 后跑它自己的 `npm run build`）。
2. 改 `packages/dsh-strata/package.json` 的 `version`。
3. 跑该模块自己的测试（`cd packages/dsh-strata && npm test`）。
4. 回仓库根跑 `node scripts/check.mjs` 与 `node scripts/module.mjs check`（确认装载机那边没被带坏）。
5. 提交 + 打标签：`dsh-strata@0.2.1`。

**装载机和其它三个模块一个字都不用动。** 模块的版本号和装载机的版本号互不绑定 ——
这是「单独更新」能成立的前提。

> 真实机器上的生效边界：模块的**客户端半边**刷新页面即生效；**宿主半边**（`lib/index.js`）
> 必须**完全退出 Harness 再打开**。改了源码还要让 profile 指向的安装面拿到新文件：
> `node scripts/release.mjs --to <安装目录>`（不要手改安装目录）。

---

## 5. 增加 / 删除模块

### 增加

1. 把模块源码放进 `packages/<dir>/`，`package.json` 里 `name` 用**纯包名**（不带斜杠、不带 scope 前缀的包名规则见 `docs/PLUGIN-CONTRACT.md`）。
2. `lib/registry.js` 的 `SUB_PLUGINS` 加一条：`{ id, dir, entry: <包名>, clientId: <包名>, label, desc, defaultOn: false }`。
   - `id` 一旦发布就**不要再改**：它是 profile 用户层 patch 定位那一行的键。
3. `cordis.patch.yml` 的 `insert:` 里加一行：`- id: <id>` / `name: <纯包名>` / `disabled: true`。
4. `lib/client/index.mjs` 的 zh 与 en 两个 locale 段各加 `plugin.<id>` 与 `plugin.<id>.desc`。
5. `node scripts/build-client.mjs` 重建装载机的客户端 bundle。
6. `node scripts/module.mjs check` 应零问题；`node scripts/check.mjs` 应全绿。
7. 安装：在 profile 的 `package.json` 里给新包加一个 `link:<装载机>/packages/<dir>`，
   再用宿主自己的安装事务（或 `node scripts/install-profile.mjs <profileDir>`）落链接。
8. 提交 + 打标签 `<包名>@<版本>`。

### 删除

1. `lib/registry.js` 删掉那条。
2. `cordis.patch.yml` 删掉那一行（**必须删**：留下的孤立行会让它的 id 永远不可达）。
3. `lib/client/index.mjs` 删掉两段 locale 的四个键。
4. 删 `packages/<dir>/` 整个目录。
5. profile 里删掉那个依赖（否则用户层还指着不存在的路径，宿主启动会报加载失败）。
6. `node scripts/build-client.mjs` 重建 bundle。
7. `node scripts/module.mjs check` 应零问题（它会报「孤儿目录」当夹层漏删）。

> 删模块**不要**只删目录：`packages/` 少了目录但 patch/注册表还在，装载机会去找一个不存在的包。
> 反过来，只删注册表条目会在 `module.mjs check` 里报孤儿目录。

---

## 6. 标签约定（单独更新的可追溯身份）

每个包**独立打标签**，标签名就是「包名@版本」：

```bash
git tag laurel-center@1.1.1
git tag laurel@0.1.0
git tag dsh-claude-parchment@1.2.0
git tag dsh-strata@0.2.0
git tag dsh-loom@0.8.6
```

这样「哪个模块什么时候到的哪一版」在仓库里可查，也不需要给整仓编一个统一的版本号。
`package.json` 的 `version` 与之同步；`release.manifest.json` 记录本次生成的安装面来自哪个 commit。

---

## 7. 与安装面的关系

- 本仓库是**完整开发输入**（含各模块的 `src/`、`tests/`、`scripts/`）。
- **安装面**只该有运行需要的文件，由 `node scripts/release.mjs --to <目录>` 生成，逐文件 hash 记在 `release.manifest.json`。
- 安装目录**不要手改**：下次 release 会覆盖它。
- profile 的注册走安装事务：`node scripts/install-profile.mjs <profileDir>`（写依赖 → 一次 pnpm install → 校验，失败整体回滚）。
- ⚠ Windows profile 不要在 WSL 里跑 pnpm（会写出 Windows 解析不了的链接）；用宿主插件页的安装流程。
