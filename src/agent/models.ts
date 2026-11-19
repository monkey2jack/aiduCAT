import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentKind } from '../config/profile-schema';

/**
 * Sentinel selection meaning "don't pass `--model`; let the agent CLI /
 * account decide". Kept as a real option value (rather than empty string)
 * because Feishu's `select_static` requires `initial_option` to match one of
 * the option `value`s exactly and rejects an empty string.
 */
export const DEFAULT_MODEL = 'default';

export interface ModelOption {
  /**
   * Stored in `preferences.model` and forwarded to the agent's `--model`
   * flag. `DEFAULT_MODEL` is special-cased to omit the flag entirely.
   */
  value: string;
  /** Human-facing label shown in the `/config` picker. */
  label: string;
}

/**
 * Claude Code models. Pinned to concrete version ids (Claude Code's `--model`
 * accepts the full model-id string, not just the `opus`/`sonnet` aliases) so
 * the picker names an exact model. Add new ids here when a generation ships;
 * `opusplan` is kept as the one alias with no versioned equivalent (it runs
 * Opus for planning and Sonnet for execution).
 */
const CLAUDE_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8（最新）' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5（最新）' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5（最新）' },
  { value: 'opusplan', label: 'Opus Plan（规划用 Opus，执行用 Sonnet）' },
];

/** Codex CLI models. Forwarded to `codex exec --model`. */
const CODEX_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { value: 'gpt-5', label: 'GPT-5' },
  { value: 'o3', label: 'o3' },
];

/** f0.4+: Hermes Agent — model ids come from Hermes's own model service
 * (e.g. 10router combos via /model); only the default is fixed here. */
const HERMES_MODELS: ModelOption[] = [{ value: DEFAULT_MODEL, label: '跟随 Hermes 配置（不指定）' }];

const DSH_FALLBACK_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随 DSH profile 配置（不指定）' },
];

/** The model routing a DSH profile's patch layer currently declares. */
export interface DshProfileModels {
  /** Provider route the profile's `agent-default-model` row points at. */
  provider?: string;
  /** Model the profile boots with. */
  model?: string;
  /** Model ids the profile's providers offer. */
  models: string[];
}

interface DshProfileCache {
  models: DshProfileModels;
  path: string;
  mtimeMs: number;
}
let dshProfileModelsCache: DshProfileCache | undefined;

/** Test seam: drop the memoized profile read. */
export function resetDshProfileModelsCache(): void {
  dshProfileModelsCache = undefined;
}

/**
 * Read the model routing the DSH profile layer declares.
 *
 * DSH has no `--model` flag: the model is the `agent-default-model` row in the
 * profile's own patch file, and the only per-invocation override is a
 * `--patch` overlay that REPLACES that row's whole config — so the provider
 * must be restated alongside the model. Reading the same file keeps the /model
 * picker honest instead of inventing model ids.
 *
 * Parsing is line-based over the documented patch layout rather than a YAML
 * dependency: the file is a flat, id-keyed list, and an unreadable or missing
 * profile must degrade to "no extra options", never throw.
 *
 * The read auto-refreshes: the profile file is the same document the desktop
 * GUI writes (Settings → Models), so each call stats it and re-parses only
 * when its mtime changed. Adjusting the model list on the desktop therefore
 * shows up on the next /model open without a service restart — the DSH
 * counterpart of the 5-minute combo refresh cc/codex/hermes use.
 */
export function resolveDshProfileName(configured?: string): string {
  return configured?.trim() || process.env.AIDUCAT_DSH_PROFILE?.trim() || 'headless';
}

export function readDshProfileModels(configured?: string): DshProfileModels {
  const located = locateDshProfilePatch(resolveDshProfileName(configured));
  if (!located) {
    dshProfileModelsCache = undefined;
    return { models: [] };
  }
  if (
    dshProfileModelsCache &&
    dshProfileModelsCache.path === located.path &&
    dshProfileModelsCache.mtimeMs === located.mtimeMs
  ) {
    return dshProfileModelsCache.models;
  }
  const models = parseDshProfileModels(located.text);
  dshProfileModelsCache = { models, path: located.path, mtimeMs: located.mtimeMs };
  return models;
}

