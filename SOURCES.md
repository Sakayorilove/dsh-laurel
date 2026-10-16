# 来源与组成

本仓库是 Laurel 套件的**单一开发仓库**：装载机（根目录的 `laurel-center`）与四个模块
（`packages/` 下）的完整开发输入都在这里，安装面由 `scripts/release.mjs` 从本仓库生成。

| 包 | 仓库内路径 | 版本 | 来源 |
|---|---|---|---|
| laurel-center | `.` | 1.1.2 | 本仓库（权威开发源） |
| laurel | `packages/laurel` | 0.1.0 | 本仓库（权威开发源） |
| dsh-claude-parchment | `packages/dsh-claude-parchment` | 1.2.0 | 本仓库（权威开发源） |
| dsh-strata | `packages/dsh-strata` | 0.2.0 | 本仓库（权威开发源） |
| dsh-loom | `packages/dsh-loom` | 0.8.6 | 本仓库（权威开发源） |

- 版本以各 `package.json` 为准；`node scripts/module.mjs list` 打印实时值。
- 各包之间**没有源码引用关系**：`packages/<目录>` 都是实体文件，删掉任何一个目录，
  装载机与其余模块照常运行（装载机的模块清单在 `lib/registry.js`）。
- 逐文件 hash 与「安装面来自哪个 commit」记在 `release.manifest.json`（由 release 生成，不入库）。
- 第三方接口、参考实现与许可见 [THIRD-PARTY.md](THIRD-PARTY.md)。

> 开发过程中的内部迭代记录（评审响应、故障复盘、交接手册、逐版本流水）**不随本仓库发布**。
> 本仓库只保留面向使用者的说明与可复现的检查脚本。
