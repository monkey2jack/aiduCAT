import { normalizeChatModels } from './chat-model';
import { isAbsolute, join } from 'node:path';
import { devNull } from 'node:os';
import type {
  AppCredentials,
  AppPreferences,
  MessageReplyMode,
  SecretsConfig,
} from './schema';
import {
  normalizePermissions,
  permissionsToLegacySandbox,
  type AccessMode,
  type CodexSandboxMode,
  type PermissionConfig,
  type PermissionSource,
} from './permissions';

export type AgentKind = 'claude' | 'codex';
export type SandboxMode = CodexSandboxMode;
export type { AccessMode, PermissionConfig, PermissionSource };

export interface ProfileAccess {
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  requireMentionInGroup: boolean;
  /**
   * Per-chat override of {@link requireMentionInGroup}, keyed by chat_id.
   * `true` = require an @-mention in that chat, `false` = respond to every
   * message. A chat absent from the map follows the global setting. Takes
   * priority over `requireMentionInGroup` for the chats it lists.
   */
  chatRequireMention?: Record<string, boolean>;
  /**
   * f031-sec-#3: open_ids of other bots/apps allowed to drive this bot
   * (bot-at-bot). Empty/absent = every non-human sender is rejected. A listed
   * bot still has to be in an allowlisted group.
   */
  allowedBots?: string[];
  /**
   * chat_ids of allowlisted groups where every human member may use the bot
   * (not only allowedUsers/admins/owner). Only takes effect for chats that are
   * also in {@link allowedChats}. Toggle in the group with `/invite alluser`.
   * Empty/absent = sender allowlist applies (f031-sec-#3 default).
   */
  chatAllowAllUsers?: string[];
  /**
   * f0.4 之后的修复: extra paths a non-owner (outsider) run may not read — on
   * top of the built-in credential list. Absolute or `~/`; a `*` in the last
   * segment matches existing files (backups). Claude Code profiles only; the
   * owner's runs are unaffected. Edit config.json and restart to change.
   */
  outsiderDenyRead?: string[];
}

export interface SandboxConfig {
  default?: SandboxMode;
  max?: SandboxMode;
  defaultMode: SandboxMode;
  maxMode: SandboxMode;
}

export interface CodexConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
}

export interface AttachmentConfig {
  maxCount: number;
  maxBytes: number;
  maxFileBytes: number;
  imageMaxBytes: number;
  cacheTtlMs: number;
  cacheMaxBytes: number;
}

export type CommentConfig = Record<string, never>;

/** Where the agent's answer goes when it responds to meeting content. */
export type MeetingRespondIn = 'meeting' | 'im' | 'both';

/**
 * Where the end-of-meeting summary is delivered.
 *  - `origin`: the chat the bot was told to join from (`/meeting join` there).
 *  - `owner`: the bot owner's direct message.
 * Either way the other one is used as a fallback, so a summary is never
 * silently dropped just because the preferred target isn't available (a
 * console-initiated join has no origin chat; an unresolved owner has no DM).
 */
export type MeetingSummaryTarget = 'origin' | 'owner';

/**
 * In-meeting agent ("智能体入会", path 2 / TAT): the bot joins a Feishu meeting
 * as a real participant, receives in-meeting activity (transcript, chat,
 * participants, doc shares) and can answer in the meeting or over IM.
 *
 * Off by default — the capability is gated by a Feishu allowlist plus the
 * `vc:meeting.bot.join:write` scope, so it must be opted into per profile.
 */
export interface MeetingConfig {
  enabled: boolean;
  /** Auto-join when the bot is invited (needs `vc.bot.meeting_invited_v1` push). */
  autoJoinOnInvite: boolean;
  transcript: {
    /** Rolling transcript lines kept as agent context. */
    keep: number;
    /** Debounce window (ms) before a sentence counts as final; 0 = emit every update. */
    stabilizeMs: number;
  };
  /** Where answers go. */
  respondIn: MeetingRespondIn;
  /**
   * Extra prefix that makes an in-meeting chat message a question for the agent.
   * `@<bot 当前名字>` is always accepted on top of this, so the natural thing to
   * type works without configuring anything.
   */
  trigger: string;
  /** Base interval for the `bots/events` poller (idle rounds back off). */
  pollIntervalMs: number;
  /** Summarize the meeting to IM when it ends. */
  summaryOnEnd: boolean;
  /** Preferred destination for that summary. See {@link MeetingSummaryTarget}. */
  summaryTarget: MeetingSummaryTarget;
}

