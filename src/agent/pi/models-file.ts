import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../../core/logger';

/**
 * f0.6+ (pi): pi reads its model catalog from `<agent-dir>/models.json`.
 * aiduCAT owns a dedicated agent dir per profile and writes ONLY the
 * curated 10router combos into it — never the ~700 raw provider models
 * (猴哥's standing rule, same as the /model card).
 *
 * The API key is NEVER written to disk: models.json supports `$NAME` env
 * interpolation, so the file references `AIDUCAT_PI_API_KEY` and the
 * adapter injects the real key into the child's env at spawn time (via the
 * same secret chain every other agent uses).
 *
 * The file is rewritten when the combo catalog refreshes (5-minute TTL in
 * tenrouter.ts); pi re-reads models.json when a model command runs, and
 * `set_model` takes effect immediately, so combo edits on 10router show up
 * without a service restart.
 */

export const PI_PROVIDER_ID = '10router';
export const PI_API_KEY_ENV = 'AIDUCAT_PI_API_KEY';
/** Fallback window when the gateway does not report one (Wei 2026-11-24: 1M). */
export const PI_DEFAULT_CONTEXT_WINDOW = 1_000_000;
/** Auto-compact once the context reaches this share of the window (Wei 2026-11-24: 70%). */
export const PI_COMPACT_AT = 0.7;
/** Retry defaults written when settings.json has none (upstream queues ~30s+). */
export const PI_RETRY_DEFAULTS = { enabled: true, maxRetries: 6, baseDelayMs: 5000, maxAgentDelayMs: 60000 };

export interface PiModelEntry {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  /** accepts images (gateway capabilities.vision) */
  vision?: boolean;
}

export interface PiModelsFileInput {
  baseUrl: string;
  models: readonly PiModelEntry[];
}

export function renderModelsJson(input: PiModelsFileInput): string {
  const providers: Record<string, unknown> = {
    [PI_PROVIDER_ID]: {
      name: '10router (aiduCAT combos)',
      baseUrl: input.baseUrl.replace(/\/+$/, ''),
      api: 'openai-completions',
      apiKey: `$${PI_API_KEY_ENV}`,
      authHeader: true,
      models: input.models.map((m) => ({
        id: m.id,
        name: m.id,
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        maxTokens: m.maxTokens ?? 32000,
        // vision models: pi's read tool then hands images to the model
        // instead of refusing them (Wei 2026-11-25「要打开」)
        ...(m.vision ? { input: ['text', 'image'] } : {}),
      })),
    },
  };
  return JSON.stringify({ providers }, null, 2) + '\n';
}

/** Write models.json into the profile's pi agent dir. Idempotent. */
export function writePiModelsFile(agentDir: string, input: PiModelsFileInput): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const path = join(agentDir, 'models.json');
  const next = renderModelsJson(input);
  try {
    if (existsSync(path) && readFileSync(path, 'utf8') === next) return;
  } catch {
    // fall through and rewrite
  }
  writeFileSync(path, next, { mode: 0o600 });
  log.info('agent', 'pi-models-written', { path, models: input.models.length });
}

/**
 * Merge aiduCAT-managed keys into pi's settings.json, keeping everything
 * else the owner put there:
 *  - compaction.modelOverrides["10router/<id>"].reserveTokens so pi
 *    compacts at PI_COMPACT_AT of each model's window (pi compacts when
 *    context > window - reserveTokens; one global reserve can't express a
 *    ratio across 229k and 1M models)
 *  - retry defaults, only when the file has no retry block
 */
export function writePiSettings(agentDir: string, models: readonly PiModelEntry[]): void {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const path = join(agentDir, 'settings.json');
  let cur: Record<string, unknown> = {};
  let raw = '';
  try {
    if (existsSync(path)) {
      raw = readFileSync(path, 'utf8');
      cur = JSON.parse(raw) as Record<string, unknown>;
    }
  } catch (err) {
    // never clobber a file we cannot parse
    log.warn('agent', 'pi-settings-unreadable', { path, err: err instanceof Error ? err.message : String(err) });
    return;
  }
  const compaction = { ...((cur.compaction as Record<string, unknown> | undefined) ?? {}) };
  const overrides = { ...((compaction.modelOverrides as Record<string, unknown> | undefined) ?? {}) };
  for (const k of Object.keys(overrides)) if (k.startsWith(`${PI_PROVIDER_ID}/`)) delete overrides[k];
  for (const m of models) {
    if (!m.contextWindow) continue;
    overrides[`${PI_PROVIDER_ID}/${m.id}`] = {
      reserveTokens: Math.round(m.contextWindow * (1 - PI_COMPACT_AT)),
    };
  }
  compaction.modelOverrides = overrides;
  const next: Record<string, unknown> = { ...cur, compaction };
  if (next.retry === undefined) next.retry = { ...PI_RETRY_DEFAULTS };
  const text = JSON.stringify(next, null, 2) + '\n';
  if (text === raw) return;
  writeFileSync(path, text, { mode: 0o600 });
  log.info('agent', 'pi-settings-written', { path, overrides: models.length });
}
