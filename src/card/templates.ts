interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function actions(buttons: ButtonSpec[]): object {
  return { tag: 'action', actions: buttons.map(button) };
}

const HR: object = { tag: 'hr' };

function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

export function workspacesCard(current: string | undefined, named: Record<string, string>): object {
  const entries = Object.entries(named);
  const elements: object[] = [];

  elements.push(divMd(`当前 cwd：\`${escapeCode(current ?? '(未设置)')}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('暂无命名工作目录。'));
    elements.push(
      divMd('💡 发送 `/ws save <name>` 把当前 cwd 存为命名工作目录'),
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? '  ← 当前' : '';
      elements.push(divMd(`**${escapeMd(name)}** → \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: '切换到此处', value: { cmd: 'ws.use', name }, style: 'primary' },
          { text: '删除', value: { cmd: 'ws.remove', name }, style: 'danger' },
        ]),
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  return shell('📂 工作目录', elements);
}

export interface StatusInfo {
  profileName: string;
  cwd?: string;
  sessionId?: string;
  emptySessionText?: string;
  sessionStale: boolean;
  agentName: string;
  runtimeAccess: {
    label: string;
    value: string;
  };
  larkCliStatus?: 'app' | 'user-ready' | 'user-missing' | 'check-failed';
  activeRun: boolean;
  /** Global queue — admins only (f031-sec-L3); absent → `🚦 —`. */
  queue?: { active: number; waiting: number; cap: number };
  ownerState: string;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
  /** f0.2+ /status: session stats block (/new resets). */
  sessionStats?: {
    startedAt: number;
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheCreate: number;
    userMessages: number;
    agentMessages: number;
    tpsAvg?: number;
  };
  /** f0.2+: session start fallback for entries created pre-stats. */
  sessionUpdatedAt?: number;
  /** f031-func-#2: real session start (first transcript timestamp). */
  sessionStartedAt?: number;
  /** f0.2+ /status: current model/effort/ctx readout. */
  modelLine?: {
    model?: string;
    effort?: string;
    ctxUsed?: number;
    ctxTotal?: number;
    compactPct?: number;
    /** f04-group-cmd-model: where the model comes from (本群设置 / 跟随默认 / 默认). */
    source?: string;
  };
}

export function statusCard(info: StatusInfo): object {
  const sessionLine = info.sessionId
    ? `\`${info.sessionId}\`${info.sessionStale ? ' ⚠️ 旧 cwd，下一条会新建' : ''}`
    : (info.emptySessionText ?? '`(待首跑创建)`');
  const st = info.sessionStats;
  const fmtTok = (n: number) => {
    const t = (x: number) => x.toFixed(1).replace(/\.0$/, '');
    if (n >= 1_000_000) return `${t(n / 1_000_000)}M`;
    if (n >= 1_000) return `${t(n / 1_000)}k`;
    return String(n);
  };
  const ml = info.modelLine;
  const modelBits = [
    ml?.model ? (ml.source ? `${ml.model}（${ml.source}）` : ml.model) : ml?.source ? `模型（${ml.source}）` : undefined,
    ml?.effort,
    // 🗜️ = auto-compact trigger as a % of the model window (setting display)
    ml?.compactPct !== undefined ? `🗜️ ${ml.compactPct}%` : undefined,
  ].filter(Boolean) as string[];
  const startedAtMs = info.sessionStartedAt ?? st?.startedAt ?? info.sessionUpdatedAt;
  const dur = startedAtMs ? Date.now() - startedAtMs : 0;
  const durMin = Math.floor(dur / 60_000);
  const durTxt = durMin >= 60 ? `${Math.floor(durMin / 60)}h${durMin % 60}m` : durMin >= 1 ? `${durMin}m` : '刚刚';
  const startedTxt = startedAtMs
    ? new Date(startedAtMs).toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      })
    : '刚刚';
  // f031-#10: 🎯 = cache_read share of all prompt tokens (tokensIn already
  // includes input + cache_read + cache_creation).
  const cacheHitPct = st && st.tokensIn > 0 ? Math.round((st.cacheRead / st.tokensIn) * 100) : 0;
  // f031-#8: an unknown window stays unknown (no invented denominator).
  const ctxBits =
    ml?.ctxUsed !== undefined && ml?.ctxTotal
      ? `${fmtTok(ml.ctxUsed)}/${fmtTok(ml.ctxTotal)} (${Math.round((ml.ctxUsed / ml.ctxTotal) * 100)}%)`
      : ml?.ctxUsed !== undefined
        ? `${fmtTok(ml.ctxUsed)}/— (—%)`
        : '—/— (—%)';
  const tokenBits = `📥 ${st ? fmtTok(st.tokensIn) : 0} · 📤 ${st ? fmtTok(st.tokensOut) : 0} · 🎯 ${cacheHitPct}% · ⚡ ${st?.tpsAvg ?? '—'} tok/s`;
  // f0.2+ 猴哥终版 (2026-10-21): six lines — runtime/identity middle rows come
  // back (they were missed after the cleanup pass), placed between the model
  // line and the stats lines.
  const runtimeBits = [
    `🛡 ${escapeMd(info.runtimeAccess.value)}`,
    `👤 ${escapeMd(info.ownerState)}`,
  ].join(' · ');
  const queueLine = info.queue
    ? `🚦 ${info.queue.active}/${info.queue.cap} active, ${info.queue.waiting} waiting`
    : '🚦 —';
  const larkBit = info.larkCliStatus ? `🔐 ${info.larkCliStatus}` : '🔐 0';
  const runBit = info.activeRun ? '🏃 1' : '🏃 0';
  const lines = [
    `🏷️ **Session**: ${sessionLine}`,
    `🤖 ${escapeMd(info.agentName)}${modelBits.length ? ` · ${modelBits.join(' · ')}` : ''}`,
    runtimeBits,
    `${larkBit} · ${runBit} · ${queueLine}`,
    `🚩 ${startedTxt} · ⏱️ ${durTxt} · 💬 User ${st?.userMessages ?? 0} / Agent ${st?.agentMessages ?? 0}`,
    `⏳ ${ctxBits} · ${tokenBits}`,
  ];
  return shell('📊 当前状态', [divMd(lines.join('\n'))]);
}

