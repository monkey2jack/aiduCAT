# aiduCAT☤爱嘟妙咪飞 — Coding Agent Texting · a wonderfully designed, charmingly simple Feishu card

<p align="center">
  <img src="docs/images/aidububble-banner.webp" alt="aiduCAT 爱嘟妙咪飞 · 泡波横幅（aidu 家族同款）" width="100%">
</p>

> **爱嘟妙咪飞 (Aidu Miao-Mi-Fei): *miao* sounds like a cat's meow, *mi* is kitty, *fei* is Feishu — a wonderfully designed, charmingly simple Feishu card**
>
> **aiduCAT = Coding Agent Texting — a cat living inside Feishu, typing code for you**
>
> **Ask on top, process folded into one small panel, the result told by the panel's color.**
>
> Dress your Claude Code / Codex CLI / Hermes Agent / DSH (DeepSeek Harness) in a Bubble-Wave Feishu card: deep-blue veins on paper white, one cat, zero noise.

[![Version](https://img.shields.io/badge/version-f0.6-blue.svg)](https://github.com/monkey2jack/aiduCAT)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20.12%2B-brightgreen.svg)](https://nodejs.org/)
[![Claude Code](https://img.shields.io/badge/agent-Claude%20Code%20%7C%20Codex%20%7C%20Hermes-orange.svg)](https://docs.anthropic.com/en/docs/claude-code/quickstart)
[![aiduCAT](https://img.shields.io/badge/aiduCAT-Claude--code_Agent_Texting-1f4e79.svg)](https://github.com/monkey2jack/aiduCAT)

**[📖 中文](./README.md)** | **English**

<!-- distribution-policy: github-source-only -->
> **Distribution note**: aiduCAT is not published to npm / PyPI. Run it from this repository source (`pnpm install --frozen-lockfile`, see Quick start).

---

## What is aiduCAT?

**aiduCAT☤爱嘟妙咪飞** — **Coding Agent Texting** — is a Feishu cat for **Claude Code / Codex CLI / Hermes Agent / DSH (DeepSeek Harness) / OpenCode** (one per profile; Hermes since f0.4+, DSH since f0.5++, OpenCode since f0.6): it streams your local coding agent's thinking, tool calls and final answer into a single Feishu card styled after [aiduPOP](https://github.com/monkey2jack/aiduPOP)'s Bubble Wave.

aiduCAT originates from and credits the upstream [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) (npm package `lark-channel-bridge`), an MIT-licensed project. On top of that code, aiduCAT adds a complete **Bubble Wave transformation**:

| Feature | What it does |
|------|------|
| 🤖 **Five agents, pick one** (Hermes f0.4+, DSH f0.5++, OpenCode f0.6) | Each profile runs Claude Code, Codex CLI, Hermes Agent, DSH (DeepSeek Harness) or OpenCode with the same cards, commands and allowlists; see "Hermes Agent", "DSH (DeepSeek Harness)" and "OpenCode / OpenChamber" below |
| 🫧 **Single Bubble-Wave panel** | The answer streams on top; thinking and every tool call fold into one collapsible panel (aiduPOP layout) |
| 💭 **Counter header** | Panel header: `model · 💭 thinking segments · 🛠️ tools · ⏱️ elapsed`; while running a status line sits flush-left right above the panel (aiduCATing / Thinking / Running, followed by loading dots), gone on completion |
| 🏷 **Agent icon** | The panel header shows the profile's coding agent (Claude Code / Codex / Hermes Agent / DSH / OpenCode), not the model vendor; the model id follows the icon |
| 🔌 **Multi-provider** | `/model` card with Provider → Model → Effort dropdowns; provider keys resolve from env/secret refs, never plaintext; takes effect next turn without restart; 10router gateways only offer curated combos |
| 🗜️ **Window-based auto-compact** | Compacts at 60% of the model window (`AIDUCAT_COMPACT_PCT`); the window comes from the 10router combo (when `/api/combos` carries a window field) or the provider's `contextWindow`; when neither has one aiduCAT sets nothing and Claude Code keeps `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from its own `settings.json` (since f0.3.4 the full 10router `/v1/models` list is never pulled) |
| 🚦 **Border = status** | done green / stopped yellow / error red / running grey — no trailing notes |
| 🛟 **Rejected cards never hang** | Image markdown becomes links, HTML is stripped, answers over 25KB are split into ordered "续 i/N" continuation cards (cut at paragraph/code/table boundaries); if Feishu rejects the card it degrades (strict card → plain text → failure notice) instead of sticking on "Thinking" |
| ⏳ **aiduCATing… placeholder card** | The moment a message lands (even while queued behind a running round) a card appears as a one-line panel「[agent icon] aiduCATing…」; at the agent's first thinking, tool call or answer text the header becomes「[agent icon] model · counters」with the status word flush-left above the panel, and streams as usual; card mode no longer adds a Feishu reaction (markdown/text modes and Codex keep it). ⚡ TPS is shown only in `/status` (session average) |
| 🗣 **Free-form `/model`** | Passes any gateway combo id through (e.g. `Gemini-3.8-Flash`), no allow-list |

## Quick start (from scratch)

Prerequisites: Node.js >= 20.12.0, and a working [Claude Code](https://docs.anthropic.com/en/docs/claude-code/quickstart) (or [Codex CLI](https://developers.openai.com/codex/cli), or [Hermes Agent](https://github.com/NousResearch/hermes-agent) — see "Hermes Agent" and "DSH (DeepSeek Harness)" below) whose model gateway is already configured in its env or `~/.claude/settings.json` (e.g. `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`).

```bash
git clone https://github.com/monkey2jack/aiduCAT.git
cd aiduCAT
corepack enable                    # enables pnpm (or npm i -g pnpm@10; or use npx --yes pnpm@10 instead of pnpm)
pnpm install --frozen-lockfile     # installs deps (incl. the SDK patch); the prepare hook also builds dist/
pnpm build                         # rebuild after code changes

# Run in foreground (first run opens a QR binding wizard)
node bin/lark-channel-bridge.mjs run
```

The first run renders a binding QR code, lets you scan and pick/create a PersonalAgent app, then writes `~/.aiducat/config.json` (machines set up before f0.3+ keep `~/.lark-channel`, see "Data dir and migration" below).

To type `aiduCAT …` directly: run `pnpm setup`, then `pnpm link --global` (or `alias aiduCAT="node $PWD/bin/lark-channel-bridge.mjs"`). The entry file `bin/lark-channel-bridge.mjs` and the service names keep the upstream names; since f0.3+ the data dir is `~/.aiducat` — the old `~/.lark-channel` is still read, and `aiduCAT migrate-home` moves it.

Optional environment variables (in the bot's service environment):

| Variable | Purpose |
|---|---|
| `AIDU_10ROUTER_URL` / `AIDU_10ROUTER_TOKEN` | 10router URL + management token: `/model` combo list and model-window lookup (auto-compact and the `/status` denominator) |
| `AIDUCAT_COMPACT_PCT` | Auto-compact trigger as % of the window, default `60` |

## Hermes Agent (f0.4+)

aiduCAT now drives four agents, **one per profile**: Claude Code, Codex CLI, [Hermes Agent](https://github.com/NousResearch/hermes-agent) or DSH (DeepSeek Harness). Cards, slash commands, allowlists and group rules are the same; only the agent doing the work changes. One machine can run several profiles, each on its own Feishu bot.

### Setup

1. Install Hermes Agent and configure a model (`hermes setup` or `hermes model`); check that `hermes chat -q "hello"` answers in a terminal.
2. Create a Hermes profile and start it:

```bash
aiduCAT profile create hermes --agent hermes   # records the absolute path of hermes
aiduCAT start --profile hermes                 # background service; foreground: node bin/lark-channel-bridge.mjs run --profile hermes
```

3. Optional settings (`profiles.<name>.hermes` in `~/.aiducat/config.json`):

```json
{
  "hermes": {
    "binaryPath": "/home/me/.local/bin/hermes",
    "profile": "aiducat",
    "outsiderToolsets": ["todo", "web"]
  }
}
```

- `binaryPath`: where `hermes` lives. The Hermes installer puts it in `~/.local/bin`, which a systemd user service's PATH often lacks, so profile creation records the absolute path; `LARK_CHANNEL_HERMES_BIN` overrides it.
- `profile`: which Hermes profile aiduCAT uses (`hermes --profile <name>`); unset = Hermes's own default. A separate one keeps aiduCAT's sessions, memory and config apart from your everyday Hermes.
- `outsiderToolsets`: toolsets for non-owner turns, `todo` and `web` only (anything else is dropped); unset = `todo` only.
- Models: the id picked in `/model` goes to `hermes chat -m` as is and is resolved by the model service configured in Hermes; `/model default` = Hermes's own default. Provider keys configured in `/model` for Claude Code are never passed to Hermes.
- Feature switch `features.hermes` (on by default).

### How it behaves (tested with Hermes 0.22)

- **One `hermes chat` client per turn**: the message goes in on stdin (never through argv or a shell); answer text, tool calls and tool results stream into the card panel; the client exits when the turn ends.
- **Hermes brings its own on-demand background process**: since Hermes 0.22, `hermes chat` hands the turn to a local Hermes background process (`hermes gateway run --idle-exit`, connected to no chat platform), starting it if needed; it exits after 600 idle seconds (`gateway.unmanaged_idle_exit_seconds`) and measured about 270–290 MB resident. This is Hermes's own mechanism, nothing extra to install. The first turn is slower because it starts that process; later turns only start a client.
- **/stop stops the card only**: the card ends yellow right away, but Hermes finishes the turn it already accepted in the background (a running command runs to the end). That is Hermes 0.22's design ("accepted work continues" after the client detaches); aiduCAT cannot interrupt it midway.
- **No thinking section**: Hermes's output protocol carries no reasoning. Token counts are per whole turn, so `/status` shows no context ratio; Hermes compacts context by its own settings.
- **Owner turns** run with `--yolo` (nobody can click a Hermes approval in Feishu), get every Hermes tool, and use the chat's working directory (`/cd`, `/ws` work as usual).
- **Everyone else's turns** (group @mentions by others, allowlisted users, doc comments) get `todo` only (optionally `web`) plus `--ignore-rules`: no AGENTS.md, SOUL.md, memory or skills; no terminal, file or code-execution tools. Reason: those Hermes tools run inside the owner's Hermes process with the owner's rights and cannot be put in a bubblewrap sandbox the way Claude Code's can, so they are not offered. The environment handed to Hermes carries no provider keys and no `HERMES_*` switches.
- **Separate sessions for the owner and everyone else**: Hermes fixes a session's model, toolsets and `--yolo` when it is created, so each chat keeps two Hermes sessions. Outsiders never see the owner's conversation, and after an outsider's turn the owner continues their own session. Changing the model starts a new session.
- `/status` shows both session ids and "owner 全部（--yolo）/ 其他人 todo"; `/resume` does not list Hermes history (Hermes keeps it); the same chat continues automatically, `/new` starts fresh.
- On the Hermes side `hermes sessions list --source tool` lists these turns; titles are generated by Hermes from the first message and may read "aiduCAT 运行约定…" — harmless.

### Gateway style or bridge style? (aiduPOP vs aiduCAT)

There are two ways to put Hermes in Feishu:

- **Gateway style**: Hermes runs its own resident messaging gateway that connects to Feishu, keeps sessions and runs scheduled jobs; [aiduPOP](https://github.com/monkey2jack/aiduPOP) is the Bubble-Wave card plugin inside that gateway.
- **Bridge style**: aiduCAT connects to Feishu itself and starts the agent CLI once per turn (`claude` / `codex` / `hermes chat`); the agent only does the work.

| | Gateway style (Hermes gateway + aiduPOP) | Bridge style (aiduCAT + Hermes) |
|---|---|---|
| Idle footprint | The Hermes gateway is always up | aiduCAT (Node) is always up; the Hermes background process starts on demand and exits after 600 idle seconds |
| Per-turn speed | Resident gateway, no process start per turn | One extra `hermes chat` client per turn; small overhead once the background process is up, the cold turn is slower |
| Scheduled jobs / proactive push / multi-platform | Native in Hermes (cron, proactive messages, Telegram / Discord / Slack …) | Feishu ask-and-answer only; no proactive push, no other platforms |
| Crash impact | Every channel lives in the one gateway process | A failing agent run affects that turn only; the Feishu connection lives in aiduCAT, apart from the agent |
| Maintenance | Follows Hermes's plugin system | One set of cards, commands and allowlists for Claude Code, Codex and Hermes; switch agents without switching Feishu bots |
| Outsider isolation | Per the Hermes gateway's own user allowlist and permissions | Outsiders get their own session, `todo` / `web` only, no memory or rules loaded |
| Approvals | Clickable in Feishu cards (aiduPOP has native confirm and clarify cards) | No approval UI: owner turns use `--yolo`, outsider turns get no dangerous tools |
| /stop | Handled by the Hermes gateway | Stops the card; Hermes finishes the turn in the background |

**Which one**:

- Mostly Hermes, and you want scheduled jobs, proactive push, multiple platforms or in-card approvals → gateway style (aiduPOP).
- Already using Claude Code / Codex in Feishu and want Hermes with the same experience; outsiders in your groups who must be kept apart from you; or one thing to maintain → bridge style (aiduCAT).
- Both can run side by side, each on its own Feishu bot. aiduPOP stays maintained; the two complement each other.

### "Agent gateway" and "model gateway" are different things

In aiduCAT, Claude Code, Codex, Hermes and DSH go through **no agent gateway**: aiduCAT starts their CLIs directly (Hermes 0.22's client then talks to its local background process, which is internal to Hermes). A **model gateway** such as [10router](https://github.com/techysy/10router) is another layer: it sits behind the agent and forwards model requests to model providers. Claude Code reaches it through `ANTHROPIC_BASE_URL`, Hermes through the model endpoint in its own `config.yaml`; whether and which one you use has nothing to do with aiduCAT.

## DSH (DeepSeek Harness), f0.5++

aiduCAT drives four agents, **one per profile**: Claude Code, Codex CLI, [Hermes Agent](https://github.com/NousResearch/hermes-agent) and **DSH (DeepSeek Harness)**. Cards, slash commands, allowlists and group rules are the same; only the agent doing the work changes. One machine can run several profiles, each on its own Feishu bot. A DSH profile starts one `dsh` client per turn — no resident background process (unlike Hermes).

### Setup

1. Install DSH and check it can run a turn in a terminal (the task rides on stdin, so `-` must be the only positional argument):

```bash
echo "hello" | dsh --profile headless --json -
```

2. Create a DSH profile and start it:

```bash
aiduCAT profile create dsh --agent dsh   # records a default dsh; the install is discovered at run time
aiduCAT start --profile dsh              # background service; foreground: node bin/lark-channel-bridge.mjs run --profile dsh
```

3. Optional settings (`profiles.<name>.dsh` in `~/.aiducat/config.json`):

```json
{
  "dsh": {
    "binaryPath": "C:\\tools\\dsh.cmd",
    "profile": "headless"
  }
}
```

- `binaryPath`: optional in practice — set it only to **pin a specific build** (or to use your own launcher). When it is missing or no longer resolves, aiduCAT probes `LARK_CHANNEL_DSH_BIN`, then `dsh` on PATH, then finds the Desktop install and launches it the way it needs (see "Windows launcher" below).
- `profile`: which DSH profile aiduCAT runs (`dsh --profile <name>`); default `headless`. DSH keeps profiles under `$DSH_HOME/profiles/<name>`.
- `modelLabel`:**deprecated**, kept for older configs. The bridge now reads the profile's own `agent-default-model` (and mirrors the desktop routing) for the name on the card; a hand-written label keeps showing a stale model after you change it on the desktop, so do not set it on new configs.
- Environment: besides `LARK_CHANNEL_DSH_BIN`, give the service a real `DSH_HOME` (DSH's own data dir) — the bridge uses it to read the profile, mirror the desktop model routing and write the `/model` `--patch` overlay; without it those steps are skipped (log only) and `/model` switches do nothing. A profile whose aidu provider route reads `AIDU_API_KEY` gets that variable passed through; `DSH_*`, vendor prefixes (`ANTHROPIC_` / `OPENAI_` / `CODEX_` / `CLAUDE_` / `DEEPSEEK_`) and any name containing `KEY` / `TOKEN` / `SECRET` / `PASS` are never passed (so provider keys configured for Claude Code in `/model` cannot leak into DSH).
- There is no `features.dsh` switch (unlike `features.codex` / `features.hermes`).

### How a turn runs

```text
dsh --profile <profile> --json [--patch <abs.yml>] [--permission-mode <preset>] [--approval-policy never] [--session-id <id>] -
```

- The task rides on **stdin** (`-`, the only positional argument); message text is never argv- or shell-interpreted.
- `--json` turns stdout into newline-delimited events: `session` / `status` / `text` / `thinking` / `tool_call` / `tool_result` / `error` / `final` / `step_end`; the bridge maps them onto the card's thinking segments, tool rows and answer.
- Success requires the exit code `0` **and** `final.reason.kind === "completed"` — neither alone is enough, and trusting one alone reports an aborted run as a success. On failure the card shows DSH's error code and message (`dsh <CODE>: <message>`); the full text is in the log.
- The process exits when the turn ends; nothing stays resident.

### Models: no `--model`, the profile plus `--patch`

- DSH has no `--model` flag. The model is the `agent-default-model` row in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`.
- On a DSH profile `/model` lists "follow the DSH profile (currently …)" first, then the model ids declared by the profile's **default provider**; there is no Effort column (DSH takes no reasoning effort) and no 10router combo lookup.
- Picking a concrete model writes a `--patch` overlay that **replaces that whole row**: the provider has to be restated from the profile, since a bare model id would not route and comes back `UNKNOWN_MODEL`. The overlay goes only to `$DSH_HOME/aiducat-model-patches/<model>.yml` (characters outside `A-Za-z0-9._-` are replaced), profile files are never modified, and it is written once per model id.
- Auto-refresh: the bridge stats and re-parses the profile file, so adding/removing a model or changing the default on the desktop shows up the next time `/model` is opened, with no service restart.
- A profile may declare several providers, but the overlay can restate only one, so the picker lists the default provider's models alone; another provider's ids cannot be routed by `--patch`.

### Model follows the desktop

- DSH refuses to run a profile named `desktop` from a CLI (`profile "desktop" is managed exclusively by the Electron application`), so Feishu and the GUI cannot share one profile object.
- Before **every turn** and before **opening `/model`**, the bridge mirrors the desktop profile's `agent-default-model` and `llm-pi-ai` entries into the profile it runs (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`, headed `GENERATED by aiduCAT`). The desktop file is **read-only** and stays the single source of truth.
- Only an existing aiduCAT-managed run patch is eligible. Missing, redirected, or hand-customized targets are not created or overwritten; `/doctor` reports the reason.
- So adding/removing models or changing the default model on the desktop (Settings → Models) is followed automatically. An unreadable, half-written (the GUI rewrites the file) or model-less source leaves the previous routing in place: a stale-but-working model beats a turn that cannot start.
- Only supported routing fields in those entries travel, including model catalogs and environment variable references, not inline credentials or desktop UI plugins. The picker lists the selected provider only.

### Multi-turn sessions

- Each Feishu DM / group / topic / doc comment keeps one session; the first turn returns DSH's session id and every later turn resumes it with `--session-id <id>`; `/new` starts a fresh one.
- Continuity depends on `$DSH_HOME` not being cleaned: once it is, old ids are gone — send a new message to start over.
- `/resume` does not list DSH history; it replies "DSH 会话由系统自动接管(--session-id),无需手动 resume。". `/status` shows the current session id.

### Permissions and approvals

- aiduCAT's access levels (`full` / `workspace` / `read-only` in the config) map onto DSH's three presets `read-only` / `workspace-write` / `danger-full-access`, the same names as aiduCAT's internal sandbox values, one to one. Groups stay capped by `groupMaxAccess` (default `workspace`); comment, meeting and team-mode runs are always capped at `workspace`.
- A value outside the three is dropped so the turn keeps the profile default — DSH **aborts** a run on an unknown preset instead of falling back.
- Headless has no live approval channel, so a bridged turn always passes `--approval-policy never`: a call that needs human approval **fails** instead of parking forever. Raise the preset to grant more, rather than waiting for an approval nobody can click.

### Windows launcher

- aiduCAT finds DSH on its own: `dsh.binaryPath` → `LARK_CHANNEL_DSH_BIN` → `dsh` on PATH → the **Desktop install**. For the Desktop build it runs `<install>/DeepSeek Harness.exe --expose-internals <install>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js` with `ELECTRON_RUN_AS_NODE=1` (without that variable Electron starts the GUI), so no hand-written launcher is needed.
- Set `dsh.binaryPath` only to pin a specific build (or to use your own launcher): a configured value always wins. A hand-written launcher is a single point of failure — a DSH upgrade, another machine or another OS account breaks it with `agent-binary-not-found`.
- Because the direct child can be the cmd / Electron wrapper, `/stop` sends SIGTERM first and, after the grace period (5 seconds by default), kills the whole process tree with `killProcessTree`, so no orphaned process keeps holding the workspace.

### Known limitations

- DSH must be installed locally; without it the startup preflight fails with `agent-binary-not-found`.
- The Desktop build is found and started automatically in Electron-as-node mode (its cold start unpacks assets, so the preflight timeout is relaxed to 30 seconds); the CLI never runs the `desktop` profile, and the mirror is how Feishu follows it.
- The `--json` stream carries no model field, so the card shows the model "this turn will use" (the profile's `agent-default-model`, or the `/model` pick) rather than a model DSH reports back.
- Every non-terminal string is capped at 8 KiB; a capped block is dropped and the lossless `final.text` supplies the whole answer, so long answers stay complete.
- The model list comes from the profile's own declaration; aiduCAT ships no DSH model table, so a model the profile does not declare cannot run.

### Troubleshooting

| Symptom / code | Cause | Fix |
|---|---|---|
| `agent-binary-not-found` | no `dsh` executable found (wrong path, launcher deleted, PATH missing in the service env) | check that `dsh.binaryPath` / `LARK_CHANNEL_DSH_BIN` points at a real file and that the service environment can run it |
| want to see where DSH lives, which profile it runs, where the model comes from | — | `/doctor` prints the dsh binary and how it was found (`config` / `env` / `path` / `desktop-app`), the argv prefix, the `--version` probe, the profile, the model and provider, and whether the model routing still mirrors the desktop |
| `MISSING_CREDENTIAL` | the provider route named by the profile's `agent-default-model` has no credential (its key never reached the service env) | put the credential that provider needs into the service environment and restart; only `AIDU_API_KEY` and `agentEnv.passthrough` names are forwarded |
| `UNKNOWN_MODEL` | the id this turn will run is not served by the provider that got restated (typically a `--patch` overlay whose model belongs to another provider) | pick a model from `/model`, or add that model to the default provider on the desktop |
| `deepseek-official` route error | the profile's `agent-default-model` points at `deepseek-official` but that route does not work here (missing credential, unreachable endpoint, or an id it does not serve) | give that route its credential, switch the default to a provider already configured in the profile, or `/model`-pick a default-provider model |
| empty `/model` list | the bridge cannot read `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (`DSH_HOME` not set for the service, wrong profile name) | set `DSH_HOME` in the service environment, check the profile dir exists, restart |
| `dsh exited with code N` | DSH itself exited non-zero | run the same command by hand in a terminal; the full stderr is in the aiduCAT log |

## OpenCode / OpenChamber integration (f0.6)

aiduCAT supports five agents, **one per profile**: Claude Code, Codex CLI, Hermes Agent, DSH, and **OpenCode (including OpenChamber desktop)**. All share the same cards, slash commands, allowlists, and group rules.

### Setup

1. Install OpenCode or OpenChamber desktop:

```bash
aiduCAT profile create opencode --agent opencode   # auto-detects OpenCode / OpenChamber CLI
aiduCAT start --profile opencode                  # start background service
```

2. Key Features:
- **Single-session context reset (/clear and /new)**: Tailored for OpenCode's session architecture. Calling `/clear` or `/new` clears message history directly from the SQLite store, resetting tokens to baseline **without cluttering the OpenChamber desktop sidebar with empty sessions**.
- **Unified workspace**: Feishu sessions bind to OpenChamber's dedicated `chats` workspace, keeping desktop and chat contexts clean and aligned.
- **Free models & Effort control**: Full support for `opencode/free-large`, `opencode/free-small`, and more; adjusts Reasoning Effort directly via the `/model` card (high / medium / low / off).
- **Auto CLI discovery**: Resolves path in order: `opencode.binaryPath` -> `LARK_CHANNEL_OPENCODE_BIN` -> system PATH -> OpenChamber desktop app bundle (`resources/...`).

## Commands

### Slash commands inside Feishu / Lark

| Command | Effect |
|---|---|
| `/help` | List every command (the dropdown runs one directly) |
| `/new` | Stop the current task and start a new session (keeps model/effort); `/new chat` is admin-only |
| `/clear` | Clear current session context (preserves session without creating a new one in OpenCode; acts as `/new` for others) |
| `/reset` | Same as `/new` |
| `/stop` | Stop the running task; says so when nothing is running |
| `/status` | Six-line status card: session id, model · effort · 🗜️ compact point, permissions/owner, lark-cli/run/queue, 🚩 session start · age · message counts, ⏳ context and token stats |
| `/model` | Show / switch model and reasoning effort (any gateway combo id; `/model default` restores; non-Claude models are marked "translated by gateway" and get no effort flag). **In a DM it changes the default; in a group it changes that group only** (groups without their own setting follow the default; `/model reset` or the card's "follow default" button drops the group's setting; `/status` shows whether the model is the group's own or the default) (admin) |
| `/resume` | List and resume past sessions for this working directory |
| `/cd <path>` | Switch working directory (admin; refuses credential/system dirs such as `~/.ssh`, `~/.claude`, `~/.aiducat`, `~/.lark-channel`, `/etc`, including subtrees) |
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
aiduCAT migrate-home --dry-run   # data dir ~/.lark-channel → ~/.aiducat (stop the service first; drop --dry-run to migrate)
aiduCAT secrets set --app-id <id>
```

(Without a global link, replace `aiduCAT` with `node bin/lark-channel-bridge.mjs`.)

## Card anatomy

One card, top to bottom:

```
[the model's answer, streaming]

Thinking…                                            ← flush-left above the panel while running: status word (aiduCATing / Thinking / Running), gone on completion
┌─                                               ─┐
│ [agent icon] Claude-Opus-4.6 · 💭 2 · 🛠️ 4 · ⏱️ 38s │  ← collapsed panel header: agent icon · model · thinking segments · tools · elapsed
│ 💭 thinking text (up to 1500 chars)               │  ← when expanded
│ - 🖥️ **Bash** — pnpm test                         │
│ - 📖 **Read** — src/bot/channel.ts                │
└──────────────────────────────────────────────────┘
```

- **Tool emoji**: 🖥️Bash 📖Read ⌨️Edit 📝Write 🔍Grep 🗂️Glob 🌐Web 🤖Agent/sub-agent 💻other; with many tools only the latest are listed, the rest fold into "…N more"
- **On completion**: the status word disappears; the **border carries the result** — done green / stopped yellow / error red; the Feishu chat-list preview shows ✅Completed / ⭕️Stopped / ❌Failed / ⚠️Timed out
- **Empty run** (the agent exits without output): a red error card with the reason, asking you to resend
- **Too long / rejected**: an answer over 25KB fills card 1 up to the budget (cut at a paragraph, code-block or table boundary, ending in "…（未完，见下一张卡）"), then continues on ordered "续 2/N", "续 3/N" cards — rendered markdown, each <30KB, nothing repeated; an oversized code block is split between lines with the fence reopened, an oversized table between rows with the header repeated; only if Feishu rejects a continuation card does the rest from that card on go out once as plain text. if Feishu rejects the card, a strict card (no image links, 12KB answer) is retried, then plain text, then a one-line "card failed" notice

## Changelog (f0.6)

### f0.6

- **OpenCode as the fifth agent**: `aiduCAT profile create <name> --agent opencode`, alongside Claude Code, Codex, Hermes, and DSH; auto-detects OpenChamber desktop CLI and binds to dedicated chats workspace;
- **Single-session `/clear` context reset**: clears message history while preserving the session ID without cluttering the desktop sidebar; token counts reset instantly;
- **`/model` free models & effort control**: full support for OpenCode native free models (free-large, free-small) and reasoning effort adjustments on the card.

## Changelog (f0.5++)

- **Steer**: message Claude Code again while it works, no waiting for it to finish — it reads the message at its next step and carries on without restarting; the card so far ends as「↪️Steered」and the rest goes into the new message's card
- No more "reply then recall" (an empty result from a background-task notice no longer ends the turn); no ☤ before the in-progress status words

### f0.5++

- **DeepSeek Harness is the fourth agent**: `aiduCAT profile create <name> --agent dsh`, alongside Claude Code / Codex / Hermes. aiduCAT finds the DSH install itself (the Desktop app included, no hand-written launcher), `/model` switches with a `--patch` overlay, and the model list plus the default model follow the desktop app
- **DSH failure alerts**: three consecutive DSH failures send the owner a private notice, subject to a cooldown. Other agent types do not use this monitor.
- `/doctor` prints where the DSH binary came from, its version, the profile, and whether the model routing still mirrors the desktop; Windows is covered by CI
### f0.5

- **Status words with motion, more professional**: ☤ is back, followed by Feishu's loading dots; in progress aiduCATing / Thinking / Running, finished Completed / Stopped / Failed / Timed out
- **Community contributions**: Windows background service without a console window, every bot comes online at boot, no lock stall after a forced kill, the "interactive card" setting no longer silently downgraded (@alone-lon); "No response requested." no longer shown (@iMissNan)
- At most 5 tables per card; the rest go to 「续」 cards

### f0.4++

- **Leaner card**: the panel icon is the coding agent (Claude Code / Codex / Hermes Agent) instead of a vendor logo guessed from the model (all vendor logos removed); ☤ dropped; Thinking… / Processing… sit flush-left right above the panel
- Chinese name 爱嘟妙咪飞, full English name Coding Agent Texting

### f0.4+

- **Hermes Agent is the third agent**: `aiduCAT profile create <name> --agent hermes`; pick Claude Code / Codex / Hermes per profile; separate Hermes sessions for the owner and everyone else, outsider turns get `todo` only (optionally `web`) with no memory or rules; /stop stops the card (Hermes finishes the turn in the background). See "Hermes Agent" above
- Includes the fixes shipped after f0.4: group "everyone may use" switch (`/invite alluser`), slash commands admin-only in groups, per-chat `/model`, outsider turns work (and reach the internet) inside the sandbox, extra `access.outsiderDenyRead` paths, two services starting together without lock errors, non-owner errors kept out of chats

### f0.4

- A message gets a one-line panel 「[agent icon] aiduCATing…」 right away; the header shows the counters and the status word appears above the panel when the agent first thinks, calls a tool or writes; queued messages get their own card each, unused placeholder cards are recalled; no Feishu reaction in card mode
- Faster start: only 10router combos are loaded (no full `/v1/models` pull), the combo list refreshes in the background and is prewarmed at start
- With no window field on the combo, the context window follows Claude Code's `settings.json` (e.g. 1M)
- TPS is recomputed from each turn's real generation time (tool time removed) and shown only in `/status`; no ⚡ on cards
- Group chats use the panel card too (tool rows hidden by default); @mentions in cards are real @mentions
- Models containing `aiduPARK` get the dedicated wing logo; logs carry ms timings (`atMs` / `sinceMsgMs`)
- One code dir can run two services with two `--profile`s (each on its own Feishu app)

### f0.3+

- New per-profile `features` switches (meeting / web console / Codex / CoT): a module that is off is not loaded, its commands are hidden from `/help` and answer 「此功能未开启」 (feature not enabled); all on by default
- Meeting, CoT, Codex and the web console load on demand; code loaded at startup down ~46%
- The `unrecognized_model` notice is logged once per model
- Graceful restart: stopping the service first lets in-flight rounds finish (`shutdownDrainMinutes`, default 10 min); a round cut off by a restart is continued once automatically if the service is back within 10 minutes
- Data dir is now `~/.aiducat`; `aiduCAT migrate-home [--dry-run]` migrates in one step and never touches the old dir
- Tokens in `settings.json` only reach the owner's rounds; the data dir self-tightens to 0700/0600 at start; optional `/cd` allowlist `workspaces.roots`

Full details in [CHANGELOG.md](./CHANGELOG.md).

## Sessions and queueing

- Each DM / group / topic / doc-comment thread keeps its own session
- Messages sent in quick succession merge into one batch; messages sent during a run queue up as the next turn
- **Steer** (Claude Code, card mode): a message from the same person during a run goes straight into the running Claude Code, which reads it at its next step and carries on without restarting; the card so far ends as「↪️Steered」and the rest goes into the new message's card. Other people's messages, Codex, Hermes and DSH still queue
- Session history persists locally; `/resume` restores it

## Runtime notes

### Per-profile service and CLI

The daemon installs one **per-profile service** per PersonalAgent app: macOS launchd `ai.lark-channel-bridge.bot.<profile>`, Linux systemd `lark-channel-bridge.bot.<profile>.service`, Windows Task Scheduler `LarkChannelBridge.Bot.<profile>` via a `.cmd` wrapper. Host CLI reference:

```bash
aiduCAT profile create claude --agent claude
aiduCAT profile create codex --agent codex
aiduCAT profile create hermes --agent hermes
aiduCAT profile create dsh --agent dsh
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
/invite alluser        let every member of this group use the bot (toggle)
/remove user @name
/remove admin @name
/remove group
```

An allowlisted group is not enough: the sender must also be in allowedUsers / admins / owner — unless `/invite alluser` was sent in that group to let every member use the bot (stored in `access.chatAllowAllUsers`, only for allowlisted groups; send it again to turn it off). Other bots are rejected unless listed in `access.allowedBots` (and the group is allowlisted). Team mode only serves the owner's own tenant. Card button clicks are re-checked with the same rules. `@all` in replies becomes the plain text "@所有人". Groups get the same streaming card (with its panel) as DMs; tool lines in the panel are hidden in groups unless `preferences.showToolCallsInGroups` is `true`.

**In groups only the owner / admins can use slash commands**: anything else starting with `/` (`/help`, `/new`, `/stop`…, unregistered `/xxx`, also `@bot /xxx`) is neither run nor passed to Claude Code / Codex (so their built-in slash commands cannot be triggered); if the bot was @-mentioned it replies "群里只有管理员能用命令。" (only admins can use commands in groups), otherwise it stays silent. Card buttons in groups follow the same rule. DMs are unchanged.

Runs started by anyone but the owner (group members, allowlisted users) need bubblewrap on Linux: `sudo apt-get install -y bubblewrap socat` (without it the startup log warns `bwrap-missing` and Claude Code cannot start for those runs). They run isolated (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`) but can work normally: Bash runs inside Claude Code's bubblewrap sandbox and can read/write files in the working directory; settings.json (user and project `.claude/settings*.json`), `~/.ssh`, `~/.aiducat`, `~/.config/aiduCAT`, `~/.lark-cli`, `.env` files and `/proc` are unreadable and the environment carries no keys; the working directory's `CLAUDE.md`, `.claude/` and `.mcp.json` are read-only; sandboxed Bash can reach the internet (`curl`, `pip`, `npm`, …) but not loopback / private addresses (e.g. aiduMEI, the web console); `git` follows the host's `~/.gitconfig` `http.proxy`, so a loopback proxy there breaks git inside the sandbox. On hosts with containerd (`/run/containerd` at 0711) aiduCAT starts these runs in a private mount namespace that covers `/run/containerd` with an empty directory, which avoids bubblewrap 0.12's `Can't mkdir parents for /run/containerd/containerd.sock` (anthropics/claude-code#93144) **without changing `/run/containerd` permissions** (needs util-linux `unshare` and `setpriv`, present on Debian/Ubuntu; skipped automatically, with a `runtime-dir-mask-unavailable` warn, where unprivileged user namespaces are blocked, e.g. by Ubuntu 24.04's default AppArmor policy). A profile can also list `access.outsiderDenyRead` (absolute or `~/…` paths; a `*` in the last segment also covers backups, e.g. `"~/.xiaohou/memory/server-notes.md*"`): those paths are unreadable in these runs to both the Read tool and sandboxed Bash (`cat`, `python`, …); restart the service after editing. Unset = no extra limits. Owner runs are unaffected. If the agent fails, groups only see a short "can't handle this right now" notice; the full error goes to the log, and only the owner's private chat shows a one-line reason.

### Cloud-doc comments

Cloud-doc comments use the DM allowlist: only owner / allowedUsers / admins can trigger a run by mentioning the bot in a comment. Comment runs are capped at `workspace`, and the document body and other people's replies reach the agent as untrusted content.

### lark-cli identity policy

Each profile uses a profile-local lark-cli directory at `~/.aiducat/profiles/<profile>/lark-cli`. The agent process receives `LARKSUITE_CLI_CONFIG_DIR` for that directory, so personal authorization in one profile is never shared with another. The default policy is `bot-only`; `/config` can switch an authorized user to `user-default`. `/status` shows the summary (`lark-cli: app` / `lark-cli: user-ready`).

This **lark-cli identity policy** is per profile, not global.

Only runs started by the owner get a lark-cli config. Runs started by anyone else (allowlisted DMs, groups, comments, meetings, meeting minutes) get no lark-cli config at all and are pinned to the bot identity.



### Multi-provider setup

The `/model` card offers three dropdowns (Provider / Model / Effort). The default gateway comes from service env (`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`); extra providers live in `~/.aiducat/config.json` (`~/.lark-channel/config.json` on older machines) under `profiles.<name>.modelProviders`:

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
- `contextWindow`: **declare it if you can** — it is the denominator of the `/status` context readout and the 60% auto-compact trigger. Without it (and without 10router) aiduCAT does not override the compact point: Claude Code keeps `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from its own `settings.json` (conversation itself is unaffected)

**C. Local inference (Ollama / llama.cpp / vLLM)**

Same as B: point `baseUrl` at `http://127.0.0.1:11434` (Ollama: enable its OpenAI-compatible endpoint), pick `wire` per protocol, and declare `contextWindow` to match the loaded model (e.g. `40960` for `qwen3:32b`).

**How 10router users differ (two enhancements, not dependencies):**

| Capability | 10router users | Your gateway |
|------|--------------|----------|
| `/model` dropdown | pulls 10router's **curated combos** (`/api/combos`, management token) | pulls `<baseUrl>/v1/models` or uses the static `models` list |
| Agent icons | shipped (Claude Code / Codex / Hermes / DSH) | upload your own tenant img_keys once (next section); without them the panel simply shows no icon |

**Compliance note**: before pointing aiduCAT at any third-party gateway or free pool, make sure its terms of service allow programmatic access. aiduCAT does not and will not bypass upstream anti-abuse controls.

### Agent icons (panel header icon)

The panel header shows the profile's coding agent icon (`agentKind`: claude → Claude Code, codex → Codex, hermes → Hermes Agent, dsh → DeepSeek Harness) at its far left, regardless of the model; it does not rotate when the panel expands. Without an icon the collapse chevron shows on the right. Feishu cards reject external image URLs for `custom_icon` — they only render `img_key` values from images uploaded **to your own tenant** via `POST /open-apis/im/v1/images`. The shipped `assets/lark-logo-keys.json` is only valid for the tenant that uploaded them. For your own deployment:

1. Prepare 4 PNGs at 128px (from [lobehub icons-static-png](https://github.com/lobehub/lobe-icons): `claudecode-color`, `codex-color`, `hermesagent`, and your own DSH icon).
2. Upload each via the im/v1/images API with your app credentials and collect the returned `img_key`s.
3. Put them under the `claudecode`, `codex`, `hermes` and `dsh` keys of `assets/lark-logo-keys.json` and rebuild (`pnpm build`).
4. Without an upload the feature degrades gracefully: the header simply renders without an icon; no core functionality is affected.

### Working directories

Each profile may define a default workspace through `workspaces.default`. `/cd` switches the current directory and resets the session; `/ws` saves and reuses named workspaces (`/ws list`, `/ws save <name>`, `/ws use <name>`, `/ws remove <name>`). The directory is the agent's current working directory, not a filesystem sandbox — file access still depends on the local agent process and its permission mode.

Optional allowlist `workspaces.roots` (absolute paths or `~/…`): when set, `/cd`, `/ws use` and a chat's working directory must sit under one of them, otherwise the bot replies that the directory is outside the allowed roots; the denylist still applies and `workspaces.default` is not checked. Unset = denylist only (default).

```json
{ "workspaces": { "default": "~/proj/main", "roots": ["~/proj", "/srv/work"] } }
```

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
- The agent subprocess env is an allowlist: PATH/HOME/LANG/LC_*/proxy/certs, plus `ANTHROPIC_*`/`CLAUDE_*` for Claude or `OPENAI_*`/`CODEX_*` for Codex; Hermes gets nothing extra (it uses the model settings in its own `~/.hermes/.env`; only `HERMES_HOME` is passed). Any other service variable (e.g. `AIDU_10ROUTER_URL`, `SSH_AUTH_SOCK`) must be listed in `agentEnv.passthrough`; DSH additionally gets `DSH_HOME` and `AIDU_API_KEY`.
- Tool calls are hidden in groups by default; set `preferences.showToolCallsInGroups: true` to show them.
- Timeouts: `preferences.runIdleTimeoutMinutes` (default 15 min without output), `preferences.runToolTimeoutMinutes` (one tool call, default 30 min). After a restart, queued messages younger than 10 minutes are replayed, older ones get a "please resend"; in-flight cards are marked "service restarted, please resend".
- Graceful restart: on a stop signal the bridge takes no new rounds and waits for the ones in flight, at most `preferences.shutdownDrainMinutes` minutes (default 10, `0` = stop at once); messages arriving meanwhile are kept and handled after the restart. A round that was cut off is continued once, in the same session, with "（服务重启，接着刚才的继续）" if the restart took ≤ 10 minutes. systemd units need `KillMode=mixed` and `TimeoutStopSec=660` (units installed by `aiduCAT start` have them; add them to hand-written units).
- Rebuilding while the service runs is safe: `pnpm build` writes to `dist/.next`, moves the new chunks in first and swaps `dist/cli.js` with an atomic rename, keeping the chunks of the last 3 builds (`dist/.generations.json`), so the running process can still load its lazy chunks; the new code takes effect on restart. Stopping before building is still the recommended upgrade order.
- Owner-only tokens: credentials in the `env` block of `~/.claude/settings.json` (`GH_TOKEN`, `CLOUDFLARE_*`, …) are only available in rounds the owner starts; rounds started by anyone else get them blanked (`ANTHROPIC_*`/`CLAUDE_*` are kept). Nothing changes for the owner.

### Data dir and migration (migrate-home)

- Since f0.3+ the data dir is `~/.aiducat`. A machine that only has the old `~/.lark-channel` keeps using it (one notice line at start); when both exist the new one wins; `LARK_CHANNEL_HOME` still wins over both.
- To migrate: stop the service → `aiduCAT migrate-home --dry-run` to see the plan → `aiduCAT migrate-home`. It copies everything, rewrites paths that point into the old dir, verifies (including that the keystore decrypts at the new place), then renames into place; `~/.aiducat-workspaces` links to the old workspaces so sessions resume. **The old dir is never touched** — delete it by hand once you are happy.
- At start the data dir is tightened to 0700 directories / 0600 files.

### Feature switches (features)

Modules you don't use can be switched off per profile. No `features` block = everything on; only an explicit `false` turns a module off:

```json
{
  "features": { "meeting": false, "webConsole": false, "codex": false, "cot": false, "hermes": false }
}
```

- A module that is off is not loaded (less startup memory); its commands are hidden from `/help` and answer 「此功能未开启」 (feature not enabled).
- `"meeting"`: `/meeting`, meeting pushes and auto-join; `"webConsole"`: `run/start --web-ui`, `aiduCAT ui`, the console line in `/config`; `"codex"`: Codex profiles and Codex session history; `"hermes"`: Hermes profiles (a profile with `agentKind: hermes` refuses to start when off); `"cot"`: CoT process messages and their `/config` option (the preference is kept).
- Restart the service after changing it.

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
