import { describe, expect, it } from 'vitest';
import { claudeCapability } from '../../../src/agent/capability';
import { buildCodexArgs } from '../../../src/agent/codex/argv';
import { normalizePermissions, type PermissionConfig } from '../../../src/config/permissions';
import { createDefaultProfileConfig, normalizeProfileConfig } from '../../../src/config/profile-schema';
import { evaluateRunPolicy, type RunPolicyInput, type ScopeContext } from '../../../src/policy/run-policy';

function profile(permissions?: Partial<PermissionConfig>, mode: 'personal' | 'team' = 'personal') {
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    ...(permissions ? { permissions: permissions as PermissionConfig } : {}),
  });
  return { ...cfg, mode };
}

function run(scope: Partial<ScopeContext>, cfg = profile({ defaultAccess: 'full', maxAccess: 'full' })) {
  const input: RunPolicyInput = {
    scope: { source: 'im', chatId: 'oc_1', actorId: 'ou_owner', ...scope },
    attachments: [],
    prompt: 'x',
    requestedCwd: '/repo',
    cwdRealpath: '/repo',
    access: { ok: true, reason: 'owner' },
    capability: claudeCapability(cfg),
    profileConfig: cfg,
    now: 1,
  };
  const result = evaluateRunPolicy(input);
  if (!result.ok) throw new Error('expected allow');
  return result;
}

describe('f031-sec-#1 default permissions and source ceilings', () => {
  it('f031-sec-#1 a profile without permissions defaults to workspace, not full', () => {
    expect(normalizePermissions({}).permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
    });
    expect(cfg.permissions.maxAccess).toBe('workspace');
    expect(claudeCapability().permissions.maxAccess).toBe('workspace');
  });

  it('f031-sec-#1 legacy sandbox without max no longer means danger-full-access', () => {
    expect(normalizePermissions({ sandbox: { default: 'workspace-write' } }).permissions.maxAccess).toBe(
      'workspace',
    );
  });

  it('f031-sec-#1 explicit full still runs full in the owner p2p chat (嘟嘟 unchanged)', () => {
    const r = run({ chatType: 'p2p' });
    expect(r.accessMode).toBe('full');
    expect(r.permissionMode).toBe('bypassPermissions');
  });

  it('f031-sec-#1 group / comment / meeting / unknown-chat runs are capped at workspace', () => {
    expect(run({ chatType: 'group' }).accessMode).toBe('workspace');
    expect(run({}).accessMode).toBe('workspace');
    expect(run({ source: 'comment', commentScopeId: 'c' }).accessMode).toBe('workspace');
    expect(run({ source: 'meeting' }).accessMode).toBe('workspace');
  });

  it('f031-sec-#1 team mode is capped at workspace even in p2p', () => {
    const cfg = profile({ defaultAccess: 'full', maxAccess: 'full' }, 'team');
    expect(run({ chatType: 'p2p' }, cfg).accessMode).toBe('workspace');
  });

  it('f031-sec-#1 an owner may raise groups explicitly via permissions.groupMaxAccess', () => {
    const cfg = profile({ defaultAccess: 'full', maxAccess: 'full', groupMaxAccess: 'full' });
    expect(cfg.permissions.groupMaxAccess).toBe('full');
    expect(run({ chatType: 'group' }, cfg).accessMode).toBe('full');
    // comments stay capped no matter what
    expect(run({ source: 'comment' }, cfg).accessMode).toBe('workspace');
  });

  it('f031-sec-#1 codex argv never gets danger-full-access unless asked', () => {
    const args = buildCodexArgs({ cwd: '/repo', sandbox: 'workspace-write' });
    expect(args).not.toContain('danger-full-access');
  });
});
