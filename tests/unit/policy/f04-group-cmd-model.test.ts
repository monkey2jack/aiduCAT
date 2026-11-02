import { describe, expect, it } from 'vitest';
import {
  groupSlashDenied,
  isSlashMessage,
  textAfterLeadingMentions,
} from '../../../src/policy/group-commands.js';
import {
  effectiveModelPrefs,
  normalizeChatModels,
  profileForChat,
} from '../../../src/config/chat-model.js';
import { createDefaultProfileConfig, normalizeProfileConfig } from '../../../src/config/profile-schema.js';
import { buildNonOwnerSettings } from '../../../src/agent/claude/owner-only-settings.js';
import {
  planRuntimeDirMask,
  wrapWithRuntimeDirMask,
  type MaskProbe,
} from '../../../src/agent/claude/runtime-dir-mask.js';

const profile = (prefs: Record<string, unknown> = {}) =>
  createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'a', secret: 's', tenant: 'feishu' } },
    access: { admins: ['ou_admin'] },
    preferences: prefs,
  } as never);

describe('f04 A: slash detection', () => {
  it('sees a slash after any leading @-mentions the SDK left in', () => {
    expect(isSlashMessage({ content: '/help' })).toBe(true);
    expect(isSlashMessage({ content: '  /new  ' })).toBe(true);
    expect(isSlashMessage({ content: '@_user_1 /new' })).toBe(true);
    expect(isSlashMessage({ content: '@_user_1 @_user_2 /stop' })).toBe(true);
    expect(isSlashMessage({ content: '@小猴² /status', mentions: [{ key: '@_user_1', name: '小猴²' }] })).toBe(true);
    expect(isSlashMessage({ content: '@小 猴 /status', mentions: [{ name: '小 猴' }] })).toBe(true);
    expect(isSlashMessage({ content: 'look at a/b' })).toBe(false);
    expect(isSlashMessage({ content: '@_user_1 hello /x' })).toBe(false);
    expect(textAfterLeadingMentions('@_all /x')).toBe('/x');
  });

  it('denies only in groups and only non-owner/admin', () => {
    const p = profile();
    const ctl = { botOwnerId: 'ou_owner', ownerRefreshState: 'ok' as const };
    expect(groupSlashDenied(p, ctl, { isGroup: true, senderId: 'ou_user' })).toBe(true);
    expect(groupSlashDenied(p, ctl, { isGroup: true, senderId: 'ou_admin' })).toBe(false);
    expect(groupSlashDenied(p, ctl, { isGroup: true, senderId: 'ou_owner' })).toBe(false);
    expect(groupSlashDenied(p, ctl, { isGroup: false, senderId: 'ou_user' })).toBe(false);
  });
});

describe('f04 B: per-chat model config', () => {
  it('normalize keeps every valid entry (fields trimmed), drops junk', () => {
    expect(
      normalizeChatModels({
        oc_a: { model: ' m1 ', provider: 'p', effort: 'low', extra: 1 },
        oc_b: {},
        oc_c: 'nope',
        '': { model: 'x' },
        oc_d: { model: 5 },
      }),
    ).toEqual({ oc_a: { model: 'm1', provider: 'p', effort: 'low' }, oc_b: {}, oc_d: {} });
  });

  it('load round-trip keeps chatModels', () => {
    const raw = JSON.parse(JSON.stringify(profile({ model: 'd', chatModels: { oc_a: { model: 'g' } } })));
    expect(normalizeProfileConfig(raw).preferences.chatModels).toEqual({ oc_a: { model: 'g' } });
    const none = normalizeProfileConfig(JSON.parse(JSON.stringify(profile({ model: 'd' }))));
    expect('chatModels' in none.preferences).toBe(false);
  });

  it('a group entry replaces model/provider/effort as a set; others follow the default', () => {
    const p = profile({ model: 'd', provider: 'p500', effort: 'high', chatModels: { oc_a: { model: 'g' } } });
    expect(effectiveModelPrefs(p, 'oc_a')).toEqual({ model: 'g', source: 'chat' });
    expect(effectiveModelPrefs(p, 'oc_b')).toEqual({ model: 'd', provider: 'p500', effort: 'high', source: 'default' });
    expect(effectiveModelPrefs(p, undefined).source).toBe('default');
    const chatView = profileForChat(p, 'oc_a');
    expect(chatView.preferences.model).toBe('g');
    expect(chatView.preferences.provider).toBeUndefined();
    expect(chatView.access).toBe(p.access);
    expect(profileForChat(p, 'oc_b')).toBe(p);
  });
});

