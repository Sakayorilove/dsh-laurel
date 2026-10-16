# Laurel

给 DeepSeek Harness（DSH）补上**系统通知**：agent 有问题要问你、要你批准、或者干完了，弹一条 Windows 通知并响一声 —— 你切去看别的东西的时候也不会错过。

> Codex 那种「有问题想问你」的提示，DSH 本来没有。这个插件把它补上。
> 它不注入提示词、不注册工具、不主动说话：**只在 agent 需要你的时候响一声。**

```
┌────────────────────────────────────────┐
│  DSH · 把通知做成独立插件              │
│  有问题想问你：要现在动手改配置吗      │
└────────────────────────────────────────┘
```

## 它怎么工作（为什么它这么小）

DSH 客户端本来就有一份"每个会话现在什么状态"的权威数据：
`ctx.uiSession.sessionStatus`（由 `@deepseek-ai/dsh-client-ui-session` 提供），
快照形状是 `Map<sessionId, { running, pendingInteraction, completionUnread }>`。

插件只做一件事：订阅它，在两种"新发生的事"上弹通知。

| 触发 | 含义 | 默认 |
| --- | --- | --- |
| `pendingInteraction` 从空变成非空 | 有提问／计划确认（`kind: question` / `plan-review`）或审批（`kind: approval`）在等你 | 提问 ✅ 审批 ✅ |
| `running: true → false` | 这一回合跑完了 | ❌（长任务会响很多次） |

它**不去挂** `user-questions/request` 那类瀑布事件（那条链是"谁先注册谁先答"，
插件插进去有可能把官方的问题卡片顶掉）。读状态不抢答，跟别人的注册顺序无关。

## 安装

需要 DSH 0.1.7-rc 以上（用到了 `uiSession.sessionStatus`，更老的版本里没有）。

**从 GitHub 装**（推荐，别人也是这么装你的）：

1. 侧栏 **插件** 页 → 安装 → 填本模块目录的**绝对路径**（或用装载机统一管理，见仓库根 `README.md`）
2. 重启 DSH（bundle 列表是启动期输入，必须重启一次）

**从本地目录装**（改代码时用）：

1. 侧栏 **插件** 页 → 安装 → 填这个包的**绝对路径**，例如 `D:\path\to\Laurel`
2. 重启 DSH

**手动装**（等价做法，看得见每一步）：

```jsonc
// <profile>/package.json
{
  "dependencies": { "laurel": "link:D:/path/to/Laurel" },
  "dsh": { "profile": { "bundles": ["laurel"] } }
}
```

然后在该 profile 目录里装依赖、重启。

卸载：插件页里删掉即可（`disabled` 或移除 bundle 条目）。

## 配置

优先级：`cordis.patch.yml` 里的 config（默认值） **<** `$DSH_HOME/laurel/settings.json`（设置页写的）。

