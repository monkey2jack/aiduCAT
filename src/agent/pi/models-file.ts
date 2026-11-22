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

export interface PiModelEntry {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
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