/**
 * f03p-slim-#1: optional modules, switched per profile. Every module is on
 * unless the profile says `false` explicitly, so an old config keeps today's
 * behavior. A module that is off is not loaded at all (lazy import), its
 * commands are hidden from /help and answer {@link FEATURE_OFF_REPLY}.
 *  - meeting:    in-meeting agent (/meeting, vc.bot.* pushes)
 *  - webConsole: local web console (`run/start --web-ui`, `aiduCAT ui`, /config console line)
 *  - codex:      Codex CLI agent (agentKind codex, codex /resume history)
 *  - cot:        Feishu CoT process messages (/config「COT 过程消息」)
 */
export interface ProfileFeatures {
  meeting: boolean;
  webConsole: boolean;
  codex: boolean;
  cot: boolean;
}
export type FeatureName = keyof ProfileFeatures;
export const FEATURE_NAMES: readonly FeatureName[] = ['meeting', 'webConsole', 'codex', 'cot'];
/** What a switched-off module answers. */
export const FEATURE_OFF_REPLY = '此功能未开启';

/** True unless the profile switched the module off explicitly. */
export function featureEnabled(
  profile: { features?: Partial<ProfileFeatures> } | undefined,
  name: FeatureName,
): boolean {
  return profile?.features?.[name] !== false;
}

function normalizeFeatures(input: unknown): ProfileFeatures {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    meeting: raw.meeting !== false,
    webConsole: raw.webConsole !== false,
    codex: raw.codex !== false,
    cot: raw.cot !== false,
  };
}

/** Stored form: only the switched-off modules (undefined when all on). */
export function storedFeatures(features: Partial<ProfileFeatures> | undefined): Partial<ProfileFeatures> | undefined {
  if (!features) return undefined;
  const off: Partial<ProfileFeatures> = {};
  for (const name of FEATURE_NAMES) if (features[name] === false) off[name] = false;
  return Object.keys(off).length > 0 ? off : undefined;
}

export type LarkCliIdentityPreset = 'bot-only' | 'user-default';

/**
 * Deployment mode — a single switch that binds two behaviors together
 * (see the "团队版 Bot 权限调整" spec):
 *   - `personal` (default, the status quo): only owner + allowlisted
 *     users/chats can use the bot; the CLI may carry owner's personal (user)
 *     authorization per {@link LarkCliConfig.identityPreset}.
 *   - `team`: anyone can @-use the bot (no allowlist gating), and the CLI is
 *     forced to `bot-only` so it never carries owner's personal authorization.
 *
 * The two behaviors are intentionally bound to one switch, not two configs.
 * Admin/sensitive commands stay owner/admin-gated in both modes.
 */
export type ProfileMode = 'personal' | 'team';

export type LarkCliUserImportStatus =
  | 'not-needed'
  | 'imported'
  | 'skipped-existing-private-user'
  | 'skipped-no-local-user'
  | 'failed';

export interface LarkCliConfig {
  identityPreset: LarkCliIdentityPreset;
  localUserImport?: {
    status: LarkCliUserImportStatus;
    attemptedAt?: string;
    importedAt?: string;
    reason?: string;
  };
}

