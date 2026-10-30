import { mergeProcessEnv } from './spawn';

/**
 * f031-sec-#4: the agent subprocess env is an allowlist, not a copy of the
 * daemon's env. The daemon may hold provider keys and unrelated secrets
 * (GH_TOKEN, AIDU_10ROUTER_TOKEN, …); an agent that runs `env` must not see
 * them. Provider keys reach only the agent that consumes them, and the
 * per-run overrides (lark-channel env, /model provider env) always layer on top.
 */
const BASE_EXACT = new Set(
  [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'USERNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'COLORTERM',
    'TZ', 'TMPDIR', 'TMP', 'TEMP', 'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    // Windows essentials (names are case-insensitive there).
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
    'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'HOMEDRIVE',
    'HOMEPATH', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS', 'COMPUTERNAME',
  ].map((k) => k.toUpperCase()),
);
const BASE_PREFIXES = ['LC_'];
const AGENT_PREFIXES: Record<string, string[]> = {
  claude: ['ANTHROPIC_', 'CLAUDE_'],
  codex: ['OPENAI_', 'CODEX_'],
};

export function buildAgentEnv(input: {
  agent: 'claude' | 'codex';
  base?: NodeJS.ProcessEnv;
  overrides?: NodeJS.ProcessEnv;
  /** Extra daemon env names the owner explicitly passes through (profile agentEnv.passthrough). */
  passthrough?: readonly string[];
}): NodeJS.ProcessEnv {
  const base = input.base ?? process.env;
  const extra = new Set((input.passthrough ?? []).map((k) => k.toUpperCase()));
  const prefixes = [...BASE_PREFIXES, ...(AGENT_PREFIXES[input.agent] ?? [])];
  const picked: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (BASE_EXACT.has(upper) || extra.has(upper) || prefixes.some((p) => upper.startsWith(p))) {
      picked[key] = value;
    }
  }
  return mergeProcessEnv(picked, input.overrides ?? {});
}
