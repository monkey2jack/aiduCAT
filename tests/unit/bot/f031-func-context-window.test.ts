import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// f031-func-#1: the 60% auto-compact never applied in production because the
// 10router /v1/models lookup only tried ANTHROPIC_API_KEY (absent from the bot
// env) and returned silently. The bot env carries AIDU_10ROUTER_TOKEN, which
// 10router accepts as `x-10r-cli-token` on /v1/models.

const warn = vi.fn();
vi.mock('../../../src/core/logger', () => ({
  log: { warn: (...a: unknown[]) => warn(...a), info: vi.fn(), debug: vi.fn(), error: vi.fn(), fail: vi.fn() },
}));

const ENV_KEYS = ['AIDU_10ROUTER_URL', 'AIDU_10ROUTER_TOKEN', 'ANTHROPIC_API_KEY', 'AIDUCAT_COMPACT_PCT'] as const;
const saved: Record<string, string | undefined> = {};

function modelsBody() {
  return {
    data: [
      { id: 'Claude-Opus-4.6', capabilities: { contextWindow: 1_000_000 } },
      { id: 'small', capabilities: { contextWindow: 200_000 } },
    ],
  };
}

async function load() {
  vi.resetModules();
  return import('../../../src/bot/context-window');
}

describe('f031-func-#1 10router window lookup', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    warn.mockReset();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });

  it('f031-func-#1 uses AIDU_10ROUTER_TOKEN (x-10r-cli-token) when ANTHROPIC_API_KEY is absent', async () => {
    process.env.AIDU_10ROUTER_URL = 'https://router.example/';
    process.env.AIDU_10ROUTER_TOKEN = 'tok-test';
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      if (h.get('x-10r-cli-token') !== 'tok-test') return new Response('{}', { status: 401 });
      return new Response(JSON.stringify(modelsBody()), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { contextWindowForModel } = await load();
    expect(await contextWindowForModel('Claude-Opus-4.6')).toBe(1_000_000);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://router.example/v1/models');
  });

  it('f031-func-#1 warns (no token value) when the lookup has no credentials', async () => {
    process.env.AIDU_10ROUTER_URL = 'https://router.example';
    vi.stubGlobal('fetch', vi.fn());
    const { contextWindowForModel } = await load();
    expect(await contextWindowForModel('Claude-Opus-4.6')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    const [phase, event] = warn.mock.calls[0]!;
    expect(phase).toBe('context-window');
    expect(String(event)).toMatch(/no-credentials|unresolved/);
  });

  it('f031-func-#1 warns when the model is not listed, never prints the token', async () => {
    process.env.AIDU_10ROUTER_URL = 'https://router.example';
    process.env.AIDU_10ROUTER_TOKEN = 'tok-secret-value';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(modelsBody()), { status: 200 })));
    const { contextWindowForModel } = await load();
    expect(await contextWindowForModel('Unknown-Model')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('tok-secret-value');
  });

  it('f031-func-#1 compact trigger for Claude-Opus-4.6 = 600k (1M x 60%)', async () => {
    process.env.AIDU_10ROUTER_URL = 'https://router.example';
    process.env.AIDU_10ROUTER_TOKEN = 'tok-test';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(modelsBody()), { status: 200 })));
    const { resolveModelWindow, compactPct } = await load();
    const win = await resolveModelWindow({ preferences: {} } as never, 'Claude-Opus-4.6');
    expect(win).toBe(1_000_000);
    expect(Math.round((win! * compactPct()!) / 100)).toBe(600_000);
  });
});
