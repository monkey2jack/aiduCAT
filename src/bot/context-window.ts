import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProfileConfig } from '../config/profile-schema';
import { cachedCombos } from './tenrouter';

/**
 * f0.3.4 (Wei: 「aiduCAT 天生就是配合 10router 用的，只加载 combo 最好」):
 * the window comes from the 10router *combo* entry when /api/combos carries
 * one — never from the 715-model /v1/models list, which used to be re-pulled
 * synchronously in every flush and blocked a round for ~5s.
 * Reads the combo cache only (stale-while-revalidate, see tenrouter.ts), so
 * it never waits on the network. Undefined when the combo has no window —
 * then the provider default applies, and failing that the run passes no
 * override and the Claude CLI uses its own settings.json
 * (CLAUDE_CODE_MAX_CONTEXT_TOKENS / CLAUDE_CODE_AUTO_COMPACT_WINDOW).
 */
export function contextWindowForModel(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const combos = cachedCombos();
  if (!combos) return undefined;
  const hit = combos.find((c) => c.name === model) ?? combos.find((c) => c.id === model);
  return hit?.contextWindow;
}

/** Fallback when the combo carries no window (or no 10router at all): use the
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
export function resolveModelWindow(
  profile: ProfileConfig,
  model: string | undefined,
): number | undefined {
  return contextWindowForModel(model) ?? providerContextWindow(profile);
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
