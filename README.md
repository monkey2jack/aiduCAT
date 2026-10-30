# aiduCAT☤爱嘟可爱糖 — Claude-code Agent Texting · 飞书泡波流式卡

<p align="center">
  <img src="docs/images/aidububble-banner.webp" alt="aiduCAT 爱嘟可爱糖 · 泡波横幅（aidu 家族同款）" width="100%">
</p>

> **aiduCAT = Claude-code Agent Texting ——一只住在飞书里的猫，随时替你敲代码**
>
> **提问在上方，过程收进一只小面板，结果由面板颜色说话。**
>
> 给 Claude Code / Codex CLI 穿上泡波流的飞书卡片：宣白纸面上灌一道深蓝流光，一只猫，零噪音。

[![Version](https://img.shields.io/badge/version-f0.2%2B%2B-blue.svg)](https://github.com/monkey2jack/aiduCAT)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20.12%2B-brightgreen.svg)](https://nodejs.org/)
[![Claude Code](https://img.shields.io/badge/agent-Claude%20Code%20%7C%20Codex-orange.svg)](https://docs.anthropic.com/en/docs/claude-code/quickstart)
[![aiduCAT](https://img.shields.io/badge/aiduCAT-Claude--code_Agent_Texting-1f4e79.svg)](https://github.com/monkey2jack/aiduCAT)

**中文** | **[📖 English](./README.en.md)**

<!-- distribution-policy: github-source-only -->
> **分发说明**：aiduCAT 不发 npm / PyPI 安装包，直接从本仓库源码运行（`npm install && npm run build`）。源码中的 `.bin` 入口仅用于本地开发与测试。

---

## aiduCAT 是什么？

**aiduCAT☤爱嘟可爱糖**，全称 **Claude-code Agent Texting**（Claude 代码代理短信/消息化），是给 **Claude Code / Codex CLI** 装上的一只飞书猫 —— 把本地编程 agent 的思考、工具调用和最终答案，实时装进一张仿 [aiduPOP](https://github.com/monkey2jack/aiduPOP) 泡波样式的飞书流式卡片。

aiduCAT 起源并致敬上游 [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)（npm 包 `lark-channel-bridge`），在MIT 协议的代码基础之上，做了一套完整的**泡波化改造**：

| 特性 | 说明 |
|------|------|
| 🫧 **单面板泡波样式** | 答案流式显示在上方；思考与全部工具调用收进一只折叠面板（aiduPOP 布局） |
| ☤ **单行计数头** | `模型 · 强度 · 25k/1M (2%) · 💭 n · 🛠️ n · ⏱️ ns · 状态词`——状态词（💭Reasoning/🛠️Tooling/☤aiduCATing）运行时殿后，结束消失，边框色说结果 |
| 🏷 **模型 Logo** | 29 家厂商标识（OpenAI/Gemini/Claude/Grok/DeepSeek/Qwen/Kimi/豆包/智谱…）随 `/model` 切换自动跟随，显示在面板头 |
| 🔌 **多 Provider** | /model 卡三级下拉（Provider→Model→Effort）一行排开；provider 密钥走环境变量链不入配置明文；切换下一轮即生效，无需重启；10router 系网关自动识别并只拉 curated combo |
| 👩🏻‍💻 **工具专属 emoji** | Bash👩🏻‍💻 Read👩🏻‍🏫 Edit👩🏻‍🔧 Write👩🏻‍🎨 Grep🕵🏻 Glob🥷🏻 Web👩🏻‍🚀 Agent👯🏻 —— 每类工具一个脸 |
| 🚦 **边框即状态** | 完成绿 / 停止黄 / 出错红 —— 一眼看清结果，无结尾注脚 |
| 🎹 **打字机反应** | 消息一落就打上敲键盘表情；真正开跑立刻消失，干净利落 |
| 🗣 **`/model` 自由切模型** | 免费 pass-through 任意 gateway combo id（如 `Gemini-3.8-Flash`），不做白名单收口 |
| 📝 **文案点菜单** | 全部展示文案列成 wiki 表格，按行点菜式定制 |

## 快速开始

```bash
git clone https://github.com/monkey2jack/aiduCAT.git
cd aiduCAT
npm install
npm run build

# 前台运行（首次启动扫码绑定 PersonalAgent 应用）
npm run dev -- run
```

需要 Node.js >= 20.12.0，且本机已装好 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/quickstart) 或 [Codex CLI](https://developers.openai.com/codex/cli)。

首次运行会做三件事：渲染绑定二维码 → 让你扫码并选择/创建 PersonalAgent 应用 → 把配置写入 `~/.lark-channel/config.json`。

## 常用命令

### 飞书内斜杠命令

| 命令 | 效果 |
|---|---|
| `/help` | 列出所有命令 |
| `/model` | 查看 / 切换模型（支持任意 gateway combo id；`/model default` 还原默认） |
| `/new` | 中断当前任务并开新会话 |
| `/stop` | 停止当前正在运行的任务 |
| `/timeout [N\|off]` | 设置会话空闲超时 |
| `/cd <path>` | 切换工作目录 |
| `/ws` | 管理命名工作区 |
| `/resume` | 恢复同会话历史 |
| `/status` | 显示运行状态 |
| `/config` | 调整展示偏好与访问策略 |

### 宿主机 CLI

```bash
aiduCAT run      # 前台运行
aiduCAT start    # 后台守护进程（launchd/systemd）
aiduCAT status
aiduCAT stop
aiduCAT ps
aiduCAT kill <id|#>
```

## 卡片长相

一张卡，三段式：

```
[模型长答案，流式打字]

┌────────────────────────────────────────┐
│ 💭Reasoning... · 💭 2 · 🛠️ 4 · ⏱️ 38s │  ← 标题首行：状态词+计数（结束状态词消失）
│ Gemini-3.8-Flash · Max · 25k/1M (2%)   │  ← 标题次行：模型 · 强度 · 上下文
└─────────────────────────────────────┘
```

- **运行中**：实时状态词（💭Reasoning... / 🛠️Tooling... / ☤aiduCATing...）落在面板标题首行最左；上排后接思考段数 / 工具数 / 已用时长，下排是模型 · 推理强度 · 实时上下文占用（`25k/1M (2%)`，每次 API 调用刷新）
- **展开面板**：🌊 开头的是思考文本；每个工具前是它的专属 emoji（👩🏻‍💻Bash 👩🏻‍🏫Read 👩🏻‍🔧Edit 👩🏻‍🎨Write 🕵🏻Grep 🥷🏻Glob 👩🏻‍🚀网络 👯🏻子agent 🤵🏻其他）
- **结束**：状态词消失，只剩计数头；**边框颜色说结果** —— 完成绿 / 停止黄 / 出错红


## 更新日志（f0.2+，2026-10-20）

- **修复：`/model` 切 Provider 后实际仍走默认网关**——provider 的 `ANTHROPIC_BASE_URL`/KEY 在 run-flow→executor→adapter 两层断链，现已打通（合并社区 PR [#1](https://github.com/monkey2jack/aiduCAT/pull/1)，感谢 @hermesai8888-creator）
- **修复：Provider 下拉选「默认网关」提交被静默丢弃**——表单哨兵值先归一化再校验
- **新增：Provider 静态模型清单与跨 Provider 并集下拉**（PR #1）；Provider 可选 `env` 覆写后台/子代理模型变量（PR #1）
- **新增：模型 id 支持 `/` `@`**（如 `cu/claude-opus-5-5`，PR #1）
- **新增：面板头厂商 logo**（29 家，外部部署需自查 README「模型 logo」小节上传自己租户的 img_key）
- **文档：补 README.zh.md、容器部署注意事项（见 issue [#2](https://github.com/monkey2jack/aiduCAT/issues/2)）、logo 上传指南**

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
- `contextWindow`: 上下文占用百分比表的分母

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
- `contextWindow`: **建议声明**。这是面板头「已用/总量 (x%)」占比与 60% 自动压缩触发的分母；不声明时 aiduCAT 会尝试从网关 `/v1/models` 读，仍拿不到则回落到 provider 声明值，都无效才不显示百分比（不影响对话本身）

**C. 本地推理（Ollama / llama.cpp / vLLM）**

同 B：网关地址填 `http://127.0.0.1:11434`（Ollama 需开 `OLLAMA_ORIGINS=*` 或用其 OpenAI 兼容层），`wire` 按协议填，`contextWindow` 按模型实际窗口声明（如 `qwen3:32b` 填 `40960`）。

**10router 用户与你的差异（仅两点，均为增强而非依赖）：**

| 能力 | 10router 用户 | 你的网关 |
|------|--------------|----------|
| `/model` 的 Model 下拉 | 自动拉 10router **策展 combo**（`/api/combos`，需管理 token） | 拉 `<baseUrl>/v1/models` 或用 `models` 静态清单 |
| 模型 logo | 有（29 家厂商图标） | 需自行上传一次 img_key（见下节），不传则面板头无图标，不影响对话

**合规提醒**：接任何第三方网关/免费池前，先确认其服务条款允许程序化调用；aiduCAT 不做也不支持绕过上游风控的接入。

### 模型 logo（面板头图标）

### 模型 logo（面板头图标）

面板头会显示模型厂商图标（OpenAI/Claude/Gemini 等 29 家）。飞书卡片 `custom_icon` 只认**本租户**上传图片的 `img_key`，外部 URL 会被飞书拒绝，因此仓库里的 `assets/lark-logo-keys.json` 只对上传过它们的那套飞书环境有效——**外部部署者需要自行上传一次并替换 key**：

1. 准备 29 张 128px 厂商 PNG（图标源：[lobehub icons-static-png](https://github.com/lobehub/lobe-icons)，建议 1.97.x）。命名对齐 `src/card/model-logo.ts` 里的 `VendorLogo` 枚举（`openai.png`、`claude.png`…）。
2. 用你的飞书应用凭证逐张调 `POST /open-apis/im/v1/images`（`image_type=message`）拿到 `img_key`。可用任意脚本/Postman 循环上传。
3. 把得到的 29 个 key 写成 JSON 覆盖 `assets/lark-logo-keys.json`（键名=VendorLogo 枚举值），重新 `pnpm build`。
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
