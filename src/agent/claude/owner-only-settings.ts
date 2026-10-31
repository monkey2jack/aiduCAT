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
  permissions: { deny: string[] };
}

export function buildNonOwnerSettings(input: {
  configDir: string;
  settingsEnvNames: readonly string[];
  home?: string;
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
  return { env, permissions: { deny } };
}