describe('f04 C: non-owner settings let the agent work, secrets stay denied', () => {
  const s = buildNonOwnerSettings({ configDir: '/h/.claude', settingsEnvNames: ['GH_TOKEN', 'AIDU_X_TOKEN'], home: '/h', cwd: '/w/ws' });

  it('keeps the scrub + blanks; declares tools (SCRUB forces mode default); sandboxed Bash, no unsandboxed escape', () => {
    expect(s.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
    expect(s.env.GH_TOKEN).toBe('');
    expect(s.env.AIDU_X_TOKEN).toBe('');
    expect(s.permissions.allow).toEqual(expect.arrayContaining(['Bash', 'Read', 'Edit(//w/ws/**)', 'Write(//w/ws/**)']));
    expect(s.permissions.allow?.some((r) => r.startsWith('Edit(') && !r.startsWith('Edit(//w/ws/'))).toBe(false);
    expect(s.sandbox).toEqual({ enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false });
  });

  it('denies settings / credential stores / process env / dotenv, and steering files are read-only', () => {
    const d = s.permissions.deny;
    for (const r of [
      'Read(//h/.claude/settings.json)',
      'Read(//w/ws/.claude/settings.json)',
      'Read(//w/ws/.claude/settings.local.json)',
      'Read(//h/.ssh/**)',
      'Read(//h/.aiducat/**)',
      'Read(//h/.config/aiduCAT/**)',
      'Read(//h/.lark-cli/**)',
      'Read(//proc/**)',
      'Read(//**/.env)',
      'Edit(//w/ws/CLAUDE.md)',
      'Write(//w/ws/.claude/**)',
      'Edit(//w/ws/.mcp.json)',
    ]) expect(d).toContain(r);
  });

  it('without cwd it keeps the f03p shape (no allow rules, no sandbox block)', () => {
    const old = buildNonOwnerSettings({ configDir: '/h/.claude', settingsEnvNames: [], home: '/h' });
    expect(old.permissions.allow).toBeUndefined();
    expect(old.sandbox).toBeUndefined();
  });
});

describe('f04 C: runtime-dir mask (containerd 0711, claude-code#93144)', () => {
  const probe = (o: { readable?: boolean; exists?: boolean; tools?: boolean; userns?: boolean } = {}): MaskProbe => ({
    exists: (p) => (o.exists ?? true) && p === '/run/containerd',
    readable: () => o.readable ?? false,
    onPath: () => o.tools ?? true,
    usernsWorks: () => o.userns ?? true,
  });

  it('plans a mask only on Linux for an existing, unreadable runtime dir', () => {
    expect(planRuntimeDirMask('linux', probe())).toEqual({ dirs: [{ dir: '/run/containerd', socket: 'containerd.sock' }] });
    expect(planRuntimeDirMask('linux', probe({ readable: true })).dirs).toEqual([]);
    expect(planRuntimeDirMask('linux', probe({ exists: false })).dirs).toEqual([]);
    expect(planRuntimeDirMask('darwin', probe()).dirs).toEqual([]);
  });

  it('wraps claude in an unprivileged mount namespace, drops caps, keeps argv intact', () => {
    const plan = planRuntimeDirMask('linux', probe());
    const w = wrapWithRuntimeDirMask('/usr/local/bin/claude', ['-p', '--settings', '/tmp/x y.json'], plan, probe())!;
    expect(w.command).toBe('unshare');
    expect(w.args.slice(0, 7)).toEqual(['--user', '--map-current-user', '--mount', '--propagation', 'private', '--keep-caps', '--']);
    const script = w.args[9]!;
    expect(script).toMatch(/^set -e; /);
    expect(script).toContain('mount -t tmpfs -o mode=0755,size=64k aiducat-mask /run/containerd');
    expect(script).toContain(': > /run/containerd/containerd.sock');
    expect(script).toContain('exec setpriv --inh-caps=-all --ambient-caps=-all -- "$@"');
    expect(script).not.toContain('chmod');
    expect(w.args.slice(10)).toEqual(['aiducat-mask', '/usr/local/bin/claude', '-p', '--settings', '/tmp/x y.json']);
  });

  it('no wrap when nothing to mask, util-linux tools are missing, or user namespaces are blocked (Ubuntu AppArmor)', () => {
    expect(wrapWithRuntimeDirMask('claude', [], { dirs: [] }, probe())).toBeUndefined();
    expect(wrapWithRuntimeDirMask('claude', [], planRuntimeDirMask('linux', probe()), probe({ tools: false }))).toBeUndefined();
    expect(wrapWithRuntimeDirMask('claude', [], planRuntimeDirMask('linux', probe()), probe({ userns: false }))).toBeUndefined();
  });
});
