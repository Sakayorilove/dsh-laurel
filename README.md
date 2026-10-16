# Laurel 套件 · 给 DeepSeek Harness 的「功能管理」面板 + 五个功能插件

说人话:装上它,Harness 的设置里会多出一个**功能管理**面板,面板里五行开关,
分别控制五个小功能。每个功能都能单独开、单独关,也能单独更新 —— 不喜欢一个,关掉就行,不影响别的。

| 开关 | 它干什么 |
|---|---|
| **通知** | 你在忙别的窗口时,AI 有问题要问你、等你批准、或者干完了,弹一条 Windows 通知并响一声,不用一直盯着 |
| **Claude 主题** | 把界面换成暖黄的纸面配色 + 更适合阅读的正文排版。只改外观,不碰你的数据和别的插件 |
| **记忆与上下文** | 让 AI 跨会话记得事:本会话 → 本工作区 → 全局,三级范围;读别的项目需要你逐次授权。数据只存在你自己电脑上 |
| **内耗护栏** | 治「干等、串扰、返工」:给子代理的等待套上限、把结论赶去写文件、按文件计返工次数、上下文每长一段就提醒一次、共享目录加锁。三档预设(温和/均衡/严格)+ 逐项自定义 |
| **可视化规划模式** | 把一个大任务画成节点图,拆成能并行的小批次;方案要你**采纳并批准**才开工,做完有审计报告。体积大,默认关着 |

五个功能出厂**全是关的**——你想用哪个,自己打开。

---

## 装它(三步,照着做就行)

> **先说一句前提**:这套东西是「一个面板 + 五个插件」。在 Harness 看来是**六个包**,
> 所以要**一次把六个都装上**;只装面板那一个,面板里那六行会解析不到,点了没反应。

**第 1 步:拿到代码**

```bash
git clone https://github.com/Sakayorilove/dsh-laurel
```

(不想用命令行:在仓库页面点绿色的 `Code` → `Download ZIP`,解压到一个长期不动的目录。)

**第 2 步:把六个包装进你的 Harness**(Windows 侧,不是 WSL 里)

先确认两个前置能跑(`node -v` 要 ≥ 22.19;没装 pnpm 的话先 `npm i -g pnpm`):

```powershell
node -v
pnpm -v
```

打开 PowerShell,进到刚下载的文件夹,跑:

```powershell
node scripts/install-profile.mjs
```

它会自己找到你的 Harness profile,写好六个依赖、跑一次安装、再校验一遍;
**中途出错会整体回滚**,不会把你的环境弄坏。它只动这六个包,你其它的依赖一个都不碰。

几种情况:

| 情况 | 怎么办 |
|---|---|
| 找不到 profile,或找到**多个**候选 | 它会列出候选并停下,**不会猜**。把正确的那个显式传进去:<br>`node scripts/install-profile.mjs "C:\Users\<用户名>\.dsh\profiles\desktop"` |
| 只想校验,不想改任何东西 | `node scripts/install-profile.mjs --check` |
| 安装目录不在仓库里 | 加 `--center <目录>`,例如 `--center D:\Laurel-Center` |
| 机器上有**多份** pnpm(比如 Harness 客户端自带一份、全局又装了一份) | 版本不同可能把**整个 profile 的 lockfile 重写一遍**(profile 里往往还有别的插件)。指定用哪份,再照常跑:<br>`$env:LAUREL_PNPM = "C:\...\resources\runtime\pnpm\bin\pnpm.cjs"` |
| 缺 pnpm | 安装器会先报出来(退出码 5)再退出,**不会**改到一半停住 |

**第 3 步:完全退出 Harness,再打开**

注意是**完全退出**(右下角托盘也退掉),不是关窗口。然后进 **设置 → 功能管理**,把想要的功能打开。

开了之后:界面上能立刻看到的(主题、面板本身)**刷新一下页面**就生效;
需要重启才生效的(通知、记忆这类后台逻辑)会在提示里说明。

---

## 装完发现不对?

