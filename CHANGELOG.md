# Changelog

aiduCAT 的版本号用 `f` 前缀（f0.1、f0.2+ …），`package.json` 里是对应的 semver。按 git log 与 tag 整理；日期为提交日期（CST）。

> **tag 说明**：`f0.2++` 原先误指 `6fa62f8`（package 0.2.1），**已于 2026-10-31 修正**为真实发布提交 `c7ff90d`（0.2.2）。`f0.2+`、`v0.2.1` 核实后保持 `6fa62f8`：f0.2+ 的 GitHub Release 于 2026-10-20 01:17 从 main 发布，当时 main 的头部就是 `6fa62f8`（package 0.2.1）；版本号提交 `f01fcd2` 与它只差文档和一个测试，没有代码差别。

## f0.4+ — 2026-11-02（package 0.4.1）

基于 f0.4（`8b210ba`）。主题：**Hermes Agent 成为第三种 agent**——同一套飞书泡波卡片，背后可以按 profile 选 Claude Code、Codex 或 Hermes Agent。f0.4 发布后在 main 上陆续上线的修复（群全员可用、外人轮次能干活、群命令只给管理员、按聊天配模型等）也一起收进这个版本。

### 亮点：Hermes Agent 接入（`agentKind: hermes`）
- **一个 profile 选一种 agent**：`aiduCAT profile create <名字> --agent hermes`。建 profile 时把 `hermes` 的绝对路径记进配置（Hermes 安装器放在 `~/.local/bin`，systemd 用户服务的 PATH 里常常没有它；也可用 `LARK_CHANNEL_HERMES_BIN` 指定）。配置块 `hermes: { binaryPath, profile?, outsiderToolsets? }`，`profile` 对应 `hermes --profile <名字>`，不写就用 Hermes 自己的默认 profile。功能开关 `features.hermes`（默认开）。现有 Claude Code / Codex profile 行为不变。
- **每轮起一个 `hermes chat` 客户端**：`hermes chat --query-file - --format stream-json --source tool`，消息走 stdin，不经过命令行和 shell；正文增量、工具调用、工具结果实时进卡片面板。`--source tool` 让这些轮次不混进 Hermes 自己的终端会话列表。
- **owner 和其他人各一份 Hermes 会话**：Hermes 在建会话时把模型、工具集、`--yolo` 这些启动参数冻结，换参数续会话会被拒绝，受限会话续下去又会一直受限。所以每个聊天存两份会话：owner 的、其他人的。外人看不到 owner 的对话，owner 也不会被外人的限制拖住；换模型自动开新会话；万一续会话被拒，自动开新会话重试一次。
- **owner 轮次无人值守**：带 `--yolo`（飞书里没人能点 Hermes 的审批），工作目录 = 当前聊天的工作目录。
- **外人轮次只给安全工具**：群里别人 @、白名单用户、文档评论的轮次带 `-t todo --ignore-rules`：只剩 todo（可在 `hermes.outsiderToolsets` 加 `web`，其他工具集一律滤掉），不加载 AGENTS.md / SOUL.md / 记忆 / 技能。原因：Hermes 的 terminal、文件、代码执行等工具都在 owner 自己的 Hermes 进程里、用 owner 的权限跑，没法像 Claude Code 那样套沙箱，干脆不给。传给 Hermes 的环境变量不带任何 provider 密钥和 `HERMES_*` 开关（Hermes 用它自己 `~/.hermes/.env` 里的模型配置）。
- **/stop 只能停卡片**：Hermes 0.22 的 `hermes chat` 把活交给本机按需启动的 Hermes 后台进程；aiduCAT 停的是客户端（SIGINT，卡片立刻变黄结束），后台会把已经接下的那一轮做完。README 写明了。
- `/status` 显示 owner 和其他人的会话 id，权限一行显示「owner 全部（--yolo）/ 其他人 todo」；`/resume` 对 Hermes 回一句说明（历史由 Hermes 自己保管，同一聊天自动续，`/new` 开新会话）。Hermes 的协议里没有思考内容，卡片没有思考段；token 是整轮累计，不显示上下文占比。
- **真机实测**（instabox-rose，Hermes Agent 0.22.5，模型走 10router）：owner 调 terminal、工作目录正确、同会话续聊、外人轮次拿不到密钥也看不到 owner 对话、外人之后 owner 照常续自己的会话、换模型开新会话、/stop 后卡片 0.1 秒内结束而 Hermes 后台把那一轮做完，全部符合预期。

