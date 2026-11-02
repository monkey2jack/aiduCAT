/**
 * f04-group-cmd-model (Wei 2026-11-02): the model is chosen per chat.
 *
 * - DM `/model` changes the profile default (`preferences.model/provider/effort`).
 * - `/model` inside a group changes only that group (`preferences.chatModels[chatId]`).
 * - A group with no entry follows the profile default, live — changing the
 *   default later moves it too; a group that set its own model keeps it.
 *
 * Everything a run derives from the model (the `--model` arg, provider env,
 * effort, context window, 60% auto-compact) reads the EFFECTIVE choice via
 * {@link profileForChat}, so the window/compact always follow the model the
 * chat really runs.
 */
import type { ChatModelPref } from './schema';
import type { ProfileConfig } from './profile-schema';

export type ChatModelSource = 'chat' | 'default';

export interface EffectiveModelPrefs {
  model?: string;
  provider?: string;
  effort?: string;
  /** 'chat' = this group's own setting; 'default' = the profile default. */
  source: ChatModelSource;
}

const FIELDS = ['model', 'provider', 'effort'] as const;

/** Keep string→{model?,provider?,effort?} entries (string fields only); drop junk. */
export function normalizeChatModels(input: unknown): Record<string, ChatModelPref> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, ChatModelPref> = {};
  for (const [chatId, value] of Object.entries(input as Record<string, unknown>)) {
    if (!chatId || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry: ChatModelPref = {};
    for (const key of FIELDS) {
      const v = (value as Record<string, unknown>)[key];
      if (typeof v === 'string' && v.trim()) entry[key] = v.trim();
    }
    // An entry with every field unset is still a deliberate choice ("this
    // group runs the CLI default model"), so keep it.
    out[chatId] = entry;
  }
  return out;
}

/** The chat's own entry, if it has one. DMs never have one (they ARE the default). */
export function chatModelEntry(
  profile: Pick<ProfileConfig, 'preferences'>,
  chatId: string | undefined,
): ChatModelPref | undefined {
  if (!chatId) return undefined;
  const map = profile.preferences.chatModels;
  if (!map || !Object.prototype.hasOwnProperty.call(map, chatId)) return undefined;
  return map[chatId];
}

/** Model / provider / effort this chat actually runs with, and where it came from. */
export function effectiveModelPrefs(
  profile: Pick<ProfileConfig, 'preferences'>,
  chatId: string | undefined,
): EffectiveModelPrefs {
  const own = chatModelEntry(profile, chatId);
  if (own) {
    return {
      ...(own.model ? { model: own.model } : {}),
      ...(own.provider ? { provider: own.provider } : {}),
      ...(own.effort ? { effort: own.effort } : {}),
      source: 'chat',
    };
  }
  const p = profile.preferences;
  return {
    ...(p.model ? { model: p.model } : {}),
    ...(p.provider ? { provider: p.provider } : {}),
    ...(p.effort ? { effort: p.effort } : {}),
    source: 'default',
  };
}

/**
 * The profile as one chat sees it: same object when the chat follows the
 * default; otherwise a shallow copy whose preferences carry the chat's own
 * model/provider/effort. Everything else (access, workspaces, providers…) is
 * untouched.
 */
export function profileForChat<T extends Pick<ProfileConfig, 'preferences'>>(
  profile: T,
  chatId: string | undefined,
): T {
  const own = chatModelEntry(profile, chatId);
  if (!own) return profile;
  const { model: _m, provider: _p, effort: _e, ...restPrefs } = profile.preferences;
  return {
    ...profile,
    preferences: {
      ...restPrefs,
      ...(own.model ? { model: own.model } : {}),
      ...(own.provider ? { provider: own.provider } : {}),
      ...(own.effort ? { effort: own.effort } : {}),
    },
  };
}

/** Human label for /status and the /model card. */
export function chatModelSourceLabel(source: ChatModelSource, isGroup: boolean): string {
  if (!isGroup) return '默认';
  return source === 'chat' ? '本群设置' : '跟随默认';
}
