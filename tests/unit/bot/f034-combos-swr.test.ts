import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// f0.3.4 (飞书响应慢): aiduCAT only loads 10router *combos*; the 715-model
// /v1/models list is gone, and the combo list is stale-while-revalidate so
// nothing on the conversation path ever waits on 10router.

const warn = vi.fn();
vi.mock('../../../src/core/logger', () => ({
  log: { warn: (...a: unknown[]) => warn(...a), info: vi.fn(), debug: vi.fn(), error: vi.fn(), fail: vi.fn() },
}));

const ENV_KEYS = ['AIDU_10ROUTER_URL', 'AIDU_10ROUTER_TOKEN', 'ANTHROPIC_API_KEY', 'AIDUCAT_COMPACT_PCT'] as const;
const saved: Record<string, string | undefined> = {};
const TR = { baseUrl: 'https://router.example', token: 'tok-test' };

function combosBody(names: string[], extra: Record<string, unknown> = {}) {
  return { combos: names.map((n, i) => ({ id: `id-${i}`, name: n, models: [`m/${n}`], ...(extra[n] as object) })) };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

async function load() {
  vi.resetModules();
  const tr = await import('../../../src/bot/tenrouter');
  const cw = await import('../../../src/bot/context-window');
  return { ...tr, ...cw };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('f0.3.4 combo cache (stale-while-revalidate)', () => {
  it('f034-#2 cold cache → one /api/combos fetch with the cli token, source live', async () => {
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-10r-cli-token')).toBe('tok-test');
      return ok(combosBody(['Gemini-3.8-Flash', 'aiduPARK']));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchCombos } = await load();
    const cat = await fetchCombos(TR);
    expect(cat.source).toBe('live');
    expect(cat.combos.map((c) => c.name)).toEqual(['Gemini-3.8-Flash', 'aiduPARK']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://router.example/api/combos');
  });

  it('f034-#2 expired cache → old list returned at once, ONE background refresh, then the new list', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const slow = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok(combosBody(['Old'])))
      .mockImplementationOnce(() => slow.promise);
    vi.stubGlobal('fetch', fetchMock);
    const { fetchCombos } = await load();
    await fetchCombos(TR);
    vi.setSystemTime(Date.now() + 6 * 60_000); // past the 5-min TTL
    const a = await fetchCombos(TR); // must not wait on the hanging refresh
    const b = await fetchCombos(TR);
    expect(a.combos.map((c) => c.name)).toEqual(['Old']);
    expect(b.combos.map((c) => c.name)).toEqual(['Old']);
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + one shared refresh
    slow.resolve(ok(combosBody(['New'])));
    await vi.waitFor(async () => expect((await fetchCombos(TR)).combos[0]!.name).toBe('New'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('f034-#2 refresh failure keeps the stale list (not blanked)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok(combosBody(['Keep'])))
      .mockResolvedValue(new Response('{}', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchCombos } = await load();
    await fetchCombos(TR);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const viaWait = await fetchCombos(TR, { waitForFresh: true });
    expect(viaWait.combos.map((c) => c.name)).toEqual(['Keep']);
    expect(viaWait.source).toBe('cached');
  });

  it('f034-#2 waitForFresh (submit validation) waits for the refresh when expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok(combosBody(['Old'])))
      .mockResolvedValueOnce(ok(combosBody(['Old', 'Added'])));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchCombos } = await load();
    await fetchCombos(TR);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const cat = await fetchCombos(TR, { waitForFresh: true });
    expect(cat.source).toBe('live');
    expect(cat.combos.map((c) => c.name)).toContain('Added');
  });

  it('f034-#2 invalidate keeps the list readable and makes the next open refresh in the background', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok(combosBody(['A'])))
      .mockResolvedValueOnce(ok(combosBody(['A', 'B'])));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchCombos, invalidateComboCache, cachedCombos } = await load();
    await fetchCombos(TR);
    invalidateComboCache();
    expect(cachedCombos()?.map((c) => c.name)).toEqual(['A']);
    await vi.waitFor(() => expect(cachedCombos()?.map((c) => c.name)).toEqual(['A', 'B']));
  });

  it('f034-#2 cachedCombos never waits: cold → undefined (no config yet → no fetch)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { cachedCombos } = await load();
    expect(cachedCombos()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('f034-#2 startup prewarm (env URL+token) pulls ONLY /api/combos — never /v1/models', async () => {
    process.env.AIDU_10ROUTER_URL = 'https://router.example/';
    process.env.AIDU_10ROUTER_TOKEN = 'tok-secret-value';
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      urls.push(u);
      return ok(combosBody(['Gemini-3.8-Flash']));
    }));
    const { prewarmCombos, cachedCombos, contextWindowForModel, resolveModelWindow } = await load();
    await prewarmCombos({ accounts: { app: {} } } as never);
    expect(urls).toEqual(['https://router.example/api/combos']);
    expect(cachedCombos()?.[0]?.name).toBe('Gemini-3.8-Flash');
    // the run path reads windows from the cache only
    contextWindowForModel('Gemini-3.8-Flash');
    resolveModelWindow({ preferences: {} } as never, 'Gemini-3.8-Flash');
    expect(urls.every((u) => !u.includes('/v1/models'))).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('tok-secret-value');
  });

  it('f034-#2 prewarm without 10router config does nothing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { prewarmCombos } = await load();
    await prewarmCombos({ accounts: { app: {} } } as never);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('f0.3.4 context window: combo → provider → CLI settings.json', () => {
  it('f034-#1 uses a combo-declared window when /api/combos carries one (any of the 3 field shapes)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      ok(combosBody(['A', 'B', 'C', 'D'], {
        A: { contextWindow: 1_000_000 },
        B: { context_window: '500000' },
        C: { capabilities: { contextWindow: 200_000 } },
      })),
    ));
    const { fetchCombos, contextWindowForModel, resolveModelWindow, compactPct } = await load();
    await fetchCombos(TR);
    expect(contextWindowForModel('A')).toBe(1_000_000);
    expect(contextWindowForModel('B')).toBe(500_000);
    expect(contextWindowForModel('C')).toBe(200_000);
    expect(contextWindowForModel('D')).toBeUndefined();
    const win = resolveModelWindow({ preferences: {} } as never, 'A');
    expect(Math.round((win! * compactPct()!) / 100)).toBe(600_000);
  });

  it('f034-#1 today\'s combos (no window field) → undefined, synchronously; provider default next', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(combosBody(['Gemini-3.8-Flash']))));
    const { fetchCombos, contextWindowForModel, resolveModelWindow } = await load();
    await fetchCombos(TR);
    const r = contextWindowForModel('Gemini-3.8-Flash');
    expect(r).toBeUndefined();
    expect(typeof (r as unknown as { then?: unknown } | undefined)?.then).toBe('undefined');
    expect(resolveModelWindow({ preferences: {} } as never, 'Gemini-3.8-Flash')).toBeUndefined();
    const withProvider = {
      preferences: { provider: 'p1' },
      modelProviders: { p1: { contextWindow: 400_000 } },
    };
    expect(resolveModelWindow(withProvider as never, 'Gemini-3.8-Flash')).toBe(400_000);
  });

  it('f034-#1 no window from aiduCAT → /status falls back to the CLI settings.json (900k / 600k)', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'f034-cli-'));
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      await writeFile(
        join(dir, 'settings.json'),
        JSON.stringify({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '900000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000' } }),
      );
      const { claudeCliWindow } = await load();
      expect(await claudeCliWindow()).toEqual({ window: 900_000, compactWindow: 600_000 });
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('f034-#1 source no longer contains the /v1/models window pull', async () => {
    const { readFile } = await import('node:fs/promises');
    const tr = await readFile(new URL('../../../src/bot/tenrouter.ts', import.meta.url), 'utf8');
    const cw = await readFile(new URL('../../../src/bot/context-window.ts', import.meta.url), 'utf8');
    expect(tr).not.toMatch(/fetchContextWindows|MODELS_TTL_MS|\$\{[^}]*\}\/v1\/models/);
    expect(cw).not.toMatch(/fetchContextWindows|v1\/models'/);
  });
});
