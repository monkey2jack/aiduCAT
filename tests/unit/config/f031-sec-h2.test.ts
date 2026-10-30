import { describe, expect, it } from 'vitest';
import { createDefaultProfileConfig, runLarkCliIdentityEnv, NO_LARK_CLI_CONFIG_DIR } from '../../../src/config/profile-schema';

const base = createDefaultProfileConfig({
  agentKind: 'claude',
  accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
});

describe('f031-sec-H2 non-owner runs get no lark-cli config at all', () => {
  it('f031-sec-H2 every preset/mode: non-owner → config dir + source config point nowhere, bot identity pinned', () => {
    for (const identityPreset of ['user-default', 'bot-only'] as const) {
      for (const mode of ['personal', 'team'] as const) {
        const profile = { ...base, mode, larkCli: { ...base.larkCli, identityPreset } };
        const env = runLarkCliIdentityEnv(profile, false);
        expect(env.LARKSUITE_CLI_CONFIG_DIR).toBe(NO_LARK_CLI_CONFIG_DIR);
        expect(env.LARK_CHANNEL_CONFIG).toBe(NO_LARK_CLI_CONFIG_DIR);
        expect(env.LARKSUITE_CLI_DEFAULT_AS).toBe('bot');
        expect(env.LARKSUITE_CLI_STRICT_MODE).toBe('bot');
      }
    }
  });

  it('f031-sec-H2 the owner keeps the profile lark-cli unchanged', () => {
    expect(runLarkCliIdentityEnv({ ...base, larkCli: { ...base.larkCli, identityPreset: 'user-default' } }, true)).toEqual({});
  });

  it('f031-sec-H2 the disabled dir can never be created (lives under the null device)', () => {
    expect(NO_LARK_CLI_CONFIG_DIR.startsWith(process.platform === 'win32' ? '\\\\.\\nul' : '/dev/null/')).toBe(true);
  });
});
