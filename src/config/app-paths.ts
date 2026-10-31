import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ResolveAppPathsOptions {
  rootDir?: string;
  profile?: string;
}

export interface AppPaths {
  rootDir: string;
  profile: string;
  profileDir: string;
  defaultWorkspaceDir: string;
  configFile: string;
  activeProfileFile: string;
  sessionsFile: string;
  workspacesFile: string;
  secretsFile: string;
  keystoreSaltFile: string;
  keystoreKeyFile: string;
  secretsGetterScript: string;
  larkCliConfigDir: string;
  larkCliSourceDir: string;
  larkCliSourceConfigFile: string;
  larkCliTargetConfigFile: string;
  mediaDir: string;
  logsDir: string;
  /** Sidecar file describing the running bridge's local web-config server
   * ({ url, token, port, pid }); written on start, removed on stop. */
  uiFile: string;
  /** Host-level (machine-wide) sidecar for the single supervisor's console. */
  hostUiFile: string;
  /** Host-level supervisor logs dir. */
  hostLogsDir: string;
  /** Machine-wide lock ensuring only one supervisor runs. */
  hostLockFile: string;
  registryDir: string;
  userRegistryFile: string;
  userLockDir: string;
  profileLockFile: string;
  appLockFile(appId: string): string;
}

const DEFAULT_PROFILE = 'claude';

/** f03p-infra-#4: the data dir is `~/.aiducat`; `~/.lark-channel` is the old name. */
export const DATA_DIR_NAME = '.aiducat';
export const LEGACY_DATA_DIR_NAME = '.lark-channel';

/**
 * f03p-infra-#4: default data root when neither `opts.rootDir` nor
 * LARK_CHANNEL_HOME says otherwise. New installs get `~/.aiducat`; a machine
 * that only has the old `~/.lark-channel` keeps using it (nothing moves on its
 * own — `aiduCAT migrate-home` does that); once `~/.aiducat` exists it wins.
 */
export function defaultDataRootDir(home: string = homedir()): string {
  const next = join(home, DATA_DIR_NAME);
  if (existsSync(next)) return next;
  const legacy = join(home, LEGACY_DATA_DIR_NAME);
  if (existsSync(legacy)) return legacy;
  return next;
}

/**
 * f03p-infra-#4: one line to print at start when the default resolution fell
 * back to the old `~/.lark-channel` (never when LARK_CHANNEL_HOME was set on
 * purpose). undefined = nothing to say.
 */
export function legacyDataDirNotice(rootDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.LARK_CHANNEL_HOME?.trim()) return undefined;
  if (resolve(rootDir) !== resolve(join(homedir(), LEGACY_DATA_DIR_NAME))) return undefined;
  return (
    `ℹ️ 数据目录还在旧位置 ${rootDir}（照常使用，不影响运行）。` +
    `想换到 ~/${DATA_DIR_NAME}：先停服务，运行 \`aiduCAT migrate-home --dry-run\` 看计划，再 \`aiduCAT migrate-home\`。`
  );
}

export function resolveAppPaths(opts: ResolveAppPathsOptions = {}): AppPaths {
  const rootDir = opts.rootDir ?? process.env.LARK_CHANNEL_HOME ?? defaultDataRootDir();
  const profile = normalizeProfileName(opts.profile ?? DEFAULT_PROFILE);
  const profileDir = join(rootDir, 'profiles', profile);
  const registryDir = join(rootDir, 'registry');
  const userLockDir = join(registryDir, 'locks');

  return {
    rootDir,
    profile,
    profileDir,
    defaultWorkspaceDir: join(`${rootDir}-workspaces`, profile, 'default'),
    configFile: join(rootDir, 'config.json'),
    activeProfileFile: join(rootDir, 'active-profile'),
    sessionsFile: join(profileDir, 'sessions.json'),
    workspacesFile: join(profileDir, 'workspaces.json'),
    secretsFile: join(profileDir, 'secrets.enc'),
    keystoreSaltFile: join(profileDir, '.keystore.salt'),
    keystoreKeyFile: join(profileDir, '.keystore.key'),
    secretsGetterScript: join(rootDir, 'secrets-getter'),
    larkCliConfigDir: join(profileDir, 'lark-cli'),
    larkCliSourceDir: join(profileDir, 'lark-cli-source'),
    larkCliSourceConfigFile: join(profileDir, 'lark-cli-source', 'config.json'),
    larkCliTargetConfigFile: join(profileDir, 'lark-cli', 'lark-channel', 'config.json'),
    mediaDir: join(profileDir, 'media'),
    logsDir: join(profileDir, 'logs'),
    uiFile: join(profileDir, 'ui.json'),
    hostUiFile: join(rootDir, 'ui.json'),
    hostLogsDir: join(rootDir, 'logs'),
    hostLockFile: join(userLockDir, 'supervisor.lock'),
    registryDir,
    userRegistryFile: join(registryDir, 'processes.json'),
    userLockDir,
    profileLockFile: join(userLockDir, 'profile', `${profile}.lock`),
    appLockFile: (appId: string) => join(userLockDir, 'app', `${lockSafeName(appId)}.lock`),
  };
}

function normalizeProfileName(profile: string): string {
  const trimmed = profile.trim();
  if (!trimmed) throw new Error('profile name is required');
  // Allow Unicode letters/digits (so a non-ASCII bot name can be used directly as
  // the profile name) but reject anything unsafe as a single path segment:
  // whitespace, path separators, control chars, and Windows-reserved chars.
  // Service labels sanitize non-ASCII names separately (see serviceProfileId).
  if (/[\u0000-\u001f\s/\\:*?"<>|]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new Error(`invalid profile name: ${profile}`);
  }
  return trimmed;
}

function lockSafeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
