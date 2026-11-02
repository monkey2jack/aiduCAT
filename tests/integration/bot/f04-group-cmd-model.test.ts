import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { GROUP_SLASH_ADMIN_ONLY_REPLY } from '../../../src/policy/group-commands.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

// f04-group-cmd-model, through the real intake (startChannel):
//  A — in a group only owner/admins may send anything starting with `/`
//      (registered or not, also `@bot /…`); it is neither run nor queued for
//      the agent. DMs unchanged.
//  B — a group's own /model drives its runs (model arg, provider window →
//      60% compact env); other groups and DMs use the default.

const sdkMock = vi.hoisted(() => ({
  channel: undefined as unknown,
  createLarkChannel: vi.fn((_opts: unknown) => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return { ...actual, createLarkChannel: sdkMock.createLarkChannel };
});

import { startChannel } from '../../../src/bot/channel.js';

vi.setConfig({ testTimeout: 15_000 });

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const answer = (text: string): AgentEvent[] =>
  [{ type: 'text', delta: text }, { type: 'done', terminationReason: 'normal' }] as AgentEvent[];

interface Harness {
  sent: Array<{ chatId: string; content: Record<string, unknown>; options?: unknown }>;
  handlers: { message?: (msg: NormalizedMessage) => Promise<void> | void };
  agent: FakeAgentAdapter;
}

async function setup(opts: { runs?: number; preferences?: Record<string, unknown>; providers?: Record<string, unknown> } = {}): Promise<Harness> {
  const tmp = await createTmpProfile('f04-gcm-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: {
      allowedUsers: ['ou_user', 'ou_admin'],
      admins: ['ou_admin'],
      allowedChats: ['oc_grp', 'oc_grp2'],
      requireMentionInGroup: false,
    },
    preferences: { messageReply: 'text', ...(opts.preferences ?? {}) },
  } as never);
  const profileConfig = {
    ...base,
    workspaces: { ...base.workspaces, default: workspace },
    ...(opts.providers ? { modelProviders: opts.providers } : {}),
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'claude',
    displayName: 'Claude',
    events: Array.from({ length: opts.runs ?? 4 }, (_, i) => answer(`ANSWER_${i}`)),
  });
  const h: Harness = { sent: [], handlers: {}, agent };
  let n = 0;
  const channel = {
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: { v6: { application: { get: vi.fn(async () => ({ data: { app: { owner: { owner_id: 'ou_owner' } } } })) } } },
      im: {
        v1: {
          message: { get: vi.fn(async () => ({ data: { items: [] } })) },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'r1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(next: Harness['handlers']) {
      Object.assign(h.handlers, next);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode(chatId: string) {
      return chatId.startsWith('oc_grp') ? 'group' : 'p2p';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId: string, content: Record<string, unknown>, options?: unknown) {
      h.sent.push({ chatId, content, options });
      return { messageId: `sent_${++n}` };
    },
    async updateCard() {},
    async recallMessage() {},
    async addReaction() {
      return 'r1';
    },
    async removeReaction() {},
    async stream(_chatId: string, input: { markdown?: (c: unknown) => Promise<void> }) {
      if (input.markdown) await input.markdown({ setContent: async () => {} });
      return { messageId: 'om_stream' };
    },
  };
  sdkMock.channel = channel;
  const controls = {
    profile: 'claude',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: join(tmp.root, 'config.json'),
    cfg: profileConfig,
    processId: 'proc_test',
  };
  const bridge = await startChannel({ cfg: profileConfig, agent, sessions, workspaces, controls } as never);
  cleanups.push(async () => {
    await bridge.disconnect();
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return h;
}

let seq = 0;
function msg(
  content: string,
  o: { chat?: 'p2p' | 'group'; chatId?: string; sender?: string; mentionedBot?: boolean; mentions?: unknown[] } = {},
): NormalizedMessage {
  const chat = o.chat ?? 'group';
  return {
    messageId: `om_${++seq}`,
    chatId: o.chatId ?? (chat === 'group' ? 'oc_grp' : 'oc_dm'),
    chatType: chat,
    senderId: o.sender ?? 'ou_user',
    senderName: 'User',
    senderType: 'user',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: o.mentions ?? [],
    mentionedBot: o.mentionedBot ?? chat === 'group',
    createTime: Date.now(),
  } as unknown as NormalizedMessage;
}

async function waitFor(pred: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for async work');
}
const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));
const texts = (h: Harness) => h.sent.map((s) => JSON.stringify(s.content));

describe('f04 A: group slash commands are owner/admin only', () => {
  it('a non-admin in a group: /help, /new, /stop, unknown /xxx, @bot /new — none runs, none reaches the agent', async () => {
    const h = await setup();
    for (const text of ['/help', '/new', '/stop', '/status', '/xxx do things', '/compact', '/model gpt-x']) {
      await h.handlers.message?.(msg(text));
    }
    // the SDK could not strip the bot mention (no identity yet): `@_user_1 /new`
    await h.handlers.message?.(
      msg('@_user_1 /new', { mentions: [{ key: '@_user_1', name: 'Bridge', openId: 'ou_bot', isBot: true }] }),
    );
    await h.handlers.message?.(msg('@Bridge  /resume', { mentions: [{ key: '@_user_1', name: 'Bridge' }] }));
    await settle();
    expect(h.agent.runOptions).toHaveLength(0);
    // one short hint per @-ed attempt, nothing else (no help/status card)
    const hints = h.sent.filter((s) => s.content.text === GROUP_SLASH_ADMIN_ONLY_REPLY);
    expect(hints).toHaveLength(9);
    expect(h.sent).toHaveLength(9);
  });

  it('without an @ (no-mention group) a non-admin slash is dropped silently', async () => {
    const h = await setup();
    await h.handlers.message?.(msg('/xxx', { mentionedBot: false }));
    await settle();
    expect(h.agent.runOptions).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it('a blocked slash does not cancel what the sender (or others) queued before it', async () => {
    const h = await setup();
    await h.handlers.message?.(msg('plain question'));
    await h.handlers.message?.(msg('/new'));
    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions[0]!.prompt).toContain('plain question');
    expect(h.agent.runOptions[0]!.prompt).not.toContain('/new');
  });

  it('a group admin keeps every command; an unknown /xxx still goes to the agent for them', async () => {
    const h = await setup();
    await h.handlers.message?.(msg('/help', { sender: 'ou_admin' }));
    await settle(300);
    expect(texts(h).join()).not.toContain(GROUP_SLASH_ADMIN_ONLY_REPLY);
    expect(h.sent.length).toBeGreaterThan(0);
    await h.handlers.message?.(msg('/xxx admin thing', { sender: 'ou_admin' }));
    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions[0]!.prompt).toContain('/xxx admin thing');
  });

  it('DMs are unchanged: an allowlisted non-admin can /help and an unknown /xxx reaches the agent', async () => {
    const h = await setup();
    await h.handlers.message?.(msg('/help', { chat: 'p2p' }));
    await settle(300);
    expect(texts(h).join()).not.toContain(GROUP_SLASH_ADMIN_ONLY_REPLY);
    expect(h.sent.length).toBeGreaterThan(0);
    await h.handlers.message?.(msg('/xxx dm thing', { chat: 'p2p' }));
    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions[0]!.prompt).toContain('/xxx dm thing');
  });

  it('plain (non-slash) group messages from a non-admin still run as before', async () => {
    const h = await setup();
    await h.handlers.message?.(msg('hello there, path a/b'));
    await waitFor(() => h.agent.runOptions.length === 1);
  });
});

