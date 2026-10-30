import { join } from 'node:path';

export interface LarkChannelEnvContext {
  profile?: string;
  rootDir?: string;
  configPath?: string;
  larkCliConfigDir?: string;
  larkCliSourceConfigFile?: string;
}

export function buildLarkChannelEnv(
  context?: LarkChannelEnvContext,
  opts: { forAgent?: boolean } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LARK_CHANNEL: '1',
  };
  const profile = nonEmpty(context?.profile);
  if (profile) env.LARK_CHANNEL_PROFILE = profile;

  const rootDir = nonEmpty(context?.rootDir);
  if (rootDir) env.LARK_CHANNEL_HOME = rootDir;

  // f031-sec-#4: an agent only ever gets the lark-cli source projection, never
  // the bridge's own config.json (which holds the app secret / provider keys).
  const configPath = opts.forAgent
    ? nonEmpty(context?.larkCliSourceConfigFile)
    : nonEmpty(context?.larkCliSourceConfigFile) ??
      nonEmpty(context?.configPath) ??
      (rootDir ? join(rootDir, 'config.json') : undefined);
  if (configPath) env.LARK_CHANNEL_CONFIG = configPath;

  const larkCliConfigDir = nonEmpty(context?.larkCliConfigDir);
  if (larkCliConfigDir) env.LARKSUITE_CLI_CONFIG_DIR = larkCliConfigDir;

  return env;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? value : undefined;
}
