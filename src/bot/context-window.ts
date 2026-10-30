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
