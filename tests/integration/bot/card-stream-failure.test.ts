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

// f0.3.1: card-mode (嘟嘟's production mode, Claude) regressions for the
// "card rejected → stuck on Thinking forever" incident. These replace the old
// markdown-mode-only fallback coverage: every path must end with the answer
// (or an explicit error) on screen.

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
}): Promise<Harness> {
  const tmp = await createTmpProfile('card-stream-failure-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: opts.agentKind ?? 'claude',
    ...(opts.agentKind === 'codex' ? { codex: { binaryPath: 'codex' } } : {}),
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    preferences: { messageReply: 'card' },
  } as never);
  const profileConfig = { ...base, workspaces: { ...base.workspaces, default: workspace } };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter(
    opts.agentKind === 'codex'
      ? { id: 'codex', displayName: 'Codex', events: opts.events }
      : { id: 'claude', displayName: 'Claude', events: opts.events },
  );

  const h: Harness = { sent: [], updates: [], updateCardCalls: [], handlers: {}, agent, sessions };
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
    async recallMessage() {},
    async stream(_chatId: string, input: StreamInput) {
      if (opts.failInitial) throw opts.failInitial;
      h.updates.push(input.card.initial);
      const ctrl: StreamCtrl = {
        messageId: 'om_stream',
        lastPatchError: undefined,
        async update(next: unknown) {
          h.updates.push(next);
          if (opts.midStreamPatchError) ctrl.lastPatchError = opts.midStreamPatchError;
        },
      };
      await input.card.producer(ctrl);
      if (opts.failTerminal) throw opts.failTerminal;
      return { messageId: 'om_stream' };
    },
    async addReaction() {
      return 'reaction_1';
    },
    async removeReaction() {},
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

