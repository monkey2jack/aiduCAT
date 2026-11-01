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

// f0.3.4 (飞书响应慢): the reaction goes on at flush start and the card opens
// at run start (☤Thinking… + model logo) — without breaking 续卡, degrade,
// /stop or the empty-run guard. Harness copied from card-stream-failure.

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
}): Promise<Harness> {
  const tmp = await createTmpProfile('f034-latency-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: opts.agentKind ?? 'claude',
    ...(opts.agentKind === 'codex' ? { codex: { binaryPath: 'codex' } } : {}),
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    preferences: { messageReply: 'card', ...(opts.model ? { model: opts.model } : {}) },
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
    if (!opts.gate) return run;
    const inner = run.events;
    const gate = opts.gate;
    return Object.assign(Object.create(Object.getPrototypeOf(run)), run, {
      stop: () => run.stop(),
      waitForExit: (ms: number) => run.waitForExit(ms),
      events: (async function* () {
        await gate;
        yield* inner;
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
    async stream(_chatId: string, input: StreamInput) {
      h.order.push('card-open');
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


function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

const answer = (text: string): AgentEvent[] =>
  [{ type: 'text', delta: text }, { type: 'done', terminationReason: 'normal' }] as AgentEvent[];

describe('f0.3.4 latency: early reaction + early card', () => {
  it('f034-#3/#4 (f0.3.5: card replaces the reaction) the ☤aiduCATing… card (with model logo) goes out before the agent says anything', async () => {
    const g = gate();
    const h = await setup({ events: answer('FINAL_SENTINEL'), gate: g.promise, model: 'Gemini-3.8-Flash' });
    await h.handlers.message?.(message('om_a', 'hi'));
    await waitFor(() => h.order.includes('card-open'));
    // nothing from the agent yet, but the user already sees the card — and
    // since f0.3.5 it is the only cue (no reaction in card mode)
    expect(h.order.indexOf('card-open')).toBe(0);
    expect(h.reactions.added).toEqual([]);
    const first = h.updates[0];
    expect(summaryOf(first)).toBe('☤aiduCATing…');
    const firstJson = JSON.stringify(first);
    expect(firstJson).toContain('☤aiduCATing…');
    expect(firstJson).toContain('Gemini-3.8-Flash');
    expect(firstJson).toContain('custom_icon');
    expect(firstJson).not.toContain('FINAL_SENTINEL');
    expect(h.sent).toHaveLength(0);

    g.open();
    await waitFor(() => summaryOf(h.updates.at(-1)) === '✅Done');
    await settle();
    // same single card carries the answer; nothing sent separately
    expect(JSON.stringify(h.updates.at(-1))).toContain('FINAL_SENTINEL');
    expect(h.order.filter((o) => o === 'card-open')).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
    expect(h.recalled).toHaveLength(0);
    expect(h.reactions.added).toHaveLength(0);
  });

  it('f034-#3 (f0.3.5) card mode never calls the reaction API, even when it is slow or down', async () => {
    const h = await setup({ events: answer('OK_SENTINEL'), failReaction: true, addReactionDelayMs: 300 });
    await h.handlers.message?.(message('om_b', 'hi'));
    await waitFor(() => summaryOf(h.updates.at(-1)) === '✅Done');
    expect(h.order).not.toContain('reaction');
    expect(JSON.stringify(h.updates.at(-1))).toContain('OK_SENTINEL');
    expect(h.reactions.removed).toHaveLength(0);
  });

  it('f034-#4 empty-run guard still shows its error on the (early) card, not recalled', async () => {
    const h = await setup({ events: [{ type: 'done', terminationReason: 'normal' }] as AgentEvent[] });
    await h.handlers.message?.(message('om_c', 'hi'));
    await waitFor(() => summaryOf(h.updates.at(-1)) === '❌Error');
    await settle();
    expect(h.order.filter((o) => o === 'card-open')).toHaveLength(1);
    expect(h.recalled).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(h.reactions.added).toHaveLength(0);
  });

  it('f034-#4 a stopped run ends on the same early card as ⭕️Stop (no second message)', async () => {
    const h = await setup({
      events: [{ type: 'done', terminationReason: 'interrupted' }] as AgentEvent[],
    });
    await h.handlers.message?.(message('om_d', 'hi'));
    await waitFor(() => summaryOf(h.updates.at(-1)) !== '☤Thinking…' && h.updates.length >= 2);
    await settle();
    expect(summaryOf(h.updates.at(-1))).toBe('⭕️Stop');
    expect(h.order.filter((o) => o === 'card-open')).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
  });

  it('f034-#4 long answers still continue as 续 cards after the early card', async () => {
    const long = longChinese() + '\n\nTAIL_SENTINEL';
    const g = gate();
    const h = await setup({ events: answer(long), gate: g.promise });
    await h.handlers.message?.(message('om_e', 'hi'));
    await waitFor(() => h.order.includes('card-open'));
    g.open();
    await waitFor(() => h.sent.some((s) => JSON.stringify(s.content).includes('TAIL_SENTINEL')));
    await settle();
    const conts = h.sent.filter((s) => 'card' in s.content);
    expect(conts.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(conts[0]!.content)).toContain('续 2/');
    expect(textSends(h)).toHaveLength(0);
  });

  it('f034-#4 initial card rejected → answer still arrives (degrade path unchanged)', async () => {
    const h = await setup({
      events: answer('DEGRADE_SENTINEL'),
      failInitial: feishuError(200800, 'create universal card fail'),
      send: async (content, n) => {
        if ('card' in content) throw feishuError(200800, 'create universal card fail');
        return { messageId: `sent_${n}` };
      },
    });
    await h.handlers.message?.(message('om_f', 'hi'));
    await waitFor(() => textSends(h).some((t) => t.includes('DEGRADE_SENTINEL')));
  });

  it('f034-#4 codex keeps the lazy open: no card before content', async () => {
    const g = gate();
    const h = await setup({ events: answer('CODEX_SENTINEL'), gate: g.promise, agentKind: 'codex' });
    await h.handlers.message?.(message('om_g', 'hi'));
    await waitFor(() => h.order.includes('agent-run'));
    await settle();
    expect(h.order).not.toContain('card-open');
    expect(h.reactions.added).toEqual(['om_g']);
    g.open();
    await waitFor(() => JSON.stringify([h.updates, h.sent]).includes('CODEX_SENTINEL'));
  });

  it('f034-#7 the latency trail is logged in ms: intake enter → early card (f0.3.5) → flush start → card adopted', async () => {
    const info = vi.spyOn(log, 'info');
    const h = await setup({ events: answer('TRAIL_SENTINEL') });
    const m = message('om_t', 'hi');
    (m as { createTime: number }).createTime = Date.now() - 1000;
    await h.handlers.message?.(m);
    await waitFor(() => summaryOf(h.updates.at(-1)) === '✅Done');
    const find = (phase: string, event: string) =>
      info.mock.calls.find((c) => c[0] === phase && c[1] === event)?.[2] as Record<string, number> | undefined;
    const enter = find('intake', 'enter');
    const flush = find('flush', 'start');
    const early = find('outbound', 'early-card-open');
    const open = find('outbound', 'progress-stream-open');
    for (const f of [enter, early, flush, open]) {
      expect(typeof f?.atMs).toBe('number');
      expect(f!.sinceMsgMs!).toBeGreaterThanOrEqual(1000);
    }
    expect(find('reaction', 'added')).toBeUndefined();
    expect(enter!.atMs!).toBeLessThanOrEqual(early!.atMs!);
    // the card is up before the debounce even ends
    expect(early!.atMs!).toBeLessThanOrEqual(flush!.atMs!);
    expect(flush!.atMs!).toBeLessThanOrEqual(open!.atMs!);
  });

  it('f034-#1/#2 a round never fetches /v1/models (combos only, never awaited)', async () => {
    const prevUrl = process.env.AIDU_10ROUTER_URL;
    const prevTok = process.env.AIDU_10ROUTER_TOKEN;
    process.env.AIDU_10ROUTER_URL = 'https://router.example';
    process.env.AIDU_10ROUTER_TOKEN = 'tok-test';
    const urls: string[] = [];
    // combos hang forever: the round must not care
    vi.stubGlobal('fetch', vi.fn((u: string) => {
      urls.push(String(u));
      return new Promise<Response>(() => {});
    }));
    try {
      const h = await setup({ events: answer('NOFETCH_SENTINEL'), model: 'Gemini-3.8-Flash' });
      await h.handlers.message?.(message('om_h', 'hi'));
      await waitFor(() => summaryOf(h.updates.at(-1)) === '✅Done');
      expect(urls.some((u) => u.includes('/v1/models'))).toBe(false);
      expect(urls.length).toBeGreaterThanOrEqual(1); // startup prewarm ran
      expect(urls.every((u) => u.endsWith('/api/combos'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.AIDU_10ROUTER_URL;
      else process.env.AIDU_10ROUTER_URL = prevUrl;
      if (prevTok === undefined) delete process.env.AIDU_10ROUTER_TOKEN;
      else process.env.AIDU_10ROUTER_TOKEN = prevTok;
    }
  });
});
