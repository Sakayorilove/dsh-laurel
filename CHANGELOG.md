# 更新日志

本文件记录**整套**的变化。每个模块自己的版本号在 [MODULES.md](MODULES.md) 的表里，
两者一起看：套件里的包可以单独更新，所以「模块版本」和「套件快照」不是一回事。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## 未发布 — 公开仓首次使用反馈的修复

来源：2026-10-13 的公开仓首次使用反馈。**以下改动尚未打标签、尚未发布**，
各包版本号仍保持 v1.1.2 时的值；发布时按 [MODULES.md](MODULES.md) §6 逐包决定。

### 修复

- **安装入口**：README 里那条 `node scripts/install-profile.mjs` 以前不带参数就退出 2、
  什么都不做；现在会自动找 profile，找不到或找到**多个**候选时列出候选并停下（不猜）。
  选项值也不再被当成位置参数（`--center X <profile>` 以前会把 X 当成 profile）。
- **迁移与卸载**：真实机器上装载机在 `dependencies`、四个模块在 `devDependencies`，
  迁移会留下旧声明、卸载只清一段。现在安装只对 OWNED 五包规范化成一处、卸载两段都清，
  备份身份与回滚也认两段。用真实 pnpm 的隔离探针覆盖九种场景（含两次失败回滚）。
- **失败回滚会先崩**：安装面缺 `cordis.patch.yml` 时 `readPatchFile` 的提前返回少一个
  `rows` 键，装配校验核在展开时抛 `loaderPatch.rows is not iterable`。抛出点在**回滚之前**，
  异常直接掀掉进程 —— profile 停在半装状态、链接还指着坏包，而屏幕上只有一句看不懂的 TypeError。
  现在三层都补上：`entries` / `rows` 在任何返回路径上都存在；校验核再兜一层 `?? []`；
  安装器的 `checkAssemblySafe` 把「校验核自己抛错」也变成一条普通校验失败，
  保证事务照样走失败 + 回滚。问题清单也直接点名「装载机 patch 文件存在」。
- **主题测试文件语法损坏**：`packages/dsh-claude-parchment/test/browser.test.mjs`
  有三处把真实换行写进单引号字符串，`node --test` 直接 SyntaxError。
  另外「仓库里每个 JS/MJS/CJS 都能被解析」现在是常驻门禁（`node scripts/check.mjs` 第 12 节）。
- **Loom 测试的宿主锚点**：测试把 `/home/<用户>/projects/deepseek-harness-runtime/package.json`
  这种脱敏占位符写死成宿主锚点 —— 在谁的机器上都不存在，文件在**模块加载期**就抛；
  当时的运行器「失败即 break」，后面几十个文件根本没跑，却看起来像「测过了」。
  现在锚点可配置、可校验（每个候选都要真的解析出 `@deepseek-ai/cordis` 才算数），
  找不到就 skip 并打印怎么准备；运行器区分独立单元测试与宿主集成测试，
  并给出 `pass` / `partial` / `fail` 三种结论 —— **跳过不算通过**。
- **Loom 界面文案（改名遗留）**：2026-10-12 把欢迎题词从「欢迎使用 Avel-Loom 工作规划系统」
  改成「欢迎使用可视化规划模式」时漏了几处：设置页标签、两份测试断言，以及
  `browser-native-host.test.mjs` 里六处旧按钮/无障碍标签。同一个文件里
  `textContent === '开始并行开工'` 那条断言从 0.7.0 起就永远成立（假通过），已改成真名。
- **Windows pnpm 启动**：安装器在 Windows 上用 shell 启动 pnpm（`.cmd` shim 不能
  直接 execFile），并加 pnpm 前置预检（缺了报退出码 5，不会改到一半停住）。

### 新增

- `scripts/install-probe.mjs`：用真实 pnpm 在临时目录复现九个场景 ——
  S1 全新安装 / S2 旧结构迁移 / S3 卸载（真实形状）/ S3b 卸载（全新形状）/ S4 显式回滚 /
  S5 失败回滚（坏包）/ S5b 失败回滚（缺装载机 patch）/ S6 参数解析 / S7 默认寻址。
  **不读也不写任何真实 profile**。
