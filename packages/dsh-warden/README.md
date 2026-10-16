# dsh-warden · 内耗护栏

> ## ⚠ 0.2.0 订正：0.1.0 里有三条"看起来在工作、实际没生效"的能力
>
> 2026-10-15 独立评审（`docs/warden/01-…`）用真实宿主运行件复现了下面几条。
> 0.1.0 的 README 把它们写成已生效，这是错的，在此逐条订正：
>
> | 0.1.0 的说法 | 实际情况 | 0.2.0 的处理 |
> |---|---|---|
> | "给 `wait_agent` 的等待时间套上限"，在 `tools/pre-execute` 里把 `timeout_ms` 压到上限 | 宿主 `createExecution()` 对参数做了 `deepFreeze`，赋值必抛；异常被自己的 `catch{}` 吞掉后继续放行 —— **工具体照旧收到 900000ms**。真实 Cordis + ToolRuntime 探针已复现 | 改到 `tools/execute` 上给**期限信号**（与官方 `dsh-tool-call-timeout-policy` 同一层同一手法）。期限到了返回 `wait_agent` 自己的正常超时值 `{timedOut:true}`，**不是** error，解释走 `additionalContexts`。见 `lib/host/wait.js` |
> | "微压缩：保留最近 N 条工具结果，更早的换成占位符" | `agent/pre-step` 拿到的是 **inbox 待追加的新批次**，完整历史要到 `buildRequest()` 才从 session surface 构建 —— **那一层根本没有旧工具结果**。旧单测人为塞了 20 条历史 tool 消息，测的是生产不存在的输入。而且占位符要求"重新执行那个工具"，写入/部署/网络请求**不可重放** | 三档全部默认关闭，且这一层不再裁历史；能力台账里 `historyPruning` 明确标 **unsupported**。历史压缩唯一 owner 是官方 `dsh-compaction-basic`。替代方案改成对**新产生的**大文本结果做归档 + 有界呈现（`lib/host/archive.js`，挂 `tools/post-execute`），原文可按路径与行区间回读，**不靠重跑找回** |
> | "水位提醒：上下文每长大 N token 提醒一次" | 采样挂在 `llm/stream` 上、从**回调入参**找 usage；但实读 `dsh-llm`，入参是**请求 options**，usage 只在 `next()` 返回的 chunk 流里 —— **一个 usage 也没采到**，提醒从未触发。另外把含输出的 `totalTokens` 当"当前上下文水位"也是错的 | 改读 `session/event`（usage 随 assistant 事件持久化，不消费流、不重不漏），提取口径照抄官方 `dsh-token-meter` 的 `usageOf()`；当前压力优先读官方 `contextPressure` 投影（`pressureTokens` = input + cacheRead + cacheWrite，**不含输出**），读不到就显示 unknown，绝不用累计值冒充 |
> | "83 项单测全过" | 隔离副本实测 **82/83**：过期锁用例是 1ms 真实时间竞速，快机器上不过 | 统一改用可注入时钟（`lib/core/clock.js`），不再有真实时间竞速。当前是 `tests/smoke.mjs` 90 项 + `tests/host-contract.mjs` 54 项 |
> | 台账未绑定产物时显示"✅ 有效" | 读不到产物、没绑产物、写盘失败都可能被当成有效验收 | 四态：`verified / stale / unverified / error`；未绑定、环境未知、旧算法指纹一律 **unverified**，写盘失败直接返回失败 |
> | 指纹是文件 sha256 | `sha256Hex` 先 `String(buffer)` 再按 UTF-8 hash，`0x80` 与 `0x81` 两个不同文件**撞成同一个 hash**，也与 `sha256sum` 不一致 —— exe/dll/图片全废 | 改为字节级 hash，与 `sha256sum` 逐字节一致；算法版本 `sha256-bytes-v2` 写进台账，v1 旧记录判 unverified、必须重记 |
> | 共享目录锁 | 两把**不同名**的锁可以同时占住同一路径；写盘失败仍返回 `ok:true`；删父目录不判子树锁 | 锁的身份改成**规范 resourceId**（含父子路径、Windows↔WSL `/mnt` 同盘合并、命名资源 `desktop-input`/`display-mode`/`deployment:<目标>`/`port:<n>`）；读写走 `O_EXCL` 独占文件锁；写失败返回失败；加 fence 栅栏令牌与续租；`force` 不能从模型侧抢活锁 |
> | "已启用" | section 注册抛错后仍用"disposers 非空"判成功，兜底永不投递；`setConfig()` 丢掉 `saveSettings()` 的 false，界面报"保存成功"而重启丢配置 | 能力台账分 `supported / mounted / observed / degraded / standby`；只认注册返回的**确切句柄**；写盘失败回 500 并在界面持续显示 |
>
> **新增（0.2.0）**：无进展识别（按"有没有新证据"判，分段读大文件不再误报）、最小阶段合同
> （缺必需项不能 `complete`）、工具失败分型、大输出归档、跨模块治理 owner 仲裁
> （与 dsh-strata 的等待上限/水位提醒不再各做一份）。
>
> **仍未验证**：真实 Electron 界面、真实付费模型链路、用户当前桌面上的并发行为、重启后加载。
> 详见 `docs/warden/04-实际交付回传手册-20261015.md`。

