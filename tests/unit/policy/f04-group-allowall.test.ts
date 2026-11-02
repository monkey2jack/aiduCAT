import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createDefaultProfileConfig, normalizeProfileConfig } from '../../../src/config/profile-schema';
import { canUseGroup, canRunAdminCommand, requireMentionForChat, type RuntimeControls } from '../../../src/policy/access';

// f0.4 之后的修复：群「全员可用」开关 access.chatAllowAllUsers。
function profile(chatAllowAllUsers?: string[]) {
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
  });
  return {
    ...cfg,
    access: {
      ...cfg.access,
      allowedChats: ['oc_open', 'oc_strict'],
      allowedUsers: ['ou_friend'],
      admins: ['ou_admin'],
      allowedBots: ['ou_bot_ok'],
      ...(chatAllowAllUsers ? { chatAllowAllUsers } : {}),
    },
  };
}

function controls(): RuntimeControls {
  return { botOwnerId: 'ou_owner', ownerRefreshState: 'ok' };
}

describe('f04 group allow-all-users', () => {
  it('lets any human member run in an allowlisted group that is switched on', () => {
    const d = canUseGroup(profile(['oc_open']), controls(), 'oc_open', 'ou_stranger', { senderType: 'user' });
    expect(d).toEqual({ ok: true, reason: 'allowed-chat' });
  });

  it('a group without the switch still denies non-allowlisted senders (denied-user)', () => {
    expect(canUseGroup(profile(['oc_open']), controls(), 'oc_strict', 'ou_stranger').reason).toBe('denied-user');
    expect(canUseGroup(profile(), controls(), 'oc_open', 'ou_stranger').reason).toBe('denied-user');
    expect(canUseGroup(profile(['oc_open']), controls(), 'oc_strict', 'ou_friend').ok).toBe(true);
  });

  it('bots stay denied even in a switched-on group (denied-bot)', () => {
    const d = canUseGroup(profile(['oc_open']), controls(), 'oc_open', 'ou_some_bot', { senderType: 'app' });
    expect(d).toEqual({ ok: false, reason: 'denied-bot' });
    // listed bot behaves exactly as before
    expect(canUseGroup(profile(['oc_open']), controls(), 'oc_open', 'ou_bot_ok', { senderType: 'app' }).ok).toBe(true);
  });

  it('the switch alone does not allowlist a group (denied-chat)', () => {
    const d = canUseGroup(profile(['oc_elsewhere']), controls(), 'oc_elsewhere', 'ou_stranger');
    expect(d).toEqual({ ok: false, reason: 'denied-chat' });
  });

  it('owner/admin reasons, admin commands and @-mention rules are unchanged', () => {
    const p = profile(['oc_open']);
    expect(canUseGroup(p, controls(), 'oc_open', 'ou_owner').reason).toBe('owner');
    expect(canUseGroup(p, controls(), 'oc_open', 'ou_admin').reason).toBe('allowed-admin');
    expect(canRunAdminCommand(p, controls(), 'ou_stranger').ok).toBe(false);
    expect(requireMentionForChat(p, { preferences: {} } as never, 'oc_open')).toBe(p.access.requireMentionInGroup);
  });

  it('config load keeps chatAllowAllUsers (and drops junk / empty lists)', () => {
    const base = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    });
    const kept = normalizeProfileConfig({
      ...base,
      access: { ...base.access, allowedChats: ['oc_open'], chatAllowAllUsers: ['oc_open', 42 as never] },
    } as never);
    expect(kept.access.chatAllowAllUsers).toEqual(['oc_open']);
    const empty = normalizeProfileConfig({ ...base, access: { ...base.access, chatAllowAllUsers: [] } } as never);
    expect(empty.access).not.toHaveProperty('chatAllowAllUsers');
  });

  it('CHANGELOG and README document the switch', async () => {
    const changelog = await readFile(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');
    expect(changelog).toContain('chatAllowAllUsers');
    for (const f of ['README.md', 'README.zh.md', 'README.en.md']) {
      const doc = await readFile(new URL(`../../../${f}`, import.meta.url), 'utf8');
      expect(doc).toContain('/invite alluser');
    }
  });
});