export interface ProfileConfig {
  schemaVersion: 2;
  agentKind: AgentKind;
  /** Deployment mode switch. Default 'personal'. See {@link ProfileMode}. */
  mode: ProfileMode;
  accounts: {
    app: AppCredentials;
  };
  secrets?: SecretsConfig;
  preferences: Omit<AppPreferences, 'access' | 'requireMentionInGroup'>;
  /** f0.2: extra API providers for the /model card (see ModelProviderDef). */
  modelProviders?: Record<string, import('./schema').ModelProviderDef>;
  /**
   * f0.2: display name of the gateway the service environment already points
   * to (e.g. `10router`). Shown as the first /model dropdown choice instead
   * of a URL — provider names are the user-facing identity, URLs are noise.
   */
  defaultProviderName?: string;
  access: ProfileAccess;
  workspaces: {
    default?: string;
    /**
     * f03p-infra-#3: optional /cd allowlist — absolute paths or `~/…`. When
     * set, /cd, /ws use and a chat's own cwd must sit under one of them (the
     * profile default above is the owner's choice and is not checked).
     */
    roots?: string[];
  };
  sandbox: SandboxConfig;
  permissions: PermissionConfig;
  permissionSource?: PermissionSource;
  codex?: CodexConfig;
  attachments: AttachmentConfig;
  comments: CommentConfig;
  /** In-meeting agent settings. See {@link MeetingConfig}. */
  meeting: MeetingConfig;
  larkCli: LarkCliConfig;
  /**
   * f031-sec-#4: daemon env vars the owner explicitly passes through to the
   * agent subprocess (the default env is an allowlist). Names only.
   */
  agentEnv?: { passthrough: string[] };
  /** f03p-slim-#1: optional module switches (normalized: all four keys). */
  features?: ProfileFeatures;
}

/**
 * The lark-cli identity preset that actually takes effect, after applying the
 * deployment-mode override. Team mode forces `bot-only` regardless of the
 * user's stored {@link LarkCliConfig.identityPreset} (which is preserved so it
 * comes back into effect when switching back to personal mode). This is the
 * single source of truth for "team mode forces bot-only" — every place that
 * applies the lark-cli identity policy should read through here.
 */
export function effectiveLarkCliIdentity(
  profile: Pick<ProfileConfig, 'mode' | 'larkCli'>,
): LarkCliIdentityPreset {
  return profile.mode === 'team' ? 'bot-only' : profile.larkCli.identityPreset;
}

/**
 * f031-sec-H2 (#5 hardened, 猴哥授权 2026-10-31): a run started by anyone but
 * the owner gets NO lark-cli config — neither the profile's lark-cli dir (which
 * may hold the owner's user token) nor the source projection. Both point at a
 * path under the null device, which can never exist or be created, so lark-cli
 * cannot fall back to any credential. DEFAULT_AS/STRICT_MODE=bot stay as a
 * second lock. The owner's runs are unchanged.
 */
export const NO_LARK_CLI_CONFIG_DIR = join(devNull, 'aiducat-no-lark-cli');

export function runLarkCliIdentityEnv(
  _profile: Pick<ProfileConfig, 'mode' | 'larkCli'>,
  actorIsOwner: boolean,
): Record<string, string> {
  if (actorIsOwner) return {};
  return {
    LARKSUITE_CLI_CONFIG_DIR: NO_LARK_CLI_CONFIG_DIR,
    LARK_CHANNEL_CONFIG: NO_LARK_CLI_CONFIG_DIR,
    LARKSUITE_CLI_STRICT_MODE: 'bot',
    LARKSUITE_CLI_DEFAULT_AS: 'bot',
  };
}

export interface RootConfig {
  schemaVersion: 2;
  activeProfile: string;
  preferences: Record<string, never>;
  secrets?: SecretsConfig;
  migrations?: {
    permissionDefaultsV1?: string[];
  };
  profiles: Record<string, ProfileConfig>;
}

export interface CreateDefaultProfileConfigInput {
  agentKind: AgentKind;
  /** Deployment mode. Default 'personal'. */
  mode?: ProfileMode;
  accounts: {
    app: AppCredentials;
  };
  preferences?: AppPreferences;
  access?: Partial<ProfileAccess>;
  sandbox?: Partial<SandboxConfig>;
  permissions?: Partial<PermissionConfig>;
  codex?: CodexConfig;
  secrets?: SecretsConfig;
  features?: Partial<ProfileFeatures>;
}

