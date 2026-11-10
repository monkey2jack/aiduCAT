import type { NormalizedMessage } from '@larksuite/channel';
import { existsSync, readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';
import { CLAUDE_USAGE_FIXTURE as F } from '../../helpers/claude-usage-fixture.js';
import { translateEvent } from '../../../src/agent/claude/stream-json.js';
import { longChinese } from '../../helpers/long-answers.js';

// f0.5 之后 (steer, Wei 2026-11-10「插话」): a message from the same person while
// claude works goes INTO the running claude; the card so far closes ↪️Steered
// and the same run carries on in the new message's card. Harness from f035.

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

type Card = Record<string, unknown>;
interface StreamCtrl {
  readonly messageId: string;
  lastPatchError?: unknown;
  update(next: unknown): Promise<void>;
}
interface StreamInput {
  card: { initial: unknown; producer: (ctrl: StreamCtrl) => Promise<void> };
}

vi.setConfig({ testTimeout: 15_000 });

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

function feishuError(code: number, msg = 'card content invalid'): Error {
  return Object.assign(new Error(`Request failed with status code 400`), {
    response: { data: { code, msg } },
  });
}

const IMG_ANSWER = '答案在这里 ANSWER_SENTINEL ![猫](https://ex.com/cat.png) 结束';

interface Harness {
  sent: Array<{ chatId: string; content: Record<string, unknown>; options?: unknown }>;
  updates: unknown[];
  updateCardCalls: Array<{ messageId: string; card: Card }>;
  order: string[];
  recalled: string[];
  reactions: { added: string[]; removed: string[] };
  handlers: { message?: (msg: NormalizedMessage) => Promise<void> | void };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  runs: SteerableRun[];
}

async function setup(opts: {
  events: FakeAgentEvents;
  failInitial?: Error;
  failTerminal?: Error;
  midStreamPatchError?: Error;
  updateCard?: (messageId: string, card: Card, n: number) => Promise<void>;
  send?: (content: Record<string, unknown>, n: number) => Promise<{ messageId: string }>;
  agentKind?: 'claude' | 'codex';
  model?: string;
  /** f0.3.4: agent events only start flowing once this resolves. */
  gate?: Promise<void>;
  addReactionDelayMs?: number;
  failReaction?: boolean;
  /** f0.3.5: sleep before each agent event (for TPS timing). */
  stepMs?: number;
  showToolCallsInGroups?: boolean;
  messageReply?: 'card' | 'markdown';
  makeRun?: (runOpts: unknown) => SteerableRun;
}): Promise<Harness> {
  const tmp = await createTmpProfile('f035-early-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: opts.agentKind ?? 'claude',
    ...(opts.agentKind === 'codex' ? { codex: { binaryPath: 'codex' } } : {}),
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'], allowedChats: ['oc_grp'], requireMentionInGroup: true },
    preferences: {
      messageReply: opts.messageReply ?? 'card',
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.showToolCallsInGroups ? { showToolCallsInGroups: true } : {}),
    },
  } as never);
  const profileConfig = { ...base, workspaces: { ...base.workspaces, default: workspace } };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter(
    opts.agentKind === 'codex'
      ? { id: 'codex', displayName: 'Codex', events: opts.events }
      : { id: 'claude', displayName: 'Claude', events: opts.events },
  );

  const h: Harness = {
    sent: [], updates: [], updateCardCalls: [], handlers: {}, agent, sessions,
    order: [], recalled: [], reactions: { added: [], removed: [] }, runs: [],
  };
  agent.run = ((runOpts: Parameters<typeof agent.run>[0]) => {
    h.order.push('agent-run');
    const run = opts.makeRun!(runOpts);
    h.runs.push(run);
    return run;
  }) as typeof agent.run;
  let sendN = 0;
  let updateN = 0;
  const channel = {
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: { v6: { application: { get: vi.fn(async () => ({ data: { app: { owner: { owner_id: 'ou_owner' } } } })) } } },
      im: {
        v1: {
          message: { get: vi.fn(async () => ({ data: { items: [] } })) },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
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
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId: string, content: Record<string, unknown>, options?: unknown) {
      h.sent.push({ chatId, content, options });
      sendN++;
      if (opts.send) return opts.send(content, sendN);
      return { messageId: `sent_${sendN}` };
    },
    async updateCard(messageId: string, card: Card) {
      h.updateCardCalls.push({ messageId, card });
      updateN++;
      if (opts.updateCard) await opts.updateCard(messageId, card, updateN);
    },
    async recallMessage(id: string) {
      h.recalled.push(id);
    },
    async stream(_chatId: string, input: StreamInput | { markdown: (c: unknown) => Promise<void> }) {
      if ('markdown' in input) {
        h.order.push('markdown-open');
        await input.markdown({ setContent: async () => {} });
        return { messageId: 'om_md' };
      }
      h.order.push('card-open');
      if (opts.failInitial) throw opts.failInitial;
      h.updates.push(input.card.initial);
      const id = `om_stream_${h.order.filter((o) => o === 'card-open').length}`;
      const ctrl: StreamCtrl = {
        messageId: id,
        lastPatchError: undefined,
        async update(next: unknown) {
          h.updates.push(next);
          if (opts.midStreamPatchError) ctrl.lastPatchError = opts.midStreamPatchError;
        },
      };
      await input.card.producer(ctrl);
      if (opts.failTerminal) throw opts.failTerminal;
      return { messageId: id };
    },
    async addReaction(messageId: string) {
      h.order.push('reaction');
      if (opts.addReactionDelayMs) await new Promise((r) => setTimeout(r, opts.addReactionDelayMs));
      if (opts.failReaction) throw new Error('reaction api down');
      h.reactions.added.push(messageId);
      return 'reaction_1';
    },
    async removeReaction(messageId: string) {
      h.reactions.removed.push(messageId);
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
    configPath: '/tmp/config.json',
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

function message(messageId: string, content: string, chat: 'p2p' | 'group' = 'p2p'): NormalizedMessage {
  return {
    messageId,
    chatId: chat === 'group' ? 'oc_grp' : 'oc_dm',
    chatType: chat,
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: chat === 'group',
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for async work');
}

const settle = () => new Promise((r) => setTimeout(r, 150));
const summaryOf = (card: unknown) =>
  ((card as { config?: { summary?: { content?: string } } })?.config?.summary?.content) ?? '';
const textSends = (h: Harness) =>
  h.sent.filter((s) => typeof s.content.text === 'string').map((s) => s.content.text as string);


function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

const answer = (text: string): AgentEvent[] =>
  [{ type: 'text', delta: text }, { type: 'done', terminationReason: 'normal' }] as AgentEvent[];


/** A claude run whose stdin takes messages mid-run (like SteerInput). */
class SteerableRun {
  readonly runId: string;
  readonly steered: string[] = [];
  stopped = false;
  #queue: AgentEvent[] = [];
  #wake: (() => void) | undefined;
  #ended = false;
  readonly events: AsyncIterable<AgentEvent>;
  constructor(
    runId: string,
    private readonly script: {
      /** events before anyone cuts in */
      first: AgentEvent[];
      /** events after each message taken in (index = nth steer) */
      afterSteer: AgentEvent[][];
      /** false = input already closed */
      accepts?: boolean;
    },
  ) {
    this.runId = runId;
    this.#queue.push(...script.first);
    if (script.afterSteer.length === 0) this.#ended = true;
    const self = this;
    this.events = (async function* () {
      while (true) {
        while (self.#queue.length > 0) yield self.#queue.shift()!;
        if (self.#ended || self.stopped) return;
        await new Promise<void>((r) => (self.#wake = r));
      }
    })();
  }
  steer(prompt: string): boolean {
    if (this.script.accepts === false) return false;
    const n = this.steered.length;
    this.steered.push(prompt);
    this.#queue.push({ type: 'steer' }, ...(this.script.afterSteer[n] ?? []));
    if (n + 1 >= this.script.afterSteer.length) this.#ended = true;
    this.#wake?.();
    return true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.#wake?.();
  }
  async waitForExit(): Promise<boolean> {
    return true;
  }
}

const done = { type: 'done', terminationReason: 'normal' } as AgentEvent;

describe('f0.5 之后 steer (插话)', () => {
  it('steer: a second message mid-run goes into the same claude; card 1 ↪️Steered, card 2 answers it', async () => {
    const h = await setup({
      events: [],
      makeRun: (o) =>
        new SteerableRun((o as { runId: string }).runId, {
          first: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 9' } }],
          afterSteer: [
            [
              { type: 'tool_result', id: 't1', output: 'ok', isError: false },
              { type: 'text', delta: 'S2_ANSWER' },
              done,
            ],
          ],
        }),
    });
    await h.handlers.message?.(message('om_a', 'first'));
    await waitFor(() => JSON.stringify(h.updates.at(-1)).includes('Running'));
    await h.handlers.message?.(message('om_b', 'second NEW_SAY'));
    await waitFor(() => h.runs[0]!.steered.length === 1);
    expect(h.runs[0]!.steered[0]).toContain('second NEW_SAY');
    expect(h.runs[0]!.steered[0]).toContain('插话');
    await waitFor(() => summaryOf(h.updates.at(-1)) === '✅Completed');
    await settle();
    // one claude process for both messages
    expect(h.order.filter((o) => o === 'agent-run')).toHaveLength(1);
    // two cards: the first closed as steered, the second carries the answer
    expect(h.order.filter((o) => o === 'card-open')).toHaveLength(2);
    const summaries = h.updates.map(summaryOf);
    expect(summaries).toContain('↪️Steered');
    expect(summaries.indexOf('↪️Steered')).toBeLessThan(summaries.lastIndexOf('✅Completed'));
    const last = JSON.stringify(h.updates.at(-1));
    expect(last).toContain('S2_ANSWER');
    expect(h.recalled).toHaveLength(0);
  });

  it('steer: when the run no longer takes input, the message waits and runs as the next round (old behavior)', async () => {
    let n = 0;
    const h = await setup({
      events: [],
      makeRun: (o) => {
        n++;
        const id = (o as { runId: string }).runId;
        return n === 1
          ? new SteerableRun(id, {
              first: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'x' } }],
              afterSteer: [[]],
              accepts: false,
            })
          : new SteerableRun(id, { first: [{ type: 'text', delta: 'R2_ANSWER' }, done], afterSteer: [] });
      },
    });
    await h.handlers.message?.(message('om_a', 'first'));
    await waitFor(() => JSON.stringify(h.updates.at(-1)).includes('Running'));
    await h.handlers.message?.(message('om_b', 'second'));
    await new Promise((r) => setTimeout(r, 1200));
    expect(h.order.filter((o) => o === 'agent-run')).toHaveLength(1);
    // finish run 1 (it never took the message in)
    await h.runs[0]!.stop();
    await waitFor(() => h.order.filter((o) => o === 'agent-run').length === 2, 8000);
    await waitFor(() => JSON.stringify(h.updates).includes('R2_ANSWER'));
    expect(h.runs[1]!.steered).toHaveLength(0);
  });
});
