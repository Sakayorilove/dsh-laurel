# 第三方接口、参考与许可

本仓库五个包**都不打包任何第三方运行时依赖**，也没有复制其他项目的源码、样式或品牌素材，
更**不引用、不适配任何其他插件**的类名、属性或存储。

## 1. 调用宿主的公开扩展点

| 本项目位置 | 用到的宿主接口 |
|---|---|
| `lib/host.js`（装载机） | 原生插件管理：`remote.pluginManager.listPlugins()` / `setPluginEnabled()`、`pluginInventory`（fiber 相位）、`plugin-manager/changed` 事件 |
| `packages/laurel`（模块） | 会话状态事件（`uiSession.sessionStatus`）与宿主通知能力 |
| `packages/dsh-claude-parchment`（模块） | 主题服务、设置页插槽、locale、`dsh-api-remotes` |
| `packages/dsh-strata`（模块） | 会话日志、设置页插槽、locale、宿主 LLM 通道（可选，拿不到就降级） |
| `packages/dsh-loom`（模块） | `@deepseek-ai/dsh-subagent`、`dsh-session`、`dsh-shell`、`dsh-tool-bash`、`dsh-fs`、`dsh-typert-protocol` 等公开接口；前端 React 由宿主平台表提供，Loom 不打包其实现 |

上表均为 `@deepseek-ai/` 作用域下的宿主包，按各自发行包的许可使用；本项目不重新许可它们，
也不把它们的实现复制进来。各包的检查脚本会守住这条线：
主半边只允许 `node:*` 与相对 import，客户端只允许 `require('react')`
（见 `scripts/check.mjs` 与 `packages/dsh-loom/scripts/check-bundle.mjs`）。

## 2. 开发期工具（不入发布包）

TypeScript、`@types/node`、Playwright、React/ReactDOM（仅测试与预览用）等只在开发与测试中使用，
许可依各自发行包，本项目的 MIT 不覆盖它们。

## 3. 只作调研参考的项目（未复制源码）

| 项目 | 参考了什么 | 是否引入代码 |
|---|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 官方仓库 | 公开 API 形状、README 与插件契约 | 否（只读公开接口） |
| 若干公开的记忆类插件 | 检索融合的取舍、「规则抽取投入产出比」等实测结论 | 否 |
| 若干公开的 MCP 服务器 | 运行安装自省、版本契约、任务状态机的思路 | 否 |
| 通用节点编辑产品（ComfyUI / Blender / Dify / n8n / Langflow / Flowise / React Flow 等） | 交互形态的公开演示 | 否（未引入源码或品牌素材） |
| B 站公开视频（标题 / 简介 / 章节） | 界面与工作流现象观察 | 否 |

调研只用于形成自己的实现判断；本项目**没有**启用、import 或复制任何第三方插件的代码，
MCP 与画布类产品的比较也只停留在公开演示层面。

## 4. 本项目自身的许可

MIT，见 [LICENSE](LICENSE) 与各模块目录下的 `LICENSE`。
