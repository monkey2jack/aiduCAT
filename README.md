# <b style="color:#000000">ai</b><b style="color:#525252">du</b><b style="color:#1F4E79">CAT</b>·<b style="color:#000000">爱</b><b style="color:#525252">嘟</b><b style="color:#1F4E79">妙咪飞</b> — Coding Agent Texting · 绝妙设计的迷人简洁飞书卡片

<p align="center">
  <img src="docs/images/aidububble-banner.webp" alt="aiduCAT 爱嘟妙咪飞 · 泡波横幅（aidu 家族同款）" width="100%">
</p>

> **爱嘟妙咪飞：妙（喵）+ 咪（猫）+ 飞（飞书）——绝妙设计的迷人简洁飞书卡片**
>
> **aiduCAT = Coding Agent Texting ——一只住在飞书里的猫，随时替你敲代码**
>
> **提问在上方，过程收进一只小面板，结果由面板颜色说话。**
>
> 给 Claude Code / Codex CLI / Hermes Agent 穿上泡波流的飞书卡片：宣白纸面上灌一道深蓝流光，一只猫，零噪音。

[![Version](https://img.shields.io/badge/version-f0.5%2B-blue.svg)](https://github.com/monkey2jack/aiduCAT)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20.12%2B-brightgreen.svg)](https://nodejs.org/)
[![Claude Code](https://img.shields.io/badge/agent-Claude%20Code%20%7C%20Codex%20%7C%20Hermes-orange.svg)](https://docs.anthropic.com/en/docs/claude-code/quickstart)
[![aiduCAT](https://img.shields.io/badge/aiduCAT-Claude--code_Agent_Texting-1f4e79.svg)](https://github.com/monkey2jack/aiduCAT)

**中文** | **[📖 English](./README.en.md)**

<!-- distribution-policy: github-source-only -->
> **分发说明**：aiduCAT 不发 npm / PyPI 安装包，直接从本仓库源码运行（`pnpm install --frozen-lockfile`，见下方「快速开始」）。`README.zh.md` 与本文件内容相同。

---

## aiduCAT 是什么？

**<b style="color:#000000">ai</b><b style="color:#525252">du</b><b style="color:#1F4E79">CAT</b>·<b style="color:#000000">爱</b><b style="color:#525252">嘟</b><b style="color:#1F4E79">妙咪飞</b>**，全称 **Coding Agent Texting**（编程代理短信/消息化），是给 **Claude Code / Codex CLI / Hermes Agent** 装上的一只飞书猫（按 profile 三选一，f0.4+ 起支持 Hermes） —— 把本地编程 agent 的思考、工具调用和最终答案，实时装进一张仿 [aiduPOP](https://github.com/monkey2jack/aiduPOP) 泡波样式的飞书流式卡片。

aiduCAT 起源并致敬上游 [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)（npm 包 `lark-channel-bridge`），在 MIT 协议的代码基础之上，做了一套完整的**泡波化改造**：

| 特性 | 说明 |
|------|------|
| 🤖 **三种 agent 三选一**（f0.4+） | 每个 profile 选 Claude Code、Codex CLI 或 Hermes Agent，同一套卡片、命令和白名单；见下方「Hermes Agent 接入」 |
| 🫧 **单面板泡波样式** | 答案流式显示在上方；思考与全部工具调用收进一只折叠面板（aiduPOP 布局） |
| 💭 **计数头** | 面板头：`模型 · 💭 思考段数 · 🛠️ 工具数 · ⏱️ 用时`；运行中面板正上方顶格多一行状态词（aiduCATing / Thinking / Running，后跟加载动效），结束即消失 |
| 🏷 **工具图标** | 面板头左侧显示当前 profile 用的编程工具图标（Claude Code / Codex / Hermes Agent），不看模型；模型名照常写在图标后面 |
| 🔌 **多 Provider** | /model 卡三级下拉（Provider→Model→Effort）；provider 密钥走环境变量链不入配置明文；切换下一轮即生效，无需重启；10router 系网关自动识别并只拉 curated combo |
| 🗜️ **按窗口自动压缩** | 上下文到模型窗口的 60%（`AIDUCAT_COMPACT_PCT`）自动压缩；窗口来自 10router combo（`/api/combos` 带窗口字段时）或 provider 的 `contextWindow`，都没有时 aiduCAT 不覆盖，沿用 Claude Code 自己 `settings.json` 的 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（f0.3.4 起不再拉 10router 的 `/v1/models` 全量模型表） |
| 🚦 **边框即状态** | 完成绿 / 停止黄 / 出错红 / 运行中灰 —— 一眼看清结果，无结尾注脚 |
| 🛟 **卡片被拒不卡死** | 图片 markdown 转链接、去 HTML、正文超 25KB 自动分成多张「续 i/N」卡片（按段落/代码块/表格边界切开）；飞书拒卡时自动降级（严格卡 → 纯文本 → 失败提示），不再停在「Thinking」 |
| ⏳ **aiduCATing… 占位卡** | 消息一落（还没开跑、在排队也一样）就出卡片，是一个只有一行「[工具图标] aiduCATing…」的面板；agent 第一次思考、调工具或出字时，面板头换成「[工具图标] 模型 · 计数」，面板正上方顶格出状态词，并继续流式；卡片模式不再加飞书表情（markdown/text 模式和 Codex 仍用表情）。⚡ TPS 只在 `/status` 显示（会话平均） |
| 🗣 **`/model` 自由切模型** | pass-through 任意 gateway combo id（如 `Gemini-3.8-Flash`），不做白名单收口 |

## 快速开始（从零安装）

前提：Node.js >= 20.12.0；本机已装好并能直接运行 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/quickstart)（或 [Codex CLI](https://developers.openai.com/codex/cli)、[Hermes Agent](https://github.com/NousResearch/hermes-agent)，Hermes 的接法见下方「Hermes Agent 接入」），模型网关已在其环境或 `~/.claude/settings.json` 里配好（如 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`）。

```bash
git clone https://github.com/monkey2jack/aiduCAT.git
cd aiduCAT
corepack enable                    # 启用 pnpm（或 npm i -g pnpm@10；也可用 npx --yes pnpm@10 代替下面的 pnpm）
pnpm install --frozen-lockfile     # 安装依赖（含 SDK 补丁），prepare 钩子会顺带 build 出 dist/
pnpm build                         # 改过代码后重新构建

# 前台运行（首次启动扫码绑定 PersonalAgent 应用）
node bin/lark-channel-bridge.mjs run
```

首次运行会做三件事：渲染绑定二维码 → 让你扫码并选择/创建 PersonalAgent 应用 → 把配置写入 `~/.aiducat/config.json`（f0.3+ 之前的机器沿用 `~/.lark-channel`，见下文「数据目录与迁移」）。

想直接敲 `aiduCAT …`：`pnpm setup` 后执行 `pnpm link --global`（或 `alias aiduCAT="node $PWD/bin/lark-channel-bridge.mjs"`）。入口文件名 `bin/lark-channel-bridge.mjs` 和服务名沿用上游命名；数据目录 f0.3+ 起改为 `~/.aiducat`，旧目录 `~/.lark-channel` 兼容读取，用 `aiduCAT migrate-home` 迁移。

可选环境变量（写在 bot 的服务环境里）：

| 变量 | 作用 |
|---|---|
| `AIDU_10ROUTER_URL` / `AIDU_10ROUTER_TOKEN` | 10router 地址与管理 token：`/model` 卡拉 combo 清单、查模型窗口（自动压缩与 `/status` 分母） |
| `AIDUCAT_COMPACT_PCT` | 自动压缩触发点占窗口的百分比，默认 `60` |

## Hermes Agent 接入（f0.4+）

aiduCAT 现在有三种 agent，**按 profile 三选一**：Claude Code、Codex CLI、[Hermes Agent](https://github.com/NousResearch/hermes-agent)。卡片、斜杠命令、白名单、群规则都一样，换的只是背后干活的那一个。一台机器可以同时跑几个 profile，各连各的飞书机器人。

### 怎么接

1. 装好 Hermes Agent，配好模型（`hermes setup` 或 `hermes model`），先在终端确认 `hermes chat -q "你好"` 能正常回答。
2. 建一个 Hermes profile 并启动：

```bash
aiduCAT profile create hermes --agent hermes   # 会把 hermes 的绝对路径记进配置
aiduCAT start --profile hermes                 # 后台服务；前台跑用 node bin/lark-channel-bridge.mjs run --profile hermes
```

3. 可选配置（`~/.aiducat/config.json` 里 `profiles.<名字>.hermes`）：

```json
{
  "hermes": {
    "binaryPath": "/home/me/.local/bin/hermes",
    "profile": "aiducat",
    "outsiderToolsets": ["todo", "web"]
  }
}
```

- `binaryPath`：`hermes` 命令的位置。Hermes 安装器把它放在 `~/.local/bin`，systemd 用户服务的 PATH 里常常没有，所以建 profile 时会记下绝对路径；也可以用环境变量 `LARK_CHANNEL_HERMES_BIN` 指定。
- `profile`：让 aiduCAT 用 Hermes 的哪个 profile（`hermes --profile <名字>`），不写就用 Hermes 自己的默认 profile。想让 aiduCAT 的会话、记忆和配置跟你平时用的 Hermes 分开，建议单独建一个。
- `outsiderToolsets`：其他人（非 owner）的轮次能用哪些工具集，只认 `todo` 和 `web`，写别的会被滤掉；不写 = 只有 `todo`。
- 模型：`/model` 填的模型 id 原样交给 `hermes chat -m`，由 Hermes 里配好的模型服务去认；`/model default` = 跟随 Hermes 自己的默认模型。`/model` 里给 Claude Code 配的 provider 密钥不会传给 Hermes。
- 功能开关 `features.hermes`（默认开）。

### 用起来是什么样（Hermes 0.22 实测）

- **每轮起一个 `hermes chat` 客户端**，消息从 stdin 送进去（不经过命令行参数和 shell），正文、工具调用、工具结果实时进卡片面板，这一轮结束客户端就退出。
- **Hermes 自带一个按需启动的后台进程**：从 Hermes 0.22 起，`hermes chat` 会把活交给本机一个 Hermes 后台进程（`hermes gateway run --idle-exit`，不连任何聊天平台），没有就自动拉起，空闲 600 秒（`gateway.unmanaged_idle_exit_seconds`）自己退出；实测常驻约 270–290 MB。这是 Hermes 自己的机制，不用另外装服务。第一轮要拉起它会慢一些，之后每轮只是起一个客户端。
- **/stop 只停卡片**：卡片立刻变黄结束，但 Hermes 后台会把已经接下的那一轮做完（比如正在跑的命令会跑完）。这是 Hermes 0.22 的设计（客户端断开后「accepted work continues」），aiduCAT 没法替它中途打断。
- **卡片没有思考段**：Hermes 的输出协议里没有思考内容。token 是整轮累计，所以 `/status` 不显示上下文占比；上下文压缩由 Hermes 按它自己的配置做。
- **owner 的轮次**：带 `--yolo`（飞书里没人能点 Hermes 的审批），能用 Hermes 的全部工具，工作目录就是这个聊天的工作目录（`/cd`、`/ws` 照常用）。
- **其他人的轮次**（群里别人 @、白名单用户、文档评论）：只给 `todo`（可加 `web`），并带 `--ignore-rules`，不加载 AGENTS.md、SOUL.md、记忆和技能；没有 terminal、文件、代码执行。原因：Hermes 的这些工具跑在 owner 自己的 Hermes 进程里、用 owner 的权限，没法像 Claude Code 那样套 bubblewrap 沙箱，所以干脆不给。传给 Hermes 的环境变量里也没有任何 provider 密钥和 `HERMES_*` 开关。
- **owner 和其他人各一份会话**：Hermes 建会话时会把模型、工具集、`--yolo` 这些参数定死，所以每个聊天存两份 Hermes 会话。外人看不到 owner 的对话；外人说完，owner 接着聊的还是自己那份。换模型会自动开新会话。
- `/status` 显示两份会话的 id 和「owner 全部（--yolo）/ 其他人 todo」；`/resume` 不列 Hermes 的历史（由 Hermes 自己保管），同一个聊天自动接着聊，`/new` 开新会话。
- 在 Hermes 那边用 `hermes sessions list --source tool` 能看到这些轮次；标题是 Hermes 按第一条消息自动起的，可能显示成「aiduCAT 运行约定…」，不影响使用。

### 网关式还是 bridge 式？（aiduPOP 和 aiduCAT 怎么选）

把 Hermes 接进飞书有两条路：

- **网关式**：Hermes 自己常驻一个消息网关，连飞书、管会话、跑定时任务；[aiduPOP](https://github.com/monkey2jack/aiduPOP) 是这个网关里的飞书泡波卡插件。
- **bridge 式**：aiduCAT 自己连飞书，每轮起一次 agent 命令行（`claude` / `codex` / `hermes chat`），agent 只管干活。

| | 网关式（Hermes 网关 + aiduPOP） | bridge 式（aiduCAT + Hermes） |
|---|---|---|
| 闲着时占资源 | Hermes 网关一直在 | aiduCAT（Node）一直在；Hermes 后台进程用到才起，空闲 600 秒退 |
| 每轮速度 | 网关常驻，没有起进程的开销 | 每轮多起一个 `hermes chat` 客户端；后台已在时开销小，冷启动那一轮会慢一些 |
| 定时任务 / 主动推送 / 多平台 | Hermes 原生支持（定时任务、主动发消息、Telegram / Discord / Slack 等） | 只做飞书里「你问它答」，没有主动推送，也不接别的平台 |
| 崩溃影响 | 所有渠道都在同一个网关进程里 | 一轮 agent 出问题只影响这一轮；飞书连接在 aiduCAT 里，和 agent 分开 |
| 统一维护 | 跟着 Hermes 的插件体系走 | 一套卡片、命令、白名单同时服务 Claude Code、Codex、Hermes，换 agent 不用换飞书机器人 |
| 外人隔离 | 按 Hermes 网关自己的用户白名单和权限 | 外人单独一份会话，只给 todo / web，不加载记忆和规则 |
| 审批 | 能在飞书卡片里点（aiduPOP 有原生确认卡和 clarify 选项卡） | 没有审批交互：owner 轮次 `--yolo`，外人轮次不给危险工具 |
| /stop | 由 Hermes 网关自己处理 | 只停卡片，Hermes 后台会把那一轮做完 |

**怎么选**：

- 主要用 Hermes，要定时任务、主动推送、多平台，或者想在卡片里点审批 → 用网关式（aiduPOP）。
- 已经在飞书里用 Claude Code / Codex，想再加一个 Hermes 且体验一致；或者群里有外人、要把外人和自己隔开；或者想一套东西统一维护 → 用 bridge 式（aiduCAT）。
- 两个可以一起用，各接一个飞书机器人。aiduPOP 继续维护，两者是互补关系，不是替代。

### 「agent 网关」和「模型网关」不是一回事

在 aiduCAT 里，Claude Code、Codex、Hermes 都**不经过任何 agent 网关**：aiduCAT 直接起它们的命令行（Hermes 0.22 的客户端再去连本机的 Hermes 后台进程，那是 Hermes 内部的事）。**模型网关**（比如 [10router](https://github.com/techysy/10router)）是另一层：它在 agent 后面，把模型请求转给各家模型服务。Claude Code 通过 `ANTHROPIC_BASE_URL` 连它，Hermes 通过自己 `config.yaml` 里的模型服务地址连它，用不用、用哪个都和 aiduCAT 无关。

## 常用命令

### 飞书内斜杠命令

| 命令 | 效果 |
|---|---|
| `/help` | 列出所有命令（下拉可直接执行） |
| `/new` | 中断当前任务并开新会话（沿用模型/强度）；`/new chat` 仅管理员 |
| `/reset` | 同 `/new` |
| `/stop` | 停止当前正在运行的任务；没有任务时回一句提示 |
| `/status` | 六行状态卡：会话 id、模型 · 强度 · 🗜️ 压缩点、权限/owner、lark-cli/运行/队列、🚩 会话开始时间 · 时长 · 消息数、⏳ 上下文与 token 统计 |
| `/model` | 查看 / 切换模型与推理强度（支持任意 gateway combo id；`/model default` 还原默认；非 Claude 模型标「经网关翻译」，不传强度）。**私聊里改的是默认；在群里改只影响这个群**（没单独设的群跟默认；`/model reset` 或卡片「恢复跟随默认」取消本群设置；`/status` 显示当前模型来自「本群设置」还是「跟随默认」）（管理员） |
| `/resume` | 列出并恢复本工作目录的历史会话 |
| `/cd <path>` | 切换工作目录（管理员；拒绝 `~/.ssh`、`~/.claude`、`~/.aiducat`、`~/.lark-channel`、`/etc` 等凭据/系统目录及其子目录） |
| `/ws` | 管理命名工作区：`list` / `save <name>` / `use <name>` / `remove <name>`（管理员） |
| `/config` | 偏好、访问控制与身份策略（管理员） |
| `/timeout [N\|off]` | 设置会话空闲超时 |
| `/account` | 查看 / 更换飞书应用凭据（管理员） |
| `/ps` | 列出本机所有 bot（管理员） |
| `/exit` | 关掉指定 bot（管理员） |
| `/reconnect` | 强制重连 WebSocket（管理员） |
| `/doctor` | 把日志交给 Agent 自助诊断（管理员） |
| `/invite` | 加入白名单：`user @某人` / `admin @某人` / `group` / `all group`（管理员） |
| `/remove` | 移出白名单：`user @某人` / `admin @某人` / `group`（管理员） |
| `/doc` | 云文档评论说明（在文档评论里 @bot 即可，无需绑定） |
| `/meeting` | 视频会议：`join <9位会议号>` / `leave` / `status` / `ask`（管理员） |

### 宿主机 CLI

```bash
aiduCAT run              # 前台运行
aiduCAT start            # 安装并启动后台服务（launchd / systemd / Windows 计划任务）
aiduCAT status
aiduCAT stop
aiduCAT restart
aiduCAT ps
aiduCAT kill <id|#>
aiduCAT ui               # 本地 web 控制台
aiduCAT migrate-home --dry-run   # 数据目录 ~/.lark-channel → ~/.aiducat（先停服务；去掉 --dry-run 正式迁移）
aiduCAT secrets set --app-id <id>
```

（未全局 link 时把 `aiduCAT` 换成 `node bin/lark-channel-bridge.mjs`。）

## 卡片长相

一张卡，从上到下：

```
[模型长答案，流式打字]

Thinking…                                            ← 运行中面板正上方顶格：状态词（aiduCATing / Thinking / Running），结束即消失
┌─                                               ─┐
│ [工具图标] Claude-Opus-4.6 · 💭 2 · 🛠️ 4 · ⏱️ 38s │  ← 折叠面板头：工具图标 · 模型 · 思考段数 · 工具数 · 用时
│ 💭 思考文本（最多 1500 字）                        │  ← 展开后
│ - 🖥️ **Bash** — pnpm test                         │
│ - 📖 **Read** — src/bot/channel.ts                │
└──────────────────────────────────────────────────┘
```

- **工具 emoji**：🖥️Bash 📖Read ⌨️Edit 📝Write 🔍Grep 🗂️Glob 🌐Web 🤖Agent/子代理 💻其他；工具多时只列最近的，其余折叠成「…另有 N 个」
- **结束**：状态词消失；**边框颜色说结果** —— 完成绿 / 停止黄 / 出错红；飞书会话列表预览显示 ✅Completed / ⭕️Stopped / ❌Failed / ⚠️Timed out
- **空跑**（agent 什么都没产出就退出）：直接显示红色报错卡和原因，提示重发
- **超长 / 被拒**：正文超 25KB 时，第 1 张卡显示到预算边界（在段落、代码块、表格边界切开，末尾「…（未完，见下一张卡）」），其余按顺序发「续 2/N」「续 3/N」卡片，markdown 正常渲染、每张 <30KB、内容不重复；超大代码块按行切开并重新开合代码围栏，超大表格按行切开并重复表头；只有续卡被飞书拒收时，该张起的剩余部分才改发一次纯文本。飞书拒收卡片时先用严格卡（无图片链接、正文 12KB）重试，再不行发纯文本，最后发一句「卡片发送失败」

## 更新日志（f0.5+）

- **插话**：Claude Code 干活时同一个人再发消息，不用等它跑完——它在下一步读到，接着手上的活往下干，不重来；原卡收尾「↪️Steered」，后面的进展写进新消息的卡片
- 嘟嘟不再「响应后撤回」（后台任务通知产生的空结果不再当成本轮结束）；进行中的状态词前面不再带符号

### f0.5

- **状态词带动效、更专业**：· 回来了，后面是飞书加载动效；进行中 aiduCATing / Thinking / Running，结束 Completed / Stopped / Failed / Timed out
- **社区贡献**：Windows 后台服务不再挂黑窗、多个 bot 开机全部自动上线、强杀后重启不再卡锁、「交互卡片」设置不再被静默降级（@alone-lon）；不再显示「No response requested.」（@iMissNan）
- 一张卡最多 5 个表格，多的进「续」卡

### f0.4++

- **卡片更简约**：面板图标按编程工具（Claude Code / Codex / Hermes Agent）显示，不再按模型猜厂商 logo（旧厂商 logo 全部删除）；· 去掉；Thinking… / Processing… 在面板正上方顶格
- 中文名「爱嘟妙咪飞」，英文全称 Coding Agent Texting

### f0.4+

- **Hermes Agent 成为第三种 agent**：`aiduCAT profile create <名字> --agent hermes`，按 profile 选 Claude Code / Codex / Hermes；owner 和其他人各一份 Hermes 会话，外人轮次只给 todo（可加 web）、不加载记忆和规则；/stop 只停卡片（Hermes 后台会把那一轮做完）。详见上方「Hermes Agent 接入」
- 并入 f0.4 发布后的修复：群「全员可用」（`/invite alluser`）、群里只有管理员能用斜杠命令、`/model` 按聊天单独配置、外人轮次在沙箱里能正常干活和上外网、`access.outsiderDenyRead` 额外封文件、两个服务同时启动不撞锁、非 owner 轮次报错不外露

### f0.4

- 收到消息立刻出一张卡，是一行面板「[工具图标] aiduCATing…」；agent 第一次思考、调工具或出字时，面板头出现计数，面板上方顶格出状态词；排队的消息各自一张卡，没用上的占位卡自动撤回；卡片模式不再加飞书表情
- 开跑更快：只拉 10router combo（不再拉 `/v1/models` 全量表），combo 列表后台刷新、启动预热
- 上下文窗口没有 combo 字段时跟 Claude Code 的 `settings.json` 走（如 1M）
- TPS 按每轮有效生成时间（扣掉工具时间）重算，只在 `/status` 显示，卡片上不再有 ⚡
- 群聊也用带面板的流式卡片，工具行默认隐藏，卡片里 @ 人是真 @
- 模型含 `aiduPARK` 显示专属翅膀图标；日志带毫秒耗时（`atMs` / `sinceMsgMs`）
- 一份代码可以用两个服务跑两个 `--profile`（各连各的飞书 app）

### f0.3+

- 新增 profile 级功能开关 `features`（会议 / Web 控制台 / Codex / CoT），关掉的模块不加载，命令在 `/help` 隐藏并回「此功能未开启」；默认全开
- 会议、CoT、Codex、Web 控制台改为按需加载，启动加载的代码减少约 46%
- `unrecognized_model` 提示每个模型只记一次
- 优雅重启：停服务时先等在途轮次跑完（`shutdownDrainMinutes`，默认 10 分钟）；被重启打断的轮次 10 分钟内自动「接着刚才的继续」一次
- 数据目录改为 `~/.aiducat`，`aiduCAT migrate-home [--dry-run]` 一键迁移，旧目录不动
- `settings.json` 里的 token 只给 owner 的轮次；启动时数据目录自收紧 0700/0600；`/cd` 可选白名单 `workspaces.roots`

完整明细见 [CHANGELOG.md](./CHANGELOG.md)。

## 会话与队列

- 每个私聊 / 群 / 话题 / 文档评论独立会话
- 快速连发的消息自动合并处理；运行中再来的消息进入队列，等这轮跑完作为下一轮输入
- **插话**（Claude Code 卡片模式）：运行中同一个人再发消息，直接交给正在跑的 Claude Code，它在下一步读到并接着干，不重来；原卡收尾为「↪️Steered」，后面的进展写进新消息的卡片。别人的消息、Codex / Hermes 照旧排队
- 会话历史本地持久化，`/resume` 恢复

## 运行时说明

### 按 profile 的服务与 CLI

守护进程为每个 PersonalAgent 应用安装一个**按 profile 的服务（per-profile service）**：macOS launchd `ai.lark-channel-bridge.bot.<profile>`、Linux systemd `lark-channel-bridge.bot.<profile>.service`、Windows 计划任务 `LarkChannelBridge.Bot.<profile>`（经 `.cmd` 包装启动）。宿主机 CLI 参考：

```bash
aiduCAT profile create claude --agent claude
aiduCAT profile create codex --agent codex
aiduCAT profile create hermes --agent hermes
aiduCAT profile list
aiduCAT profile use <name>
aiduCAT profile remove <name>            # 归档本地状态
aiduCAT profile remove <name> --purge --yes
aiduCAT profile export <name> [--output ./profile.json] [--force]
aiduCAT profile export <name> --include-secrets --yes
```

### 会话内访问控制

私聊无需 @；群与话题默认需要 `@bot`。直接在聊天里管理访问：

```text
/invite user @name     允许某用户私聊
/invite admin @name    添加访问控制管理员
/invite group          允许某个群
/invite all group      允许所有群
/invite alluser        当前群全员可用（开/关）
/remove user @name
/remove admin @name
/remove group
```

群在白名单还不够：群里发言的人本人也要在 allowedUsers / admins / owner 里——除非在该群发 `/invite alluser` 开了「全员可用」（写进 `access.chatAllowAllUsers`，只对已在白名单的群生效，再发一次关闭）；别的机器人默认被拒（bot-at-bot 要在 `access.allowedBots` 里显式写，且群在白名单）；team 模式只对 owner 同租户的人开放。卡片按钮点击按同一规则复核。回复里的 @所有人 会变成文字「@所有人」，不会真的 @全员。群里的回复和私聊一样是带折叠面板的流式卡片；面板里的工具行在群里默认隐藏，`preferences.showToolCallsInGroups: true` 才显示。

**群里只有 owner / 管理员能用斜杠命令**：其他人发的任何 `/` 开头的消息（`/help`、`/new`、`/stop` 这些，以及没注册的 `/xxx`，包括 `@机器人 /xxx`）都不执行、也不会交给 Claude Code / Codex（防止触发它们自带的斜杠命令）；@了机器人时回一句「群里只有管理员能用命令。」，没 @ 时不出声。卡片按钮在群里也按这条复核。私聊不变。

非 owner 的轮次（群里别人 @、白名单用户）在 Linux 上需要 bubblewrap：`sudo apt-get install -y bubblewrap socat`（没装时启动日志会 warn `bwrap-missing`，这类轮次的 Claude Code 起不来）。这类轮次带隔离（`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`）但能正常干活：Bash 在 Claude Code 的 bubblewrap 沙箱里跑，可以读写工作目录里的文件；读不到 settings.json（用户级和项目级 `.claude/settings*.json`）、`~/.ssh`、`~/.aiducat`、`~/.config/aiduCAT`、`~/.lark-cli`、`.env`、`/proc` 等放密钥的地方，环境变量里也没有密钥；工作目录的 `CLAUDE.md`、`.claude/`、`.mcp.json` 只读；沙箱里的 Bash 可以上外网（`curl`、`pip`、`npm` 等），但摸不到本机回环/内网地址（如 aiduMEI、网页控制台）；`git` 会听机器 `~/.gitconfig` 的 `http.proxy`，那是本机回环代理时沙箱里的 git 连不上。装了 containerd 的机器上（`/run/containerd` 是 0711），aiduCAT 会让这类轮次在一个私有挂载命名空间里起 Claude Code，把 `/run/containerd` 盖成空目录，绕开 bubblewrap 0.12 的 `Can't mkdir parents for /run/containerd/containerd.sock`（anthropics/claude-code#93144），**不改 `/run/containerd` 权限**（需要 util-linux 的 `unshare`、`setpriv`，Debian/Ubuntu 自带；主机禁止非特权用户命名空间时——如 Ubuntu 24.04 的 AppArmor 默认——自动不套这一层，日志 warn `runtime-dir-mask-unavailable`）。还能在 profile 里加 `access.outsiderDenyRead`（路径列表，绝对路径或 `~/…`，最后一段可带 `*` 顺带盖住备份，例如 `"~/.xiaohou/memory/服务器信息.md*"`）：这些路径在这类轮次里 Read 工具和沙箱 Bash（`cat`、`python` 等）都读不到；改完要重启该服务。不配 = 没有额外限制。owner 的轮次不受影响。agent 出错时群里只显示「暂时没法处理」，完整报错只进日志，只有 owner 私聊会看到一行简短原因。

### 云文档评论

Cloud-doc comments use the DM allowlist: 云文档评论与私聊同一白名单——只有 owner / allowedUsers / admins 在评论里 @ 机器人才会运行；评论运行权限封顶 `workspace`，文档正文和别人的回复按不可信内容交给 agent。

### lark-cli 身份策略（lark-cli identity policy）

每个 profile 使用 profile-local lark-cli directory：身份与凭据落在该 profile 自己的目录内。

每个 profile 使用独立的**当前 profile 的 lark-cli 目录**：`~/.aiducat/profiles/<profile>/lark-cli`。agent 进程会拿到指向该目录的 `LARKSUITE_CLI_CONFIG_DIR`，因此一个 profile 里的个人授权不会被另一个 profile 共享。默认策略 `bot-only`；`/config` 可把已授权用户切到 `user-default`。`/status` 显示摘要（`lark-cli: app` / `lark-cli: user-ready`）。

这套 **lark-cli 身份策略**是按 profile 隔离的，不是全局的。

只有 owner 本人发起的运行带 lark-cli 配置；其他人发起的运行（白名单用户私聊、群、评论、会议、会后纪要）完全不带 lark-cli 配置，并钉死 bot 身份。



### 多 Provider（多网关）配置

`/model` 卡支持三类下拉（Provider / Model / Effort）。默认网关走服务环境变量（`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`）；额外的 provider 写在 `~/.aiducat/config.json`（旧机器为 `~/.lark-channel/config.json`） 的 `profiles.<name>.modelProviders`：

```json
{
  "modelProviders": {
    "10r-jp": {
      "label": "10r 东京",
      "baseUrl": "https://your-gateway.example.com",
      "apiKey": "${MY_TOKYO_KEY}",
      "wire": "anthropic",
      "contextWindow": 1000000,
      "models": ["GLM-5.3-FlashX", "cu/claude-opus-5-5"],
      "env": { "ANTHROPIC_SMALL_FAST_MODEL": "GLM-5.3-Flash" }
    }
  },
  "defaultProviderName": "10r-US"
}
```

要点：
- `baseUrl` **不要带尾部 `/v1`**——Claude Code 会自动补 `/v1/messages`，带了会变成 `/v1/v1/messages` 触发网关风控
- `apiKey` 支持 `${ENV_VAR}` 模板、明文，或 env/file/exec 引用链
- `wire`: `anthropic`（Claude Code 系）或 `openai`（Codex 系）
- `models`: 静态清单（声明后 Model 下拉改为跨 provider 并集、按模型自动配 provider）；省略则实时拉该网关 `/v1/models`（10router 系自动只拉 curated combo）
- `env`: 切到该 provider 时附加覆写的环境变量（如后台小模型）
- `contextWindow`: 该 provider 的模型窗口，`/status` 上下文占比与 60% 自动压缩的分母

保存后无需重启，下一轮对话生效。

### 不用 10router？三步接入你自己的网关

aiduCAT 的默认示例以 [10router](https://github.com/techysy/10router) 系网关（combo 目录、`/api/combos` 策展清单）为例，但**它对网关没有任何硬依赖**——任何兼容 Anthropic Messages API（Claude Code 系）或 OpenAI Chat Completions API（Codex 系）的服务都能当后端。三类典型接法：

**A. 直连官方 API（最简）**

不配置任何 provider，直接给服务环境设官方端点：

```bash
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_API_KEY="sk-ant-..."
```

`/model` 下拉会走 Claude Code 原生模型列表；`/model default` 随时还原。

**B. 第三方聚合网关（one-api / new-api / CLIProxyAPI 等）**

在 `profiles.<name>.modelProviders` 加一个 provider（见上节 JSON 示例）：

- `wire`: 网关吐 Anthropic 协议填 `anthropic`，吐 OpenAI 协议填 `openai`
- `baseUrl`: 填到**端口根**（不带 `/v1`，Claude Code 自动补）
- `apiKey`: 建议用 `${MY_GATEWAY_KEY}` 环境变量模板，密钥不进配置文件
- `models`: 写你的网关实际提供的模型 id 清单；不写则启动时拉 `<baseUrl>/v1/models` 动态发现
- `contextWindow`: **建议声明**。这是 `/status` 上下文占比与 60% 自动压缩触发的分母；不声明时（且没配 10router）aiduCAT 不覆盖压缩点，沿用 Claude Code 自己 `settings.json` 里的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（不影响对话本身）

**C. 本地推理（Ollama / llama.cpp / vLLM）**

同 B：网关地址填 `http://127.0.0.1:11434`（Ollama 需开 `OLLAMA_ORIGINS=*` 或用其 OpenAI 兼容层），`wire` 按协议填，`contextWindow` 按模型实际窗口声明（如 `qwen3:32b` 填 `40960`）。

**10router 用户与你的差异（仅两点，均为增强而非依赖）：**

| 能力 | 10router 用户 | 你的网关 |
|------|--------------|----------|
| `/model` 的 Model 下拉 | 自动拉 10router **策展 combo**（`/api/combos`，需管理 token） | 拉 `<baseUrl>/v1/models` 或用 `models` 静态清单 |
| 工具图标 | 有（Claude Code / Codex / Hermes） | 需自行上传一次 img_key（见下节），不传则面板头无图标，不影响对话

**合规提醒**：接任何第三方网关/免费池前，先确认其服务条款允许程序化调用；aiduCAT 不做也不支持绕过上游风控的接入。

### 工具图标（面板头图标）

面板头最左侧显示当前 profile 的编程工具图标（`agentKind`：claude → Claude Code、codex → Codex、hermes → Hermes Agent），与模型无关，展开面板时不翻转；拿不到图标时右侧显示折叠箭头。飞书卡片 `custom_icon` 只认**本租户**上传图片的 `img_key`，外部 URL 会被飞书拒绝，因此仓库里的 `assets/lark-logo-keys.json` 只对上传过它们的那套飞书环境有效——**外部部署者需要自行上传一次并替换 key**：

1. 准备 3 张 128px PNG（图标源：[lobehub icons-static-png](https://github.com/lobehub/lobe-icons) 的 `claudecode-color`、`codex-color`、`hermesagent`）。
2. 用你的飞书应用凭证逐张调 `POST /open-apis/im/v1/images`（`image_type=message`）拿到 `img_key`。可用任意脚本/Postman 循环上传。
3. 把 key 写进 `assets/lark-logo-keys.json` 的 `claudecode`、`codex`、`hermes` 三个键，重新 `pnpm build`。
4. 没有上传时功能自动降级：面板头不显示图标，不影响任何主功能。

### 工作目录与工作区

每个 profile 可通过 `workspaces.default` 定义默认工作目录。`/cd` 切换当前目录并重置会话；`/ws` 保存并复用命名工作区（`/ws list`、`/ws save <name>`、`/ws use <name>`、`/ws remove <name>`）。工作目录只是 agent 的当前目录，不是文件系统沙箱 —— 实际文件访问仍取决于本地 agent 进程及其权限模式。

可选白名单 `workspaces.roots`（绝对路径或 `~/…`）：配了以后 `/cd`、`/ws use` 和会话的工作目录必须在其中某个目录下，否则回「这个目录不在允许的工作目录范围内」；黑名单照样生效，`workspaces.default` 不检查。不配 = 只有黑名单（默认）。

```json
{ "workspaces": { "default": "~/proj/main", "roots": ["~/proj", "/srv/work"] } }
```

### 权限（permissions）

访问由标准的 `"permissions"` 块控制。**不写 = `workspace`**；`full` 只能由 owner 在配置文件里显式写：

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full",
    "groupMaxAccess": "workspace"
  },
  "agentEnv": { "passthrough": ["AIDU_10ROUTER_URL", "SSH_AUTH_SOCK"] }
}
```

- 群聊运行封顶 `groupMaxAccess`（默认 `workspace`）；评论、会议、team 模式一律封顶 `workspace`；私聊不封顶。值可选 `full` / `workspace` / `read-only`。旧版 `sandbox` 配置键已不再读取（legacy `sandbox` keys are ignored）。
- agent 子进程的环境变量是白名单：PATH/HOME/LANG/LC_*/代理/证书，Claude 另给 `ANTHROPIC_*`/`CLAUDE_*`，Codex 另给 `OPENAI_*`/`CODEX_*`，Hermes 不额外给（它用自己 `~/.hermes/.env` 里的模型配置，只透传 `HERMES_HOME`）。服务环境里其他变量（如 `AIDU_10ROUTER_URL`、`SSH_AUTH_SOCK`）要在 `agentEnv.passthrough` 里显式放行。
- 群里默认不显示工具调用，`preferences.showToolCallsInGroups: true` 可打开。
- 超时：`preferences.runIdleTimeoutMinutes`（默认 15 分钟无输出即停）、`preferences.runToolTimeoutMinutes`（单个工具默认最长 30 分钟）。重启后 10 分钟内的排队消息会自动重放，更早的回一句「请重发」；在途卡片标「服务重启，请重发」。
- 优雅重启：收到停止信号后不接新轮次，先等在途轮次跑完，最多 `preferences.shutdownDrainMinutes` 分钟（默认 10，`0` = 立即停）；期间新消息记下，重启后自动处理。被打断的轮次若 10 分钟内重启完成，会在同一会话里自动发一次「（服务重启，接着刚才的继续）」，只续一次。systemd 单元需要 `KillMode=mixed` 和 `TimeoutStopSec=660`（`aiduCAT start` 安装的单元已自带，手写的要自己加）。
- 服务运行中也可以直接 `pnpm build`：构建先写到 `dist/.next`，新分块先就位、`dist/cli.js` 用原子改名替换，旧分块保留最近 3 次构建（`dist/.generations.json` 记录），所以正在跑的进程下一轮按需加载分块不会报错；新代码在重启后生效。稳妥起见仍建议升级时「先停 → 构建 → 再启动」。
- token 只给 owner：`~/.claude/settings.json` 里 `env` 的凭据（`GH_TOKEN`、`CLOUDFLARE_*` 等）只在 owner 发起的轮次里可用；别人发起的轮次会被置空（`ANTHROPIC_*`/`CLAUDE_*` 保留）。owner 体验不变。

### 数据目录与迁移（migrate-home）

- f0.3+ 起数据目录是 `~/.aiducat`。只有旧 `~/.lark-channel` 的机器照常用旧目录（启动时提示一行）；两个都在时用新的；`LARK_CHANNEL_HOME` 最优先。
- 迁移：先停服务 → `aiduCAT migrate-home --dry-run` 看计划 → `aiduCAT migrate-home`。会复制全部内容、改写配置里指向旧目录的路径、校验（含 keystore 在新位置能解密）后再改名到位；`~/.aiducat-workspaces` 链接到旧工作目录，会话照常续。**旧目录不动**，确认没问题后再手动删除。
- 启动时数据目录自动收紧为目录 0700、文件 0600。

### 功能开关（features）

不用的模块可以按 profile 关掉。不写 `features` = 全开；只有显式 `false` 才关：

```json
{
  "features": { "meeting": false, "webConsole": false, "codex": false, "cot": false, "hermes": false }
}
```

- 关掉的模块不加载（省启动内存），相关命令在 `/help` 里隐藏，调用时回「此功能未开启」。
- `"meeting"`：`/meeting`、会议推送与自动入会；`"webConsole"`：`run/start --web-ui`、`aiduCAT ui`、`/config` 里的控制台那一行；`"codex"`：Codex profile 与 Codex 会话历史；`"hermes"`：Hermes profile（关掉后 `agentKind: hermes` 的 profile 拒绝启动）；`"cot"`：CoT 过程消息与 `/config` 里的选项（偏好值保留）。
- 改完重启服务生效。

### 开发

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

## 致谢

- **上游**：[zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)（npm 包 `lark-channel-bridge` v0.7.1）
- **样式灵感**：[monkey2jack/aiduPOP](https://github.com/monkey2jack/aiduPOP) —— 泡波样式（Bubble Wave）设计语言起源
- **贡献者**：[@alone-lon](https://github.com/alone-lon) —— Windows 后台服务（[#7](https://github.com/monkey2jack/aiduCAT/pull/7)）、多 bot 自动上线与锁自愈（[#8](https://github.com/monkey2jack/aiduCAT/pull/8)）；[@iMissNan](https://github.com/iMissNan) —— 问题反馈（[#6](https://github.com/monkey2jack/aiduCAT/issues/6)）
- **定制**：aidu

---

<p align="center">
  <sub>用 💕 制作 by aidu</sub>
</p>

## License

[MIT](./LICENSE)