### 并入 f0.4 之后的修复
- **两个服务同时启动不再撞锁**：两个 profile 共用 `~/.aiducat/registry`，以前 registry 锁拿不到就直接报 `Lock file is already being held` 退出（开机或一起重启时其中一个要等 systemd 5 秒后拉起，NRestarts=1）。现在登记/改名/注销都会退避重试（约 35 秒，比 30 秒的过期判定长，被强杀进程留下的旧锁也会被接管）；退出钩子里的同步注销也会短暂重试。
- 共用的 `config.json` 锁原来只等约 1 秒，同样改成上面的重试。
- 注册表里进程已死的旧记录直接清掉，不会因为对方刚拿锁还没写完锁信息而让本进程启动失败。
- **群里可以开「全员可用」**：以前群在白名单还不够，发言人本人也得在 allowedUsers / admins / owner 里，否则静默不回（小猴² 11-02 09:53 群里被别人 @ 不回，日志 `skip-not-allowed-user reason=denied-user`）。现在 profile `access.chatAllowAllUsers` 列出的群（且在 `allowedChats` 里）所有真人成员都能用；在群里发 `/invite alluser` 开/关（只有 owner/管理员能发，热更新不用重启）；`/remove group` 会一起清掉这个开关。其它机器人仍按 `allowedBots` 拒绝，owner/管理员、@ 规则不变；不开的群行为不变。非 owner 的轮次照旧不带 settings.json 里的凭据。
- **非 owner 轮次启动失败不再把原始英文报错发到群里**（小猴² 11-02 11:14 群里被别人 @，回了「⚠️ claude exited with code 1: … bubblewrap is required …」）。原因：非 owner 的轮次设了 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`，Claude Code 2.1.3xx 在 Linux 上因此必须有 bubblewrap，没装就直接起不来；与私聊并发无关。现在 agent 进程启动失败/异常退出时：群聊、非 owner 私聊、文档评论一律只显示「暂时没法处理这条消息，请稍后再试。原因已记到日志，管理员会去看。」；owner 私聊显示一行简短原因；完整报错只进日志（`run failed`）。消息预处理失败（附件、引用等）同样按这个规则。隔离不变（非 owner 仍设 SCRUB=1）。Linux 上启动时如果 PATH 里没有 `bwrap`，日志里 warn `bwrap-missing`（装 `bubblewrap socat`）。
- 非 owner 轮次结束后清掉 Claude Code 沙箱在工作目录里留下的空占位文件（`.env*`、`package.json`、各种 lock、`.npmrc`、`node_modules/.bin`、`.claude/{agents,commands}` 等）：只删这一轮新建、并且仍是空文件/只有空目录的；原来就有的、有内容的一律不动。owner 轮次不受影响。
- **群里非管理员不能用斜杠命令**（Wei 11-02 11:35「群里非管理员一概不能用 slash 命令」）：群里不是 owner/管理员的人发任何 `/` 开头的消息（已注册的 /help /status /new /stop /resume /timeout /doc…，以及没注册的 `/xxx`；`@机器人 /xxx` 去掉 @ 后同样算），都不执行，也不交给 Claude Code / Codex（以前没注册的 `/xxx` 会当成提示词交给 agent，可能触发 Claude Code 自带的斜杠命令）。@了机器人时回一句「群里只有管理员能用命令。」，没 @ 时静默；被拦的消息不会打断/清掉同一会话里已排队的消息。卡片按钮在群里同样只认 owner/管理员。私聊、群里 owner/管理员不变。日志 `group-slash-denied`。
- **模型按聊天单独配置**：私聊里 `/model` 改 profile 默认（和以前一样）；在某个群里 `/model` 只改这个群（存 `profiles.<name>.preferences.chatModels[chat_id]`，热更新）；没单独设的群跟默认（默认改了它也跟着变）。每轮的 `--model`、provider 环境变量、effort、上下文窗口和 60% 自动压缩都按该聊天实际用的模型算。`/status`、`/new` 显示当前模型和来源（本群设置 / 跟随默认）。群里 `/model` 卡片多一个「↩️ 恢复跟随默认」，也可发 `/model reset`。`/remove group` 一起清掉该群的模型设置。`/model` 仍是管理员命令。
- **群里别人 @ 的轮次能正常干活了**（Wei 11-02 11:52）：非 owner 轮次仍开 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`（Claude Code 因此强制 permission mode = default），现在通过 `--settings` 显式放行 Bash（只在 bubblewrap 沙箱里跑、关掉绕过沙箱的口子）和工作目录内的读写；同时拒读 settings.json（含项目级 `.claude/settings*.json`，以前项目级的漏了）、`~/.ssh`、`~/.aiducat`、`~/.config/aiduCAT`、`~/.lark-cli` 等凭据目录、`.env`、`/proc`，工作目录的 `CLAUDE.md` / `.claude/` / `.mcp.json` 只读。装了 containerd 的机器（`/run/containerd` 0711）上沙箱 Bash 原来每条都报 `Can't mkdir parents for /run/containerd/containerd.sock`（bubblewrap 0.12 + claude-code#93144）：现在这类轮次在私有挂载命名空间里起 Claude Code（`unshare --user --map-current-user --mount`，只映射自己的 uid，起 Claude 前 `setpriv` 清掉能力），把 `/run/containerd` 盖成空目录再交给沙箱——**不改 `/run/containerd` 权限**，这类轮次反而更碰不到 containerd。主机禁止非特权用户命名空间时（如 Ubuntu 24.04 的 AppArmor 默认）自动不套这一层（启动后第一次用到时探测一次，日志 warn `runtime-dir-mask-unavailable`），照旧直接起 Claude Code。owner 轮次不变。沙箱里的 Bash 不能联网（Claude Code 沙箱默认），WebFetch/WebSearch 可用。
- **群里别人 @ 的轮次，沙箱里的 Bash 也能上外网了**（Wei 11-02 12:43「让小猴在群里跟正常的 agent 一样就行，只是不能让非管理员用 slash 命令，不要太复杂」）：非 owner 的 `--settings` 多放行一条 `WebFetch(domain:*)`，Claude Code 会把它当成沙箱网络白名单（≥ 2.1.186），`curl`/`pip`/`npm` 直接通。文件隔离不变：settings、`~/.ssh`、`~/.aiducat`、`~/.config/aiduCAT`、`~/.lark-cli`、`.env`、`/proc` 照样读不到；本机回环/内网地址仍被沙箱代理拒绝（摸不到 aiduMEI、网页控制台）；非管理员仍不能用斜杠命令。顺手删掉 `buildNonOwnerSettings` 不传 cwd 时的旧分支（只剩一种形状）。注意：`git` 会用机器自己 `~/.gitconfig` 里的 `http.proxy`，如果那是本机回环代理（summer 是 `127.0.0.1:18888`），沙箱里的 git 访问 GitHub 会失败。
- **外人轮次可以额外封掉指定文件**（Wei 11-02 13:52）：profile 新增 `access.outsiderDenyRead`（路径列表，绝对路径或 `~/…`；最后一段可带 `*`，按运行时目录里现有文件展开，备份 `.bak_*` 一起盖住）。非 owner 轮次里这些路径 Read 工具读不到、沙箱 Bash 的 `cat`/`python` 等也读不到，也不能改写；owner 轮次不变；不配就没有额外限制（嘟嘟没配）。小猴² 配上了 `角色记忆.md`、`服务器信息.md`、`救火手册.md`（含备份）——这三份有服务器/拓扑信息，以前外人轮次照小猴守则第 1–3 条会去读；守则文件本身照常每轮带上。改配置要重启该服务。