export function createDefaultProfileConfig(
  input: CreateDefaultProfileConfigInput,
): ProfileConfig {
  return normalizeProfileConfig({
    schemaVersion: 2,
    ...input,
  });
}

export function normalizeProfileConfig(input: unknown): ProfileConfig {
  if (!input || typeof input !== 'object') {
    throw new Error('profile config must be an object');
  }
  const raw = input as {
    schemaVersion?: unknown;
    modelProviders?: unknown;
    defaultProviderName?: unknown;
    agentKind?: unknown;
    mode?: unknown;
    accounts?: unknown;
    secrets?: SecretsConfig;
    preferences?: (AppPreferences & { access?: Partial<ProfileAccess> }) | undefined;
    access?: Partial<ProfileAccess>;
    workspaces?: {
      default?: unknown;
      roots?: unknown;
      // Legacy workspace authorization fields are accepted for config
      // compatibility only; normalizeWorkspaces drops them.
      trusted?: unknown;
      trustedRoots?: unknown;
      riskFlags?: unknown;
    };
    sandbox?: Partial<SandboxConfig>;
    permissions?: Partial<PermissionConfig>;
    codex?: CodexConfig & { flags?: unknown };
    attachments?: Partial<AttachmentConfig>;
    comments?: unknown;
    meeting?: unknown;
    larkCli?: unknown;
    agentEnv?: { passthrough?: unknown };
    features?: unknown;
  };

  if (raw.schemaVersion !== 2) {
    throw new Error('profile schemaVersion must be 2');
  }
  if (raw.agentKind !== 'claude' && raw.agentKind !== 'codex') {
    throw new Error('agentKind must be claude or codex');
  }
  const accounts = normalizeAccounts(raw.accounts);
  if (raw.agentKind === 'codex' && !raw.codex) {
    throw new Error('codex profile requires codex configuration');
  }

  const preferences = normalizePreferences(raw.preferences);
  const access = normalizeAccess(
    raw.access ?? raw.preferences?.access,
    raw.preferences?.requireMentionInGroup,
  );
  const { permissions, source: permissionSource } = normalizePermissions({
    permissions: raw.permissions,
    sandbox: raw.sandbox,
  });
  const sandbox = permissionsToLegacySandbox(permissions);
  const workspaces = normalizeWorkspaces(raw.workspaces);
  const comments = normalizeComments(raw.comments);
  const meeting = normalizeMeeting(raw.meeting);
  const larkCli = normalizeLarkCli(raw.larkCli);

  return {
    schemaVersion: 2,
    agentKind: raw.agentKind,
    mode: raw.mode === 'team' ? 'team' : 'personal',
    accounts,
    ...(raw.secrets ? { secrets: raw.secrets } : {}),
    preferences,
    access,
    workspaces,
    sandbox,
    permissions,
    permissionSource,
    // f0.2: structural passthrough validated lightly — entries are read via
    // the SecretInput chain at run time; malformed entries fail there.
    ...(raw.modelProviders && typeof raw.modelProviders === 'object'
      ? { modelProviders: raw.modelProviders as ProfileConfig['modelProviders'] }
      : {}),
    ...(typeof raw.defaultProviderName === 'string' && raw.defaultProviderName.trim()
      ? { defaultProviderName: raw.defaultProviderName.trim() }
      : {}),
    ...(raw.codex ? { codex: normalizeCodex(raw.codex) } : {}),
    ...normalizeAgentEnv(raw.agentEnv),
    attachments: {
      maxCount: numberOr(raw.attachments?.maxCount, 10),
      maxBytes: numberOr(raw.attachments?.maxBytes, 100 * 1024 * 1024),
      maxFileBytes: numberOr(raw.attachments?.maxFileBytes, 25 * 1024 * 1024),
      imageMaxBytes: numberOr(raw.attachments?.imageMaxBytes, 25 * 1024 * 1024),
      cacheTtlMs: numberOr(raw.attachments?.cacheTtlMs, 24 * 60 * 60 * 1000),
      cacheMaxBytes: numberOr(raw.attachments?.cacheMaxBytes, 512 * 1024 * 1024),
    },
    comments,
    meeting,
    larkCli,
    features: normalizeFeatures(raw.features),
  };
}

