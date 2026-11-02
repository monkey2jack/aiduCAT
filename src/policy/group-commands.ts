/**
 * f04-group-cmd-model (Wei 2026-11-02 11:35「群里非管理员一概不能用 slash 命令」):
 * in a group, only the owner / admins may send anything that starts with `/`.
 *
 * That covers our own registered commands (/help, /status, /new, /stop, …)
 * AND unregistered ones — an unknown `/xxx` used to fall through to the agent
 * as a prompt, where Claude Code / Codex would run it as THEIR built-in slash
 * command. A blocked message is neither executed nor queued for the agent.
 * DMs are unchanged (DM access is already per-user).
 */
import type { ProfileConfig } from '../config/profile-schema';
import { canRunAdminCommand, type RuntimeControls } from './access';

/** Short hint for a non-admin who @-mentioned the bot with a slash command. */
export const GROUP_SLASH_ADMIN_ONLY_REPLY = '群里只有管理员能用命令。';

interface MentionLike {
  key?: string;
  name?: string;
}

/**
 * The message text with any LEADING @-mentions removed. The SDK already
 * strips the bot's own mention, but not when it could not tell the mention is
 * the bot (no bot identity yet) — then the text reads `@小猴² /new` or
 * `@_user_1 /new`. Every leading mention is dropped, so `@bot /new` and
 * `@someone /new` both count as a slash message (deliberately conservative).
 */
export function textAfterLeadingMentions(content: string, mentions: readonly MentionLike[] = []): string {
  let s = content.trim();
  const tokens: string[] = [];
  for (const m of mentions) {
    if (m.name) tokens.push(`@${m.name}`);
    if (m.key) tokens.push(m.key.startsWith('@') ? m.key : `@${m.key}`);
  }
  // Longest first, so `@小猴²` wins over a shorter name that prefixes it.
  tokens.sort((a, b) => b.length - a.length);
  for (let guard = 0; guard < 20; guard++) {
    const before = s;
    const hit = tokens.find((t) => s.startsWith(t));
    if (hit) s = s.slice(hit.length).trimStart();
    else s = s.replace(/^@(_user_\d+|_all|所有人)(?=\s|$|\/)/u, '').trimStart();
    if (s === before) break;
  }
  return s;
}

/** True when the message (after leading @-mentions) starts with `/`. */
export function isSlashMessage(msg: { content: string; mentions?: readonly MentionLike[] }): boolean {
  return textAfterLeadingMentions(msg.content ?? '', msg.mentions ?? []).startsWith('/');
}

/** First token of a slash message, for logs only (bounded). */
export function slashName(msg: { content: string; mentions?: readonly MentionLike[] }): string {
  const t = textAfterLeadingMentions(msg.content ?? '', msg.mentions ?? []);
  return (t.split(/\s+/)[0] ?? '').slice(0, 32);
}

/**
 * Whether a slash command from `senderId` must be refused in this chat:
 * group (or topic) chat AND sender is neither the owner nor an admin.
 */
export function groupSlashDenied(
  profile: ProfileConfig,
  controls: RuntimeControls,
  input: { isGroup: boolean; senderId: string },
): boolean {
  if (!input.isGroup) return false;
  return !canRunAdminCommand(profile, controls, input.senderId).ok;
}