### f0.4+ 之后的修复
- 中文名改为「爱嘟妙咪飞」（妙=喵、咪=猫、飞=飞书；绝妙设计的迷人简洁飞书卡片），全称 aiduCAT☤爱嘟妙咪飞；英文全称 Coding Agent Texting（去掉 Claude，三种 agent 通用）。
- **模型 logo 回到面板头左侧、紧挨模型名，展开时不再翻转**（Wei 11-02 19:33「我就要这个模型logo在model的左侧，这样才自然才对，能不翻滚最好」）：以前有 logo 时没写 `icon_position`，代码注释以为默认靠左，其实飞书卡片 JSON 2.0 折叠面板默认 `right`，所以 logo 跑到面板最右边、占了箭头的位置，展开时还跟着箭头转 180 度。现在有 logo 时显式 `icon_position: left`、`icon_expanded_angle: 0`；没有 logo 的模型照旧右侧折叠箭头、展开翻转。版本号不变（0.4.1）。

## f0.4 — 2026-11-02（package 0.4.0）

基于 f0.3+（`8d6b4d1`）。把没单独发布的 0.3.3、0.3.4、0.3.5、0.3.6 合成一个版本发布（这四个版本号只在 summer / winter 上跑过，没打 tag）。主题：飞书里回得更快、卡片更干净、数字更准。

### 一收到消息就有反应
- **收到即出卡**：消息一被接收（过了权限、@、命令判断、进队列的那一刻）就发出一张流式卡片，只有一行「☤aiduCATing…」。不等 0.6 秒防抖、不等上一轮跑完、不等并发名额、不等起 Claude Code。
- **面板等 agent 开口才出现**（0.3.6）：这张卡一开始没有折叠面板、没有空面板框；agent **第一次思考、调工具或出正文**（谁先到算谁；只发最终答案的网关在答案到时），面板才出现在**同一张卡**里，之后照常流式（☤Thinking… / ☤Processing… / ☤aiduCATing…）。纯正文、没思考没工具的轮次，面板和第一段正文一起出现，头是 `模型 · 💭 0 · 🛠️ 0 · ⏱️ 用时`。结束态（✅ ⭕️ ❌ ⚠️）照样带面板，边框颜色说结果。
- **排队的消息各自一张卡**：上一轮还在跑时新来的消息马上有自己的卡，轮到它时接着用；同一批合并的多条消息共用一张卡。
- **没用上的占位卡会撤回**：这一批被命令清掉队列、服务停机排空、开跑前被拒或预处理失败时，撤回那张占位卡，不留空卡。
- **不再加飞书表情**：卡片模式的 Claude 用这张卡当"收到了"的信号，不再调表情接口（0.3.4 曾把表情提前到 flush 一开始，0.3.5 起卡片模式直接不用）。markdown/text 模式（没有卡）和 Codex（仍按有内容才开卡）保留表情。
- 实现：流式卡片本来就是每帧整卡更新（`im.v1.message.patch`，250ms 节流、串行），面板只是下一帧多出来的元素，不加新接口、不改节流；某一帧失败下一帧带全部内容重来，最后一帧失败走原来的降级（同卡修复 / 纯文本），不丢内容。没用 CardKit 元素插入接口（要另建卡片实体、管 sequence，多一种失败方式）。

