import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * f03p-infra-#2: tokens in the user's Claude settings (`~/.claude/settings.json`
 * → `env`, e.g. GH_TOKEN / GITHUB_TOKEN / CLOUDFLARE_* / AIDU_*_TOKEN) are for
 * runs the OWNER starts. Claude Code copies that `env` block into its own
 * environment and every tool it spawns, so aiduCAT's env allowlist (f031-sec-#4)
 * cannot reach them. A run started by anyone else gets an extra
 * `--settings <file>` (flag settings beat user settings) that:
 *
 *  - blanks every credential-looking settings `env` name except ANTHROPIC_* /
 *    CLAUDE_* (Claude itself needs the gateway key to answer at all), plus the
 *    GitHub token names unconditionally;
 *  - sets CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1, so Bash / hooks / MCP servers do
 *    not inherit the ANTHROPIC_* key Claude keeps for its own API calls
 *    (Claude Code ≥ 2.1.79; name/shape-based scrub of the rest ≥ 2.1.251);
 *  - denies the Read/Edit tools on the settings / credential files themselves.
 *
 * The owner's runs get none of this — zero change for 猴哥/嘟嘟. Only key
 * NAMES are ever read from the settings file; values are never touched.
 */

const ALWAYS_BLANK = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
const CLAUDE_OWN = /^(ANTHROPIC|CLAUDE)_/i;
const CREDENTIAL_PREFIX = /^(GH|GITHUB|CLOUDFLARE|CF|AIDU|AWS|AZURE|GOOGLE|GCP|OPENAI|NPM|DOCKER|HF|HUGGINGFACE)_/i;
const CREDENTIAL_WORD = /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE|COOKIE|API_?KEY|ACCESS_?KEY|(^|_)KEY$)/i;

export function isOwnerOnlySettingsEnvName(name: string): boolean {
  if (CLAUDE_OWN.test(name)) return false;
  return CREDENTIAL_PREFIX.test(name) || CREDENTIAL_WORD.test(name);
}

export function claudeUserConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? resolve(dir) : join(homedir(), '.claude');
}

/** Key names of the user settings `env` block (never values). Unreadable → []. */
export function readUserSettingsEnvNames(configDir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as { env?: unknown };
    if (!raw || typeof raw.env !== 'object' || raw.env === null || Array.isArray(raw.env)) return [];
    return Object.keys(raw.env as Record<string, unknown>);
  } catch {
    return [];
  }
}

export interface NonOwnerSettings {
  env: Record<string, string>;
  permissions: { allow: string[]; deny: string[] };
  sandbox: {
    enabled: true;
    autoAllowBashIfSandboxed: true;
    allowUnsandboxedCommands: false;
  };
}

/**
 * Where secrets usually live, relative to $HOME. Denied to the Read/Edit tools
 * AND (Claude Code merges `Read(…)` deny rules into the sandbox's
 * filesystem.denyRead) to sandboxed Bash. Directory entries deny their whole
 * subtree.
 */
const HOME_SECRET_DIRS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.config/gh',
  '.config/gcloud',
  '.config/aiduCAT',
  '.aiducat',
  '.lark-channel',
  '.lark-cli',
  '.local/share/keyrings',
];
const HOME_SECRET_FILES = ['.netrc', '.git-credentials', '.npmrc', '.pypirc', '.claude.json'];

export function buildNonOwnerSettings(input: {
  configDir: string;
  settingsEnvNames: readonly string[];
  home?: string;
  /**
   * f04-group-cmd-model (C, Wei 11:52): the run's working directory (default:
   * process cwd). The run may use Bash (sandboxed, internet allowed) and
   * read/write files in it, like a normal agent — credentials stay out of reach.
   */
  cwd?: string;
}): NonOwnerSettings {
  const env: Record<string, string> = { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' };
  for (const name of [...ALWAYS_BLANK, ...input.settingsEnvNames]) {
    if (isOwnerOnlySettingsEnvName(name)) env[name] = '';
  }
  const home = input.home ?? homedir();
  // Permission-rule paths: `//abs` is absolute (a single `/` would be relative
  // to this flag settings file's own directory).
  const abs = (p: string) => `/${resolve(p)}`;
  const files = [
    join(input.configDir, 'settings.json'),
    join(input.configDir, 'settings.local.json'),
    join(input.configDir, '.credentials.json'),
    join(home, '.claude.json'),
  ];
  const deny = [
    ...files.map((f) => `Read(${abs(f)})`),
    ...files.map((f) => `Edit(${abs(f)})`),
    `Read(${abs(join(home, '.config', 'gh'))}/**)`,
  ];
  const cwd = resolve(input.cwd ?? process.cwd());
  const cwdRule = `${abs(cwd)}/**`;
  // Project settings in the working directory carry hooks and often their own
  // `env` block (keys!) — never readable, never writable by a non-owner run.
  // CLAUDE.md / .mcp.json steer every later run (the owner's too) — read-only.
  const projectSecret = [
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ];
  const projectSteering = [join(cwd, 'CLAUDE.md'), join(cwd, '.mcp.json'), join(cwd, '.claude')];
  const extraDeny = [
    ...projectSecret.map((f) => `Read(${abs(f)})`),
    ...HOME_SECRET_DIRS.map((d) => `Read(${abs(join(home, d))}/**)`),
    ...HOME_SECRET_FILES.map((f) => `Read(${abs(join(home, f))})`),
    // Process environments (Claude's own holds the gateway key; so does the bridge's).
    'Read(//proc/**)',
    // dotenv files anywhere.
    'Read(//**/.env)',
    'Read(//**/.env.*)',
    ...[...projectSecret, ...projectSteering].flatMap((f) => [
      `Edit(${abs(f)})`,
      `Write(${abs(f)})`,
    ]),
    `Edit(${abs(join(cwd, '.claude'))}/**)`,
    `Write(${abs(join(cwd, '.claude'))}/**)`,
    ...HOME_SECRET_DIRS.flatMap((d) => [`Edit(${abs(join(home, d))}/**)`, `Write(${abs(join(home, d))}/**)`]),
  ];
  // SCRUB=1 forces permission mode `default` ("Declare allowedTools
  // explicitly"), and `-p` has nobody to approve — so declare them. Deny rules
  // above still win over these. Bash runs inside Claude Code's bubblewrap
  // sandbox (auto-allowed only because it is sandboxed; the
  // dangerouslyDisableSandbox escape is off). The sandbox only fences files:
  // `WebFetch(domain:*)` also pre-allows every host for sandboxed commands
  // (Claude Code ≥ 2.1.186), so curl/pip/npm reach the internet like a normal
  // agent (Wei 12:43). Loopback / private addresses stay refused by the proxy
  // (git obeys the user's ~/.gitconfig http.proxy; a loopback one won't work).
  const allow = [
    'Bash',
    'Read',
    'Glob',
    'Grep',
    'LS',
    'TodoWrite',
    'WebSearch',
    'WebFetch',
    'WebFetch(domain:*)',
    `Edit(${cwdRule})`,
    `Write(${cwdRule})`,
    `MultiEdit(${cwdRule})`,
    `NotebookEdit(${cwdRule})`,
  ];
  return {
    env,
    permissions: { allow, deny: [...deny, ...extraDeny] },
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
  };
}