function locateDshProfilePatch(profile: string): { path: string; text: string; mtimeMs: number } | undefined {
  const home = process.env.DSH_HOME?.trim();
  if (!home || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(profile) || profile.endsWith('.')) return undefined;
  // The bridge pins one profile per adapter (resolved once, then passed down):
  // dsh.profile -> AIDUCAT_DSH_PROFILE -> headless. This deployment runs the
  // shipped headless profile; the desktop one is the mirror's SOURCE, and a
  // shared-name deployment only changes this one string.
  const path = join(home, 'profiles', profile, 'cordis.patch.yml');
  try {
    const text = readFileSync(path, 'utf8');
    const mtimeMs = statSync(path).mtimeMs;
    return { path, text, mtimeMs };
  } catch {
    return undefined;
  }
}

function parseDshProfileModels(text: string | undefined): DshProfileModels {
  if (!text) return { models: [] };
  let provider: string | undefined;
  let model: string | undefined;
  const models: string[] = [];
  let section: 'default-model' | 'pi-ai' | undefined;
  let modelsIndent = -1;
  let inModelsBlock = false;
  let providersIndent = -1;
  let currentProvider: string | undefined;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      const id = /^-\s+id:\s*(\S+)\s*$/.exec(trimmed);
      if (id?.[1]) {
        const name = id[1];
        section =
          name === 'agent-default-model' ? 'default-model' : name === 'llm-pi-ai' ? 'pi-ai' : undefined;
        inModelsBlock = false;
        providersIndent = -1;
        currentProvider = undefined;
      }
      continue;
    }

    if (section === 'default-model') {
      const p = /^provider:\s*(.+?)\s*$/.exec(trimmed);
      if (p?.[1] && provider === undefined) provider = unquote(p[1]);
      const m = /^model:\s*(.+?)\s*$/.exec(trimmed);
      if (m?.[1] && model === undefined) model = unquote(m[1]);
      continue;
    }

    if (section === 'pi-ai') {
      // A profile may declare several providers (e.g. aidu + gpt). Only the
      // default-model's provider is routable by a --patch overlay (the overlay
      // restates that provider), so the picker lists THAT provider's models
      // alone — another provider's ids would switch to a model the restated
      // provider does not serve (UNKNOWN_MODEL at the gateway).
      if (/^providers:\s*$/.test(trimmed)) {
        providersIndent = indent;
        currentProvider = undefined;
        inModelsBlock = false;
        continue;
      }
      if (providersIndent >= 0 && indent === providersIndent + 2) {
        const pk = /^([A-Za-z0-9_-]+):\s*$/.exec(trimmed);
        if (pk) {
          currentProvider = pk[1];
          inModelsBlock = false;
          continue;
        }
      }
      if (/^models:\s*$/.test(trimmed)) {
        // Scope to the default provider when both are known; a profile with
        // no provider declaration (or no providers wrapper) lists everything,
        // as before.
        inModelsBlock =
          provider === undefined || providersIndent < 0 || currentProvider === provider;
        modelsIndent = indent;
        continue;
      }
      if (!inModelsBlock) continue;
      if (indent <= modelsIndent) {
        inModelsBlock = false;
        continue;
      }
      const m = /^-\s+id:\s*(.+?)\s*$/.exec(trimmed);
      if (m?.[1]) models.push(unquote(m[1]));
    }
  }

  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    models,
  };
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '').trim();
}

/**
 * The /model picker for a DSH profile: "follow the profile" first, then every
 * model the profile's provider actually offers. Switching writes a `--patch`
 * overlay, so an id that is not in this list would fail the run.
 */
