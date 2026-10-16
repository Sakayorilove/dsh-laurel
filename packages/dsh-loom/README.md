# Loom · 0.8.6

Loom 是 DeepSeek Harness 的**可视化规划与并行交付工作台**：把项目拆成可编辑的节点图，
编译成可并行执行的批次脚本，再按批次开工、逐批验收。全部自建，**零第三方运行时代码**。

## 它做什么

- **规划画布**：聊天里点「规划模式」，AI 产出图文候选方案 → 在画布上增删节点、连线、编组；
  候选要**采纳并批准**之后才会开工，不存在「聊着聊着就动手」。
- **任务与批次**：任务有目标、接口、验收判据；依赖分层后编译成可并行批次，
  批内并发执行，批间由消费端独立验收后再启动下一批。
- **编组与分管**：框选/多选就地建组，拖入组框改归属；组可指定分管子代理与独立审查者。
- **审计与回传**：每步产出并发收据与审计报告，可展开、可复制；失败候选保留并可局部重试。
- **跨会话恢复**：计划与回复按会话持久化，重开面板能找回已有候选；`.loom/plan.json` 是恢复通道。

## 体积与开关

Loom 的客户端 bundle 约 340 KB —— 开着会明显拖慢首屏，所以**出厂默认关闭**，
在装载机的「功能管理」里按需打开。

## 安装

Loom 是 Laurel 套件的一个模块（独立包，可单独更新）：

- 随套件安装：见仓库根 [README.md](../../README.md)（profile 里给 `dsh-loom` 一个
  `link:<仓库>/packages/dsh-loom`）。
- 单独安装：在 DSH「设置 → 插件」里填本包目录的绝对路径。

宿主半边改动需要**完全退出 Harness 再打开**；客户端半边刷新页面即生效。

## 开发

```bash
npm run build        # tsc + bundle 一致性检查
npm test             # tsc + 单元测试 + 宿主集成测试（没有宿主时后者 skip，不算通过）
npm run test:all     # 同上，另跑 12 个浏览器用例（需要 Chromium）
```

`lib/` 是 `src/` 的编译产物；`lib/client.js` 是客户端半边（手写，不是构建产物）。
改了 `src/` 要重新构建，否则运行的是旧代码。

### 测试分两类

| 类别 | 例子 | 需要什么 |
|---|---|---|
| **独立单元测试** | `core` / `worktree` / `scope` / `appearance-settings` … | 只要 Node |
| **宿主集成测试** | `approval-progress` / `planning-gate` / `wsl-shell` / `browser-native-host` … | 本机 DSH 宿主；浏览器用例还要 Chromium |

`node scripts/run-tests.mjs` 给三种结论，**不会拿「跳过」冒充通过**：

- `pass` —— 所有用例真的跑过并通过；
- `partial` —— 单元用例通过，但**宿主集成用例被跳过**。这不是通过；退出码仍是 0，
  好让没装宿主的机器能本地跑；
- `fail` —— 有用例失败，或浏览器用例没真跑，或加了 `--require-host` 而本机没有宿主。

CI 里跑集成任务请加 `--require-host`，让它直接失败而不是静默跳过。
结果同时写在 `.verification/results.json`，每个文件一份 `.log`。

### 准备宿主环境

宿主锚点是**可配置、可校验**的（`scripts/host-anchor.mjs`）：每个候选都要真的解析出
`@deepseek-ai/cordis` 才算数，找不到就 `skip` 并打印怎么准备。任选一种：

```bash
# ① 本机装了 Harness 源码/运行时，直接指过去（package.json 或安装目录都行）
LOOM_HOST_ANCHOR=~/projects/deepseek-harness-runtime npm test

# ② 设了 DSH_HOME（Harness 的用户目录）
DSH_HOME=~/.dsh npm test

# ③ 什么都不用配：Loom 装进 profile 之后，它自己就在宿主的解析路径里
```

自检：`node scripts/host-anchor.mjs` 打印解析到的锚点；找不到时列出全部候选与准备方式。

浏览器用例按 `LOOM_CHROME` → `~/.cache/ms-playwright/*/chrome-linux64/chrome` 的顺序找 Chromium，
都没有就 `export LOOM_CHROME=/path/to/chrome`。**缺浏览器会被判为失败，不会被跳过。**

## 环境

- 支持 Windows 宿主 + WSL2 工作树（git 操作留在 Linux 文件系统上），也支持纯 Linux。
- 与 WSL 相关的位置由环境变量指定：
  - `DSH_LOOM_WSL_USER`：WSL 用户名（默认不指定 = 用该发行版默认用户）
  - `DSH_LOOM_WSL_WORKTREE_BASE`：工作树根目录的宿主侧基础路径

## 许可

MIT，见 [LICENSE](LICENSE)。第三方接口与参考见 [THIRD-PARTY.md](THIRD-PARTY.md)。
