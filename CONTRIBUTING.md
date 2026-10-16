# 参与开发

欢迎提 Issue 和 PR。这个仓库是「一个装载机 + 四个模块」的单一开发仓库，
每个包独立版本、可以单独更新 —— 模块的增删与更新步骤见 [MODULES.md](MODULES.md)。

## 环境

- **Node.js**：`^22.19.0 || >=24.0.0`。CI 用 Node 22；本机开发实测 Node 24.21.0。
- 开发/构建/测试在 **WSL2（Ubuntu）** 里跑最顺；Windows 上也能跑纯 Node 的检查。
- 包管理器用 `pnpm`（仓库含 `pnpm-workspace.yaml`）。根 `pnpm-lock.yaml` **已提交**，
  装依赖请用 `pnpm install --frozen-lockfile`；本机开发实测 pnpm 12.8.1。
- ⚠ **不要**在 WSL 里对着 Windows 的 DSH profile 跑 `pnpm install`：会写出 Windows 解析不了的
  相对链接。装进 profile 请在 Windows 侧跑 `scripts/install-profile.mjs`。
- 换 Node/pnpm 大版本时请一并更新 lockfile，别让 CI 与本机解出两套依赖树。

## 提交前必须跑（CI 也会跑同样的几条）

```bash
node scripts/check.mjs               # 装载机离线自检（模块加载 / 注册表 / 结果合同 / 客户端产物 / 模块落点 / 全仓 JS 语法）
node scripts/integration-probe.mjs   # patch 组出 loader 树、单独开关的语义
node scripts/bootgraph-probe.mjs     # boot graph 行、bundle id、inject 值域
node scripts/module.mjs check        # 每个模块的四处落点是否一致
node scripts/build-client.mjs --check # 客户端产物是否与源码一致
```

这几条**不需要安装任何依赖**，克隆下来就能跑。全绿再提 PR。

改了客户端半边（`lib/client/index.mjs`）要重新打包产物：`node scripts/build-client.mjs`。

**动了安装事务**（`scripts/install-profile.mjs` / `profile-path.mjs` / `assembly-check.mjs`）
或 `lib/patch.js`，另外跑一遍隔离复现（需要 pnpm，只在临时目录里操作，不碰任何真实 profile）：

```bash
node scripts/install-probe.mjs       # 九个场景：全新安装 / 旧结构迁移 / 卸载×2 / 显式回滚 /
                                     #           失败回滚×2（坏包、缺装载机 patch）/ 参数解析 / 默认寻址
```

`lib/patch.js` 也在这个清单里：`readPatchFile` 少一个 `entries` / `rows` 键，
装配校验核就会在展开时抛 `TypeError`，而那个位置在**回滚之前** —— 异常会掀掉整个进程，
profile 停在半装状态。所以 `check.mjs` 第 5b 节盯键契约、第 13 节盯
「校验核必须返回结论而不是抛异常」，`install-probe.mjs` 的 S5b 再盯一次事务级后果。

## 各模块自己的测试

| 包 | 命令 | 额外依赖 |
|---|---|---|
| `packages/laurel` | `npm test` | 无 |
| `packages/dsh-strata` | `npm test` | 无（UI 测试另需 React/Playwright） |
| `packages/dsh-loom` | `npm test`（含浏览器：`npm run test:all`） | `pnpm install`（TypeScript）；宿主集成用例需本机 DSH 宿主，浏览器用例需 Chromium |
| `packages/dsh-claude-parchment` | `npm test` | `pnpm install`（Playwright/React） |

**宿主集成用例没有宿主会 skip，而 skip 不算通过。** Loom 的 `node scripts/run-tests.mjs`
会把这种情况报成 `partial` 并列出跳过了哪些文件；要让跳过直接算失败就加 `--require-host`。
准备宿主环境和浏览器见 [packages/dsh-loom/README.md](packages/dsh-loom/README.md#准备宿主环境)。

## CI 跑什么

`.github/workflows/check.yml` 四个 job：

| job | 覆盖 | 主要挡住 |
|---|---|---|
| `offline-gates` | `check.mjs`（含**全仓 JS 语法**）/ 三个探针 / `build-client --check` | 坏语法进仓库这类 |
| `install-transaction` | `install-probe.mjs`（真实 pnpm，隔离 profile） | 安装入口 / 迁移卸载 / 失败回滚 |
| `module-tests` | 四个包各自的 `npm test`，外加 Loom 的报告断言 | 宿主锚点写死、主题与各模块功能 |
| `host-integration` | **手动触发**，需要自托管 runner + 真实 DSH | 宿主集成用例 |

宿主集成测试**不**混进托管 runner 的 job：那上面没装 Harness，跑起来只能 skip，
而「跳过」不该被算成通过。要跑就手动触发 `workflow_dispatch` 并勾上 `host_integration`，
机器上先设仓库变量 `LOOM_HOST_ANCHOR`。

> ⚠ 这套 CI **尚未在 GitHub 上实际执行过**：workflow 已写好，同样的命令都在本机逐条跑通。

## 维护流程（公开仓是主线，内部记录不公开）

- **唯一开发主线就是这个公开仓。** 内部评审报告、交付回传、验收证据、真实 profile 的路径与
  用户名、会话日志、个人数据**都不进仓库** —— 需要留档的放本地/私有位置。
  公开仓只放代码、契约文档和**任何人克隆下来都能跑**的检查。
- 提交信息写清「改了什么、为什么、怎么验证的」；行为变更要写明**未验证的部分**。
- 发布走标签：每个包独立打 `<包名>@<版本>`（见 [MODULES.md](MODULES.md) §6）。
  **没验证过的改动不要写进 CHANGELOG 的已发布小节**，也不要声称已经上线。
- 只改 `packages/<模块>/` 不影响别的包；改装载机（根 `lib/`、`scripts/`）要一起跑
  `node scripts/module.mjs check`。
- 引入依赖前先查许可与版本。本项目的硬约束是**零第三方运行时依赖**，
  测试依赖也只放各包的 `devDependencies`；引入后提交 lockfile 与执行环境信息。

## 几条硬规矩（踩过坑，别绕）

1. **不要手改构建产物**：`lib/client.js`（装载机）、`packages/dsh-strata/lib/client.js`、
   `packages/dsh-claude-parchment/lib/client.js` 都由脚本从源码生成；改源码再重建。
2. **模块清单只有一处真相**：`lib/registry.js`。加/删模块要一起改
   `packages/<目录>`、`cordis.patch.yml`（`name` 必须是**纯包名**）、
   客户端 locale 键；用 `node scripts/module.mjs check` 核。
3. **不要引用其它插件的类名/属性/存储**：本项目与任何第三方插件都保持零耦合。
4. **不要写死本机路径或用户名**：需要位置的地方用环境变量或参数（例如
   `DSH_LOOM_WSL_USER`、`LAUREL_CENTER_INSTALL`）。
5. 提交信息写清「改了什么、为什么、怎么验证的」；改行为要说明未验证的部分。

## PR 检查表

- [ ] 上面四条离线检查全绿
- [ ] 涉及行为变更的，写清验证方式；没验证的明确标注
- [ ] 没有引入本机路径、用户名、密钥或个人数据
- [ ] 相关文档（README / MODULES.md / CHANGELOG.md）已同步

## 安全

发现安全问题请走 [SECURITY.md](SECURITY.md) 的渠道，不要在公开 Issue 里贴可利用细节。
