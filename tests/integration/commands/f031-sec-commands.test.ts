import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface RunOverrides {
  scope?: string;
  senderId?: string;
  chatId?: string;
  chatMode?: CommandContext['chatMode'];
  mentions?: NormalizedMessage['mentions'];
}

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: ReturnType<typeof createFakeAgent>;
  controls: Controls;
  run(content: string, overrides?: RunOverrides): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];
const UUID = '3f2a9c1e-7b4d-4e8f-9a01-23456789abcd';

describe('f031-sec command hardening', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('f031-sec-M1 /model is admin-only (it rewrites the profile-wide model/provider)', async () => {
    const h = await createHarness();
    await expect(h.run('/model', { senderId: 'ou-allowed' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
    await expect(h.run('/model sonnet', { senderId: 'ou-allowed' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
    expect(h.controls.profileConfig.preferences.model).toBeUndefined();
  });

  it('f031-fix-#2 typed `/model <non-Claude>` says the gateway translates it and effort does not apply', async () => {
    const h = await createHarness();
    await expect(h.run('/model Gemini-3.8-Flash')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('经网关翻译');
    await expect(h.run('/model Claude-Opus-4.6')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).not.toContain('经网关翻译');
  });

  it('f031-sec-M2 /config never shows the tokenized console URL; groups get no console line at all', async () => {
    const h = await createHarness();
    const token = 'f'.repeat(64);
    await writeFile(
      join(h.tmp.root, 'ui.json'),
      JSON.stringify({ url: `http://127.0.0.1:53219/?token=${token}`, token, port: 53219, pid: process.pid, startedAt: 'x' }),
    );
    await expect(h.run('/config', { senderId: 'ou-owner', chatMode: 'group' })).resolves.toBe(true);
    const group = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(group).not.toContain(token);
    expect(group).not.toContain('Web 控制台');

    await expect(h.run('/config', { senderId: 'ou-owner' })).resolves.toBe(true);
    const dm = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(dm).not.toContain(token);
    expect(dm).not.toContain('token=');
    expect(dm).toContain('Web 控制台');
  });

  it('f031-sec-L1 /resume use only accepts a Claude session UUID (no option-looking strings)', async () => {
    const h = await createHarness();
    for (const bad of ['--dangerously-skip-permissions', '-p', 'sess-anything', '../../x']) {
      await expect(h.run(`/resume use ${bad}`)).resolves.toBe(true);
      expect(lastMarkdown(h.channel)).toContain('会话 ID');
      expect(h.sessions.getRaw('chat-1')?.sessionId).toBeUndefined();
    }
    await expect(h.run(`/resume use ${UUID}`)).resolves.toBe(true);
    expect(h.sessions.getRaw('chat-1')?.sessionId).toBe(UUID);
  });

  it('f031-sec-L3 /status for a non-admin shows only its own session (no global queue)', async () => {
    const h = await createHarness();
    await expect(h.run('/status', { senderId: 'ou-allowed' })).resolves.toBe(true);
    const plain = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(plain).toContain('**Session**');
    expect(plain).not.toMatch(/🚦 \d+\/\d+ active/);
    await expect(h.run('/status', { senderId: 'ou-admin' })).resolves.toBe(true);
    expect(JSON.stringify(h.channel.sent.at(-1)?.content)).toMatch(/🚦 \d+\/\d+ active/);
  });

  it('f031-sec-L7 /new chat is admin-only; plain /new stays open', async () => {
    const h = await createHarness();
    const createChat = vi.fn(async () => ({ chatId: 'oc_new', name: 'x' }));
    (h.channel as unknown as { createChat: typeof createChat }).createChat = createChat;
    await expect(h.run('/new chat demo', { senderId: 'ou-allowed' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
    expect(createChat).not.toHaveBeenCalled();
    await expect(h.run('/new', { senderId: 'ou-allowed' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('新会话');
  });
});

async function createHarness(): Promise<Harness> {
  const tmp = await createTmpProfile('commands-v1-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const workspaceRealpath = await realpath(tmp.workspace);
  const profileConfig = appConfig(workspaceRealpath);
  const configPath = join(tmp.root, 'config.json');
  await saveRootConfig(createRootConfig('claude', profileConfig), configPath);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  workspaces.setCwd('chat-1', workspaceRealpath);

  const run = (content: string, overrides: RunOverrides = {}): Promise<boolean> => {
    const chatId = overrides.chatId ?? 'chat-1';
    const scope = overrides.scope ?? chatId;
    return tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content, {
        chatId,
        senderId: overrides.senderId ?? 'ou-admin',
        mentions: overrides.mentions ?? [],
      }),
      scope,
      chatMode: overrides.chatMode ?? 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      controls,
    });
  };

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, sessions, workspaces, activeRuns, agent, controls, run };
}

function appConfig(defaultWorkspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'], allowedUsers: ['ou-allowed'] },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
    preferences: { maxConcurrentRuns: 2 },
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function message(
  content: string,
  opts: {
    chatId: string;
    senderId: string;
    mentions?: NormalizedMessage['mentions'];
  },
): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: opts.chatId,
    chatType: 'p2p',
    senderId: opts.senderId,
    senderName: 'User',
    content,
    resources: [],
    mentions: opts.mentions ?? [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}


function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = lastContent(channel);
  expect(content.markdown).toBeTypeOf('string');
  return content.markdown as string;
}