- `node scripts/check.mjs` 新增两节常驻断言：第 5b 节盯 `readPatchFile` 的键契约，
  第 13 节盯「装配校验核缺文件时必须返回结论而不是抛异常」（回归防线）。
- `packages/dsh-loom/scripts/host-anchor.mjs`：宿主锚点解析；
  `node scripts/host-anchor.mjs` 可自检并打印准备方式。
- `packages/dsh-loom/scripts/check-test-report.mjs`：机器可读地断言测试报告如实
  （不许有崩掉的文件，不许静默全跳过）。
- CI 新增两个 job（安装事务、模块测试）；需要真实 DSH 宿主的集成测试单列成手动入口，
  不混进托管 runner 的 job 里，也不靠「跳过」凑绿。

### 未验 / 已知限制

- **CI 尚未在 GitHub 上实际执行过**：workflow 已写好，同样的命令在本机
  （WSL，Node 24.21.0，pnpm 12.8.1）逐条跑通；首次执行结果待观察。
- **Windows 宿主的 pnpm 行为未实测**：Windows 上的 pnpm 行为仍是条件性风险。
- **真实 Windows 宿主 + Electron 未验**：本轮只在 WSL 与隔离 profile 上验证。
- 主题包 devDependency 是 `playwright` 1.56.1，它把 `ubuntu26.04-x64` 判为不支持
  （`Playwright does not support chromium on ubuntu26.04-x64`）；本机浏览器用例用的是
  `~/.cache/ms-playwright` 里已装好的 Chromium。是否升级 playwright 待定。

## v1.1.2 — 首个公开版本

装载机 `laurel-center` 1.1.2 · `laurel` 0.1.0 · `dsh-claude-parchment` 1.2.0 ·
`dsh-strata` 0.2.0 · `dsh-loom` 0.8.6

### 新增

- **装载机**：设置页「功能管理」总控台，列出四个模块，单个/一键开关；
  开关走宿主原生插件管理（写 profile 用户层，重启保持），并分三层显示
  「设置意图 / 宿主运行状态 / 本窗口加载状态」。
- **`laurel`（通知）**：agent 提问、等待批准、回合结束时弹 Windows 通知并可选提示音；
  Harness 在前台时改为页内卡片。
- **`dsh-claude-parchment`（Claude 主题）**：暖黄羊皮纸明暗配色、会话排版
  （居中列宽、衬线正文、消息块）；只改外观，不碰其它插件的偏好或存储。
- **`dsh-strata`（记忆与上下文）**：跨会话记忆，三级作用域（本会话 → 本工作区 → 全局），
  跨工作区读取逐次授权；数据是追加式 JSONL，遗忘走追加事件、不删行。
- **`dsh-loom`（可视化规划模式）**：把项目拆成可编辑节点图，编译成可并行执行的批次；
  候选要「采纳 + 批准」后才开工，含编组、分管与独立审查、审计报告。
- **模块化**：加/删模块只需要登记一处（`lib/registry.js`），
  用 `node scripts/module.mjs check` 核对全部落点；每个模块独立版本、独立标签。

### 变更

- 主题模块**不再与任何第三方皮肤插件耦合**：以前会检测别的插件的外观属性并自动暂停，
  该行为与相关样式、文案、测试已整体移除。
- Loom 的 WSL 用户与工作树根改为环境变量驱动（`DSH_LOOM_WSL_USER` /
  `DSH_LOOM_WSL_WORKTREE_BASE`），不再写死某个人的用户名与家目录。
- 装载机里写死的本机路径改为按环境推导（profile 位置、release 校验目标）。

### 修复

- 装配校验只读 `dependencies`，而真实机器上模块链接可能落在 `devDependencies`，
  会报假失败；现在两处依赖段都认。
- 客户端对宿主原生 RPC 加了等待上限：宿主忙（例如正在安装插件）时如实报
  「结果未确认」，不再让界面看起来卡死。
- 迁移失败不再被当成「迁移完成」；release 切换失败会从备份恢复并逐文件核对。

### 说明

- 首次公开版本只做 GitHub 分发，未发布到 npm。
- 支持范围见 [README](README.md) 的「兼容与已知限制」。
