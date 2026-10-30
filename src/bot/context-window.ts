import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProfileConfig } from '../config/profile-schema';
import { fetchContextWindows } from './tenrouter';

/**
 * aiduCAT: context window for the run's model, from 10router's /v1/models
 * (cached 10 min). Returns undefined when 10router isn't configured or the
 * model isn't listed.
 */
export async function contextWindowForModel(model: string | undefined): Promise<number | undefined> {
  const url = (process.env.AIDU_10ROUTER_URL ?? '').trim();
  if (!url || !model) return undefined;
  const windows = await fetchContextWindows(url);
  return windows.get(model);
}

/** Fallback when the router lookup has no answer (no AIDU_10ROUTER_URL, or a
 * gateway like CLIProxyAPI whose /v1/models carries no context size): use the
 * active provider's declared `contextWindow`, so the 60% auto-compact still
 * applies on non-10router providers. */
export function providerContextWindow(profile: ProfileConfig): number | undefined {
  const id = profile.preferences.provider;
  if (!id || id === 'default') return undefined;
  const win = profile.modelProviders?.[id]?.contextWindow;
  return typeof win === 'number' && win > 0 ? win : undefined;
}

/** f031-#8: the window a run is spawned with (drives
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW in run-flow). /status uses the SAME
 * resolution so its denominator and 🗜️ match what the CLI was told. */
export async function resolveModelWindow(
  profile: ProfileConfig,
  model: string | undefined,
): Promise<number | undefined> {
  return (await contextWindowForModel(model)) ?? providerContextWindow(profile);
}

/** Auto-compact trigger as % of the window (AIDUCAT_COMPACT_PCT, default 60). */
export function compactPct(): number | undefined {
  const pct = Number(process.env.AIDUCAT_COMPACT_PCT ?? 60);
  return pct > 0 && pct <= 100 ? pct : undefined;
}

/**
 * f031-#8: window / auto-compact the Claude CLI applies on its own when
 * aiduCAT passes no override — from `env` in the CLI's settings.json
 * ($CLAUDE_CONFIG_DIR or ~/.claude), then the bot's process env. Only these
 * two numeric keys are read; nothing else from the file is kept.
 */
export async function claudeCliWindow(): Promise<{ window?: number; compactWindow?: number }> {
  const num = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  let env: Record<string, unknown> = {};
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
    const raw = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as { env?: unknown };
    if (raw.env && typeof raw.env === 'object') env = raw.env as Record<string, unknown>;
  } catch {
    /* no settings file → process env only */
  }
  return {
    window: num(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) ?? num(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS),
    compactWindow: num(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) ?? num(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW),
  };
}
