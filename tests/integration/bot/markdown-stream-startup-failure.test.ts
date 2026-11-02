import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import type { FakeAgentEvents } from '../../helpers/fake-agent.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';
import { AGENT_FAILED_PUBLIC_NOTICE } from '../../../src/bot/user-facing-error.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      v1: {
        message: {
          get: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

type StreamFn = FakeLarkChannel['stream'];
type SendFn = FakeLarkChannel['send'];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('markdown stream startup failures', () => {
  it('does not leave the IM queue blocked when the agent exits before stream producer starts', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.channel.rawClient.im.v1.messageReaction.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_first', reaction_id: 'reaction_1' },
      }),
    );
    expect(lastMarkdown(h.channel)).toContain('agent 失败');
    // f0.4 之后的修复 (bwrap): ou_user is not the owner — friendly notice only.
    expect(lastMarkdown(h.channel)).toContain(AGENT_FAILED_PUBLIC_NOTICE);
    expect(lastMarkdown(h.channel)).not.toContain('codex exited with code 1');
  });

  it('does not wait for the working reaction before draining a failed agent run', async () => {
    const reaction = deferred<{ data: { reaction_id: string } }>();
    const h = await createHarness({
      reactionCreate: () => reaction.promise,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2, 1000);

    expect(lastMarkdown(h.channel)).toContain('agent 失败');

    reaction.resolve({ data: { reaction_id: 'reaction_1' } });
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);
  });

  it('logs stream failures that arrive after terminal grace expires', async () => {
    const streamFailure = deferred<void>();
    let streamProducerStarted = false;
    const h = await createHarness({
      // The first run has to stream something, or no progress stream is opened
      // at all and there is no late failure to log.
      events: [
        [
          { type: 'text', delta: 'progress update' },
          {
            type: 'error',
            message: 'codex exited with code 1: Error loading config.toml',
            terminationReason: 'failed',
          },
        ],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (producer) {
          streamProducerStarted = true;
          void producer({ setContent: vi.fn(async () => {}) });
        }
        await streamFailure.promise;
      },
    });
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => streamProducerStarted);
    await waitFor(
      () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
      4500,
    );

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    streamFailure.reject(new Error('late stream failed'));

    await waitFor(() =>
      fail.mock.calls.some((call) =>
        call[0] === 'stream' &&
        call[1] instanceof Error &&
        call[1].message === 'late stream failed' &&
        (call[2] as { step?: string } | undefined)?.step === 'stream-terminal-late',
      ),
    );
  }, 10_000);

  it('sends one dedicated non-streaming final reply after progress completes', async () => {
    const visibleProgress: string[] = [];
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'final_text', content: 'FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_final', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(visibleProgress.some((markdown) => markdown.includes('progress update'))).toBe(true);
    expect(h.channel.sent).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toContain('FINAL_SENTINEL');
    // aiduCAT: p2p replies are not quoted (no replyTo); only topic groups thread.
    expect(h.channel.sent[0]?.options).toEqual({});
  });

  it('opens no progress stream for a final-only round', async () => {
    // The regression this guards: Codex answering without any commentary. The
    // SDK sends its streaming card as soon as `stream()` is called and finishes
    // an empty one with "(no content)", so the user saw that placeholder for a
    // few seconds, watched it get recalled, and only then got the answer.
    const streamCalls: unknown[] = [];
    const h = await createHarness({
      events: [
        { type: 'final_text', content: 'FINAL_ONLY_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        streamCalls.push(input);
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_final_only', 'run'));
    await waitFor(() => h.channel.sent.length === 1);
    // give a stray stream / recall a chance to fire before asserting
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(streamCalls).toHaveLength(0);
    expect(h.channel.sent).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toContain('FINAL_ONLY_SENTINEL');
  });

  it('does not repeat streamed text as the final reply when Codex held nothing back', async () => {
    // Codex only reserves its *last* message as `final_text`; an abnormal turn
    // end (turn.failed, or the process dying before turn.completed) flushes it
    // as a text block instead. Those blocks are already on screen, so the
    // dedicated final reply must not post the same words a second time.
    const visibleProgress: string[] = [];
    const h = await createHarness({
      events: [
        { type: 'text', delta: '这是答案' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_no_final', 'run'));
    await waitFor(() => visibleProgress.some((markdown) => markdown.includes('这是答案')));
    // give a (duplicate) final reply a chance to fire before asserting
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.channel.sent).toHaveLength(0);
  });

  it('waits for a slow-opening progress stream instead of replying alongside it', async () => {
    // Opening a streaming card costs two API round trips. When the run finishes
    // first, replying right away duplicates the answer verbatim — once as text,
    // once as the card that lands a moment later.
    const visibleProgress: string[] = [];
    const h = await createHarness({
      agentKind: 'claude',
      events: [
        { type: 'text', delta: 'ANSWER_ONCE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await new Promise((resolve) => setTimeout(resolve, 200));
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_slow_stream', 'run'));
    await waitFor(() => visibleProgress.some((markdown) => markdown.includes('ANSWER_ONCE')));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.channel.sent).toHaveLength(0);
  });

  it('renders nothing in a progress stream it already gave up on', async () => {
    // If the stream is still not producing after the grace window we do reply
    // without it — but the stream must then stay empty, or the answer shows up
    // twice as soon as it catches up.
    const gate = deferred<void>();
    const setContent = vi.fn(async () => {});
    const h = await createHarness({
      agentKind: 'claude',
      events: [
        { type: 'text', delta: 'ANSWER_ONCE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await gate.promise;
        await producer?.({ setContent });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stuck_stream', 'run'));
    await waitFor(() => h.channel.sent.length === 1, 6000);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(lastMarkdown(h.channel)).toContain('ANSWER_ONCE');
    expect(h.channel.sent).toHaveLength(1);
    expect(setContent).not.toHaveBeenCalled();
  }, 15_000);

  it('still sends the final reply when the progress stream fails at completion', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'final_text', content: 'FINAL_AFTER_STREAM_FAILURE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: vi.fn(async () => {}) });
        throw new Error('progress stream failed');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stream_fail', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(lastMarkdown(h.channel)).toContain('FINAL_AFTER_STREAM_FAILURE');
    expect(
      fail.mock.calls.some(
        (call) =>
          call[0] === 'stream' &&
          call[1] instanceof Error &&
          call[1].message === 'progress stream failed' &&
          (call[2] as { step?: string } | undefined)?.step === 'progress-stream',
      ),
    ).toBe(true);
  });

  it('does not record delivery when the final send has no message receipt', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const h = await createHarness({
      events: [
        { type: 'final_text', content: 'FINAL_WITHOUT_RECEIPT' },
        { type: 'done', terminationReason: 'normal' },
      ],
      send: async () => ({ messageId: '' }),
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: vi.fn(async () => {}) });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_no_receipt', 'run'));
    await waitFor(() =>
      fail.mock.calls.some(
        (call) => call[1] instanceof Error && call[1].message.includes('missing message receipt'),
      ),
    );

    expect(
      info.mock.calls.some((call) => call[0] === 'outbound' && call[1] === 'sent'),
    ).toBe(false);
  });

  it('renders progress and the final answer in one unified card in card mode', async () => {
    // aiduCAT unified card: in card mode the streamed card carries both the
    // progress text and Codex's final answer; no second card is sent.
    const progressCards: unknown[] = [];
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'final_text', content: 'FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
        }).card?.producer;
        await producer?.({
          update: vi.fn(async (next: unknown) => {
            progressCards.push(next);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_card_final', 'run'));
    await waitFor(() => JSON.stringify(progressCards.at(-1) ?? '').includes('FINAL_SENTINEL'));
    await new Promise((resolve) => setTimeout(resolve, 80));

    const finalCard = JSON.stringify(progressCards.at(-1));
    expect(finalCard).toContain('progress update');
    expect(finalCard).toContain('FINAL_SENTINEL');
    expect(finalCard).toContain('✅Done');
    expect(h.channel.sent).toHaveLength(0);
  });
});

async function createHarness(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  send?: SendFn;
  /** One run's events, or one array per run. */
  events?: FakeAgentEvents;
  messageReply?: 'card' | 'markdown' | 'text';
  /** Codex holds its answer back for a dedicated final reply; Claude streams it. */
  agentKind?: 'claude' | 'codex';
  /** f0.4 bwrap: override the profile's access block. */
  access?: Record<string, unknown>;
  /** f0.4 bwrap: the bot owner's open_id (controls.botOwnerId). */
  botOwnerId?: string;
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('markdown-stream-startup-failure-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: options.agentKind ?? 'codex',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: (options.access ?? {
      allowedUsers: ['ou_user'],
    }) as never,
    codex: {
      binaryPath: '/usr/local/bin/codex',
    },
    // These cases exercise markdown streaming unless a test opts into card;
    // the profile default became 'card' in aiduCAT (card-mode coverage lives
    // in card-stream-failure.test.ts).
    preferences: { messageReply: options.messageReply ?? 'markdown' },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'codex',
    displayName: 'Codex',
    events: options.events ?? [
      [
        {
          type: 'error',
          message: 'codex exited with code 1: Error loading config.toml',
          terminationReason: 'failed',
        },
      ],
      [{ type: 'done', terminationReason: 'normal' }],
    ],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig, options.botOwnerId);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(harnessOptions: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  send?: SendFn;
} = {}): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(harnessOptions.reactionCreate ?? (async () => ({ data: { reaction_id: 'reaction_1' } }))),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
      if (harnessOptions.send) return harnessOptions.send(chatId, content, options);
      return { messageId: `sent_${sent.length}` };
    },
    stream: harnessOptions.stream ?? (async () => {
      await new Promise<void>(() => {});
    }),
    async addReaction(messageId, emojiType) {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return (r as { data?: { reaction_id?: string } })?.data?.reaction_id ?? '';
    },
    async removeReaction(messageId, reactionId) {
      await channel.rawClient.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    },
  };
  return channel;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>, botOwnerId?: string) {
  return {
    ...(botOwnerId ? { botOwnerId } : {}),
    profile: 'codex',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(
  messageId: string,
  content: string,
  over: Partial<{ chatId: string; chatType: string; senderId: string; mentionedBot: boolean }> = {},
): NormalizedMessage {
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
    ...over,
  } as unknown as NormalizedMessage;
}

function lastMarkdown(channel: FakeLarkChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown ?? '';
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}

// f0.4 之后的修复 (bwrap, 2026-11-02): 小猴² answered a group @ from someone
// else with the raw "claude exited with code 1: … bubblewrap is required …".
describe('f04-bwrap: agent start failure never shows the raw error to the group', () => {
  const BWRAP_ERROR =
    'claude exited with code 1: Claude Code could not start: bubblewrap is required for subprocess env scrubbing and isolation. Install with: sudo apt-get install -y bubblewrap, set sandbox.bwrapPath in managed settings, or set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0 to disable (loses subprocess isolation).';
  const failedRun: AgentEvent[] = [{ type: 'error', message: BWRAP_ERROR, terminationReason: 'failed' }];
  const groupAccess = { allowedChats: ['oc_grp'], chatAllowAllUsers: ['oc_grp'] };
  const groupMsg = (id: string, senderId: string) =>
    message(id, '@小猴 你现在把家搬到哪去了', { chatId: 'oc_grp', chatType: 'group', senderId, mentionedBot: true });

  function cardCapture(progressCards: unknown[]): StreamFn {
    return async (_chatId, input) => {
      const producer = (input as {
        card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
      }).card?.producer;
      await producer?.({
        update: vi.fn(async (next: unknown) => {
          progressCards.push(next);
        }),
      });
    };
  }

  function everythingShown(h: { channel: FakeLarkChannel }, cards: unknown[]): string {
    return JSON.stringify(cards) + JSON.stringify(h.channel.sent);
  }

  it('group, non-owner, card mode: friendly notice, no raw stderr', async () => {
    const cards: unknown[] = [];
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'card',
      access: groupAccess,
      botOwnerId: 'ou_owner',
      events: [failedRun],
      stream: cardCapture(cards),
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(groupMsg('om_grp_1', 'ou_stranger'));
    await waitFor(() => everythingShown(h, cards).includes(AGENT_FAILED_PUBLIC_NOTICE), 4000);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const shown = everythingShown(h, cards);
    expect(h.agent.runOptions[0]?.ownerRun).toBe(false);
    expect(shown).not.toContain('bubblewrap');
    expect(shown).not.toContain('exited with code');
    expect(shown).not.toContain('apt-get');
  });

  it('group, the owner himself: still the friendly notice (the whole group sees the card)', async () => {
    const cards: unknown[] = [];
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'card',
      access: groupAccess,
      botOwnerId: 'ou_owner',
      events: [failedRun],
      stream: cardCapture(cards),
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(groupMsg('om_grp_2', 'ou_owner'));
    await waitFor(() => everythingShown(h, cards).includes(AGENT_FAILED_PUBLIC_NOTICE), 4000);
    expect(everythingShown(h, cards)).not.toContain('bubblewrap');
  });

  it('owner private chat: a short reason, never the raw multi-part stderr', async () => {
    const cards: unknown[] = [];
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'card',
      access: { allowedUsers: [] },
      botOwnerId: 'ou_owner',
      events: [failedRun],
      stream: cardCapture(cards),
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_dm_owner', 'hi', { senderId: 'ou_owner' }));
    await waitFor(() => everythingShown(h, cards).includes('这轮没跑成'), 4000);
    const shown = everythingShown(h, cards);
    expect(h.agent.runOptions[0]?.ownerRun).toBe(true);
    expect(shown).toContain('bubblewrap');
    expect(shown).toContain('aiduCAT 日志');
    expect(shown).not.toContain('exited with code');
    expect(shown).not.toContain('apt-get');
    expect(shown).not.toContain(AGENT_FAILED_PUBLIC_NOTICE);
  });

  it('a busy scope queues new messages and runs them after — no "already running" error', async () => {
    const gate = deferred<void>();
    const h = await createHarness({
      messageReply: 'markdown',
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: vi.fn(async () => {}) });
      },
    });
    let call = 0;
    h.agent.run = (opts) => {
      h.agent.runOptions.push(opts);
      const n = ++call;
      const run = {
        runId: opts.runId,
        events: (async function* () {
          if (n === 1) await gate.promise;
          yield { type: 'final_text', content: `ANSWER_${n}` } as AgentEvent;
          yield { type: 'done', terminationReason: 'normal' } as AgentEvent;
        })(),
        async stop() {},
        async waitForExit() {
          return true;
        },
      };
      return run;
    };
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_busy_1', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);
    await h.channel.handlers.message?.(message('om_busy_2', 'second'));
    await h.channel.handlers.message?.(message('om_busy_3', 'third'));
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(h.agent.runOptions).toHaveLength(1);

    gate.resolve();
    await waitFor(() => h.agent.runOptions.length === 2, 4000);
    await waitFor(() => JSON.stringify(h.channel.sent).includes('ANSWER_2'), 4000);
    const shown = JSON.stringify(h.channel.sent);
    expect(shown).toContain('ANSWER_1');
    expect(shown).not.toContain('已有运行在执行');
    expect(shown).not.toContain('⚠️');
    // the two queued messages went into ONE follow-up round
    expect(h.agent.runOptions[1]?.prompt).toContain('second');
    expect(h.agent.runOptions[1]?.prompt).toContain('third');
  }, 12_000);
});
