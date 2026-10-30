# aiduCAT☤爱嘟可爱糖 — Claude-code Agent Texting · 飞书泡波流式卡

<p align="center">
  <img src="docs/images/aidububble-banner.webp" alt="aiduCAT 爱嘟可爱糖 · 泡波横幅（aidu 家族同款）" width="100%">
</p>

> **aiduCAT = Claude-code Agent Texting ——一只住在飞书里的猫，随时替你敲代码**
>
> **提问在上方，过程收进一只小面板，结果由面板颜色说话。**
>
> 给 Claude Code / Codex CLI 穿上泡波流的飞书卡片：宣白纸面上灌一道深蓝流光，一只猫，零噪音。

[![Version](https://img.shields.io/badge/version-f0.3.1-blue.svg)](https://github.com/monkey2jack/aiduCAT)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20.12%2B-brightgreen.svg)](https://nodejs.org/)
[![Claude Code](https://img.shields.io/badge/agent-Claude%20Code%20%7C%20Codex-orange.svg)](https://docs.anthropic.com/en/docs/claude-code/quickstart)
[![aiduCAT](https://img.shields.io/badge/aiduCAT-Claude--code_Agent_Texting-1f4e79.svg)](https://github.com/monkey2jack/aiduCAT)

**中文** | **[📖 English](./README.en.md)**

<!-- distribution-policy: github-source-only -->
> **分发说明**：aiduCAT 不发 npm / PyPI 安装包，直接从本仓库源码运行（`pnpm install --frozen-lockfile`，见下方「快速开始」）。`README.zh.md` 与本文件内容相同。

---

## aiduCAT 是什么？

**aiduCAT☤爱嘟可爱糖**，全称 **Claude-code Agent Texting**（Claude 代码代理短信/消息化），是给 **Claude Code / Codex CLI** 装上的一只飞书猫 —— 把本地编程 agent 的思考、工具调用和最终答案，实时装进一张仿 [aiduPOP](https://github.com/monkey2jack/aiduPOP) 泡波样式的飞书流式卡片。

aiduCAT 起源并致敬上游 [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)（npm 包 `lark-channel-bridge`），在 MIT 协议的代码基础之上，做了一套完整的**泡波化改造**：

| 特性 | 说明 |
|------|------|
| 🫧 **单面板泡波样式** | 答案流式显示在上方；思考与全部工具调用收进一只折叠面板（aiduPOP 布局） |
| ☤ **单行计数头** | 面板头一行：`模型 · 💭 思考段数 · 🛠️ 工具数 · ⏱️ 用时`；运行中的状态词（☤Thinking… / ☤Processing… / ☤aiduCATing…）在面板上方，结束即消失 |
| 🏷 **模型 Logo** | 30 家厂商标识（OpenAI/Gemini/Claude/Grok/DeepSeek/Qwen/Kimi/豆包/智谱…）随 `/model` 切换自动跟随，显示在面板头 |
| 🔌 **多 Provider** | /model 卡三级下拉（Provider→Model→Effort）；provider 密钥走环境变量链不入配置明文；切换下一轮即生效，无需重启；10router 系网关自动识别并只拉 curated combo |
| 🗜️ **按窗口自动压缩** | 上下文到模型窗口的 60%（`AIDUCAT_COMPACT_PCT`）自动压缩；窗口来自 10router `/v1/models` 或 provider 的 `contextWindow`，都拿不到时沿用 Claude Code 自己 `settings.json` 的设置并打 warn 日志 |
| 🚦 **边框即状态** | 完成绿 / 停止黄 / 出错红 / 运行中灰 —— 一眼看清结果，无结尾注脚 |
| 🛟 **卡片被拒不卡死** | 图片 markdown 转链接、去 HTML、正文超 25KB 截断并补发纯文本全文；飞书拒卡时自动降级（严格卡 → 纯文本 → 失败提示），不再停在「Thinking」 |
| 🎹 **打字机反应** | 消息一落就打上敲键盘表情；真正开跑立刻消失 |
| 🗣 **`/model` 自由切模型** | pass-through 任意 gateway combo id（如 `Gemini-3.8-Flash`），不做白名单收口 |

## 快速开始（从零安装）

前提：Node.js >= 20.12.0；本机已装好并能直接运行 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/quickstart)（或 [Codex CLI](https://developers.openai.com/codex/cli)），模型网关已在其环境或 `~/.claude/settings.json` 里配好（如 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`）。

```bash
git clone https://github.com/monkey2jack/aiduCAT.git
cd aiduCAT
corepack enable                    # 启用 pnpm（或 npm i -g pnpm@10；也可用 npx --yes pnpm@10 代替下面的 pnpm）
pnpm install --frozen-lockfile     # 安装依赖（含 SDK 补丁），prepare 钩子会顺带 build 出 dist/
pnpm build                         # 改过代码后重新构建

# 前台运行（首次启动扫码绑定 PersonalAgent 应用）
node bin/lark-channel-bridge.mjs run
```

首次运行会做三件事：渲染绑定二维码 → 让你扫码并选择/创建 PersonalAgent 应用 → 把配置写入 `~/.lark-channel/config.json`。

想直接敲 `aiduCAT …`：`pnpm setup` 后执行 `pnpm link --global`（或 `alias aiduCAT="node $PWD/bin/lark-channel-bridge.mjs"`）。入口文件名 `bin/lark-channel-bridge.mjs` 和数据目录 `~/.lark-channel` 沿用上游命名，暂未改名（改名需要迁移，见 CHANGELOG）。

可选环境变量（写在 bot 的服务环境里）：

| 变量 | 作用 |
|---|---|
| `AIDU_10ROUTER_URL` / `AIDU_10ROUTER_TOKEN` | 10router 地址与管理 token：`/model` 卡拉 combo 清单、查模型窗口（自动压缩与 `/status` 分母） |
| `AIDUCAT_COMPACT_PCT` | 自动压缩触发点占窗口的百分比，默认 `60` |

## 常用命令

### 飞书内斜杠命令

| 命令 | 效果 |
|---|---|
| `/help` | 列出所有命令（下拉可直接执行） |
| `/new` | 中断当前任务并开新会话（沿用模型/强度） |
| `/reset` | 同 `/new` |
| `/stop` | 停止当前正在运行的任务；没有任务时回一句提示 |
| `/status` | 六行状态卡：会话 id、模型 · 强度 · 🗜️ 压缩点、权限/owner、lark-cli/运行/队列、🚩 会话开始时间 · 时长 · 消息数、⏳ 上下文与 token 统计 |
| `/model` | 查看 / 切换模型与推理强度（支持任意 gateway combo id；`/model default` 还原默认） |
| `/resume` | 列出并恢复本工作目录的历史会话 |
| `/cd <path>` | 切换工作目录（管理员） |
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
aiduCAT secrets set --app-id <id>
```

（未全局 link 时把 `aiduCAT` 换成 `node bin/lark-channel-bridge.mjs`。）

## 卡片长相

一张卡，从上到下：

```
[模型长答案，流式打字]

☤Thinking…                                       ← 运行中的状态词（Thinking / Processing / aiduCATing），结束即消失
┌─ [logo] Claude-Opus-4.6 · 💭 2 · 🛠️ 4 · ⏱️ 38s ─┐  ← 折叠面板头：模型 · 思考段数 · 工具数 · 用时
│ 💭 思考文本（最多 1500 字）                        │  ← 展开后
│ - 🖥️ **Bash** — pnpm test                         │
│ - 📖 **Read** — src/bot/channel.ts                │
└──────────────────────────────────────────────────┘
```

- **工具 emoji**：🖥️Bash 📖Read ⌨️Edit 📝Write 🔍Grep 🗂️Glob 🌐Web 🤖Agent/子代理 💻其他；工具多时只列最近的，其余折叠成「…另有 N 个」
- **结束**：状态词消失；**边框颜色说结果** —— 完成绿 / 停止黄 / 出错红；飞书会话列表预览显示 ✅Done / ⭕️Stop / ❌Error / ⚠️Timeout
- **空跑**（agent 什么都没产出就退出）：直接显示红色报错卡和原因，提示重发
- **超长 / 被拒**：正文超 25KB 时卡内截断并补发纯文本全文；飞书拒收卡片时先用严格卡（无图片链接、正文 12KB）重试，再不行发纯文本，最后发一句「卡片发送失败」

## 更新日志（f0.3.1）

- 卡片被拒自动降级、答案清洗与 30KB 大小控制、SDK 节流更新不再 unhandledRejection、空跑保护真正生效、节流改 250ms
- `/status` 数字全部改为真实值（上下文 = input + cache，统计重启不清零，🚩 取 Claude 会话记录首条时间）
- 60% 自动压缩修复：10router 窗口改用 `AIDU_10ROUTER_TOKEN` 查询，查不到打 warn 并沿用 CLI `settings.json`
- `/help` 列全 20 个命令；提示文案统一为 `aiduCAT …`；删除约 300 行死代码

完整明细见 [CHANGELOG.md](./CHANGELOG.md)。

## 会话与队列

- 每个私聊 / 群 / 话题 / 文档评论独立会话
- 快速连发的消息自动合并处理；运行中再来的消息进入队列，等这轮跑完作为下一轮输入
- 会话历史本地持久化，`/resume` 恢复

## 运行时说明

### 按 profile 的服务与 CLI

守护进程为每个 PersonalAgent 应用安装一个**按 profile 的服务（per-profile service）**：macOS launchd `ai.lark-channel-bridge.bot.<profile>`、Linux systemd `lark-channel-bridge.bot.<profile>.service`、Windows 计划任务 `LarkChannelBridge.Bot.<profile>`（经 `.cmd` 包装启动）。宿主机 CLI 参考：

```bash
aiduCAT profile create claude --agent claude
aiduCAT profile create codex --agent codex
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
/remove user @name
/remove admin @name
/remove group
```

### 云文档评论

Cloud-doc comments are document-scoped: 云文档评论按文档权限生效（document-scoped）：评论触发的运行跟随文档本身的权限，而不是单独的访问闸门。在受支持的文档评论中 @ 机器人即可运行。

### lark-cli 身份策略（lark-cli identity policy）

每个 profile 使用 profile-local lark-cli directory：身份与凭据落在该 profile 自己的目录内。

每个 profile 使用独立的**当前 profile 的 lark-cli 目录**：`~/.lark-channel/profiles/<profile>/lark-cli`。agent 进程会拿到指向该目录的 `LARKSUITE_CLI_CONFIG_DIR`，因此一个 profile 里的个人授权不会被另一个 profile 共享。默认策略 `bot-only`；`/config` 可把已授权用户切到 `user-default`。`/status` 显示摘要（`lark-cli: app` / `lark-cli: user-ready`）。

这套 **lark-cli 身份策略**是按 profile 隔离的，不是全局的。



### 多 Provider（多网关）配置

`/model` 卡支持三类下拉（Provider / Model / Effort）。默认网关走服务环境变量（`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`）；额外的 provider 写在 `~/.lark-channel/config.json` 的 `profiles.<name>.modelProviders`：

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
- `contextWindow`: **建议声明**。这是 `/status` 上下文占比与 60% 自动压缩触发的分母；不声明时（且没配 10router）aiduCAT 不覆盖压缩点，沿用 Claude Code 自己 `settings.json` 里的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`，并在日志里打一条 warn（不影响对话本身）

**C. 本地推理（Ollama / llama.cpp / vLLM）**

同 B：网关地址填 `http://127.0.0.1:11434`（Ollama 需开 `OLLAMA_ORIGINS=*` 或用其 OpenAI 兼容层），`wire` 按协议填，`contextWindow` 按模型实际窗口声明（如 `qwen3:32b` 填 `40960`）。

**10router 用户与你的差异（仅两点，均为增强而非依赖）：**

| 能力 | 10router 用户 | 你的网关 |
|------|--------------|----------|
| `/model` 的 Model 下拉 | 自动拉 10router **策展 combo**（`/api/combos`，需管理 token） | 拉 `<baseUrl>/v1/models` 或用 `models` 静态清单 |
| 模型 logo | 有（30 家厂商图标） | 需自行上传一次 img_key（见下节），不传则面板头无图标，不影响对话

**合规提醒**：接任何第三方网关/免费池前，先确认其服务条款允许程序化调用；aiduCAT 不做也不支持绕过上游风控的接入。

### 模型 logo（面板头图标）

面板头会显示模型厂商图标（OpenAI/Claude/Gemini 等 30 家）。飞书卡片 `custom_icon` 只认**本租户**上传图片的 `img_key`，外部 URL 会被飞书拒绝，因此仓库里的 `assets/lark-logo-keys.json` 只对上传过它们的那套飞书环境有效——**外部部署者需要自行上传一次并替换 key**：

1. 准备 30 张 128px 厂商 PNG（图标源：[lobehub icons-static-png](https://github.com/lobehub/lobe-icons)，建议 1.97.x）。命名对齐 `src/card/model-logo.ts` 里的 `VendorLogo` 枚举（`openai.png`、`claude.png`…）。
2. 用你的飞书应用凭证逐张调 `POST /open-apis/im/v1/images`（`image_type=message`）拿到 `img_key`。可用任意脚本/Postman 循环上传。
3. 把得到的 30 个 key 写成 JSON 覆盖 `assets/lark-logo-keys.json`（键名=VendorLogo 枚举值），重新 `pnpm build`。
4. 没有上传时功能自动降级：面板头不显示图标，不影响任何主功能。

### 工作目录与工作区

每个 profile 可通过 `workspaces.default` 定义默认工作目录。`/cd` 切换当前目录并重置会话；`/ws` 保存并复用命名工作区（`/ws list`、`/ws save <name>`、`/ws use <name>`、`/ws remove <name>`）。工作目录只是 agent 的当前目录，不是文件系统沙箱 —— 实际文件访问仍取决于本地 agent 进程及其权限模式。

### 权限（permissions）

访问由标准的 `"permissions"` 块控制：

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

把任一值设为 `workspace` 或 `read-only` 可收紧 profile。旧版 `sandbox` 配置键已不再读取（legacy `sandbox` keys are ignored）。

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
- **定制**：aidu

---

<p align="center">
  <sub>用 💕 制作 by aidu</sub>
</p>

## License

[MIT](./LICENSE)
