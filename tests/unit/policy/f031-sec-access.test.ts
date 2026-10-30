import { describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import * as access from '../../../src/policy/access';
import type { RuntimeControls } from '../../../src/policy/access';

function profile(mode: 'personal' | 'team' = 'personal') {
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
  });
  return {
    ...cfg,
    mode,
    access: { ...cfg.access, allowedChats: ['oc_ok'], allowedUsers: ['ou_friend'], admins: [] },
  };
}

function controls(extra: Partial<RuntimeControls> = {}): RuntimeControls {
  return { botOwnerId: 'ou_owner', ownerRefreshState: 'ok', ...extra };
}

// Call through a loose signature so this file also compiles against the
// pre-fix 4-argument API (red run).
const canUseGroup = access.canUseGroup as unknown as (...args: unknown[]) => access.AccessDecision;
const canUseDm = access.canUseDm as unknown as (...args: unknown[]) => access.AccessDecision;

describe('f031-sec-#3 group sender, bot and tenant checks', () => {
  it('f031-sec-#3 an allowlisted group no longer lets every member run', () => {
    expect(canUseGroup(profile(), controls(), 'oc_ok', 'ou_stranger').ok).toBe(false);
    expect(canUseGroup(profile(), controls(), 'oc_ok', 'ou_friend').ok).toBe(true);
    expect(canUseGroup(profile(), controls(), 'oc_ok', 'ou_owner').ok).toBe(true);
    // a non-allowlisted group still answers with the "not allowed" reason
    expect(canUseGroup(profile(), controls(), 'oc_other', 'ou_friend').reason).toBe('denied-chat');
  });

  it('f031-sec-#3 sender_type=app/bot is rejected in groups and DMs', () => {
    const bot = { senderType: 'app' };
    expect(canUseGroup(profile(), controls(), 'oc_ok', 'ou_friend', bot).ok).toBe(false);
    expect(canUseDm(profile(), controls(), 'ou_friend', { senderType: 'bot' }).ok).toBe(false);
    expect(canUseDm(profile(), controls(), 'ou_friend', { senderType: 'user' }).ok).toBe(true);
  });

  it('f031-sec-#3 team mode only opens to the bot home tenant', () => {
    const c = controls({ homeTenantKey: 't_home' } as Partial<RuntimeControls>);
    expect(canUseDm(profile('team'), c, 'ou_x', { senderType: 'user', tenantKey: 't_other' }).ok).toBe(false);
    expect(canUseDm(profile('team'), c, 'ou_x', { senderType: 'user', tenantKey: 't_home' }).ok).toBe(true);
    expect(canUseGroup(profile('team'), c, 'oc_any', 'ou_x', { tenantKey: 't_other' }).ok).toBe(false);
    expect(canUseGroup(profile('team'), c, 'oc_any', 'ou_x', { tenantKey: 't_home' }).ok).toBe(true);
    // unknown tenant (e.g. a doc comment) is not "everyone"
    expect(canUseDm(profile('team'), controls(), 'ou_x').ok).toBe(false);
  });

  it('f031-sec-#3 the home tenant is learned from the owner, read off the raw event', () => {
    const c = controls();
    const facts = access.senderFactsOf({
      raw: { sender: { sender_type: 'user', tenant_key: 't_home' } },
    });
    expect(facts).toEqual({ senderType: 'user', tenantKey: 't_home' });
    access.noteOwnerTenant(c, 'ou_someone', facts);
    expect(c.homeTenantKey).toBeUndefined();
    access.noteOwnerTenant(c, 'ou_owner', facts);
    expect(c.homeTenantKey).toBe('t_home');
  });
});
