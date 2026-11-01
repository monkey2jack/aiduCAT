import { log } from '../core/logger';
import { resolveAppSecret } from '../config/secret-resolver';
import type { AppConfig, SecretInput } from '../config/schema';

/**
 * aiduCAT: client for the 10router combo catalog (GET /api/combos).
 *
 * 猴哥's principle: only *custom combos* (the short curated list he manages
 * in the 10router dashboard) are offered in the /model card — never the
 * ~700 raw provider models behind /v1/models (f0.3.4: aiduCAT never pulls
 * that list any more). The cache is refreshed in the background, so combos
 * added/removed on 10router still sync automatically.
 *
 * The management token is never hardcoded: it resolves through the secret
 * chain (env `AIDU_10ROUTER_TOKEN` → file → exec) via SecretInput, with a
 * plain config string as the last fallback for self-hosters who don't care.
 */

const COMBOS_TIMEOUT_MS = 8_000;

export interface TenRouterCombo {
  id: string;
  name: string;
  models: string[];
  /** f0.3.4: context window, only when /api/combos carries one (it doesn't as of 2026-11-02). */
  contextWindow?: number;
}

export interface TenRouterConfig {
  /** 10router base URL, e.g. https://your-gateway.example.com */
  baseUrl: string;
  /** Management token value (x-10r-cli-token). */
  token: string;
}

export interface ComboCatalog {
  combos: TenRouterCombo[];
  /** 'live' = fetched now; 'cached' = recent fetch reused; 'unavailable' = fell back to stored preference only. */
  source: 'live' | 'cached' | 'unavailable';
}