| 现象 | 多半是因为 |
|---|---|
| 面板里没有五行,或者点了开关没反应 | 只装了面板,没装五个模块 → 重跑第 2 步的安装命令 |
| 点某个开关,提示「操作未成功：XX:operation-error」 | 那个模块的包**还没装进 profile**(源码里有它、profile 里没有)。先**完全退出** Harness,重跑第 2 步的安装命令,再启动。界面上的提示会把宿主的原始报错带在括号里,一般能直接看出是哪个包 |
| 打开了但界面没变化 | 没有完全退出重开;或只刷新了页面但改的是后台半边 |
| 五个功能显示「已关闭」 | 这是出厂默认,自己在面板里打开就行 |
| 主题没生效 | 它有两道开关:功能管理里打开,「设置 → Claude 羊皮纸」里也要勾上 |
| 想让 Harness 回到装之前的样子 | `node scripts/install-profile.mjs --rollback` 回滚;`--uninstall` 移除六个依赖(两个命令都不用再传 profile 路径) |

**支持范围**:这套在 **DeepSeek Harness 桌面版 0.2.0-rc.2**(Windows + WSL2)上验证过。
更早或更新的版本没测过 —— 宿主升级后如果界面细节回退,通常是客户端类名变了,来提 Issue 就行。

---

## 给 AI 助手看的精确指令

> 你要让 AI 帮你装,把下面整段原样发给它。这一节是**机器可读版本**,保留了全部路径与参数。

```text
任务:在 Windows 上把 Laurel 套件装进 DeepSeek Harness。

前提(必须遵守):
- 本套件在宿主看来是六个直接依赖:laurel-center(装载机/面板) + laurel + dsh-claude-parchment
  + dsh-strata + dsh-warden + dsh-loom(五个模块)。只装 laurel-center 会导致它插入的其余六行解析不到。
- 改的是 Windows 的 profile,所以 pnpm 必须在 Windows 侧跑;
  不要在 WSL 里对 Windows profile 跑 pnpm(会写出 Windows 解析不了的链接)。
- 需要 Node ≥ 22.19 与可用的 pnpm(`pnpm -v` 能跑;没有就先 `npm i -g pnpm`)。
  缺 pnpm 时安装器会先报错退出(退出码 5),不会改到一半停住。

步骤:
1. 克隆仓库并进入目录:
   git clone https://github.com/Sakayorilove/dsh-laurel
   cd <仓库目录>
2. 跑安装事务(它会写六个依赖 → pnpm install → 校验,失败整体回滚):
   node scripts/install-profile.mjs
   # 它会自己找 profile;找不到或找到多个候选时它会列出来并停下,把正确的那个显式传进去:
   #   node scripts/install-profile.mjs "C:\Users\<用户名>\.dsh\profiles\desktop"
   # 安装目录不在仓库里时:  --center <仓库绝对路径>
   # 只校验不改动:  --check
   # 回滚:          --rollback
   # 卸载:          --uninstall
3. 校验装配(只读):
   node scripts/verify-installed.mjs
   期望:六个依赖的 realpath 分别落在 <仓库> 与 <仓库>/packages/<模块>,patch 六行、模块默认 disabled。
4. 告诉用户:完全退出 Harness 再打开,然后进「设置 → 功能管理」打开需要的功能。
   客户端半边刷新页面即生效;宿主半边(通知/记忆等)需要完全重启。

等价的手工做法(profile 的 package.json,六个都要有;放 dependencies 或 devDependencies 都行,
但**每个只能出现一处** —— 两段都有同一个名字时,后面那段会盖掉前面那段):
  "dependencies": {
    "laurel-center": "link:<仓库绝对路径>",
    "laurel": "link:<仓库绝对路径>/packages/laurel",
    "dsh-claude-parchment": "link:<仓库绝对路径>/packages/dsh-claude-parchment",
    "dsh-strata": "link:<仓库绝对路径>/packages/dsh-strata",
    "dsh-warden": "link:<仓库绝对路径>/packages/dsh-warden",
    "dsh-loom": "link:<仓库绝对路径>/packages/dsh-loom"
  }
  并确保 "dsh.profile.bundles" 里有 "laurel-center",且没有把六个模块另写成 bundle 行。

只读自检(不需要装任何依赖,克隆下来就能跑):
  node scripts/check.mjs            # 期望:通过 236 项,失败 0 项
  node scripts/integration-probe.mjs # 期望:通过 32 项
  node scripts/bootgraph-probe.mjs   # 期望:通过 37 项
  node scripts/module.mjs check      # 期望:0 问题

安装事务的隔离复现(需要 pnpm;在临时目录里跑真实的安装/迁移/卸载/回滚,**不碰任何真实 profile**):
  node scripts/install-probe.mjs     # 期望:全部场景通过(九个场景)

相关环境变量(可选):
  DSH_LOOM_WSL_USER              指定 WSL 用户(默认用该发行版的默认用户)
  DSH_LOOM_WSL_WORKTREE_BASE     指定 Loom 工作树的 WSL 侧基础目录
  LAUREL_CENTER_INSTALL          指定安装面目录(默认从 profile 推导)

不要做的事:
- 不要手改安装面里的文件(它由 node scripts/release.mjs 从源码生成)
- 不要手改构建产物 lib/client.js(改源码后跑 node scripts/build-client.mjs)
```

