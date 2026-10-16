# 第三方接口、来源与许可 · 0.3.0

本项目独立实现 Loom 的业务逻辑、DOM/SVG 画布、提示词协议、执行校验与插件适配。正式 tgz 不包含 node_modules、宿主/竞品源码、品牌资产或前端库的打包副本；package.json 无运行时 npm dependencies。这一范围说明不意味着宿主或开发工具没有第三方许可。

## 交付内容与接口调用

包内为本项目 `lib/` 编译产物、手写 `lib/client.js`、bundle patch、package.json、自写文档及 MIT LICENSE。`scripts/check-bundle.mjs` 检查主半边仅 node:* 与相对 import、客户端仅 `require('react')`、受限 host API 解析和版本一致。检查用于发现意外打包与接口漂移，不能替代逐项许可判断或完整代码审计。

客户端 React 由 Harness 的平台 seed 表提供；Loom 未打包其实现。Cordis、Connection/Typert、SessionController/commands、工具、子 Agent 组合和策略由宿主提供，Loom 调用公开扩展点。

主半边 `createRequire` 的可选解析入口与允许的宿主包为：

| 本项目入口 | 宿主公开接口 |
| --- | --- |
| `src/host-helpers.ts` | `@deepseek-ai/dsh-subagent`、`dsh-llm`、`dsh-agent`、`dsh-session`、`dsh-brand`：父/子生命周期、组合与结果读取。 |
| `src/host-helpers.ts` | `@deepseek-ai/dsh-shell`、`dsh-tool-bash`、`dsh-fs`、`dsh-tool-fs`：Windows 子作用域的 WSL 公共 ShellExecutor/FileSystem 与工具。 |
| `src/remote.ts` | `@deepseek-ai/dsh-typert-protocol`：公开 Service/Remote，复用宿主传输。 |

上表简写的包均属 `@deepseek-ai/` 作用域。解析失败时相关能力明确拒绝/降级，不安装或复制另一份宿主。WSL worker、路径/策略适配代码由本项目编写，未复制内部 driver 或另一个插件实现。

## 构建、测试与研究材料

TypeScript 和 @types/node 只用于开发编译/类型检查，不随 tgz。其许可依各工具发行包；本项目的 MIT 不重新许可它们。运行宿主的 React/Cordis/DeepSeek Harness 等仍按各自发行包许可分发，Loom 没有将其许可义务转移或取消。

验收从现有安装的 Harness 包读取公共接口、生产 Agent 与宿主前端平台，并在测试进程内加载；没有把供应商 JS 或其截取文件保存到仓库/发布包。浏览器、Node、Git、WSL 和 pnpm 为环境工具，不是包内代码。用户参考截图是内部设计资料，不进入安装包。

读取官方 checkout `639ed015397290b3745d163aafe02ffee4aa3f84` 的公开 API 源码及 README，用于适配真实 SessionController/commands、Typert、子 Agent、shell/fs 边界；未复制源码。来源为 [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)。公开 SDK/ACP Provider 文档用于方案比较，本版没有引入这些独立进程 provider。

B站 BV1AzQZBYEPz、BV1HyRsYHEk2、av1206319288 只查看标题/简介/章节列表，未播放。通用节点编辑交互参考不构成照搬；没有引入 ComfyUI、Blender、Dify、n8n、Langflow、Flowise、LangGraph、React Flow 的源码/品牌素材，也没有依赖第三方 DSH 插件。

未来若引入成熟库或源码，须核查明确许可、保留要求的归属与 notices，并更新此页及打包检查；公开仓库不能被视为无限复制许可。当前项目自身采用 MIT，见 [LICENSE](LICENSE)，随源码与安装包分发。