interface CacheEntry {
  combos: TenRouterCombo[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60_000;
let cache: CacheEntry | undefined;

/**
 * aiduCAT: one immediate retry on network failure. Right after a service
 * restart (or on Cloudflare-tunnel jitter) the first fetch can fail with a
 * bare "fetch failed" while a retry a second later succeeds — seen live on
 * Hangzhou 2026-10-18 when /model blanked twice after deploys.
 * Logs the underlying cause (ECONNRESET / EAI_AGAIN / abort) so failures
 * are diagnosable instead of a bare "fetch failed".
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    try {
      return await fetch(url, init);
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      log.warn('tenrouter', 'fetch-network-failed', {
        path: new URL(url).pathname,
        err: err instanceof Error ? err.message : String(err),
        cause: cause?.code ?? cause?.message ?? 'unknown',
      });
      throw err;
    }
  };
  try {
    return await attempt();
  } catch {
    await new Promise((r) => setTimeout(r, 1_500));
    return attempt();
  }
}

/** Read an env-style secret value via the app secret chain. A plain string
 * token rides the same "${VAR}" template resolution; SecretRef forms
 * (env/file/exec) go through the full provider chain rooted at cfg. */
async function resolveSecretValue(
  input: SecretInput,
  cfg: AppConfig,
): Promise<string> {
  // resolveAppSecret reads cfg.accounts.app.secret; we only need its
  // resolveSecretInput internals, so shim a minimal AppConfig carrying the
  // token as the "secret". Providers/allowlist config is shared.
  return resolveAppSecret({
    ...cfg,
    accounts: { app: { ...cfg.accounts.app, secret: input } },
  });
}

/**
 * Resolve 10router access from (in order):
 *  1. process.env.AIDU_10ROUTER_URL + AIDU_10ROUTER_TOKEN
 *  2. config `tenRouter.url` + `tenRouter.token` — the token rides the same
 *     SecretInput chain as the app secret (plain string / "${VAR}" template /
 *     env / file / exec), so it never has to sit in config plaintext.
 *  3. undefined (caller degrades to the direct-text /model flow)
 */
export async function resolveTenRouterConfig(
  cfg: AppConfig,
): Promise<TenRouterConfig | undefined> {
  const tenRouter = cfg.tenRouter;
  const url = (process.env.AIDU_10ROUTER_URL ?? tenRouter?.url ?? '').trim();
  if (!url) return undefined;
  let token: string | undefined;
  const envToken = process.env.AIDU_10ROUTER_TOKEN;
  if (envToken && envToken.trim() !== '') {
    token = envToken.trim();
  } else if (tenRouter?.token) {
    // Best-effort: a broken secret ref degrades the card to unavailable
    // instead of crashing the command.
    try {
      token = await resolveSecretValue(tenRouter.token, cfg);
    } catch (err) {
      log.warn('tenrouter', 'token-resolve-failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }
  if (!token) return undefined;
  return { baseUrl: url.replace(/\/+$/, ''), token };
}

/**
 * f0.3.4 (飞书响应慢): the combo list is served stale-while-revalidate.
 * A cached list — even an expired one — is returned at once and an expired
 * one is refreshed in the background; only a cold cache (first /model open
 * before the startup prewarm landed) waits for 10router. Concurrent
 * refreshes share one request. Nothing on the conversation path ever awaits
 * this: runs only read the cache via `cachedCombos()`.
 */
let inflight: Promise<TenRouterCombo[] | undefined> | undefined;
/** Last config a fetch was made with — lets cache readers trigger a refresh. */
let lastConfig: TenRouterConfig | undefined;

function positiveNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

type RawCombo = {
  id?: unknown;
  name?: unknown;
  models?: unknown;
  contextWindow?: unknown;
  context_window?: unknown;
  capabilities?: { contextWindow?: unknown } | null;
};

function parseCombo(c: RawCombo): TenRouterCombo {
  const contextWindow =
    positiveNumber(c.contextWindow) ??
    positiveNumber(c.context_window) ??
    positiveNumber(c.capabilities?.contextWindow);
  return {
    id: String(c.id ?? ''),
    name: String(c.name ?? ''),
    models: Array.isArray(c.models) ? c.models.map(String) : [],
    ...(contextWindow ? { contextWindow } : {}),
  };
}

function refreshCombos(cfg: TenRouterConfig): Promise<TenRouterCombo[] | undefined> {
  lastConfig = cfg;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetchWithRetry(`${cfg.baseUrl}/api/combos`, {
        headers: { 'x-10r-cli-token': cfg.token },
        signal: AbortSignal.timeout(COMBOS_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { combos?: RawCombo[] };
      const combos = (body.combos ?? []).map(parseCombo).filter((c) => c.id && c.name);
      if (combos.length === 0) throw new Error('empty combo list');
      cache = { combos, fetchedAt: Date.now() };
      log.info('tenrouter', 'combos-fetched', { count: combos.length });
      return combos;
    } catch (err) {
      log.warn('tenrouter', 'combos-fetch-failed', {
        err: err instanceof Error ? err.message : String(err),
        keptStale: cache !== undefined,
      });
      return undefined;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

function isStale(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt >= CACHE_TTL_MS;
}

/**
 * The custom combo list for the /model card. Fresh cache → as is; expired
 * cache → returned at once while a background refresh runs; cold cache →
 * waits for one fetch. `waitForFresh` (the /model submit validation, off the
 * conversation path) waits for the refresh when the cache is expired, and
 * still falls back to the stale list if 10router can't answer.
 */
export async function fetchCombos(
  cfg: TenRouterConfig,
  opts: { waitForFresh?: boolean } = {},
): Promise<ComboCatalog> {
  lastConfig = cfg;
  if (cache && !isStale(cache)) return { combos: cache.combos, source: 'cached' };
  if (cache && !opts.waitForFresh) {
    void refreshCombos(cfg);
    return { combos: cache.combos, source: 'cached' };
  }
  const combos = await refreshCombos(cfg);
  if (combos) return { combos, source: 'live' };
  if (cache) return { combos: cache.combos, source: 'cached' };
  return { combos: [], source: 'unavailable' };
}

/**
 * f0.3.4: synchronous read for the conversation path. Returns whatever is
 * cached (fresh or expired) and kicks a background refresh when it is
 * expired or missing — never waits.
 */
export function cachedCombos(): TenRouterCombo[] | undefined {
  if (lastConfig && (!cache || isStale(cache))) void refreshCombos(lastConfig);
  return cache?.combos;
}

/** f0.3.4: warm the combo cache at startup (background; failures only log). */
export async function prewarmCombos(cfg: AppConfig): Promise<void> {
  try {
    const tr = await resolveTenRouterConfig(cfg);
    if (!tr) return;
    await refreshCombos(tr);
  } catch (err) {
    log.warn('tenrouter', 'prewarm-failed', { err: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Mark the cache expired (e.g. after a preference write) so the next /model
 * open refreshes it. The old list stays readable meanwhile (f0.3.4).
 */
export function invalidateComboCache(): void {
  if (cache) cache = { ...cache, fetchedAt: 0 };
}

/** Test hook: forget cache, in-flight refresh and remembered config. */
export function resetComboCacheForTests(): void {
  cache = undefined;
  inflight = undefined;
  lastConfig = undefined;
}