---

## 常见配置

- **通知提示音**：「设置 → 通知」里可以填一个 wav 文件的绝对路径；
  Windows 自带的在 `C:\Windows\Media\` 下,例如 `C:/Windows/Media/Windows Notify Calendar.wav`。
- **记忆数据**：存在 `$DSH_HOME/strata/memories.jsonl`,是**追加式**的——遗忘会追加一条事件,不删旧行,方便你以后核对。
- **Loom 的工作树**：默认放在插件自己的数据目录;想放到 WSL 里(更快)就设
  `DSH_LOOM_WSL_WORKTREE_BASE`,例如 `/home/<你的 WSL 用户>/projects/.dsh-loom`。

---

## 给开发者

```bash
node scripts/check.mjs              # 装载机离线自检(248 项,含全仓 JS 语法)
node scripts/integration-probe.mjs  # patch 组出 loader 树、开关语义
node scripts/bootgraph-probe.mjs    # boot graph 行、bundle id、inject 值域
node scripts/module.mjs check       # 五个模块的落点是否一致
node scripts/install-probe.mjs      # 安装事务的隔离复现(真实 pnpm,临时目录,需 pnpm)
node scripts/build-client.mjs       # 改了客户端源码后重建产物
node scripts/release.mjs --to <目录> # 从源码生成只含运行文件的安装面
```

上面几条里只有 `install-probe.mjs` 需要 pnpm(要真的建链接);其余克隆下来就能跑,不用装依赖。

CI 在 push 到 main 和每个 PR 上跑四个 job:

| job | 跑什么 |
|---|---|
| 离线门禁 | 上面那四条 + 客户端产物与源码一致(不需要装依赖) |
| 安装事务 | `install-probe.mjs`,真实 pnpm,隔离 profile |
| 模块测试 | 五个包各自的测试:通知、记忆、主题(含真实 Chromium 用例)、护栏(离线,零依赖)、Loom(含 tsc) |
| 宿主集成 | **手动触发**,需要一台装了 Harness 的自托管 runner,`--require-host` |

各模块自己的测试需要额外依赖,见 [CONTRIBUTING.md](CONTRIBUTING.md)。
⚠ 这四个 job 目前**还没有在 GitHub 上真正执行过**(仓库刚公开,CI 环境未验证);
本机已按同一组命令跑通,但别把它当成"已经绿了的徽章"。

| 文档 | 内容 |
|---|---|
| [MODULES.md](MODULES.md) | 装载机与模块的关系、单独更新、增删模块、标签约定 |
| [CHANGELOG.md](CHANGELOG.md) | 变化记录 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 环境、提交前必跑的检查、硬规矩 |
| [SECURITY.md](SECURITY.md) | 安全问题怎么报、各模块接触哪些数据 |
| [THIRD-PARTY.md](THIRD-PARTY.md) | 第三方接口与参考(不打包任何第三方运行时依赖) |
| [docs/PLUGIN-CONTRACT.md](docs/PLUGIN-CONTRACT.md) | 与 DSH 客户端模块系统的接线契约 |

## 许可

MIT,见 [LICENSE](LICENSE);每个模块的 `packages/<目录>/LICENSE` 同样保留。