describe('f04 B: per-group model drives the run', () => {
  const providers = {
    p500: { label: 'P500', baseUrl: 'https://p500.example.com', apiKey: 'k', wire: 'anthropic', contextWindow: 500_000 },
    p200: { label: 'P200', baseUrl: 'https://p200.example.com', apiKey: 'k', wire: 'anthropic', contextWindow: 200_000 },
  };

  it('a group with its own model runs it (window → compact env follows); other group + DM use the default', async () => {
    const h = await setup({
      providers,
      preferences: {
        model: 'default-model',
        provider: 'p500',
        effort: 'high',
        chatModels: { oc_grp: { model: 'group-model', provider: 'p200', effort: 'low' } },
      },
    });
    await h.handlers.message?.(msg('in group 1', { sender: 'ou_admin' }));
    await waitFor(() => h.agent.runOptions.length === 1);
    await h.handlers.message?.(msg('in group 2', { chatId: 'oc_grp2', sender: 'ou_admin' }));
    await waitFor(() => h.agent.runOptions.length === 2);
    await h.handlers.message?.(msg('in dm', { chat: 'p2p', sender: 'ou_admin' }));
    await waitFor(() => h.agent.runOptions.length === 3);
    const [g1, g2, dm] = h.agent.runOptions;
    expect(g1!.model).toBe('group-model');
    expect(g1!.effort).toBe('low');
    expect(g1!.envOverrides?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(String(200_000 * 0.6));
    expect(g1!.envOverrides?.ANTHROPIC_BASE_URL).toBe('https://p200.example.com');
    for (const d of [g2!, dm!]) {
      expect(d.model).toBe('default-model');
      expect(d.effort).toBe('high');
      expect(d.envOverrides?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(String(500_000 * 0.6));
      expect(d.envOverrides?.ANTHROPIC_BASE_URL).toBe('https://p500.example.com');
    }
  });
});
