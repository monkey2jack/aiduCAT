import { describe, expect, it } from 'vitest';
import {
  FEATURE_OFF_REPLY,
  createDefaultProfileConfig,
  featureEnabled,
  normalizeProfileConfig,
} from '../../../src/config/profile-schema';
import { createRootConfig, formatRootConfig } from '../../../src/config/profile-store';

const app = { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };

describe('f03p-slim-#1 profile features switch', () => {
  it('f03p-slim-#1 no features block = everything on (current behavior)', () => {
    const p = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });
    expect(p.features).toEqual({ meeting: true, webConsole: true, codex: true, cot: true });
    for (const f of ['meeting', 'webConsole', 'codex', 'cot'] as const) {
      expect(featureEnabled(p, f)).toBe(true);
    }
    expect(featureEnabled(undefined, 'meeting')).toBe(true);
  });

  it('f03p-slim-#1 only an explicit false turns a module off; junk values stay on', () => {
    const p = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      features: { meeting: false, webConsole: 'no', codex: 0, cot: false, bogus: false },
    });
    expect(p.features).toEqual({ meeting: false, webConsole: true, codex: true, cot: false });
    expect(featureEnabled(p, 'meeting')).toBe(false);
    expect(featureEnabled(p, 'cot')).toBe(false);
  });

  it('f03p-slim-#1 save keeps the switched-off modules and omits the block when all on', () => {
    const off = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
      features: { meeting: false, codex: false },
    });
    const saved = JSON.parse(formatRootConfig(createRootConfig('claude', off)));
    expect(saved.profiles.claude.features).toEqual({ meeting: false, codex: false });
    expect(normalizeProfileConfig(saved.profiles.claude).features).toEqual({
      meeting: false,
      webConsole: true,
      codex: false,
      cot: true,
    });

    const on = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });
    const savedOn = JSON.parse(formatRootConfig(createRootConfig('claude', on)));
    expect(savedOn.profiles.claude).not.toHaveProperty('features');
  });

  it('f03p-slim-#1 the shared off reply text', () => {
    expect(FEATURE_OFF_REPLY).toBe('此功能未开启');
  });

  it('f03p-slim-#1 a codex profile with codex switched off still loads (refused when the agent starts)', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'codex',
        accounts: { app },
        codex: { binaryPath: 'codex' },
        features: { codex: false },
      }),
    ).not.toThrow();
  });
});