export interface ResumeEntry {
  sessionId: string;
  displayId?: string;
  preview: string;
  relTime: string;
  lineCount?: number;
  detail?: string;
  current?: boolean;
}

export function resumeCard(cwd: string, entries: ResumeEntry[]): object {
  const elements: object[] = [];
  elements.push(divMd(`当前 cwd：\`${escapeCode(cwd)}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('此 cwd 下没有历史会话。'));
    return shell('🔁 恢复历史会话', elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? '  ← 当前' : '';
    const detail = e.detail ?? `${e.lineCount ?? 0} 条`;
    const displayId = e.displayId ?? e.sessionId;
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${displayId.slice(0, 8)}…\` · ${e.relTime} · ${escapeMd(detail)}`,
      ),
    );
    elements.push(
      actions([
        {
          text: e.current ? '已是当前会话' : '▸ 恢复此会话',
          value: { cmd: 'resume.use', arg: e.sessionId },
          style: e.current ? 'default' : 'primary',
        },
      ]),
    );
    if (i < entries.length - 1) elements.push(HR);
  });

  return shell('🔁 恢复历史会话', elements);
}

/**
 * aiduCAT /help (猴哥点单): plain "command — 中文注解" lines (no bullet or
 * backtick noise), no bottom buttons, plus a dropdown that executes the
 * picked command immediately (select callback → dispatcher `help.run`).
 * f031-func-#4: must list every command in the commands/index.ts registry
 * (guarded by tests/unit/card/f031-func-help-registry.test.ts).
 */
export const HELP_COMMANDS: Array<{ cmd: string; note: string }> = [
  { cmd: 'new', note: '新建会话，重新开始' },
  { cmd: 'reset', note: '同 /new（别名）' },
  { cmd: 'resume', note: '列出并恢复历史会话' },
  { cmd: 'cd', note: '切换工作目录' },
  { cmd: 'ws', note: '工作目录管理' },
  { cmd: 'account', note: '查看/更换飞书应用凭据' },
  { cmd: 'config', note: '偏好、访问控制与身份策略' },
  { cmd: 'model', note: '切换模型与推理强度（群里只改本群）' },
  { cmd: 'status', note: '当前状态' },
  { cmd: 'stop', note: '结束正在跑的任务' },
  { cmd: 'timeout', note: '会话探活设置' },
  { cmd: 'ps', note: '列出本机所有 bot' },
  { cmd: 'exit', note: '关掉指定 bot' },
  { cmd: 'reconnect', note: '强制重连 WebSocket' },
  { cmd: 'doctor', note: '把日志交给 Agent 自助诊断' },
  { cmd: 'invite', note: '加入白名单：user/admin @某人、group、all group' },
  { cmd: 'remove', note: '移出白名单：user/admin @某人、group' },
  { cmd: 'doc', note: '云文档评论说明（在文档评论里 @bot 即可）' },
  { cmd: 'meeting', note: '视频会议：join <会议号> / leave / status / ask' },
  { cmd: 'help', note: '本帮助' },
];

/**
 * @param hidden f03p-slim-#2: commands of switched-off modules (`/meeting`),
 *   left out of both the list and the dropdown.
 */
export function helpCard(agentName = 'Agent', hidden: readonly string[] = []): object {
  const escapedAgentName = escapeMd(agentName);
  const visible = HELP_COMMANDS.filter((c) => !hidden.includes(`/${c.cmd}`));
  const listLines = visible.map((c) => `/${c.cmd} — ${c.note}`);
  return {
    schema: '2.0',
    config: {},
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `💡 **使用帮助**\n\n${listLines.join('\n')}\n\n其他内容直接交给 ${escapedAgentName}。`,
        },
        { tag: 'hr' },
        {
          tag: 'select_static',
          name: 'help_cmd',
          placeholder: { tag: 'plain_text', content: '选择命令，直接执行' },
          options: visible.map((c) => ({
            text: { tag: 'plain_text', content: `/${c.cmd} · ${c.note}` },
            value: c.cmd,
          })),
          // Selecting an option fires the callback right away — no submit
          // button. The dispatcher turns action.option into a real command.
          behaviors: [{ type: 'callback', value: { cmd: 'help.run' } }],
        },
      ],
    },
  };
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