给 DeepSeek Harness 的 agent 装一副「缰绳」。

它治的**不是**「模型不聪明」，而是几件事凑在一起产生的**内耗**：

| 症状 | 实测（2026-10-14，本机 19 个会话） |
|---|---|
| 子代理干等，一等就是一小时 | `wait_agent` 单会话最多被调 **41 次**；一个 486 步的会话跨度 **6 小时**，真正在算的只有 **73 分钟** |
| 子代理互相直接对话，读数互相污染 | 一个会话 **98 条** team message，多条「更正（重要，请以这条为准）」 |
| 同一个文件反复改 | `acceptance-gestures.md` 改 **31 次**、`DesktopNativeDedupWin.h` **24 次** |
| 同一个文件反复读 | 一个文件被读 **60 次**（另两个 56 / 31 次） |
| 上下文只涨不降 | 单步上下文中位 **218k**、峰值 **627k**，而宿主压缩阈值是 **80 万** —— 一次都没触发 |
| 几个子代理共用一个部署目录 | 原话「验收期间部署换了三次，**读数无法归属**」 |
| 改文件匹配失败就原地重试 | **8 次** `old_string was not found` + 1 次 `old_string matched 2 times` |

这个插件把上面这些收成一套**可开关的护栏**：三条自动生效的钩子链 + 6 个模型可以主动调的工具 + 一个设置页。内置**三档预设**（温和 / 均衡 / 严格），也可以**逐项自定义**。

> 它是 [Laurel 套件](../..) 的一个子插件，但**可以单独装**。宿主半边零第三方依赖，只用 Node 内置模块。

---

## 三档预设

出厂默认是**均衡**。

| | 温和 Gentle | 均衡 Balanced | 严格 Strict |
|---|---|---|---|
| 子代理等待上限 | 5 分钟 | **60 秒** | 30 秒 |
| 子代理只对主控汇报 | 开 | 开 | 开 |
| 子代理结论写文件 | 关 | 开 | 开 |
| 返工提醒（同一文件第 N 次起） | 5 | 3 | 2 |
| 重复读提醒（第 N 次起） | 关 | 3 | 2 |
| 上下文水位提醒（每长多少） | 100k | 50k | 25k |
| ~~微压缩~~（已废弃，三档全关） | 关 | 关 | 关 |
| 大输出归档（≥N 字符先落盘，只留首尾摘要） | 16000 | 8192 | 4096 |
| 共享目录锁 | 关 | 开（2 分钟过期） | 开（1 分钟过期） |
| 读数指纹台账 | 关 | 开 | 开 |

**温和** = 只提醒、几乎不拦，适合你本来就打算自己盯着的时候。
**均衡** = 默认档。
**严格** = 无人值守 / 长时间跑。

三档是**三张完整的取值表**，不是「基线 + 补丁」。所以不存在「档位写着均衡、某个值还留着上次严格」这种幽灵状态。你动了任何一项，档位就自动变成**自定义**（这一步由宿主侧强制，不靠前端自觉）。

---

## 它到底做了什么

### ① 执行前守卫（`tools/pre-execute`）

- **给 `wait_agent` 套等待上限。** 宿主的 `dsh-tool-call-timeout-policy` 只对「自己声明了 `timeoutMs` 的工具」生效，而 `wait_agent` 没声明 —— 所以那个硬超时对它形同虚设。这里直接把参数里的 `timeout_ms` 压到上限。
- **共享目录锁。** 别人正占着你准备写的路径 → 拦下来，并说清「谁占着、还有多久过期、你现在能怎么办」。
  **只拦「写」，不拦「读」** —— 别的子代理正需要读它来核对读数。

### ② 执行后观察（`tools/post-execute`）

- **返工提醒按「同一个文件」计数。** 宿主自带的 `dsh-repeat-tool-reminder` 用参数的规范化结果做键，所以**两次内容不同的 edit 不算重复**。而实测最烧时间的返工恰恰是「同一个文件改了 31 次」，每次内容都不一样 —— 宿主完全看不见。这一条正好补上那个洞。
- **重复读提醒。** 同一个文件读了很多次，说明信息第一次就已经拿到了。
- **改文件匹配失败 → 提示「先完整重读再改」。** 比让模型原地重试有效得多。
- **未知工具 → 附上当前 agent 的真实工具清单。** 宿主只报一句错，模型看不到「到底有哪些工具」，于是继续凭记忆拼名字。