function message(messageId: string, content: string): NormalizedMessage {
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

const answerEvents: AgentEvent[] = [
  { type: 'text', delta: IMG_ANSWER },
  { type: 'done', terminationReason: 'normal' },
] as AgentEvent[];

describe('card-mode stream failures (f0.3.1)', () => {
  it('f031-#1 final patch rejected → strict retry patches the same card, answer kept, no Thinking', async () => {
    const h = await setup({ events: answerEvents, failTerminal: feishuError(230099) });
    await h.handlers.message?.(message('om_1', 'hi'));
    await waitFor(() => h.updateCardCalls.length >= 1);
    await settle();

    const retry = h.updateCardCalls[0]!;
    expect(retry.messageId).toBe('om_stream');
    const json = JSON.stringify(retry.card);
    expect(json).toContain('ANSWER_SENTINEL');
    expect(json).not.toContain('![');
    expect(json).not.toContain('https://ex.com/cat.png');
    expect(summaryOf(retry.card)).toBe('✅Done');
    // Strict retry worked: no extra messages needed.
    expect(h.sent).toHaveLength(0);
  });

  it('f031-#1 strict retry rejected too → plain-text answer sent, card closed as error', async () => {
    const h = await setup({
      events: answerEvents,
      failTerminal: feishuError(230099),
      updateCard: async (_id, _card, n) => {
        if (n === 1) throw feishuError(230099);
      },
    });
    await h.handlers.message?.(message('om_2', 'hi'));
    await waitFor(() => textSends(h).length >= 1 && h.updateCardCalls.length >= 2);
    await settle();

    const text = textSends(h).join('\n');
    expect(text).toContain('ANSWER_SENTINEL');
    expect(text).toContain('https://ex.com/cat.png');
    expect(text).not.toContain('![');
    const closing = h.updateCardCalls.at(-1)!.card;
    expect(summaryOf(closing)).not.toContain('Thinking');
    expect(JSON.stringify(closing)).toContain('纯文本');
    expect(JSON.stringify(closing)).not.toContain('ANSWER_SENTINEL');
  });

  it('f031-#1 text fallback also fails → one explicit 卡片发送失败 notice', async () => {
    const h = await setup({
      events: answerEvents,
      failTerminal: feishuError(230099),
      updateCard: async () => {
        throw feishuError(230099);
      },
      send: async (content, n) => {
        if (n === 1) throw feishuError(230001, 'text send failed');
        return { messageId: `sent_${n}` };
      },
    });
    await h.handlers.message?.(message('om_3', 'hi'));
    await waitFor(() => textSends(h).some((t) => t.includes('卡片发送失败')));
    await settle();
    expect(textSends(h).filter((t) => t.includes('卡片发送失败'))).toHaveLength(1);
  });

  it('f031-#1 initial card send rejected (200800) → answer still arrives as text', async () => {
    const h = await setup({
      events: answerEvents,
      failInitial: feishuError(200800, 'create universal card fail'),
      send: async (content, n) => {
        if ('card' in content) throw feishuError(200800, 'create universal card fail');
        return { messageId: `sent_${n}` };
      },
    });
    await h.handlers.message?.(message('om_4', 'hi'));
    await waitFor(() => textSends(h).length >= 1);
    await settle();
    // The degrade path tried a sanitized card first, never the raw image.
    const cardSends = h.sent.filter((s) => 'card' in s.content);
    expect(cardSends.length).toBeGreaterThanOrEqual(1);
    for (const c of cardSends) expect(JSON.stringify(c.content)).not.toContain('![');
    expect(textSends(h).join('\n')).toContain('ANSWER_SENTINEL');
  });

  // f03p-fix-#8 (replaces f031-#2's plain-text full copy): a long answer goes
  // out as the streaming card + ordered 「续 i/N」 cards, never as plain text.
  it('f03p-fix-#8 a 17k-char answer → streaming card + 续 2/N… cards in order, no plain-text copy, nothing repeated', async () => {
    const long = longChinese() + '\n\nTAIL_SENTINEL';
    const h = await setup({
      events: [{ type: 'text', delta: long }, { type: 'done', terminationReason: 'normal' }] as AgentEvent[],
    });
    await h.handlers.message?.(message('om_5', 'hi'));
    await waitFor(() => h.sent.some((s) => JSON.stringify(s.content).includes('TAIL_SENTINEL')));
    await settle();
    for (const u of h.updates) expect(Buffer.byteLength(JSON.stringify(u))).toBeLessThan(30_000);
    const last = JSON.stringify(h.updates.at(-1));
    expect(last).toContain('…（未完，见下一张卡）');
    expect(last).not.toContain('已截断');
    expect(textSends(h)).toHaveLength(0);
    const conts = h.sent.filter((s) => 'card' in s.content).map((s) => JSON.stringify(s.content.card));
    const total = conts.length + 1;
    expect(total).toBeGreaterThanOrEqual(2);
    conts.forEach((c, i) => {
      expect(c).toContain(`续 ${i + 2}/${total}`);
      expect(Buffer.byteLength(c)).toBeLessThan(30_000);
      expect(c).not.toContain('![');
    });
    expect(conts.at(-1)).toContain('TAIL_SENTINEL');
    // every paragraph exactly once across all cards
    const all = [last, ...conts].join('\n');
    for (const n of [1, 50, 100, 150]) expect(all.split(`〔P${n}〕这是第${n}段`).length - 1).toBe(3);
    expect(h.updateCardCalls).toHaveLength(0);
  });

  it('f03p-fix-#8 a continuation card rejected by Feishu → only the rest goes out as plain text', async () => {
    const long = longChinese(30_000);
    const h = await setup({
      events: [{ type: 'text', delta: long }, { type: 'done', terminationReason: 'normal' }] as AgentEvent[],
      send: async (content, n) => {
        if ('card' in content && JSON.stringify(content).includes('续 3/')) throw feishuError(230099);
        return { messageId: `sent_${n}` };
      },
    });
    await h.handlers.message?.(message('om_5b', 'hi'));
    await waitFor(() => textSends(h).length >= 1);
    await settle();
    const conts = h.sent.filter((s) => 'card' in s.content).map((s) => JSON.stringify(s.content.card));
    expect(conts[0]).toContain('续 2/');
    const text = textSends(h).join('\n');
    expect(text).toContain('续 3/');
    expect(text).not.toContain('全文（卡片里放不下）');
    // the plain text starts where card 2 ended: no paragraph of card 1 or 2 repeated
    const firstInText = Number(/〔P(\d+)〕这是第/.exec(text)![1]);
    expect(conts[0]).not.toContain(`〔P${firstInText}〕这是第`);
    expect(JSON.stringify(h.updates.at(-1))).not.toContain(`〔P${firstInText}〕这是第`);
    expect(text).toContain(long.slice(-30));
  });

  it('f031-#3 a mid-stream throttled patch failure comes back to aiduCAT and is logged once with its code', async () => {
    const warn = vi.spyOn(log, 'warn');
    const h = await setup({
      events: [
        { type: 'text', delta: 'part one ' },
        { type: 'text', delta: 'part two' },
        { type: 'done', terminationReason: 'normal' },
      ] as AgentEvent[],
      midStreamPatchError: feishuError(230020, 'rate limited'),
    });
    await h.handlers.message?.(message('om_6', 'hi'));
    await waitFor(() => warn.mock.calls.some((c) => c[0] === 'card' && c[1] === 'patch-failed'));
    await settle();
    const calls = warn.mock.calls.filter((c) => c[0] === 'card' && c[1] === 'patch-failed');
    expect(calls).toHaveLength(1);
    expect(calls[0]![2]).toMatchObject({ code: 230020 });
  });

  it('f031-#4 an empty Claude run (done with no output) shows an error card with a reason', async () => {
    const h = await setup({
      events: [{ type: 'done', terminationReason: 'normal' }] as AgentEvent[],
    });
    await h.handlers.message?.(message('om_7', 'hi'));
    await waitFor(() => h.sent.length >= 1);
    await settle();
    const card = h.sent.at(-1)!.content.card;
    expect(card).toBeDefined();
    expect(summaryOf(card)).toBe('❌Error');
    expect(JSON.stringify(card)).toContain('没有产出');
  });

  it('f031-#5 card patches are throttled to <=4/s (250ms, no char-count bypass)', async () => {
    await setup({ events: answerEvents });
    const opts = sdkMock.createLarkChannel.mock.calls[0]![0] as {
      outbound: { streamThrottleMs: number; streamThrottleChars: number };
    };
    expect(opts.outbound.streamThrottleMs).toBeGreaterThanOrEqual(250);
    // The SDK fires immediately once pending chars >= streamThrottleChars and a
    // whole card JSON is always > 50 chars, so the char trigger must be off.
    expect(opts.outbound.streamThrottleChars).toBeGreaterThan(1_000_000);
  });

  it('f031-#6 a rejected card is logged as hash/length/code, never dumped to /tmp', async () => {
    const dump = '/tmp/aiduCAT-rejected-card.json';
    const before = existsSync(dump) ? readFileSync(dump, 'utf8') : '';
    const warn = vi.spyOn(log, 'warn');
    const h = await setup({ events: answerEvents, failTerminal: feishuError(230099) });
    await h.handlers.message?.(message('om_8', 'hi'));
    await waitFor(() => h.updateCardCalls.length >= 1);
    await settle();
    const after = existsSync(dump) ? readFileSync(dump, 'utf8') : '';
    expect(after).toBe(before);
    const rejected = warn.mock.calls.find((c) => c[0] === 'card' && c[1] === 'rejected');
    expect(rejected).toBeDefined();
    const fields = rejected![2] as Record<string, unknown>;
    expect(fields).toMatchObject({ code: 230099 });
    expect(typeof fields.sha256).toBe('string');
    expect(typeof fields.bytes).toBe('number');
    expect(JSON.stringify(fields)).not.toContain('ANSWER_SENTINEL');
  });
});

describe('f031-#8 /status numbers flow from the real claude stream through channel', () => {
  it('f031-#8 context = last main-line call (not sub-agent, not result); totals = turn result', async () => {
    const raw = [
      { type: 'system', subtype: 'init', session_id: 'sess-f031', model: F.model },
      F.mainAssistant(F.calls[0]!),
      F.mainAssistant(F.calls[1]!),
      F.sidechainAssistant(F.subagentCall),
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'ok' }] } },
      F.result(),
    ];
    const events = raw.flatMap((r) => [...translateEvent(r)]);
    const h = await setup({ events });
    await h.handlers.message?.(message('om_ctx', 'hi'));
    await waitFor(() => h.sessions.getRaw('oc_dm')?.stats?.tokensOut !== undefined && (h.sessions.getRaw('oc_dm')?.stats?.tokensOut ?? 0) > 0);
    const st = h.sessions.getRaw('oc_dm')!.stats!;
    const c = F.calls[1]!;
    expect(st.contextTokens).toBe(c.input_tokens + c.cache_read_input_tokens + c.cache_creation_input_tokens);
    expect(st.tokensOut).toBe(F.turn.output_tokens);
    expect(st.model).toBe(F.model);
    expect(st.userMessages).toBe(1);
    expect(st.agentMessages).toBe(1);
  });
});

describe('f031-func-#8 codex: one Agent message per turn', () => {
  it('f031-func-#8 final_text + done count as ONE agent message', async () => {
    const events: AgentEvent[] = [
      { type: 'text', delta: 'hello' },
      { type: 'final_text', content: 'hello' },
      { type: 'done', terminationReason: 'normal' },
    ];
    const h = await setup({ events, agentKind: 'codex' });
    h.sessions.set('oc_dm', 'thread-x', '/tmp');
    await h.handlers.message?.(message('om_codex', 'hi'));
    await waitFor(() => (h.sessions.getRaw('oc_dm')?.stats?.agentMessages ?? 0) > 0);
    await settle();
    const st = h.sessions.getRaw('oc_dm')!.stats!;
    expect(st.userMessages).toBe(1);
    expect(st.agentMessages).toBe(1);
  });
});
