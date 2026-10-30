// f031-stab: shared card-mode harness for startChannel with a fake SDK
// channel. Mirrors the one in tests/integration/bot/card-stream-failure.test.ts
// (kept separate so that file stays untouched by the parallel branches).
// Callers must route the SDK factory through the global mock first:
//
//   vi.mock('@larksuite/channel', async (orig) => ({
//     ...(await orig<typeof import('@larksuite/channel')>()),
//     createLarkChannel: (o: unknown) =>
//       (globalThis as { __stabSdkMock?: { createLarkChannel(o: unknown): unknown } })
//         .__stabSdkMock!.createLarkChannel(o),
//   }));
import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { vi } from 'vitest';
import { createDefaultProfileConfig } from '../../src/config/profile-schema.js';
import { SessionStore } from '../../src/session/store.js';
import { WorkspaceStore } from '../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentEvents } from './fake-agent.js';
import { createTmpProfile, type TmpProfile } from './tmp-profile.js';

interface StabSdkMock {
  channel: unknown;
  createLarkChannel: ReturnType<typeof vi.fn>;
}
const g = globalThis as { __stabSdkMock?: StabSdkMock };
export const stabSdkMock: StabSdkMock = (g.__stabSdkMock ??= {
  channel: undefined,
  createLarkChannel: vi.fn((_opts: unknown) => {
    if (!g.__stabSdkMock!.channel) throw new Error('fake channel not configured');
    return g.__stabSdkMock!.channel;
  }),
});

export type Card = Record<string, unknown>;
export interface StreamCtrl {
  readonly messageId: string;
  lastPatchError?: unknown;
  update(next: unknown): Promise<void>;
}
interface StreamInput {
  card: { initial: unknown; producer: (ctrl: StreamCtrl) => Promise<void> };
}

export interface StabHarness {
  tmp: TmpProfile;
  sent: Array<{ chatId: string; content: Record<string, unknown>; options?: unknown }>;
  updates: unknown[];
  updateCardCalls: Array<{ messageId: string; card: Card }>;
  handlers: {
    message?: (msg: NormalizedMessage) => Promise<void> | void;
    cardAction?: (evt: unknown) => Promise<unknown> | unknown;
  };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  disconnect(): Promise<void>;
}

export async function setupStabChannel(opts: {
  events?: FakeAgentEvents;
  agent?: FakeAgentAdapter;
  tmp?: TmpProfile;
  /** pass appPaths so state files (callback nonces, run journal) live in the tmp profile */
  withAppPaths?: boolean;
  configPatch?: (cfg: Record<string, unknown>) => Record<string, unknown>;
  updateCard?: (messageId: string, card: Card, n: number) => Promise<void>;
  /** called with each streamed card update; lets a test pause mid-run */
  onUpdate?: (card: unknown) => Promise<void> | void;
}): Promise<StabHarness> {
  const tmp = opts.tmp ?? (await createTmpProfile('stab-channel-'));
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    preferences: { messageReply: 'card' },
  } as never);
  let profileConfig = { ...base, workspaces: { ...base.workspaces, default: workspace } } as Record<string, unknown>;
  if (opts.configPatch) profileConfig = opts.configPatch(profileConfig);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  await sessions.load?.();
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = opts.agent ?? new FakeAgentAdapter({ id: 'claude', displayName: 'Claude', events: opts.events ?? [] });

  const h = {
    tmp,
    sent: [],
    updates: [],
    updateCardCalls: [],
    handlers: {},
    agent,
    sessions,
  } as unknown as StabHarness;
  let sendN = 0;
  let updateN = 0;
  let streamN = 0;
  const channel = {
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: { v6: { application: { get: vi.fn(async () => ({ data: { app: { owner: { owner_id: 'ou_owner' } } } })) } } },
      im: {
        v1: {
          message: { get: vi.fn(async () => ({ data: { items: [] } })), list: vi.fn(async () => ({ data: { items: [] } })) },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(next: StabHarness['handlers']) {
      Object.assign(h.handlers, next);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId: string, content: Record<string, unknown>, options?: unknown) {
      h.sent.push({ chatId, content, options });
      sendN++;
      return { messageId: `sent_${sendN}` };
    },
    async updateCard(messageId: string, card: Card) {
      h.updateCardCalls.push({ messageId, card });
      updateN++;
      if (opts.updateCard) await opts.updateCard(messageId, card, updateN);
    },
    async recallMessage() {},
    async stream(_chatId: string, input: StreamInput) {
      streamN++;
      const id = `om_stream_${streamN}`;
      h.updates.push(input.card.initial);
      const ctrl: StreamCtrl = {
        messageId: id,
        lastPatchError: undefined,
        async update(next: unknown) {
          h.updates.push(next);
          await opts.onUpdate?.(next);
        },
      };
      await input.card.producer(ctrl);
      return { messageId: id };
    },
    async addReaction() {
      return 'reaction_1';
    },
    async removeReaction() {},
  };
  stabSdkMock.channel = channel;
  const controls = {
    profile: 'claude',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc_test',
  };
  const { startChannel } = await import('../../src/bot/channel.js');
  const appPaths = opts.withAppPaths
    ? {
        secretsFile: join(tmp.profile, 'secrets.enc'),
        keystoreSaltFile: join(tmp.profile, 'keystore.salt'),
        mediaDir: join(tmp.profile, 'media'),
      }
    : undefined;
  const bridge = await startChannel({ cfg: profileConfig, agent, sessions, workspaces, controls, appPaths } as never);
  h.disconnect = async () => {
    await bridge.disconnect();
    await Promise.all([sessions.flush(), workspaces.flush()]);
  };
  return h;
}

export function dmMessage(messageId: string, content: string, extra: Record<string, unknown> = {}): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
    ...extra,
  } as unknown as NormalizedMessage;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for async work');
}

export const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
export const summaryOf = (card: unknown) =>
  ((card as { config?: { summary?: { content?: string } } })?.config?.summary?.content) ?? '';