function normalizeAccounts(input: unknown): ProfileConfig['accounts'] {
  if (!input || typeof input !== 'object') {
    throw new Error('accounts.app is required');
  }
  const accounts = input as { app?: Partial<AppCredentials> };
  const app = accounts.app;
  if (!app?.id || !app.secret || (app.tenant !== 'feishu' && app.tenant !== 'lark')) {
    throw new Error('accounts.app is incomplete');
  }
  return {
    app: {
      id: app.id,
      secret: app.secret,
      tenant: app.tenant,
    },
  };
}

function normalizePreferences(
  preferences: AppPreferences | undefined,
): ProfileConfig['preferences'] {
  const {
    access: _access,
    requireMentionInGroup: _mention,
    messageReply,
    chatModels: rawChatModels,
    ...rest
  } = preferences ?? {};
  // f04-group-cmd-model: keep every well-formed per-group model entry (load
  // and save never trim valid ones); drop only malformed junk.
  const chatModels = normalizeChatModels(rawChatModels);
  const withChats = Object.keys(chatModels).length > 0 ? { ...rest, chatModels } : rest;
  if (messageReply !== undefined && isMessageReply(messageReply)) {
    return {
      ...withChats,
      messageReply,
    };
  }
  return withChats;
}

function isMessageReply(value: unknown): value is MessageReplyMode {
  return value === 'card' || value === 'markdown' || value === 'text';
}

function normalizeAgentEnv(input: { passthrough?: unknown } | undefined): Pick<ProfileConfig, 'agentEnv'> {
  const names = stringArray(input?.passthrough).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
  return names.length > 0 ? { agentEnv: { passthrough: names } } : {};
}

function normalizeAccess(
  access: Partial<ProfileAccess> | undefined,
  legacyRequireMentionInGroup: boolean | undefined,
): ProfileAccess {
  const chatRequireMention = normalizeChatMentionMap(access?.chatRequireMention);
  const allowedBots = stringArray(access?.allowedBots);
  const chatAllowAllUsers = stringArray(access?.chatAllowAllUsers);
  const outsiderDenyRead = stringArray(access?.outsiderDenyRead)
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    allowedUsers: stringArray(access?.allowedUsers),
    allowedChats: stringArray(access?.allowedChats),
    admins: stringArray(access?.admins),
    requireMentionInGroup: access?.requireMentionInGroup ?? legacyRequireMentionInGroup ?? true,
    // Omit when empty so configs without per-chat overrides stay clean.
    ...(Object.keys(chatRequireMention).length > 0 ? { chatRequireMention } : {}),
    ...(allowedBots.length > 0 ? { allowedBots } : {}),
    ...(chatAllowAllUsers.length > 0 ? { chatAllowAllUsers } : {}),
    ...(outsiderDenyRead.length > 0 ? { outsiderDenyRead } : {}),
  };
}

/** Keep only string→boolean entries; drop anything malformed. */
function normalizeChatMentionMap(input: unknown): Record<string, boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, boolean> = {};
  for (const [chatId, value] of Object.entries(input as Record<string, unknown>)) {
    if (chatId && typeof value === 'boolean') out[chatId] = value;
  }
  return out;
}

function normalizeWorkspaces(input: {
  default?: unknown;
  roots?: unknown;
  trusted?: unknown;
  trustedRoots?: unknown;
  riskFlags?: unknown;
} | undefined): ProfileConfig['workspaces'] {
  const defaultWorkspace = typeof input?.default === 'string' && input.default.trim()
    ? input.default.trim()
    : undefined;
  const roots = Array.isArray(input?.roots)
    ? input.roots
        .filter((r): r is string => typeof r === 'string')
        .map((r) => r.trim())
        .filter((r) => r === '~' || r.startsWith('~/') || isAbsolute(r))
    : [];
  return {
    ...(defaultWorkspace ? { default: defaultWorkspace } : {}),
    ...(roots.length > 0 ? { roots } : {}),
  };
}

