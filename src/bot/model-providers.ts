import { log } from '../core/logger';
import type { ProfileConfig } from '../config/profile-schema';

/**
 * aiduCAT f0.2: multi-provider model catalog for the /model card.
 *
 * The default provider inherits the service environment (systemd env) and
 * needs no fetching for credentials; its model list comes from the existing
 * 10router combo pull (tenrouter.ts). Extra providers declare their own
 * baseUrl + api key (SecretInput chain) and either a static model list or a
 * live `/v1/models` pull — cached 5 min like combos.
 */

export const DEFAULT_PROVIDER = 'default';
/**
 * f0.2: dropdown wire value for the default choice. `default` as a raw
 * select_static value was rejected by CardKit (card.create returned no
 * card_id — 12:48 logs), so the option travels as a dedicated sentinel that
 * can't collide with a provider id or Feishu reserved words.
 */
export const DEFAULT_PROVIDER_VALUE = '__default__';

export interface ProviderChoice {
  id: string;
  label: string;
}

export interface ProviderModelsResult {
  source: 'live' | 'cached' | 'unavailable';
  models: string[];
  /** Full count before the dropdown cap — the card hints at the overflow. */
  total?: number;
}

/** f0.2: dropdown hard cap — see fetchProviderModels. */
export const MAX_PROVIDER_MODELS = 50;

interface ModelsCacheEntry {
  models: string[];
  fetchedAt: number;
  /** Count before the cap, for the card hint. */
  total?: number;
}

const MODELS_TTL_MS = 5 * 60_000;
const MODELS_TIMEOUT_MS = 8_000;
const modelsCache = new Map<string, ModelsCacheEntry>();


/**
 * Dropdown choices: the service's own gateway first, labelled by its
 * configured provider name (`defaultProviderName`, e.g. `10router`),
 * falling back to the plain word `默认` when unnamed. Provider names are
 * the user-facing identity; URLs stay out of the picker.
 */
export function providerChoices(
  providers: NonNullable<ProfileConfig['modelProviders']>,
  defaultName?: string,
): ProviderChoice[] {
  const extras = Object.entries(providers).map(([id, p]) => ({
    id,
    label: p.label || id,
  }));
  return [{ id: DEFAULT_PROVIDER, label: defaultName?.trim() || '默认' }, ...extras];
}

export interface ProviderModelChoice {
  id: string;
  name: string;
  /** Dropdown text: `<model> · <provider label>`. */
  label: string;
  provider: string;
}

/**
 * Union of every provider's static `models` list, each entry tagged with the
 * provider it belongs to. When non-empty, the /model card lists these in a
 * single Model dropdown and the provider is derived from the chosen model —
 * the card's Provider select has no change callback, so picking a provider
 * never re-rendered the Model list and the submit could pair the new
 * provider with a model it does not serve. First provider wins on duplicates.
 */
