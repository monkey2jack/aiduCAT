# aiduCAT☤爱嘟可爱糖 — Claude-code Agent Texting on Feishu

<p align="center">
  <img src="docs/images/aidububble-banner.webp" alt="aiduCAT 爱嘟可爱糖 · 泡波横幅（aidu 家族同款）" width="100%">
</p>

> **aiduCAT = Claude-code Agent Texting — a cat living inside Feishu, typing code for you**
>
> **Ask on top, process folded into one small panel, the result told by the panel's color.**
>
> Dress your Claude Code / Codex CLI in a Bubble-Wave Feishu card: deep-blue veins on paper white, one cat, zero noise.

[![Version](https://img.shields.io/badge/version-f0.3.1-blue.svg)](https://github.com/monkey2jack/aiduCAT)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20.12%2B-brightgreen.svg)](https://nodejs.org/)
[![Claude Code](https://img.shields.io/badge/agent-Claude%20Code%20%7C%20Codex-orange.svg)](https://docs.anthropic.com/en/docs/claude-code/quickstart)
[![aiduCAT](https://img.shields.io/badge/aiduCAT-Claude--code_Agent_Texting-1f4e79.svg)](https://github.com/monkey2jack/aiduCAT)

**[📖 中文](./README.md)** | **English**

<!-- distribution-policy: github-source-only -->
> **Distribution note**: aiduCAT is not published to npm / PyPI. Run it from this repository source (`pnpm install --frozen-lockfile`, see Quick start).

---

## What is aiduCAT?

**aiduCAT☤爱嘟可爱糖** — **Claude-code Agent Texting** — is a Feishu cat for **Claude Code / Codex CLI**: it streams your local coding agent's thinking, tool calls and final answer into a single Feishu card styled after [aiduPOP](https://github.com/monkey2jack/aiduPOP)'s Bubble Wave.

aiduCAT originates from and credits the upstream [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) (npm package `lark-channel-bridge`), an MIT-licensed project. On top of that code, aiduCAT adds a complete **Bubble Wave transformation**:

| Feature | What it does |
|------|------|
| 🫧 **Single Bubble-Wave panel** | The answer streams on top; thinking and every tool call fold into one collapsible panel (aiduPOP layout) |
| ☤ **One-line counter header** | Panel header: `model · 💭 thinking segments · 🛠️ tools · ⏱️ elapsed`; the live status word (☤Thinking… / ☤Processing… / ☤aiduCATing…) sits above the panel and disappears on completion |
| 🏷 **Model logos** | 30 vendor marks (OpenAI/Gemini/Claude/Grok/DeepSeek/Qwen/Kimi/Doubao/Zhipu…) follow `/model` and show in the panel header |
| 🔌 **Multi-provider** | `/model` card with Provider → Model → Effort dropdowns; provider keys resolve from env/secret refs, never plaintext; takes effect next turn without restart; 10router gateways only offer curated combos |
| 🗜️ **Window-based auto-compact** | Compacts at 60% of the model window (`AIDUCAT_COMPACT_PCT`); the window comes from 10router `/v1/models` or the provider's `contextWindow`; when neither is available the Claude Code `settings.json` value is kept and a warn is logged |
| 🚦 **Border = status** | done green / stopped yellow / error red / running grey — no trailing notes |
| 🛟 **Rejected cards never hang** | Image markdown becomes links, HTML is stripped, answers over 25KB are truncated in the card and sent in full as plain text; if Feishu rejects the card it degrades (strict card → plain text → failure notice) instead of sticking on "Thinking" |
| 🎹 **Typing reaction** | A keyboard reaction lands on your message and disappears as soon as output starts |
| 🗣 **Free-form `/model`** | Passes any gateway combo id through (e.g. `Gemini-3.8-Flash`), no allow-list |

## Quick start (from scratch)

Prerequisites: Node.js >= 20.12.0, and a working [Claude Code](https://docs.anthropic.com/en/docs/claude-code/quickstart) (or [Codex CLI](https://developers.openai.com/codex/cli)) whose model gateway is already configured in its env or `~/.claude/settings.json` (e.g. `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`).

```bash
git clone https://github.com/monkey2jack/aiduCAT.git
cd aiduCAT
corepack enable                    # enables pnpm (or npm i -g pnpm@10; or use npx --yes pnpm@10 instead of pnpm)
pnpm install --frozen-lockfile     # installs deps (incl. the SDK patch); the prepare hook also builds dist/
pnpm build                         # rebuild after code changes

# Run in foreground (first run opens a QR binding wizard)
node bin/lark-channel-bridge.mjs run
```

The first run renders a binding QR code, lets you scan and pick/create a PersonalAgent app, then writes `~/.lark-channel/config.json`.

To type `aiduCAT …` directly: run `pnpm setup`, then `pnpm link --global` (or `alias aiduCAT="node $PWD/bin/lark-channel-bridge.mjs"`). The entry file `bin/lark-channel-bridge.mjs` and the data dir `~/.lark-channel` keep the upstream names for now (renaming needs a migration, see CHANGELOG).

Optional environment variables (in the bot's service environment):

| Variable | Purpose |
|---|---|
| `AIDU_10ROUTER_URL` / `AIDU_10ROUTER_TOKEN` | 10router URL + management token: `/model` combo list and model-window lookup (auto-compact and the `/status` denominator) |
| `AIDUCAT_COMPACT_PCT` | Auto-compact trigger as % of the window, default `60` |

## Commands

### Slash commands inside Feishu / Lark

| Command | Effect |
|---|---|
| `/help` | List every command (the dropdown runs one directly) |
| `/new` | Stop the current task and start a new session (keeps model/effort); `/new chat` is admin-only |
| `/reset` | Same as `/new` |
| `/stop` | Stop the running task; says so when nothing is running |
| `/status` | Six-line status card: session id, model · effort · 🗜️ compact point, permissions/owner, lark-cli/run/queue, 🚩 session start · age · message counts, ⏳ context and token stats |
| `/model` | Show / switch model and reasoning effort (any gateway combo id; `/model default` restores; non-Claude models are marked "translated by gateway" and get no effort flag) (admin) |
| `/resume` | List and resume past sessions for this working directory |
| `/cd <path>` | Switch working directory (admin; refuses credential/system dirs such as `~/.ssh`, `~/.claude`, `~/.lark-channel`, `/etc`, including subtrees) |
| `/ws` | Named workspaces: `list` / `save <name>` / `use <name>` / `remove <name>` (admin) |
| `/config` | Preferences, access control and identity policy (admin) |
| `/timeout [N\|off]` | Session idle timeout |
| `/account` | Show / replace the Feishu app credentials (admin) |
| `/ps` | List every bot on this machine (admin) |
| `/exit` | Stop a given bot (admin) |
| `/reconnect` | Force a WebSocket reconnect (admin) |
| `/doctor` | Hand the logs to the agent for self-diagnosis (admin) |
| `/invite` | Allow-list: `user @name` / `admin @name` / `group` / `all group` (admin) |
| `/remove` | Remove from allow-list: `user @name` / `admin @name` / `group` (admin) |
| `/doc` | Cloud-doc comment help (just @bot in a doc comment, no binding) |
| `/meeting` | Video meetings: `join <9-digit no.>` / `leave` / `status` / `ask` (admin) |

### Host CLI

```bash
aiduCAT run              # foreground
aiduCAT start            # install + start the background service (launchd / systemd / Windows Task Scheduler)
aiduCAT status
aiduCAT stop
aiduCAT restart
aiduCAT ps
aiduCAT kill <id|#>
aiduCAT ui               # local web console
aiduCAT secrets set --app-id <id>
```

(Without a global link, replace `aiduCAT` with `node bin/lark-channel-bridge.mjs`.)

## Card anatomy

One card, top to bottom:

```
[the model's answer, streaming]

☤Thinking…                                       ← live status word (Thinking / Processing / aiduCATing), gone on completion
┌─ [logo] Claude-Opus-4.6 · 💭 2 · 🛠️ 4 · ⏱️ 38s ─┐  ← collapsed panel header: model · thinking segments · tools · elapsed
│ 💭 thinking text (up to 1500 chars)               │  ← when expanded
│ - 🖥️ **Bash** — pnpm test                         │
│ - 📖 **Read** — src/bot/channel.ts                │
└──────────────────────────────────────────────────┘
```

- **Tool emoji**: 🖥️Bash 📖Read ⌨️Edit 📝Write 🔍Grep 🗂️Glob 🌐Web 🤖Agent/sub-agent 💻other; with many tools only the latest are listed, the rest fold into "…N more"
- **On completion**: the status word disappears; the **border carries the result** — done green / stopped yellow / error red; the Feishu chat-list preview shows ✅Done / ⭕️Stop / ❌Error / ⚠️Timeout
- **Empty run** (the agent exits without output): a red error card with the reason, asking you to resend
- **Too long / rejected**: answers over 25KB are truncated in the card and sent in full as plain text; if Feishu rejects the card, a strict card (no image links, 12KB answer) is retried, then plain text, then a one-line "card failed" notice

## Changelog (f0.3.1)

- Rejected cards degrade automatically, answers are sanitized and kept under 30KB, SDK throttled updates no longer raise unhandledRejection, the empty-run guard really works, patch throttle 250ms
- `/status` numbers are real (context = input + cache, stats survive restarts, 🚩 from the Claude transcript's first entry)
- 60% auto-compact fixed: the 10router window lookup uses `AIDU_10ROUTER_TOKEN`; when unresolved it logs a warn and keeps the CLI `settings.json`
- `/help` lists all 20 commands; hints say `aiduCAT …`; ~300 lines of dead code removed

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

An allowlisted group is not enough: the sender must also be in allowedUsers / admins / owner. Other bots are rejected unless listed in `access.allowedBots` (and the group is allowlisted). Team mode only serves the owner's own tenant. Card button clicks are re-checked with the same rules. `@all` in replies becomes the plain text "@所有人".

### Cloud-doc comments

Cloud-doc comments use the DM allowlist: only owner / allowedUsers / admins can trigger a run by mentioning the bot in a comment. Comment runs are capped at `workspace`, and the document body and other people's replies reach the agent as untrusted content.

### lark-cli identity policy

Each profile uses a profile-local lark-cli directory at `~/.lark-channel/profiles/<profile>/lark-cli`. The agent process receives `LARKSUITE_CLI_CONFIG_DIR` for that directory, so personal authorization in one profile is never shared with another. The default policy is `bot-only`; `/config` can switch an authorized user to `user-default`. `/status` shows the summary (`lark-cli: app` / `lark-cli: user-ready`).

This **lark-cli identity policy** is per profile, not global.

Only runs started by the owner get a lark-cli config. Runs started by anyone else (allowlisted DMs, groups, comments, meetings, meeting minutes) get no lark-cli config at all and are pinned to the bot identity.



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
- `contextWindow`: this provider's model window — denominator of the `/status` context readout and the 60% auto-compact

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
- `contextWindow`: **declare it if you can** — it is the denominator of the `/status` context readout and the 60% auto-compact trigger. Without it (and without 10router) aiduCAT does not override the compact point: Claude Code keeps `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from its own `settings.json`, and a warn is logged (conversation itself is unaffected)

**C. Local inference (Ollama / llama.cpp / vLLM)**

Same as B: point `baseUrl` at `http://127.0.0.1:11434` (Ollama: enable its OpenAI-compatible endpoint), pick `wire` per protocol, and declare `contextWindow` to match the loaded model (e.g. `40960` for `qwen3:32b`).

**How 10router users differ (two enhancements, not dependencies):**

| Capability | 10router users | Your gateway |
|------|--------------|----------|
| `/model` dropdown | pulls 10router's **curated combos** (`/api/combos`, management token) | pulls `<baseUrl>/v1/models` or uses the static `models` list |
| Model logos | shipped (30 vendor icons) | upload your own tenant img_keys once (next section); without them the panel simply shows no icon |

**Compliance note**: before pointing aiduCAT at any third-party gateway or free pool, make sure its terms of service allow programmatic access. aiduCAT does not and will not bypass upstream anti-abuse controls.

### Model logos (panel header icon)

The panel header shows a vendor icon (OpenAI/Claude/Gemini, 30 vendors). Feishu cards reject external image URLs for `custom_icon` — they only render `img_key` values from images uploaded **to your own tenant** via `POST /open-apis/im/v1/images`. The shipped `assets/lark-logo-keys.json` is only valid for the tenant that uploaded them. For your own deployment:

1. Prepare 30 vendor PNGs at 128px (icons: [lobehub icons-static-png](https://github.com/lobehub/lobe-icons), ~1.97.x), named after the `VendorLogo` union in `src/card/model-logo.ts` (`openai.png`, `claude.png`, ...).
2. Upload each via the im/v1/images API with your app credentials and collect the returned `img_key`s.
3. Overwrite `assets/lark-logo-keys.json` with your key map and rebuild (`pnpm build`).
4. Without an upload the feature degrades gracefully: the header simply renders without an icon; no core functionality is affected.

### Working directories

Each profile may define a default workspace through `workspaces.default`. `/cd` switches the current directory and resets the session; `/ws` saves and reuses named workspaces (`/ws list`, `/ws save <name>`, `/ws use <name>`, `/ws remove <name>`). The directory is the agent's current working directory, not a filesystem sandbox — file access still depends on the local agent process and its permission mode.

### Permissions

Access is controlled by the canonical `"permissions"` block. **Omitted = `workspace`**; `full` must be written explicitly by the owner:

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

- Group runs are capped at `groupMaxAccess` (default `workspace`); comment, meeting and team-mode runs are always capped at `workspace`; DMs are not capped. Values: `full` / `workspace` / `read-only`. The legacy `sandbox` config keys are no longer read.
- The agent subprocess env is an allowlist: PATH/HOME/LANG/LC_*/proxy/certs, plus `ANTHROPIC_*`/`CLAUDE_*` for Claude or `OPENAI_*`/`CODEX_*` for Codex. Any other service variable (e.g. `AIDU_10ROUTER_URL`, `SSH_AUTH_SOCK`) must be listed in `agentEnv.passthrough`.
- Tool calls are hidden in groups by default; set `preferences.showToolCallsInGroups: true` to show them.
- Timeouts: `preferences.runIdleTimeoutMinutes` (default 15 min without output), `preferences.runToolTimeoutMinutes` (one tool call, default 30 min). After a restart, queued messages younger than 10 minutes are replayed, older ones get a "please resend"; in-flight cards are marked "service restarted, please resend".

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