### 开跑更快：只拉 10router combo
- **不再拉 `/v1/models` 全量模型表**（715 个模型，约 200KB）：以前两条消息隔 10 分钟以上，下一轮开跑前要同步重拉这张表，约一半轮次因此多等 4.5–5.5 秒。现在只用 `/api/combos`。`/model` 下拉照旧只列 combo。
- **combo 列表先用旧的、后台再刷新**：缓存 5 分钟，过期时立刻用旧列表、后台刷新一次（并发只发一个请求），刷新失败保留旧列表；**启动时预热一次**。对话这条路只读缓存，从不等 10router。`/model` 提交校验在缓存过期时会等一次刷新（点卡片时，不在对话路径上）。

### 上下文窗口跟 settings.json 走（1M）
- 窗口取 combo 自带的窗口字段（`/api/combos` 有 `contextWindow` / `context_window` / `capabilities.contextWindow` 时）→ provider 的 `contextWindow`；都没有时 aiduCAT 不覆盖，Claude Code 用自己 `settings.json` 的 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW`，`/status` 的分母和 🗜️ 也读这两项。
- 部署时 summer 的 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 900000 → 1000000（与 winter 一致），`AUTO_COMPACT_WINDOW=600000`、`MAX_OUTPUT_TOKENS=32000` 不变，`/status` 分母 1M。注意：同一台机器上多个 profile 共用这一份 `settings.json`。

### TPS 算对了，只在 /status 显示
- **以前的 ⚡ 是错的**：用「累计输出 ÷ 累计 `duration_api_ms`」，但续接会话（`--resume`）时 claude 给的 `duration_api_ms` 是**整个会话的累计值**，每轮再加一遍越滚越大（嘟嘟一个会话 43 轮累出约 21.7 小时，⚡ 只有 4 tok/s）。
- **现在按轮自己计时**：从 Claude Code 起来到模型最后一次输出，**扣掉所有工具执行时间**（并行工具算到最后一个返回），不含排队、起进程、等工具。分子是本轮主线输出（每次 API 调用最终的 `message_delta` 用量相加，子代理不算，与整轮 result 取较小值防重复）；Codex 没有逐次用量时用整轮输出。
- **只在 `/status` 显示**：⚡ = Σ本轮输出 ÷ Σ本轮有效生成时间（会话平均），还没测到显示「—」。卡片面板头**不再显示 `⚡ N tok/s`**（卡上是本轮、/status 是平均，两个数不一样容易看糊涂）。被停止/失败的轮次不计入。旧会话里错的 `activeMs` / `tpsAvg` 加载时丢掉，其它计数保留。

### 群聊也用面板卡片
- 上游把群聊写死成富文本（post）回复，群里没有卡片和面板。现在群聊和私聊一样走流式卡片，也有「☤aiduCATing…」占位卡。**工具行在群里默认隐藏**，`preferences.showToolCallsInGroups: true` 才显示；只调工具也会让面板出现（🛠️ 0）。
- **卡片里的 @ 是真 @**：agent 写的 `<at user_id="ou_…">名字</at>` 改写成卡片格式 `<at id=ou_…></at>`，对方会收到提醒（以前卡片把所有 HTML 标签删掉）；@所有人 仍变成文字。

### aiduPARK 图标
- **专属黑白翅膀 logo 从 combo `monkey` 挪到 `aiduPARK`**：模型 id 含 `aidupark`（不分大小写，带前缀/后缀也算，如 `10router/aiduPARK`、`aiduPARK[1m]`）就显示这个图标，排在所有厂商规则前面。旧 combo `monkey` 不再有专属图标。`assets/lark-logo-keys.json` 键名 `monkey` → `aidupark`，img_key 不变，不用重传图片。

### 日志
- **毫秒耗时**：`intake enter`、`flush start`、`early-card-open`、`progress-stream-open`（非卡片模式还有 `reaction added`）带 `atMs`（本机毫秒）和 `sinceMsgMs`（距飞书消息创建），jsonl 时间戳只到分钟，查慢先看这两个字段。
- **用量日志能看了**：日志会把键名含 `token` 的字段打码，以前 `inputTokens`/`outputTokens` 全是 `[REDACTED]`；改成 `inTok`/`outTok`，加 `callFinal`。claude 的 `total_cost_usd` 在续接会话里也是累计，改名 `sessionCostUsd`。每轮一条 `turn-tps`（`outTok`、`genMs`、`tps`）。

### 一份代码跑两个机器人（双 profile）
- 同一个代码目录、同一份 `dist`，用两个服务分别跑 `--profile claude` 和 `--profile xiaohou`，各连自己的飞书 app，数据各在 `~/.aiducat/profiles/<名字>/`（sessions.json、run-journal.json、logs/）。换 `dist` 只影响之后启动的进程，**两个服务都要重启才换版本**。停服务时有在途轮次会先排空（最多 `shutdownDrainMinutes`），被打断的轮次起来后自动在同一张卡上续跑。

## f0.3+ — 2026-10-31（`8d6b4d1`，package 0.3.2）

基于 f0.3.1（`bd79bcb`）。嘟嘟和猴哥自己用，体验优先：不用的模块可以关掉，收紧不能让日常用起来更麻烦。

### 功能开关（Y 路）
- **profile 级 `features: {meeting, webConsole, codex, cot}`**：不写 = 全开（行为不变）；只有显式 `false` 才关。关掉的模块**不加载**（懒加载），相关命令在 `/help` 里隐藏，调用时回「此功能未开启」：
  - `meeting`：`/meeting`、会议推送与自动入会、控制台会议接口；即使 `meeting.enabled: true` 也不创建会议管理器。
  - `webConsole`：`run/start --web-ui` 拒绝启动、`aiduCAT ui` 拒绝、`/config` 不显示控制台那一行。
  - `codex`：`agentKind: codex` 的 profile 拒绝启动；`/resume` 不读 Codex 历史。
  - `cot`：CoT 过程消息强制关闭（偏好值保留，重新打开后恢复），`/config` 不显示「COT 过程消息」选项。
- **懒加载 + 拆包**：会议、CoT、Codex、Web 控制台（含约 430KB 内嵌页面）改为按需 `import()`，构建开启 code splitting。启动时加载的代码 1,205,897 B → 655,424 B（−46%）；`--version` 进程 heapUsed 中位数 38.0 → 36.0 MB。默认配置下（会议没启用、CoT 偏好关）这些模块本来就不会被用到，现在也不再被加载。
- **`[claude-code:unrecognized_model]` 提示每个模型每个进程只记一次**：网关模型（如 Gemini-3.8-Flash）每轮都会触发这条 Claude Code 官方说明的提示，f0.3.1 已降为 info，但每轮仍写一行；现在同一模型只记第一次。没有用 `modelOverrides` 消掉它，因为那会让 Claude Code 把 Gemini 当成某个 Claude 模型（effort/thinking/窗口都跟着变）。
- **超长回答改成多张续卡**（f03p-fix-#8，猴哥反馈：生产 10:14 一条 17,451 字的回答被截断后又整段发了纯文本「📄 全文」，格式没了、内容重复）：第 1 张流式卡显示到预算边界，在段落/代码块/表格边界切开，末尾「…（未完，见下一张卡）」；之后按顺序发「续 2/N」「续 3/N」卡片，markdown 正常渲染，每张 <30KB、无 `![`、无 HTML。超大代码块按行切开、每段重新开合同样的围栏和语言；超大表格按行切开、每段重复表头；超长段落按行→句→字切。不再发纯文本全文；只有续卡被飞书拒收时，从那张起的剩余部分改发一次纯文本。拒卡降级（严格卡 → 纯文本 → 失败提示）不变，严格卡放不下的部分同样走续卡。Codex 非流式回复同样分卡。
- **运行中构建不再让下一轮报错**（f03p-fix-#7）：拆包后正在跑的进程会按需 `import()` 分块，旧构建 `clean` 会先清空 `dist/`，服务运行中 `pnpm build` 会让它下一轮找不到分块。现在构建先写到 `dist/.next`，再发布：新分块（文件名带内容哈希）先移入，`dist/cli.js` 原子改名替换，保留最近 3 次构建的分块（`dist/.generations.json`），更早的自动删除。启动体积不变。升级仍建议先停再构建，但不再是必须。
- 删除没人引用的 `src/agent/index.ts`；模型 logo 表在 cwd 不是仓库根时也能从 `dist/` 找到。

### 基础设施（X 路）
- **优雅重启**：收到 SIGTERM/SIGINT（`systemctl --user restart/stop`）后不再接新轮次，先等在途轮次跑完再退出，最多等 `preferences.shutdownDrainMinutes` 分钟（默认 10，`0` = 立即停 = 旧行为，上限 60）。排空期间新来的消息记进 run journal，每个会话回一次「⏳ 服务正在重启，这条消息已记下，重启后会自动接着处理」，重启后自动接着处理；排空期间 `/stop` 的轮次不会被续跑。systemd 单元需要 `KillMode=mixed`（SIGTERM 只发给 bridge，不直接杀它跑着的 agent）和 `TimeoutStopSec=660`（比排空上限长），`aiduCAT` 安装的单元已自带；手写的单元要自己加。
- **重启自动续跑**：被重启打断的轮次（排空超时或 agent 被一起杀掉），如果服务 10 分钟内回来、会话能恢复，就在**同一个 Claude 会话**里自动发一次「（服务重启，接着刚才的继续）」：旧卡片标「🔄 服务重启后自动继续（见下一张卡片）」，新卡片接着答。只续一次（续跑那轮再被打断就回「请重发」），超过 10 分钟或会话没了也回「请重发」。journal 只记消息 id 等元数据，不存原话。
- **数据目录 `~/.lark-channel` → `~/.aiducat`**：新装默认 `~/.aiducat`；只有旧目录的机器照常用旧目录（启动时提示一行），两个都有时新的优先；`LARK_CHANNEL_HOME` 仍然最优先。迁移命令 `aiduCAT migrate-home [--dry-run] [--from <dir>] [--to <dir>]`：先停服务；复制全部内容（保留权限和时间）→ 改写小配置文件里指向旧目录的绝对路径（日志、媒体逐字节复制不改）→ 在临时目录里校验（逐字节比对、JSON 能解析、keystore 在新位置能解密）→ 改名到位；`~/.aiducat-workspaces` 做成指向旧工作目录的链接，会话 cwd 不变、Claude 会话照常续。**旧目录一字不动**；旧目录的 bridge 还活着或目标已有内容时拒绝。命令按需加载，不进启动包。`/cd` 黑名单同时拒绝 `~/.aiducat` 和 `~/.lark-channel`。
- **`settings.json` 里的 token 只给 owner 的轮次**：`~/.claude/settings.json` 的 `env`（如 `GH_TOKEN`、`CLOUDFLARE_*`、`AIDU_*_TOKEN`）Claude Code 会注入给所有工具。现在非 owner 发起的轮次额外带一个 `--settings` 临时文件（0600）把这些凭据键置空（`ANTHROPIC_*`/`CLAUDE_*` 保留，否则 Claude 无法应答），并设 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`、禁止 Read/Edit 凭据文件。**owner（猴哥/嘟嘟）的轮次零变化**，`gh`/Cloudflare 照常可用。只读键名，不读值，不改 summer 上的 settings.json。限制：给非 owner 开 `full` 权限时仍能直接 cat 文件，所以非 owner 保持 `workspace`。
- **权限自收紧**：启动时后台把数据目录收紧为目录 0700、文件 0600（带执行位的如 `secrets-getter` 为 0700）；幂等、不跟随链接、失败不阻塞启动；数据目录误指 `~` 或 `/` 时不动；`<数据目录>-workspaces` 不动。
- **`/cd` 可选白名单 `workspaces.roots`**：profile 里 `"workspaces": { "roots": ["~/proj", "/srv/work"] }`（绝对路径或 `~/…`）后，`/cd`、`/ws use` 和会话自己的 cwd 必须在其中某个目录下（按真实路径判断，黑名单照样生效），否则回「这个目录不在允许的工作目录范围内」；profile 的 `workspaces.default` 是 owner 自己定的，不检查。不配 = 原行为（只有黑名单）。
- 与功能开关的交叉：四个开关全关时，优雅重启、自动续跑、migrate-home 均不受影响；`features.cot=false` 时自动续跑的卡片照常（不发 CoT 过程消息）；migrate-home 原样保留 `features`、`workspaces.roots`、`shutdownDrainMinutes`（f03p-fix 测试）。

### 设计如此（不改）
- **keystore 同用户可解**：`secrets.enc` 用同目录 `.keystore.key`（0600）加密，防的是别的用户和误传文件；同一系统用户下的进程（包括 agent 自己）能解开，这是本机单用户部署的取舍。
- **`aiduCAT ui` 在本机打印完整 URL（含 token）**：只在本机终端输出，用来打开控制台；日志、journald 与飞书里的控制台地址都已打码（f0.3.1）。

## f0.3.1 — 2026-10-31（`bd79bcb`，package 0.3.1）

基于 f0.3（`3aa4a2d`）。修掉「卡片被拒 → 永久思考中」、`/status` 数字不真实、60% 自动压缩从没生效等问题，门禁转绿。

### 卡片稳定性
- **卡片被拒自动降级**：最终更新失败 → 严格卡重试（不带图片链接、答案 ≤12KB、不带思考/工具列表）→ 纯文本消息补发答案 → 最后发一句「⚠️ 卡片发送失败，本轮回答没能送达，请重发一次」。首卡就发不出时同样走这条链。卡片不会再停在 Thinking。
- **答案清洗**：`![alt](url)` 转成 `[🖼 alt](url)` 链接，`<img>` 转链接、其他 HTML 去掉（代码块里不动）；答案上限 25KB，超出截断并补发纯文本全文（f0.3+ 起改为续卡，见上）；整卡控制在 28KB 内（飞书上限 30KB）。
- **SDK 节流更新失败不再变成 unhandledRejection**：pnpm patch `@larksuite/channel`（随 SDK 升级重做为 0.7.1 版 patch），失败记到 `lastPatchError`，最后一次失败交给降级链。
- **空跑保护真正生效**：检查挪到 `reduce` 之后（f0.3 里会被 `done` 覆盖回绿卡），带原因文案。
- **节流 60ms → 250ms**（飞书单条消息更新 5 QPS），关掉 SDK「累计 50 字符立即发送」的触发。
- **不再把被拒卡片明文写进 `/tmp/aiduCAT-rejected-card.json`**，日志只记 sha256 前缀、字节数、错误码。

### `/status` 真实化
- 上下文 = 最近一次**主线**调用的 `input + cache_read + cache_creation`（以前只算 `input_tokens`，网关下只有几千）；子代理调用不覆盖。
- 窗口与 🗜️ 压缩点和运行时同一来源；不知道时显示 `—`，不再写死 1M。
- 统计重启不清零（格式 v2，部署时旧统计丢弃一次）；📥/📤 按每轮 result 累加；🎯 = cache_read / 全部 prompt；⚡ TPS = 输出 / 模型生成时间（`duration_api_ms`）。
- 🚩 开始时间读 Claude 会话记录（`~/.claude/projects/*/<session>.jsonl`）第一条时间戳，读不到回落到统计开始时间。
- 模型行没设偏好时显示 CLI 实际上报的模型；新话题首条消息计入；`/resume` 切会话清旧统计；`/stop` 空闲时回一句提示。
- Codex 每轮 Agent 消息只记 1 次（以前 `final_text` 和 `done` 各记一次）。

### 自动压缩
- 10router 模型窗口查询改用 bot 环境里的 `AIDU_10ROUTER_TOKEN`（`x-10r-cli-token`），`ANTHROPIC_API_KEY` 保留为备选。以前只认 `ANTHROPIC_API_KEY`，生产 bot 环境没有 → 查询静默为空 → 60% 压缩从没生效。
- 查不到窗口（没凭据 / 请求失败 / 模型不在列表）时打 `context-window unresolved` warn 日志（10 分钟内同原因同模型只打一次，不含 token），并沿用 Claude Code 自己 `settings.json` 的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`。

### 命令与文档
- `/help` 列全 20 个已注册命令（补上 `/reset /invite /remove /doc /meeting`），加测试保证命令注册表与 `/help` 一致。
- 用户看到的提示、帮助、CLI 程序名、控制台标题、agent 系统提示词里的 `lark-channel-bridge …` 统一改成 `aiduCAT …`。数据目录 `~/.lark-channel`、服务名、`bin/lark-channel-bridge.mjs`、协议字段 `source` 不变（改名需迁移，单独排期）。
- 三份 README 统一（版本 f0.3.1、命令表与代码一致、卡片长相按现行代码、从零安装改为 pnpm），`README.zh.md` 与 `README.md` 同内容；新增本 CHANGELOG。
- 删除约 300 行死代码（未用 import、`resolveConflict`、`toolBodyMd`、`readRecentLogs` 等）。

### 测试与门禁
- 修 typecheck 错误、16 个过时测试、markdown 降级套件；新增 card 模式降级回归与 `/status`、命令、文档等 f031 用例。全量 typecheck / test / build 全绿。

### 安全加固、稳定性与上游修复

#### 安全（审计 19 条全修）
- **默认权限收紧**：没写 `permissions` 的 profile 默认 `workspace`，`full` 只能在配置文件里显式写；群聊运行封顶 `permissions.groupMaxAccess`（默认 workspace），评论/会议/team 模式一律封顶 workspace，私聊不封顶。Codex 不再兜底 `danger-full-access`，Claude 没传策略时也不再 bypass。
- **群里谁能叫**：白名单群里发言人本人也要在 allowedUsers/admins/owner；别的机器人默认拒绝（`access.allowedBots` 显式放行）；team 模式只对 owner 同租户开放；卡片按钮点击同规则复核。云文档评论与私聊同一白名单（回归测试）。
- **agent 拿不到守护进程的密钥**：子进程环境变量改白名单（PATH/HOME/LANG/LC_*/代理/证书 + Claude 的 `ANTHROPIC_*`/`CLAUDE_*`、Codex 的 `OPENAI_*`/`CODEX_*`），其他变量要在 profile `agentEnv.passthrough` 放行；agent 不再拿到 bridge 配置路径；Codex `shell_environment_policy.inherit="core"`。群里默认不显示工具调用（`preferences.showToolCallsInGroups` 可开）。回复统一做密钥形态脱敏（sk-、ghp_、Bearer、JWT、PEM、`*_API_KEY=` 等）。
- **不能借 owner 身份**：非 owner 发起的运行（私聊/群/评论/会议/会后纪要）完全不带 lark-cli 配置，并钉死 bot 身份。
- **间接提示注入**：引用消息、话题上文、卡片、评论原文与他人回复、其他机器人的话统一包进 `<untrusted_content>`，伪造的闭合标签被拆掉。
- `/model`、`/new chat` 只限管理员；`/config` 卡片不再带控制台 token，`start` 输出的控制台地址打码；会议里只有白名单的人能叫/叫停，自动入会只认 owner/admin 邀请。
- 日志目录 0700、日志文件 0600，数据根/profile/媒体缓存目录 0700；日志字段与文本脱敏增强。
- `/resume` 只收 UUID；`/cd` 拒绝凭据/系统目录（含子目录）；普通用户 `/status` 只看自己的会话；provider `env` 禁止 `LD_*`/`NODE_OPTIONS`/`PATH`/`LARKSUITE_CLI_*` 等危险变量；回复里 @所有人 变成文字；代码围栏防逃逸；删除死分支。
- **依赖漏洞**：`pnpm.overrides` 抬升 protobufjs / ws / follow-redirects / qs / @protobufjs/utf8，`pnpm audit --prod` 20 个（8 high）→ 0。

#### 稳定性
- **SDK 升级 `@larksuite/channel` 0.6.0 → 0.7.1**，patch 重做；markdown 流式模式中途失败后最后一帧会重推，`setContent` 走节流（上游 #289）。
- 长连接 `connectTimeoutMs` 8s / `pingTimeout` 20s；旧 agent 进程退出后才开新一轮（避免"发两次"）。
- **空闲看门狗默认开**：15 分钟无输出即停（`preferences.runIdleTimeoutMinutes`），单个工具最长 30 分钟（`preferences.runToolTimeoutMinutes`）。被停/超时/出错的轮次里没跑完的工具显示 ⏹（卡片与 COT 时间线）。
- **重启恢复**：`run-journal.json`（0600，含排队消息原文）记录队列与在途卡；重启后 10 分钟内的排队消息自动重放，更早的回「请重发」，在途卡标「服务重启，请重发」。
- keystore 从 hostname 推导改为 key 文件（`.keystore.key`），首次启动自动迁移并备份旧库（上游 #242）。
- `uncaughtException` 记录后退出进程，交给 systemd `Restart=always` 拉起；`unhandledRejection` 只记录（上游 #287）。日志写入失败、单日日志超限不会拖垮进程。
- 运行前步骤（附件/引用/话题上下文/整理消息/准备运行）出错时回用户一句明确的错误，不再静默；**单个附件下载失败**不再静默：agent 照常运行，提示词里点名哪个附件没下载下来，并要求 agent 在回答里告诉用户、需要时请对方重发。
- `/ps`、`/exit`、`status`、`profile list` 不再把已退出的进程当成在跑（上游 #290）；`/invite group` 后同一 profile 的所有连接立即生效（上游 #296）。
- 非 Claude 模型不再传 `--effort`（只打一次 info），`unrecognized_model` stderr 降为 info；`/model` 卡上非 Claude 模型标「经网关翻译」。
- 其他上游修复：#277 #286 #309（引用消息）#148 #299/#183；子进程不继承 `HERMES_HOME`/`OPENCLAW_HOME`。

#### 部署注意
- 必须 `pnpm install --frozen-lockfile`（打 SDK patch）；部署前备份整个 `~/.lark-channel`（含 `profiles/<profile>/.keystore.key`、`secrets.enc`）；回滚到旧版要把 `secrets.enc.bak-hostname-kdf` 拷回 `secrets.enc`。
- 想保持旧的 full 权限与环境变量，要在 profile 里显式写 `permissions` 和 `agentEnv.passthrough`（见 README「权限」）。
- `/status` 统计部署后清零一次；agent 系统提示词首行改名，首轮提示词缓存 miss 一次。

## f0.3 — 2026-10-30（`3aa4a2d`，package 0.3.0）

- 空跑保护：agent 秒退时想显示报错卡（实际顺序有 bug，f0.3.1 修复）；post-done grace 2s → 15s。
- 合并 PR #3（@hermesai8888-creator）：云文档评论走与私聊相同的白名单；群里机器人互相 @ 防循环（每小时 5 次）；非 10router 网关的 60% 自动压缩回退到 provider `contextWindow`。
- 第 30 个厂商 logo（monkey）；logo key 表随新应用重传更新。
- README：「不用 10router？三步接入你自己的网关」。

## f0.2++ — 2026-10-21（`c7ff90d`，package 0.2.2）

- 面板头改一行极简：`模型 · 💭 n · 🛠️ n · ⏱️`，状态词移到面板上方（notation 字号），会话列表预览带 ☤ 前缀状态词。
- `/status` 改为六行卡：会话 id、模型 · 强度 · 🗜️、运行权限/owner、lark-cli/运行/队列、开始时间/时长/消息数、上下文与 token 统计；`/new` 保留统计骨架。
- 自动压缩 = 模型声明窗口的 60%（百分比，不写死 token 数）。
- TPS 分母改为 agent 实际执行时间；Agent 消息在 run `done` 时计数。
- Inception Labs（Mercury）厂商 logo。

## f0.2+ — 2026-10-20（tag `6fa62f8`，package 0.2.1；版本号提交 `f01fcd2`）

- 修复：`/model` 切 Provider 后实际仍走默认网关（provider env 在 run-flow → executor → adapter 断链），合并社区 PR #1。
- 修复：Provider 下拉选「默认网关」提交被静默丢弃。
- 新增：Provider 静态模型清单与跨 Provider 并集下拉；Provider 可选 `env` 覆写；模型 id 支持 `/` `@`。
- 流式节流 400ms → 60ms（f0.3.1 改回 250ms）；状态词统一 ☤ 前缀；GLM 等 logo 多轮修正。
- 文档：多 Provider 配置、logo 上传指南、README.zh.md、容器部署注意事项。

## f0.2 — 2026-10-19（`a71bf5a`）

- 多 Provider `/model` 卡（Provider → Model → Effort）、29 家厂商 logo、单行面板头、clarify 重做。
- Codex：解析 reasoning / mcp_tool_call，单卡统一布局，按轮取 `last_token_usage`，运行中实时刷新上下文。
- 禁止 agent 重启自己所在的 aiduCAT 服务；零计数也显示；`/model` 强度选项按 Claude Code / Codex 区分。
- README 中文为默认，英文移到 README.en.md。

## f0.1+ — 2026-10-17（`d4acd98`）

- `/model` 交互卡（10router combo + 强度）、`/new` 回显模型与强度、Get 表情、状态行移到面板上方，品牌「爱嘟可爱糖」。
- `[CLARIFY]` 标记 → 飞书选项按钮，点选后答案回到本轮。
- `/help` 下拉直接执行；`/status` 只读卡。
- 两行面板头：强度 + 实时上下文。
- README 补运行时契约章节；横幅换成 aidu 家族同款。

## f0.1 — 2026-10-15（`b4c539f`，package 0.1.0）

- 首个版本：给 Claude Code 的泡波流式卡片——单个 aiduPOP 过程面板、面板头实时状态词（结束消失）、边框颜色表示结果（绿/黄/红）、去掉停止按钮（用 `/stop`）、工具 emoji、敲键盘表情（开跑即撤）、`/model` 自由透传模型 id。
- 基于上游 [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)（MIT）。