function normalizeCodex(input: CodexConfig & { flags?: unknown }): CodexConfig {
  const codex: CodexConfig = {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(typeof input.codexHome === 'string' ? { codexHome: input.codexHome } : {}),
    inheritCodexHome: input.inheritCodexHome !== false,
    ignoreUserConfig: input.ignoreUserConfig === true,
    ignoreRules: input.ignoreRules !== false,
  };
  return codex;
}

function normalizeComments(_input: unknown): CommentConfig {
  return {};
}

/** Defaults keep the in-meeting agent off until a profile opts in. */
export const MEETING_DEFAULTS: MeetingConfig = {
  enabled: false,
  autoJoinOnInvite: false,
  transcript: { keep: 200, stabilizeMs: 0 },
  respondIn: 'meeting',
  trigger: '@bot',
  pollIntervalMs: 3000,
  summaryOnEnd: false,
  summaryTarget: 'origin',
};

function normalizeMeeting(input: unknown): MeetingConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as {
    enabled?: unknown;
    autoJoinOnInvite?: unknown;
    transcript?: { keep?: unknown; stabilizeMs?: unknown };
    respondIn?: unknown;
    trigger?: unknown;
    pollIntervalMs?: unknown;
    summaryOnEnd?: unknown;
    summaryTarget?: unknown;
  };
  const trigger = typeof raw.trigger === 'string' && raw.trigger.trim() ? raw.trigger.trim() : MEETING_DEFAULTS.trigger;
  return {
    enabled: raw.enabled === true,
    autoJoinOnInvite: raw.autoJoinOnInvite === true,
    transcript: {
      keep: clampNumber(raw.transcript?.keep, 10, 2000, MEETING_DEFAULTS.transcript.keep),
      // 0 is meaningful here ("no debounce"), so it can't go through numberOr.
      stabilizeMs: clampNumber(raw.transcript?.stabilizeMs, 0, 30_000, MEETING_DEFAULTS.transcript.stabilizeMs),
    },
    respondIn:
      raw.respondIn === 'im' || raw.respondIn === 'both' || raw.respondIn === 'meeting'
        ? raw.respondIn
        : MEETING_DEFAULTS.respondIn,
    trigger,
    pollIntervalMs: clampNumber(raw.pollIntervalMs, 1000, 60_000, MEETING_DEFAULTS.pollIntervalMs),
    summaryOnEnd: raw.summaryOnEnd === true,
    summaryTarget:
      raw.summaryTarget === 'owner' || raw.summaryTarget === 'origin'
        ? raw.summaryTarget
        : MEETING_DEFAULTS.summaryTarget,
  };
}

/** Like {@link numberOr} but keeps 0 and bounds the result. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function normalizeLarkCli(input: unknown): LarkCliConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { identityPreset: 'bot-only' };
  }
  const raw = input as {
    identityPreset?: unknown;
    localUserImport?: unknown;
  };
  const identityPreset: LarkCliIdentityPreset =
    raw.identityPreset === 'user-default' ? 'user-default' : 'bot-only';
  const localUserImport = normalizeLarkCliUserImport(raw.localUserImport);
  return {
    identityPreset,
    ...(localUserImport ? { localUserImport } : {}),
  };
}

function normalizeLarkCliUserImport(input: unknown): LarkCliConfig['localUserImport'] | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as {
    status?: unknown;
    attemptedAt?: unknown;
    importedAt?: unknown;
    reason?: unknown;
  };
  if (!isLarkCliUserImportStatus(raw.status)) return undefined;
  return {
    status: raw.status,
    ...(typeof raw.attemptedAt === 'string' ? { attemptedAt: raw.attemptedAt } : {}),
    ...(typeof raw.importedAt === 'string' ? { importedAt: raw.importedAt } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
}

function isLarkCliUserImportStatus(value: unknown): value is LarkCliUserImportStatus {
  return (
    value === 'not-needed' ||
    value === 'imported' ||
    value === 'skipped-existing-private-user' ||
    value === 'skipped-no-local-user' ||
    value === 'failed'
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