### ③ 上下文层（`agent/pre-step` + `systemPrompt.section`）

- **子代理纪律**（星型拓扑 + 结论落文件）写成系统提示词里的**常驻 section** —— 它跟着每一轮请求走，压缩之后也还在，比每轮塞一条消息便宜得多。
- **水位提醒。** 宿主的自动压缩只在窗口到 80% 时才动手（1M 窗口 = 80 万 token），长会话常常到不了。这里改成「每长大一定量就温和提醒一次」，与窗口大小无关。**只提醒，不删改任何历史。**
- **大输出归档（代替已废弃的「微压缩」）。** 在结果进入上下文之前拦一道（`tools/post-execute`）：原文完整写到 `$DSH_HOME/warden/archive/<会话>/<callId>.txt`，上下文里只留有界摘要 + 行数 + 字节数 + sha256 + 文件路径；要中间部分就按行区间读那个文件，**不重新执行工具**（写入/部署/网络请求重跑有副作用）。归档失败保留原结果；失败结果一律不归档；图片等非文本块原样保留。
- **历史压缩 warden 不做。** 唯一 owner 是官方 `dsh-compaction-basic`（压力压缩 + 溢出重试），单条超长由官方 `dsh-compaction-tool-result-pruner` 处理。能力台账里 `historyPruning` 明确标 unsupported。

### ④ 模型侧工具

| 工具 | 干什么 |
|---|---|
| `warden_status` | 看当前档位、各项开关、持有的锁、台账统计 |
| `acquire_lock` / `release_lock` / `list_locks` | 共享资源锁（拿不到会告诉你谁占着、还有多久） |
| `evidence_record` / `evidence_check` | 记一条读数并**绑上产物 sha256**；复核时指纹对不上就**直接判这条作废** |

### ⑤ 设置页

「设置 → Laurel 套件 → 内耗护栏」，四个页签：**档位 / 子代理 / 上下文 / 诊断**。
数据面在 `/warden` 下（`/status` `/preset` `/config` `/lock/release`），单独装这个插件时就是「设置 → 内耗护栏」。

---

## 这些数字是怎么来的

**没有一个是拍的。** 全部来自 2026-10-14 本机 `~/.dsh/sessions/` 里 19 个会话的原始日志，逐条扫 `tool/result` 的 `isError`、`tool/call` 的参数、以及 `user/message` 里的 Team message。

| 配置项 | 取值 | 出处 |
|---|---|---|
| `waitCapMs` | 60s（均衡） | `wait_agent` 单会话最多 41 次；486 步会话跨度 6 小时、实际计算 73 分钟 |
| `reworkThreshold` | 3（均衡） | 同文件改 31 / 24 / 19 / 18 / 16 次 |
| `rereadThreshold` | 3（均衡） | 同文件读 60 / 56 / 31 次 |
| `waterLevelStep` | 50k（均衡） | 单步上下文中位 218k、峰值 627k；宿主压缩阈值 80 万从未触发 |
| `archiveThresholdChars` | 8192（均衡） | 与宿主 `tool-result-pruner` 同一个「太长」口径，避免两套阈值互相打架 |
| `archiveKeepChars` | 1200（均衡） | 首尾各半；归一化时强制 `2×keep ≤ threshold`，否则「归档」等于没省 |
| `taskBudgetMs` / `taskBudgetReplies` | 600000 / 30 | 评审建议的试验起点：每阶段 10 分钟或 30 次回复先到者**复盘**（不是自动成功/放弃） |
| `lockTtlMs` | 2min（均衡） | 4 个子代理共用一个部署目录 →「读数无法归属」 |

⚠ 这些数字是**在作者的机器上量出来的**，不一定是你机器上的最优值。所以三档之外还留了逐项自定义 —— 你按自己的会话日志调。

---

## 装它

它是 Laurel 套件的一部分，跟着套件一起装：

```bash
node scripts/install-profile.mjs     # 在 Laurel-Center 仓库根跑
```

只想单独装这一个：

```bash
cd <你的 Harness profile 目录>
pnpm add link:<仓库绝对路径>/packages/dsh-warden
```

然后把 `dsh-warden` 写进 profile 的 `package.json` → `dsh.profile.bundles`（或让 Laurel 总控台的开关去写）。

**完全退出 Harness 再打开**（右下角托盘也退掉），然后进「设置 → Laurel 套件 → 内耗护栏」。

---

## 系统层问题（插件治不了的）

护栏只能约束**协作方式**。下面这些是**权限、网络、路径**层面的，插件层绕不过去 —— 插件甚至**不应该**去绕（那等于把沙箱拆了）。所以这些必须在本机就地解决。