export function unionProviderModels(
  providers: NonNullable<ProfileConfig['modelProviders']>,
): ProviderModelChoice[] {
  const out: ProviderModelChoice[] = [];
  const seen = new Set<string>();
  for (const [id, def] of Object.entries(providers)) {
    if (!def || !Array.isArray(def.models)) continue;
    const tag = (def.label || id).replace(/[（(].*$/, '').trim() || id;
    for (const m of def.models) {
      if (typeof m !== 'string' || !m || seen.has(m)) continue;
      seen.add(m);
      out.push({ id: m, name: m, label: `${m} · ${tag}`, provider: id });
    }
  }
  return out.slice(0, MAX_PROVIDER_MODELS * 2);
}

export function providerDef(
  providers: NonNullable<ProfileConfig['modelProviders']>,
  id: string | undefined,
) {
  if (!id || id === DEFAULT_PROVIDER) return undefined;
  return providers[id];
}

/** Coerce a stored provider preference to a known id (default on unknown). */
export function normalizeProvider(
  providers: NonNullable<ProfileConfig['modelProviders']>,
  value: string | undefined,
): string {
  if (!value || value === DEFAULT_PROVIDER) return DEFAULT_PROVIDER;
  return providers[value] ? value : DEFAULT_PROVIDER;
}

/**
 * Fetch the model list for one provider.
 *
 * 10router-family gateways expose a curated `/api/combos` (the short list
 * the router admin maintains) — that's what belongs in the dropdown; the raw
 * `/v1/models` path returns every internal routing name (659 on 10r, live
 * 2026-10-19) which blows CardKit's 200-element budget and blanks the card
 * with 300305. Strategy per provider: default → shared 10router combo pull;
 * extras → own-host `/api/combos` first (CLI token from env), /v1/models
 * capped at ${MAX_PROVIDER_MODELS} only as a fallback.
 *
 * The combos management token resolves from AIDU_10ROUTER_TOKEN (same token
 * works across our 10router deployments).
 */
export async function fetchProviderModels(
  providers: NonNullable<ProfileConfig['modelProviders']>,
  providerId: string,
  fetchCombosDefault: () => Promise<{ combos: Array<{ name: string }>; source: string }>,
): Promise<ProviderModelsResult> {
  if (providerId === DEFAULT_PROVIDER) {
    const cat = await fetchCombosDefault();
    return { source: cat.source as ProviderModelsResult['source'], models: cat.combos.map((c) => c.name) };
  }
  const def = providerDef(providers, providerId);
  if (!def) return { source: 'unavailable', models: [] };

  // Static list from config wins: ModelProviderDef.models documents "live
  // /v1/models pull when omitted", so when present it must be used as-is.
  // Needed for gateways whose baseUrl cannot carry `/v1` (Claude Code would
  // then call /v1/v1/messages) and therefore cannot serve /v1/models.
  if (Array.isArray(def.models) && def.models.length > 0) {
    return {
      source: 'live',
      models: def.models.slice(0, MAX_PROVIDER_MODELS),
      total: def.models.length,
    };
  }

  const cached = modelsCache.get(providerId);
  if (cached && Date.now() - cached.fetchedAt < MODELS_TTL_MS) {
    return { source: 'cached', models: cached.models, total: cached.total };
  }

  // Preferred: curated combos from the provider's own host.
  const combos = await fetchProviderCombos(def.baseUrl);
  if (combos.length > 0) {
    modelsCache.set(providerId, { models: combos, fetchedAt: Date.now(), total: combos.length });
    return { source: 'live', models: combos, total: combos.length };
  }

  // Fallback: raw /v1/models, capped for the card budget.
  const apiKey = await resolveProviderKey(def);
  if (!apiKey) return { source: 'unavailable', models: [] };

  try {
    const models = await listModelsWithRetry(def.baseUrl, apiKey);
    if (models.length === 0) throw new Error('empty model list');
    const trimmed = models.slice(0, MAX_PROVIDER_MODELS);
    modelsCache.set(providerId, { models: trimmed, fetchedAt: Date.now(), total: models.length });
    return { source: 'live', models: trimmed, total: models.length };
  } catch (err) {
    log.warn('provider', 'models-fetch-failed', {
      provider: providerId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { source: 'unavailable', models: cached?.models ?? [], total: cached?.total };
  }
}

/**
 * Pull the curated combo list from a 10router-family host. The CLI token is
 * shared across our deployments (sha256 of machine-id + app secret, same
 * value everywhere). Returns [] when the host isn't a 10router (404/401) so
 * the caller falls back to /v1/models.
 */
async function fetchProviderCombos(baseUrl: string): Promise<string[]> {
  const token = (process.env.AIDU_10ROUTER_TOKEN ?? '').trim();
  if (!token) return [];
  try {
    const origin = new URL(baseUrl).origin;
    const res = await fetch(`${origin}/api/combos`, {
      headers: { 'x-10r-cli-token': token },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { combos?: Array<{ name?: unknown }> };
    return (body.combos ?? [])
      .map((c) => String(c.name ?? ''))
      .filter((n) => n && /^[-\w.:@/ ]{1,80}$/.test(n));
  } catch {
    return [];
  }
}

async function listModelsWithRetry(baseUrl: string, apiKey: string): Promise<string[]> {
  const attempt = async (): Promise<string[]> => {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? [])
      .map((m) => String(m.id ?? ''))
      .filter((id) => id && /^[\w.:@/-]{1,160}$/.test(id));
  };
  try {
    return await attempt();
  } catch {
    await new Promise((r) => setTimeout(r, 1_500));
    return attempt();
  }
}

/** Resolve an extra provider's API key through the same secret chain as the app secret. */
export async function resolveProviderKey(
  def: NonNullable<ReturnType<typeof providerDef>>,
): Promise<string | undefined> {
  const k = def.apiKey as unknown;
  if (typeof k === 'string') {
    const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(k);
    if (m) return process.env[m[1]!]?.trim() || undefined;
    return k.trim() || undefined;
  }
  // SecretInput ref forms (env/file/exec) ride the app secret resolver via a
  // dynamic import to avoid a config/ ↔ bot/ cycle at module init.
  try {
    const { resolveAppSecret } = await import('../config/secret-resolver');
    const shim = {
      accounts: { app: { secret: k } },
      secrets: undefined,
    } as unknown as Parameters<typeof resolveAppSecret>[0];
    const v = await resolveAppSecret(shim);
    return v?.trim() || undefined;
  } catch (err) {
    log.warn('provider', 'key-resolve-failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
