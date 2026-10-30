# aiduCAT☤爱嘟可爱糖 — Claude-code Agent Texting on Feishu

<p align="center">
  <img src="docs/images/aidububble-banner.webp" alt="aiduCAT 爱嘟可爱糖 · 泡波横幅（aidu 家族同款）" width="100%">
</p>

> **aiduCAT = Claude-code Agent Texting — a cat living inside Feishu, typing code for you**
>
> **Ask on top, process folded into one small panel, the result told by the panel's color.**
>
> Dress your Claude Code / Codex CLI in a Bubble-Wave Feishu card: deep-blue veins on paper white, one cat, zero noise.

[![Version](https://img.shields.io/badge/version-f0.2%2B%2B-blue.svg)](https://github.com/monkey2jack/aiduCAT)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20.12%2B-brightgreen.svg)](https://nodejs.org/)
[![Claude Code](https://img.shields.io/badge/agent-Claude%20Code%20%7C%20Codex-orange.svg)](https://docs.anthropic.com/en/docs/claude-code/quickstart)
[![aiduCAT](https://img.shields.io/badge/aiduCAT-Claude--code_Agent_Texting-1f4e79.svg)](https://github.com/monkey2jack/aiduCAT)

**[📖 中文](./README.md)** | **English**

<!-- distribution-policy: github-source-only -->
> **Distribution note**: aiduCAT is not published to npm / PyPI. Run it from this repository source (`npm install && npm run build`). The local `bin` entry is for development and testing only.

---

## What is aiduCAT?

**aiduCAT** = **Claude-code Agent Texting** — aiduCAT dresses **Claude Code / Codex CLI** as a Feishu cat — streaming your local coding agent's thinking, tool calls, and final answer into one Feishu card styled after the [aiduPOP](https://github.com/monkey2jack/aiduPOP) Bubble Wave look.

aiduCAT originates from and credits the upstream [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) (npm package `lark-channel-bridge`), an MIT-licensed project. On top of that code, aiduCAT adds a complete **Bubble Wave transformation**:

| Feature | Description |
|---------|-------------|
| 🫧 **Single Bubble panel** | The answer streams on top; thinking and all tool calls fold into one collapsible panel (aiduPOP layout) |
| ☤ **Two-line counter header** | Collapsed, the header reads `🌊 thinking · 🫧 tools · ✨ elapsed` over `model · effort · 25k/1M (2%)` — no caption text |
| 👩🏻‍💻 **Per-tool emoji** | Bash👩🏻‍💻 Read👩🏻‍🏫 Edit👩🏻‍🔧 Write👩🏻‍🎨 Grep🕵🏻 Glob🥷🏻 Web👩🏻‍🚀 Agent👯🏻 — one face per tool family |
| 🚦 **Border = status** | done green / stopped yellow / error red — read the result at a glance, no trailing notes |
| 🎹 **Typing reaction** | A Typing emoji lands on your message the moment it arrives, and vanishes as soon as real work starts |
| 🗣 **`/model` free switching** | Pass through any gateway combo id (e.g. `Gemini-3.8-Flash`) with no whitelist clamping |
| 📝 **Copywriting menu** | Every visible string is cataloged in a wiki table for à-la-carte customization |

## Quick start

```bash
git clone https://github.com/monkey2jack/aiduCAT.git
cd aiduCAT
npm install
npm run build

# Run in foreground (first run opens a QR binding wizard)
npm run dev -- run
```

Requires Node.js >= 20.12.0 and one local agent installed and logged in: [Claude Code](https://docs.anthropic.com/en/docs/claude-code/quickstart) or [Codex CLI](https://developers.openai.com/codex/cli).

The first run: renders a binding QR code → you scan and pick/create a PersonalAgent app → config is written to `~/.lark-channel/config.json`.

## Commands

### Slash commands inside Feishu / Lark

| Command | Effect |
|---|---|
| `/help` | List all commands |
| `/model` | Show / switch the model (any gateway combo id; `/model default` restores) |
| `/new` | Interrupt the current run and start a fresh session |
| `/stop` | Stop the current running task |
| `/timeout [N\|off]` | Set the session idle watchdog |
| `/cd <path>` | Switch the working directory |
| `/ws` | Manage named workspaces |
| `/resume` | Resume the same session history |
| `/status` | Show run state |
| `/config` | Adjust presentation preferences and access policy |

### Host CLI

```bash
aiduCAT run      # foreground
aiduCAT start    # background daemon (launchd/systemd)
aiduCAT status
aiduCAT stop
aiduCAT ps
aiduCAT kill <id|#>
```

## Card anatomy

One card, three parts:

```
[final answer, streamed]

🫧Poping…                                    ← live status line (above panel)
┌─────────────────────────────────────┐
│  2 · 🫧 4 · ✨ 38s                  │  ← header line 1: counters
│ Gemini-3.8-Flash · max · 25k/1M (2%) │  ← header line 2: model · effort · context
└─────────────────────────────────────┘
```

- **While running**: a live status word (🌊Waving… / 🫧Poping… / ☤aiduCATing…) rides on its own line above the panel; the two-line header shows thinking segments / tool count / elapsed time on top, model · effort · live context usage (`25k/1M (2%)`, refreshed per API call) below
- **Expanded panel**: thinking text is prefixed 🌊; each tool line carries its own emoji (👩🏻‍💻Bash 👩🏻‍🏫Read 👩🏻‍🔧Edit 👩🏻‍🎨Write 🕵🏻Grep 🥷🏻Glob 👩🏻‍🚀Web 👯🏻agent 🤵🏻other)
- **On completion**: the status word disappears; the **panel border carries the result** — done green / stopped yellow / error red


## Changelog (f0.2+, 2026-10-20)

- **Fix: /model provider switching never reached the gateway** — provider `ANTHROPIC_BASE_URL`/KEY broke at two layers (run-flow → executor → adapter); now wired through (community PR [#1](https://github.com/monkey2jack/aiduCAT/pull/1), thanks @hermesai8888-creator)
- **Fix: picking the default provider in the /model dropdown was silently dropped** — form sentinel normalized before validation
- **New: static provider model lists + union dropdown across providers** (PR #1); optional per-provider `env` overrides for haiku/subagents (PR #1)
- **New: model ids accept `/` and `@`** (e.g. `cu/claude-opus-5-5`, PR #1)
- **New: vendor logos in the panel header** (29 vendors; external deployments upload their own tenant keys — see the "Model logos" section)
- **Docs: added README.zh.md, container deployment notes (issue [#2](https://github.com/monkey2jack/aiduCAT/issues/2)), logo upload guide**

Full details in [CHANGELOG.md](./CHANGELOG.md).
## Sessions and queueing

- Each DM / group / topic / doc-comment thread keeps its own session
- Messages sent in quick succession merge into one batch; messages sent during a run queue up as the next turn
- Session history persists locally; `/resume` restores it

## Runtime notes

### Per-profile service and CLI

The daemon installs one **per-profile service** per PersonalAgent app: macOS launchd `ai.lark-channel-bridge.bot.<profile>`, Linux systemd `lark-channel-bridge.bot.<profile>.service`, Windows Task Scheduler `LarkChannelBridge.Bot.<profile>` via a `.cmd` wrapper. Host CLI reference:

```bash
aiduCAT profile create claude --agent claude
aiduCAT profile create codex --agent codex
aiduCAT profile list
aiduCAT profile use <name>
aiduCAT profile remove <name>            # archive local state
aiduCAT profile remove <name> --purge --yes
aiduCAT profile export <name> [--output ./profile.json] [--force]
aiduCAT profile export <name> --include-secrets --yes
```

### Access control in chat

DMs do not require an @ mention; groups and topics require `@bot` by default. Manage access from chat itself:

```text
/invite user @name     allow a user in DMs
/invite admin @name    add an access-control admin
/invite group          allow a group
/invite all group      allow all groups
/remove user @name
/remove admin @name
/remove group
```

### Cloud-doc comments

Cloud-doc comments are document-scoped: a comment run follows the document's own permissions rather than a separate access gate. Mention the bot in a supported doc's comment to run.

### lark-cli identity policy

Each profile uses a profile-local lark-cli directory at `~/.lark-channel/profiles/<profile>/lark-cli`. The agent process receives `LARKSUITE_CLI_CONFIG_DIR` for that directory, so personal authorization in one profile is never shared with another. The default policy is `bot-only`; `/config` can switch an authorized user to `user-default`. `/status` shows the summary (`lark-cli: app` / `lark-cli: user-ready`).

This **lark-cli identity policy** is per profile, not global.



### Multi-provider setup

The `/model` card offers three dropdowns (Provider / Model / Effort). The default gateway comes from service env (`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`); extra providers live in `~/.lark-channel/config.json` under `profiles.<name>.modelProviders`:

```json
{
  "modelProviders": {
    "10r-jp": {
      "label": "10r Tokyo",
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

Notes:
- `baseUrl` must **not** end with `/v1` — Claude Code appends `/v1/messages` itself; a trailing `/v1` produces `/v1/v1/messages` and trips gateway WAFs
- `apiKey` accepts `${ENV_VAR}` templates, plaintext, or env/file/exec ref chains
- `wire`: `anthropic` (Claude Code) or `openai` (Codex)
- `models`: static list (declared = the Model dropdown becomes a cross-provider union and the provider follows the model); omitted = live `/v1/models` pull (10router-family hosts automatically return only the curated combos)
- `env`: extra environment overrides applied when this provider is selected (e.g. haiku-model vars)
- `contextWindow`: denominator of the ctx % meter

Takes effect next turn; no restart needed.
### Not on 10router? Plug in your own gateway in three steps

aiduCAT's examples default to a [10router](https://github.com/techysy/10router)-style gateway (curated combos, `/api/combos`), but **nothing in aiduCAT hard-depends on it** — any service speaking the Anthropic Messages API (Claude Code family) or the OpenAI Chat Completions API (Codex family) works as a backend. Three typical setups:

**A. Direct official API (simplest)**

Configure no provider at all; set the official endpoint in the service environment:

```bash
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_API_KEY="sk-ant-..."
```

The `/model` dropdown falls back to Claude Code's native model list; `/model default` restores it anytime.

**B. Third-party aggregation gateways (one-api / new-api / CLIProxyAPI, etc.)**

Add a provider under `profiles.<name>.modelProviders` (see the JSON example above):

- `wire`: use `anthropic` if the gateway speaks the Anthropic protocol, `openai` for OpenAI-compatible
- `baseUrl`: up to the **port root** (no trailing `/v1` — Claude Code appends it, doubling it trips gateway WAFs)
- `apiKey`: prefer the `${MY_GATEWAY_KEY}` env template; keep secrets out of config files
- `models`: list the model ids your gateway actually serves; omit it and aiduCAT discovers via `<baseUrl>/v1/models` at startup
- `contextWindow`: **declared it if you can** — it is the denominator of the panel's context-usage readout and the 60% auto-compact trigger. Without it, aiduCAT tries the gateway's `/v1/models`, then the provider's declared value; if none is found the percentage is simply hidden (conversation itself is unaffected)

**C. Local inference (Ollama / llama.cpp / vLLM)**

Same as B: point `baseUrl` at `http://127.0.0.1:11434` (Ollama: enable its OpenAI-compatible endpoint), pick `wire` per protocol, and declare `contextWindow` to match the loaded model (e.g. `40960` for `qwen3:32b`).

**How 10router users differ (two enhancements, not dependencies):**

| Capability | 10router users | Your gateway |
|------|--------------|----------|
| `/model` dropdown | pulls 10router's **curated combos** (`/api/combos`, management token) | pulls `<baseUrl>/v1/models` or uses the static `models` list |
| Model logos | shipped (29 vendor icons) | upload your own tenant img_keys once (next section); without them the panel simply shows no icon |

**Compliance note**: before pointing aiduCAT at any third-party gateway or free pool, make sure its terms of service allow programmatic access. aiduCAT does not and will not bypass upstream anti-abuse controls.

### Model logos (panel header icon)

The panel header shows a vendor icon (OpenAI/Claude/Gemini, 29 vendors). Feishu cards reject external image URLs for `custom_icon` — they only render `img_key` values from images uploaded **to your own tenant** via `POST /open-apis/im/v1/images`. The shipped `assets/lark-logo-keys.json` is only valid for the tenant that uploaded them. For your own deployment:

1. Prepare 29 vendor PNGs at 128px (icons: [lobehub icons-static-png](https://github.com/lobehub/lobe-icons), ~1.97.x), named after the `VendorLogo` union in `src/card/model-logo.ts` (`openai.png`, `claude.png`, ...).
2. Upload each via the im/v1/images API with your app credentials and collect the returned `img_key`s.
3. Overwrite `assets/lark-logo-keys.json` with your key map and rebuild (`pnpm build`).
4. Without an upload the feature degrades gracefully: the header simply renders without an icon; no core functionality is affected.

### Working directories

Each profile may define a default workspace through `workspaces.default`. `/cd` switches the current directory and resets the session; `/ws` saves and reuses named workspaces (`/ws list`, `/ws save <name>`, `/ws use <name>`, `/ws remove <name>`). The directory is the agent's current working directory, not a filesystem sandbox — file access still depends on the local agent process and its permission mode.

### Permissions

Access is controlled by the canonical `"permissions"` block:

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

Set either value to `workspace` or `read-only` to tighten a profile. The legacy `sandbox` config keys are no longer read.

### Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

## Credits

- **Upstream**: [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) (npm package `lark-channel-bridge` v0.7.1)
- **Style inspiration**: [monkey2jack/aiduPOP](https://github.com/monkey2jack/aiduPOP) — origin of the Bubble Wave design language
- **Customization**: aidu

---

<p align="center">
  <sub>Made with 💕 by aidu</sub>
</p>

## License

[MIT](./LICENSE)