完整版（含可直接复制给 AI 的提示词）见 **[系统层问题与提示词.md](系统层问题与提示词.md)**。摘要：

| 症状 | 根因 | 怎么修 |
|---|---|---|
| `cannot read` / `cannot modify` / `cannot write` / `cannot edit` 大面积出现 | 沙箱档位（Workspace Write vs Full access）或目录 ACL 挡住了 | 确认沙箱档位；对**固定工作目录**预先授权，别整个盘一刀切 |
| `SetNamedSecurityInfoW failed (Win32 5)` | 改目录 ACL 需要管理员权限 | 用**管理员权限**对工作目录改一次 ACL；或把工作目录挪到已有写权限的位置 |
| WSL 文件走 `\\wsl.localhost\...` 又慢又被反复读 60 次 | 跨 UNC 路径访问，每次都要过一次协议栈 | 改用 **WSL 原生工作区**：bash 与读写都跑在发行版内，不要跨 UNC |
| 抓 `claude.com` / `platform.claude.com` / `developers.openai.com` 报 `cross-origin redirect` | 跨域跳转不自动跟随 | 用**能跟随跳转的抓取通道**（搜索桥 / 浏览器），别用裸 fetch |
| `DeepSeek search has no API key` | 搜索插件缺凭据，白试 5 次 | 补 key，或启用免费引擎自动回退 |
| `subagent depth 2 exceeds maxDepth 1` | 子代理想再开子代理 | 这是**保护机制**，别放开。改成让子代理把子任务回给父级 |

---

## 关于这个插件的一条设计纪律

**护栏坏掉时，它什么都不做。**

所有 IO 与所有钩子回调都各自吞异常。因为它在**每一次工具调用**的路径上 —— 一旦它抛出去，影响的是宿主里所有别的东西。所以：

- 路径挖不出来、锁读不到、工具名认不出 → 一律**放行**（宁可漏拦，不可误拦）；
- 配置读不出来 → 退回内置默认值继续跑；
- 台账写不进去 → 这一次没记上，不报错。

代价是有些故障是**静默**的。所以设置页「诊断」页签里放了**最近事件流**：它到底拦了什么、提醒了什么，全在那。

---

## 开发

```bash
npm run test:unit   # 单元与数据层，90 项，零依赖
npm run test:host   # 真实宿主契约验收，54 项 —— 需要本机官方运行件（见下）
npm test            # 两个都跑
# test:host 用 RUNTIME=<node_modules> 指定官方运行件路径，默认
# ~/projects/deepseek-harness-runtime/node_modules；
# 那份运行件已由 scripts/s1-runtime-identity.sh 核对与当前 app.asar 逐字节一致
npm run build     # 改过 lib/client/index.mjs 之后重建 lib/client.js
npm run build:check
```

`lib/client.js` 是**构建产物**，不要直接改。改 `lib/client/index.mjs`（设置页）或 `lib/client-kit.js`（与宿主通讯的 kit）。

⚠ 打包器的剥注释状态机**不处理模板串里嵌套模板串**（`` `${a ? `x${b}` : ''}` `` 会让它错判字符串边界）。所以源码里所有模板串的 `${}` 内只放标识符或简单表达式，要拼接就用 `+`。这条已经踩过一次，坏代码不会报错、只会在浏览器里炸。

---

## 许可

MIT，见 [LICENSE](LICENSE)。

## 参考与致谢

**只借机制与思路，实现全部自己写。** 没有抄任何开源插件的代码。

| 来源 | 借了什么 |
|---|---|
| DeepAgents（langchain-ai） | 工具输出先写 backend、再留预览与引用；失败保留原文 —— 本插件的大输出归档借的是这个机制，**不是** Claude Code 的「四层压缩」（那是服务端能力，无法佐证在 pre-step 改数组有效） |
| 官方 `dsh-tool-call-timeout-policy` | 等待上限的正确落点：在 `tools/execute` 上临时替换 `exec.signal` 加期限，`finally` 还原 |
| Claude Code `isolation: worktree` / Git worktree | **物理隔离优先于加锁**；只对真正没法隔离的资源（端口、数据库、全局开关）才加锁 |
| Anthropic 多智能体研究系统 | 子代理输出写文件、只回轻量引用（减少「传话游戏」式失真）；任务边界写死 |
| LangGraph Supervisor 模式 | worker 只回 Supervisor、彼此不互发 |
| OpenAI Agents SDK | handoff 后只有一个 active agent；guardrail 只允许放行/拒绝、不能改参数 |
| Temporal | 三层超时；幂等键 |
| DSH 社区插件（机制参考） | `dsh-turnscope` 的「漂移即拒」（台账指纹）、`dsh-wait-subagent` 的「阻塞等待必须带超时」、`dsh-agent-loop-guard` 的「故障关闭式循环防护」、`dsh-task-queue` 的 busy-lock |