export function dshModelCatalog(configuredProfile?: string): ModelOption[] {
  const { model, models } = readDshProfileModels(configuredProfile);
  if (models.length === 0) {
    return model
      ? [{ value: DEFAULT_MODEL, label: `跟随 DSH profile（当前 ${model}）` }]
      : DSH_FALLBACK_MODELS.map((m) => ({ ...m }));
  }
  const options: ModelOption[] = [
    {
      value: DEFAULT_MODEL,
      label: model ? `跟随 DSH profile（当前 ${model}）` : '跟随 DSH profile（不指定）',
    },
  ];
  const seen = new Set<string>();
  for (const id of models) {
    if (seen.has(id)) continue;
    seen.add(id);
    options.push({ value: id, label: id });
  }
  return options;
}

export const OPENCODE_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: 'Default (OpenCode Default)' },
  { value: 'opencode/hy4-flash-free', label: 'Hunyuan 4 Flash (Free)' },
];

/** The model picker options for a profile's agent kind. */
export function supportedModels(agentKind: AgentKind): ModelOption[] {
  if (agentKind === 'hermes') return HERMES_MODELS;
  if (agentKind === 'dsh') return dshModelCatalog();
  if (agentKind === 'opencode' || agentKind === 'openchamber') return OPENCODE_MODELS;
  return agentKind === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
}

/** True when the selection means "use the agent default" (no `--model`). */
export function isDefaultModel(value: string | undefined): boolean {
  return !value || value === DEFAULT_MODEL;
}

/**
 * Coerce a stored model preference into a value guaranteed to be one of the
 * current agent's picker options — Feishu's `select_static` requires
 * `initial_option` to match an option value exactly. Unknown / cross-agent
 * values (e.g. a Claude alias left over after switching a profile to Codex)
 * fall back to {@link DEFAULT_MODEL}.
 */
export function normalizeModelSelection(
  agentKind: AgentKind,
  value: string | undefined,
): string {
  if (isDefaultModel(value) || value === undefined) return DEFAULT_MODEL;
  // aiduCAT: free-form model ids are legitimate here — behind a gateway
  // (10router) the useful names are combo ids outside the hardcoded picker
  // catalog (`Gemini-3.8-Flash`, `claude-opus-4-6-thinking`, …). Any
  // non-default stored value passes through; only the /config form picker
  // (which needs exact option-value matches for select_static) clamps.
  // `/` and `@` are allowed: gateway ids look like `cu/claude-opus-5-5` or
  // `model@version`, and rejecting them silently fell back to default.
  if (/^[\w.:@/-]{1,120}$/.test(value)) return value;
  return supportedModels(agentKind).some((m) => m.value === value)
    ? (value as string)
    : DEFAULT_MODEL;
}

/**
 * Resolve the concrete model string to hand the agent, or `undefined` to omit
 * the `--model` flag. Cross-agent / unknown values are treated as "default".
 */
export function resolveModelArg(
  agentKind: AgentKind,
  value: string | undefined,
): string | undefined {
  const normalized = normalizeModelSelection(agentKind, value);
  return normalized === DEFAULT_MODEL ? undefined : normalized;
}

/** Picker label for a stored value, for display in the saved-config card. */
export function modelLabel(agentKind: AgentKind, value: string | undefined): string {
  const normalized = normalizeModelSelection(agentKind, value);
  return supportedModels(agentKind).find((m) => m.value === normalized)?.label ?? normalized;
}

/**
 * f0.5++: the model name the card's meta panel shows.
 *
 * An explicit /model pick rides the `--patch` overlay, so it IS what the next
 * turn runs — show it verbatim. Only "follow the profile" needs the profile's
 * own `agent-default-model` declaration: the `--json` event stream carries no
 * model field, so the bridge cannot probe what actually ran, and reading the
 * same row the run boots from keeps the name honest (a hard-coded label would
 * silently drift). `modelLabel` is only a fallback for an unreadable profile,
 * and describing where the model comes from is the last resort.
 */
export function displayModelName(
  agentKind: AgentKind,
  profile: { dsh?: { modelLabel?: string; profile?: string } },
  selected: string | undefined,
): string | undefined {
  if (agentKind !== 'dsh') return selected;
  if (!isDefaultModel(selected)) return selected;
  return (
    readDshProfileModels(profile.dsh?.profile).model ?? profile.dsh?.modelLabel ?? '跟随 DSH profile'
  );
}
