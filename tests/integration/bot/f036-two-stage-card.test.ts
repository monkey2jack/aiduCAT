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

// f0.3.5 (Wei 02:03): the「☤aiduCATing…」card goes out the moment a message is
// accepted — before debounce, queueing behind a running round, agent spawn —
// and replaces the working reaction in card mode. Harness from f034-latency.

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
}): Promise<Harness> {
  const tmp = await createTmpProfile('f036-card-');
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
    order: [], recalled: [], reactions: { added: [], removed: [] },
  };
  const origRun = agent.run.bind(agent);
  agent.run = ((runOpts: Parameters<typeof agent.run>[0]) => {
    h.order.push('agent-run');
    const run = origRun(runOpts);
    if (!opts.gate && !opts.stepMs) return run;
    const inner = run.events;
    const gate = opts.gate ?? Promise.resolve();
    const stepMs = opts.stepMs ?? 0;
    return Object.assign(Object.create(Object.getPrototypeOf(run)), run, {
      stop: () => run.stop(),
      waitForExit: (ms: number) => run.waitForExit(ms),
      events: (async function* () {
        await gate;
        for await (const e of inner) {
          if (stepMs) await new Promise((r) => setTimeout(r, stepMs));
          yield e;
        }
      })(),
    });
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

// f0.3.6 (Wei 2026-11-02): the placeholder card is one line「☤aiduCATing…」;
// the panel joins the SAME card (next full-card update) at the agent's first
// thinking / tool call / answer text. TPS only in /status.
// f0.4+ (Wei 2026-11-04): the placeholder is already a one-line panel
// 「[agent icon] aiduCATing…」; "the panel" here means the working panel with
// the meta line (💭 / 🛠️ counters).
const hasPanel = (card: unknown) => JSON.stringify(card).includes('💭');

describe('f0.3.6 two-stage card (line first, panel on first agent output)', () => {
  it('f036 thinking turn: line only through intake + adoption; panel appears with the first thinking; one card', async () => {
    const g = gate();
    const h = await setup({
      events: [
        { type: 'thinking', delta: 'hmm' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_result', id: 't1', output: 'ok' },
        { type: 'text', delta: 'TS_ANSWER' },
        { type: 'done', terminationReason: 'normal' },
      ] as AgentEvent[],
      gate: g.promise,
      model: 'aiduPARK',
      stepMs: 30,
    });
    await h.handlers.message?.(message('om_s1', 'hi'));
    expect(hasPanel(h.updates[0])).toBe(false);
    expect(JSON.stringify(h.updates[0])).toContain('"content":"aiduCATing…"');
    await waitFor(() => h.order.includes('agent-run'));
    await settle();
    // adopted, agent still silent → still just the line
    expect(h.updates.every((u) => !hasPanel(u))).toBe(true);
    g.open();
    await waitFor(() => summaryOf(h.updates.at(-1)) === '✅Done');
    await settle();
    const firstWithPanel = h.updates.findIndex(hasPanel);
    expect(firstWithPanel).toBeGreaterThan(0);
    // the first frame with a panel is the thinking frame
    expect(JSON.stringify(h.updates[firstWithPanel])).toContain('"content":"Thinking…"');
    // once the panel is there it stays
    expect(h.updates.slice(firstWithPanel).every(hasPanel)).toBe(true);
    const last = JSON.stringify(h.updates.at(-1));
    expect(last).toContain('TS_ANSWER');
    expect(last).toContain('custom_icon');
    expect(last).not.toContain('tok/s');
    expect(h.order.filter((o) => o === 'card-open')).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
    expect(h.recalled).toHaveLength(0);
  });

  it('f036 pure text turn: the panel arrives together with the first answer text', async () => {
    const h = await setup({ events: answer('PURE_TEXT'), model: 'aiduPARK', stepMs: 30 });
    await h.handlers.message?.(message('om_s2', 'hi'));
    await waitFor(() => summaryOf(h.updates.at(-1)) === '✅Done');
    await settle();
    const firstWithPanel = h.updates.findIndex(hasPanel);
    expect(firstWithPanel).toBeGreaterThan(0);
    expect(h.updates.slice(0, firstWithPanel).every((u) => !JSON.stringify(u).includes('PURE_TEXT'))).toBe(true);
    expect(JSON.stringify(h.updates[firstWithPanel])).toContain('PURE_TEXT');
    expect(JSON.stringify(h.updates.at(-1))).toContain('💭 0 · 🛠️ 0');
  });

  it('f036 group (tools hidden): a tool-only start still brings the panel', async () => {
    const h = await setup({
      events: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_result', id: 't1', output: 'ok' },
        { type: 'text', delta: 'G_ANSWER' },
        { type: 'done', terminationReason: 'normal' },
      ] as AgentEvent[],
      stepMs: 30,
    });
    await h.handlers.message?.(message('om_s3', '@Bridge hi', 'group'));
    await waitFor(() => summaryOf(h.updates.at(-1)) === '✅Done');
    const firstWithPanel = h.updates.findIndex(hasPanel);
    expect(JSON.stringify(h.updates[firstWithPanel])).toContain('"content":"Processing…"');
    expect(JSON.stringify(h.updates.at(-1))).not.toContain('Bash');
  });

  it('f036 a failing mid-stream patch (the frame adding the panel) loses nothing: final card has answer + panel', async () => {
    const h = await setup({
      events: [{ type: 'thinking', delta: 'x' }, { type: 'text', delta: 'KEEP_ME' }, { type: 'done', terminationReason: 'normal' }] as AgentEvent[],
      midStreamPatchError: feishuError(230020, 'rate limited'),
      stepMs: 30,
    });
    await h.handlers.message?.(message('om_s4', 'hi'));
    await waitFor(() => summaryOf(h.updates.at(-1)) === '✅Done');
    await settle();
    const last = JSON.stringify(h.updates.at(-1));
    expect(last).toContain('KEEP_ME');
    expect(hasPanel(h.updates.at(-1))).toBe(true);
  });

  it('f036 /stop while still on the line: card ends ⭕️Stop as before', async () => {
    const g = gate();
    const h = await setup({ events: answer('NEVER_SHOWN'), gate: g.promise });
    await h.handlers.message?.(message('om_s5', 'hi'));
    await waitFor(() => h.order.includes('agent-run'));
    await h.handlers.message?.(message('om_s6', '/stop'));
    g.open();
    await waitFor(() => summaryOf(h.updates.at(-1)) === '⭕️Stop');
    await settle();
    expect(hasPanel(h.updates.at(-1))).toBe(true);
    expect(h.order.filter((o) => o === 'card-open')).toHaveLength(1);
    expect(JSON.stringify(h.updates)).not.toContain('NEVER_SHOWN');
  });
});