也就是说，设置页里改过的开关会盖掉 patch；删掉 `settings.json` 就回到默认值。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `notifyOnQuestion` | `true` | 提问时通知 |
| `notifyOnPlanReview` | `true` | 计划待确认时通知（与提问各有一个开关） |
| `notifyOnApproval` | `true` | 审批请求时通知 |
| `notifyOnCompletion` | `false` | 回合结束时通知 |
| `onlyWhenUnfocused` | `true` | 只在窗口没焦点（或被收进托盘）时弹。你正看着窗口时 DSH 自己就有提示 |
| `throttleSeconds` | `30` | 同一会话的最小间隔；另外还有一条固定的 2 秒全局底线 |
| `sound` | `true` | 提示音总开关（关掉 = 完全静音） |
| `soundFile` | `""` | 自定义提示音。留空 = Windows 系统通知音。见下面「换提示音」 |
| `sticky` | `true` | 提问／审批留在通知中心，直到你处理 |
| `title` | `""` | 标题前缀，留空 = 只用会话标题（拿不到就 `DSH`） |
| `maxBodyChars` | `140` | 正文最大字符数（超了截断） |
| `language` | `auto` | `auto` / `zh` / `en` |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error` |

设置页在 **设置 → 通知**，五块，从上到下：

| 区块 | 里面有什么 |
| --- | --- |
| 通知时机 | 三选一：只在窗口没在前台时（走系统通知）/ 只在窗口在前台时（走页内卡片）/ 两种都发 |
| 哪些事件要提醒我 | 一张表：四类事件 × 两条通路（系统通知 / 页内卡片），逐格勾。"提问"和"计划确认"在系统通知那一列共用一个格子 —— 配置里它们本来就是同一个键 |
| 系统通知（窗口没在前台时） | 提示音总开关、自定义提示音（输入框＋试听＋目录里已有音效的一键选择）、留在通知中心 |
| 页内卡片（窗口在前台时） | 卡片停留秒数、落在哪个角落 |
| 其他 | 同一会话最小间隔、标题前缀 |

底下是两个测试按钮（**测试通知**走系统通知那条路、**试页内卡片**走卡片那条路，各钉在自己那条通路上，不受「通知时机」和事件表影响）加一个**重新读取**（重新读配置、提示音目录和通知权限），
再往下是一块运行状态（页面来源、通知权限、订阅是否挂上、配置文件位置、最近 10 条事件）。

## 换提示音

三种写法，填在 **设置 → 通知 → 自定义提示音**（或 `soundFile` 配置项）：

| 写法 | 例子 | 说明 |
| --- | --- | --- |
| 文件名 | `ding.wav` | 指向 `$DSH_HOME/laurel/sounds/` 里的文件。这个目录在插件启动时会自动建好，里面有一份说明 |
| 绝对路径 | `C:/Windows/Media/Windows Notify Calendar.wav` | 直接用系统里已有的文件，不用拷过来 |
| http(s) 链接 | `https://example.com/ding.wav` | 交给浏览器直接播。离线不可用，且受页面 CSP 限制（没实测过能不能过） |

**设了自定义音之后，系统通知音会被自动静音**，避免两声叠在一起。总开关 `sound: false` 是彻底静音（不管填了什么）。

支持 `wav / mp3 / ogg / m4a / aac / flac / webm`。建议 0.5～2 秒、几十 KB 的小文件 —— 大文件第一次播会有一点延迟。

### 零下载：先用 Windows 自带的

`C:\Windows\Media\` 里就有一堆现成的，填绝对路径即可。这台机器上确实还有的几个：

| 文件 | 感觉 |
| --- | --- |
| `C:/Windows/Media/Windows Notify Calendar.wav` | 系统日历提醒那种，柔和、不烦人 |
| `C:/Windows/Media/Windows Notify Email.wav` | 邮件到达音，比日历的短 |
| `C:/Windows/Media/Windows Notify Messaging.wav` | 消息音，更"叮"一点 |
| `C:/Windows/Media/Windows Balloon.wav` | 老式气泡提示音 |
| `C:/Windows/Media/ding.wav` | 最短最干脆 |
| `C:/Windows/Media/chimes.wav` / `chord.wav` | 两声和弦，比 ding 明显 |
| `C:/Windows/Media/tada.wav` | 完成感很强 —— 适合配"回合结束"那一条 |
| `C:/Windows/Media/Windows Background.wav` | 低存在感，长时间挂着不烦 |

想直接试：设置页输入框里粘上路径 → 点「试听」，不用等真通知。

想用自己的音效：丢进提示音目录（设置页会显示它的绝对路径，点「重新读取」即可出现在列表里），或者在输入框里粘绝对路径。

## 排错（"为什么没响"）

每一次判定都会记一条事件，落盘在 `$DSH_HOME/laurel/events.log`
（默认 `C:\Users\<你>\.dsh\laurel\events.log`）。直接看最后几行：

```powershell
Get-Content "$env:USERPROFILE\.dsh\laurel\events.log" -Tail 10
```

或者问 HTTP 端点（DSH 在本地跑着的时候）：

```powershell
Invoke-RestMethod http://127.0.0.1:19387/laurel/status   # 配置 + 路径 + 最后一条事件
Invoke-RestMethod http://127.0.0.1:19387/laurel/events    # 最近事件
```

事件里的 `kind` 说明发生了什么：

| kind | 含义 |
| --- | --- |
| `watch` | 订阅挂上了（能触发通知） |
| `fire` | 通知弹了 |
| `sound` | 自定义提示音播了（事件里带 URL） |
| `shown` / `click` | 系统确认弹出 / 你点了它 |
| `warn` | 有意没弹：窗口有焦点、节流中、该类通知已关 |
| `error` | 弹不了：没有 Notification API、拿不到会话状态、订阅失败、提示音播不动 |

## 已知边界（说清楚，免得白等）

- **渲染进程活着才有通知。** 桌面版收进托盘 = 还活着，能响；但如果你是在浏览器里开
  `http://127.0.0.1:19387`，**关掉标签页就不响了**。
