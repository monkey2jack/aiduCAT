import type { ProfileConfig } from '../config/profile-schema';
import { getRequireMentionInGroup, type AppConfig } from '../config/schema';
export { accessPolicyDigest } from './fingerprint';

export type OwnerRefreshState = 'ok' | 'failed' | 'unknown';

export interface RuntimeControls {
  botOwnerId?: string;
  /**
   * f031-sec-#3: the bot's home tenant, learned from the owner's own messages
   * (`sender.tenant_key`). Team mode only opens up to senders of this tenant.
   */
  homeTenantKey?: string;
  ownerRefreshState: OwnerRefreshState;
  ownerRefreshedAt?: number;
  ownerRefreshError?: string;
}

export interface AccessDecision {
  ok: boolean;
  reason:
    | 'owner'
    | 'allowed-team'
    | 'allowed-user'
    | 'allowed-admin'
    | 'allowed-chat'
    | 'denied-user'
    | 'denied-chat'
    | 'denied-admin'
    | 'denied-bot';
}

/** What the platform says about a sender beyond its id (f031-sec-#3). */
export interface SenderFacts {
  /** `sender.sender_type`: 'user' is a human; anything else (app/bot/…) is not. */
  senderType?: string;
  /** `sender.tenant_key` / `operator.tenant_key`. */
  tenantKey?: string;
}

/** Read sender facts off a raw Feishu message / card event (f031-sec-#3). */
export function senderFactsOf(input: { senderType?: string; raw?: unknown }): SenderFacts {
  const raw = input.raw as
    | { sender?: { sender_type?: unknown; tenant_key?: unknown }; operator?: { tenant_key?: unknown } }
    | undefined;
  const rawType = raw?.sender?.sender_type;
  const senderType =
    input.senderType ?? (typeof rawType === 'string' ? rawType : undefined);
  const tenant = raw?.sender?.tenant_key ?? raw?.operator?.tenant_key;
  return {
    ...(senderType ? { senderType } : {}),
    ...(typeof tenant === 'string' && tenant ? { tenantKey: tenant } : {}),
  };
}

/** Remember the owner's tenant the first time the owner is seen (f031-sec-#3). */
export function noteOwnerTenant(
  controls: RuntimeControls,
  senderId: string,
  facts: SenderFacts | undefined,
): void {
  if (facts?.tenantKey && isCreator(controls, senderId)) controls.homeTenantKey = facts.tenantKey;
}

function isNonHuman(facts: SenderFacts | undefined): boolean {
  return facts?.senderType !== undefined && facts.senderType !== 'user';
}

function sameHomeTenant(controls: RuntimeControls, facts: SenderFacts | undefined): boolean {
  return Boolean(facts?.tenantKey && controls.homeTenantKey && facts.tenantKey === controls.homeTenantKey);
}

export function isCreator(controls: RuntimeControls, senderId: string): boolean {
  if (controls.ownerRefreshState === 'unknown') return false;
  return Boolean(controls.botOwnerId) && controls.botOwnerId === senderId;
}

export function canUseDm(
  profile: ProfileConfig,
  controls: RuntimeControls,
  senderId: string,
  facts?: SenderFacts,
): AccessDecision {
  // f031-sec-#3: other bots/apps never drive the agent from a DM.
  if (isNonHuman(facts)) return deny('denied-bot');
  if (isCreator(controls, senderId)) return allow('owner');
  // Team mode opens up usage to humans of the bot's own tenant only (f031-sec-#3).
  // Admin commands stay owner/admin-gated via canRunAdminCommand (unchanged).
  if (profile.mode === 'team' && sameHomeTenant(controls, facts)) return allow('allowed-team');
  if (profile.access.allowedUsers.includes(senderId)) return allow('allowed-user');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  return deny('denied-user');
}

export function canUseGroup(
  profile: ProfileConfig,
  controls: RuntimeControls,
  chatId: string,
  senderId: string,
  facts?: SenderFacts,
): AccessDecision {
  if (isNonHuman(facts)) {
    // bot-at-bot is an explicit opt-in: listed bot + allowlisted group.
    return profile.access.allowedBots?.includes(senderId) && profile.access.allowedChats.includes(chatId)
      ? allow('allowed-chat')
      : deny('denied-bot');
  }
  if (isCreator(controls, senderId)) return allow('owner');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  if (profile.mode === 'team' && sameHomeTenant(controls, facts)) return allow('allowed-team');
  // f031-sec-#3: an allowlisted group is not enough — the sender must be
  // allowlisted too (anyone pulled into the group used to be able to run).
  if (profile.access.allowedChats.includes(chatId)) {
    return profile.access.allowedUsers.includes(senderId)
      ? allow('allowed-chat')
      : deny('denied-user');
  }
  return deny('denied-chat');
}

/**
 * Whether a group message must @-mention the bot to be handled. A per-chat
 * override (profile.access.chatRequireMention[chatId]) takes priority over the
 * global requireMentionInGroup (from cfg). p2p chats never call this.
 */
export function requireMentionForChat(
  profile: ProfileConfig,
  cfg: AppConfig,
  chatId: string,
): boolean {
  const override = profile.access.chatRequireMention?.[chatId];
  return typeof override === 'boolean' ? override : getRequireMentionInGroup(cfg);
}

export function canRunAdminCommand(
  profile: ProfileConfig,
  controls: RuntimeControls,
  senderId: string,
): AccessDecision {
  if (isCreator(controls, senderId)) return allow('owner');
  if (profile.access.admins.includes(senderId)) return allow('allowed-admin');
  return deny('denied-admin');
}

function allow(reason: AccessDecision['reason']): AccessDecision {
  return { ok: true, reason };
}

function deny(reason: AccessDecision['reason']): AccessDecision {
  return { ok: false, reason };
}
