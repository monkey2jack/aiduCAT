import { describe, expect, it } from 'vitest';
import { runProviderEnvOverrides } from '../../../src/bot/run-flow';

describe('f031-sec-L4 provider env cannot inject loader / runtime / identity variables', () => {
  it('f031-sec-L4 LD_*, DYLD_*, NODE_OPTIONS, PATH, LARKSUITE_CLI_* … are dropped; ordinary keys pass', async () => {
    const env = await runProviderEnvOverrides(
      {
        gw: {
          label: 'gw',
          baseUrl: 'https://gw.example.com',
          apiKey: 'plain-test-key',
          wire: 'anthropic',
          env: {
            LD_PRELOAD: '/tmp/evil.so',
            LD_LIBRARY_PATH: '/tmp',
            DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
            NODE_OPTIONS: '--require /tmp/evil.js',
            NODE_PATH: '/tmp',
            PATH: '/tmp/bin',
            BASH_ENV: '/tmp/rc',
            LARKSUITE_CLI_CONFIG_DIR: '/home/me/.lark-channel/claude/lark-cli',
            LARKSUITE_CLI_DEFAULT_AS: 'user',
            LARK_CHANNEL_CONFIG: '/home/me/.lark-channel/config.json',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-x',
          },
        },
      },
      'gw',
      'claude',
    );
    expect(env).toBeDefined();
    for (const k of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'NODE_PATH', 'PATH', 'BASH_ENV', 'LARKSUITE_CLI_CONFIG_DIR', 'LARKSUITE_CLI_DEFAULT_AS', 'LARK_CHANNEL_CONFIG']) {
      expect(env![k], k).toBeUndefined();
    }
    expect(env!.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('haiku-x');
    expect(env!.ANTHROPIC_API_KEY).toBe('plain-test-key');
  });
});