- **浏览器里第一次要授权。** 桌面壳对通知权限一律放行，不用管；浏览器里点一次设置页的
  「测试通知」按钮即可授权（权限默认是 `default`，必须由一次用户手势申请）。
- **"点通知把窗口从托盘拉出来"** 依赖 Electron 对系统通知点击的处理，没在所有环境实测过。
  插件在点击时还会调一次 `window.focus()`；如果你的环境里不生效，至少声音和通知中心还在。
- **自定义提示音在浏览器里可能被自动播放策略挡住**（Electron 窗口内一般不受限）。
  设置页的「试听」本身就是一次用户手势，所以试听能响、真实通知被挡的话，`events.log` 里会有
  一条 `error` 写着播放失败 —— 那就说明是策略问题，不是文件问题。
- **远程音效链接（http(s)）取决于页面 CSP**，这条没实测过；离线场景建议用本地文件。
- **自定义音效走的是插件自己的 HTTP 端点**（和设置页读数据同一条路）。桌面壳里媒体元素能不能
  吃 `dsh-app://` 协议的响应，得装上去才知道；真播不动的话 `events.log` 会有 `error`，
  退路是把音频改成 base64 内联喂给 `Audio`（改一处即可）。
- **只覆盖"agent 需要你"。** 它不是主动推送，agent 自己不会因此说话。

## 开发

```powershell
node tests/smoke-plugin.mjs   # 或 npm test
```

自检是"真跑"的：宿主半边会用假 ctx 真调 `apply()`、拿真 HTTP handler 发真请求体；
浏览器半边会把 `lib/client.js` 放进 `node:vm` 里执行，喂假的
`uiSession.sessionStatus` / `Notification` / `document`，断言什么时候该弹、什么时候不该弹。
零第三方依赖，只有 node 内置模块。

改了 `lib/client.js` 之后刷新页面就会用新 bundle（client-modules 按文件 mtime 生成
`rev`，浏览器拿到的 URL 会变）；改了宿主半边 `lib/index.js` 要重启。

## 结构

```
Laurel/
├── lib/index.js     宿主半边：配置的权威来源 + 事件回收 + HTTP 端点
├── lib/store.js     配置归一化、settings.json / events.log / sounds 读写、路由实现
├── lib/client.js    浏览器半边（CJS bundle）：订阅会话状态、弹通知、自定义提示音、设置页
├── cordis.patch.yml 挂进 profile 的那一层（只有相对路径）
└── tests/smoke-plugin.mjs
```

运行期数据都在 `$DSH_HOME/laurel/`：`settings.json`（设置页写的配置）、
`events.log`（事件流水）、`sounds/`（自定义提示音目录）。

HTTP 端点（同源，只读为主）：`GET /laurel/config`、`GET|POST /laurel/config`、
`GET /laurel/events`、`GET /laurel/sounds`（列目录）、`GET /laurel/sound?file=x.wav`（吐音频字节）、
`GET /laurel/status`。`/sound` 带 `file` 参数时只接受提示音目录里的**文件名**，不接受路径 ——
它不能被当成任意文件读取器。

## English quick start

`Laurel` adds Windows notifications to DSH: a toast (with sound) when the agent asks you a
question, requests approval, or finishes a turn. It subscribes to the client's own
`uiSession.sessionStatus` source — it never touches the question/approval waterfall, so it cannot
displace the official prompts.

Install: **Plugins** page → install, pointing at this module's directory, then restart DSH.
Configure in **Settings → Notifications** (or via `cordis.patch.yml` / `$DSH_HOME/laurel/settings.json`).
Custom sound: put a file in `$DSH_HOME/laurel/sounds/` and set `soundFile` to its name — or point
`soundFile` at any absolute path (e.g. `C:/Windows/Media/Windows Notify Calendar.wav`); a custom sound
mutes the system sound. Debug with `$DSH_HOME/laurel/events.log` or `GET /laurel/status`.

Known limits: notifications need a live renderer (closing the browser tab stops them), the first
browser notification requires a user gesture, and click-to-restore-from-tray depends on the
platform.

## License

MIT
