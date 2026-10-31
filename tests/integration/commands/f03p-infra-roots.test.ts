import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { startRunFlow } from '../../../src/bot/run-flow.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, normalizeProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { resolveWorkingDirectory } from '../../../src/policy/workspace.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';

const dirs: string[] = [];
const flushers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(flushers.splice(0).map((f) => f()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })));
});

async function tree(): Promise<{ base: string; allowed: string; inside: string; outside: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'f03p-roots-')));
  dirs.push(base);
  const allowed = join(base, 'projects');
  const inside = join(allowed, 'app');
  const outside = join(base, 'elsewhere');
  await mkdir(inside, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { base, allowed, inside, outside };
}

describe('f03p-infra-#3 optional workspaces.roots allowlist for /cd', () => {
  it('f03p-infra-#3 no roots configured → unchanged (blacklist only)', async () => {
    const t = await tree();
    expect((await resolveWorkingDirectory(t.outside)).ok).toBe(true);
    expect((await resolveWorkingDirectory(t.outside, { roots: [] })).ok).toBe(true);
  });

  it('f03p-infra-#3 roots configured → only dirs under them (root itself included)', async () => {
    const t = await tree();
    const roots = [t.allowed];
    expect((await resolveWorkingDirectory(t.inside, { roots })).ok).toBe(true);
    expect((await resolveWorkingDirectory(t.allowed, { roots })).ok).toBe(true);
    const r = await resolveWorkingDirectory(t.outside, { roots });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('outside-roots');
      expect(r.userVisible).toContain('workspaces.roots');
    }
    // a sibling that merely shares the prefix is outside
    await mkdir(`${t.allowed}-evil`);
    expect((await resolveWorkingDirectory(`${t.allowed}-evil`, { roots })).ok).toBe(false);
  });

  it('f03p-infra-#3 a symlink inside a root that points outside is judged by its target', async () => {
    const t = await tree();
    const { symlink } = await import('node:fs/promises');
    await symlink(t.outside, join(t.allowed, 'jump'));
    expect((await resolveWorkingDirectory(join(t.allowed, 'jump'), { roots: [t.allowed] })).ok).toBe(false);
  });

  it('f03p-infra-#3 profile config keeps valid roots, drops junk', () => {
    const base = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'a', secret: 's', tenant: 'feishu' } },
    });
    const cfg = normalizeProfileConfig({
      ...base,
      workspaces: { default: '/srv/w', roots: ['/srv/projects', '~/code', 'relative/x', '', 42] },
    });
    expect(cfg.workspaces).toEqual({ default: '/srv/w', roots: ['/srv/projects', '~/code'] });
    const none = normalizeProfileConfig({ ...base, workspaces: { default: '/srv/w' } });
    expect(none.workspaces).toEqual({ default: '/srv/w' });
  });

  it('f03p-infra-#3 /cd and /ws use honour roots; profile default stays usable', async () => {
    const t = await tree();
    const h = await harness(t.inside, [t.allowed]);
    await h.run(`/cd ${t.outside}`);
    expect(lastMarkdown(h.channel)).toContain('workspaces.roots');
    expect(h.workspaces.cwdFor('chat-1')).toBeUndefined();
    await h.run(`/cd ${t.inside}`);
    expect(lastMarkdown(h.channel)).toContain('已切换 cwd');
    h.workspaces.saveNamed('far', t.outside);
    await h.run('/ws use far');
    expect(lastMarkdown(h.channel)).toContain('workspaces.roots');
    expect(h.workspaces.cwdFor('chat-1')).toBe(t.inside);
  });

  it('f03p-infra-#3 a run whose chat cwd is outside the roots is refused; the profile default is not checked', async () => {
    const t = await tree();
    const h = await harness(t.outside, [t.allowed]);
    const base = {
      scope: { source: 'im', chatType: 'p2p', chatId: 'chat-1', actorId: 'ou-owner' },
      prompt: 'hi',
      attachments: [],
      access: { ok: true, reason: 'owner' },
      capability: { agentId: 'claude' },
      profileConfig: h.controls.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: { submit: vi.fn(async () => { throw new Error('stop-here'); }) },
      now: Date.now(),
    } as never as Parameters<typeof startRunFlow>[0];
    // profile default (outside the roots) → allowed through the cwd check
    const d = (await startRunFlow({ ...base, scopeId: 'chat-default' } as never).catch(() => ({ ok: 'later-step' }))) as {
      ok: unknown;
      rejectReason?: { code: string };
    };
    expect(d.rejectReason?.code).not.toBe('outside-roots');
    // chat cwd set earlier to a dir outside the roots → refused before spawning
    h.workspaces.setCwd('chat-1', t.outside);
    const r = await startRunFlow({ ...base, scopeId: 'chat-1' } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejectReason.code).toBe('outside-roots');
  });
});

async function harness(defaultWorkspace: string, roots: string[]) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'f03p-roots-h-')));
  dirs.push(base);
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(base, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(base, 'workspaces.json'));
  flushers.push(() => Promise.all([sessions.flush(), workspaces.flush()]));
  const profileConfig: ProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
  });
  profileConfig.workspaces = { default: defaultWorkspace, roots };
  const configPath = join(base, 'config.json');
  await saveRootConfig(createRootConfig('claude', profileConfig), configPath);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  const run = (content: string) =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: { messageId: 'om-1', chatId: 'chat-1', chatType: 'p2p', senderId: 'ou-owner', content, resources: [], mentions: [], mentionedBot: false } as unknown as NormalizedMessage,
      scope: 'chat-1',
      chatMode: 'p2p',
      sessions,
      workspaces,
      agent: createFakeAgent(),
      activeRuns: new ActiveRuns(),
      controls,
    });
  return { channel, sessions, workspaces, controls, run };
}

function lastMarkdown(channel: FakeChannel): string {
  return String((channel.sent.at(-1)?.content as { markdown?: string } | undefined)?.markdown ?? '');
}
