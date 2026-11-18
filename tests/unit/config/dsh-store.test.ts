import { describe, expect, it } from 'vitest';
import { normalizeProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, formatRootConfig, runtimeProfileConfig } from '../../../src/config/profile-store.js';

// f0.5++: dsh extension block must survive save cycles (same contract as hermes
// in f0.4 — the earlier omission silently dropped modelProviders on restart).

describe('dsh config survives save cycles', () => {
  it('normalize keeps the dsh block', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'dsh',
      accounts: { app: { id: 'x', secret: 'y', tenant: 'feishu' } },
      dsh: { binaryPath: 'D:\\aiduCAT\\dsh-launcher.cmd', profile: 'headless' },
    });
    expect(cfg.agentKind).toBe('dsh');
    expect(cfg.dsh?.binaryPath).toBe('D:\\aiduCAT\\dsh-launcher.cmd');
    expect(cfg.dsh?.profile).toBe('headless');
  });

  it('root config round-trip preserves dsh', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'dsh',
      accounts: { app: { id: 'x', secret: 'y', tenant: 'feishu' } },
      dsh: { binaryPath: 'D:\\aiduCAT\\dsh-launcher.cmd', profile: 'headless' },
    });
    const root = createRootConfig('claude', cfg);
    const formatted = formatRootConfig(root);
    expect(formatted).toContain('"dsh"');
    expect(formatted).toContain('dsh-launcher.cmd');
  });
});
