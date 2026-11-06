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

// f0.3.5: groups get the same streaming card (with its panel) as DMs —
// upstream forced groups to markdown (post), so no card / panel / early
// ☤Thinking… (winter 2026-11-02 01:44). Plus the turn TPS on the card and in
// /status. Harness copied from f034-latency.

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
}): Promise<Harness> {
  const tmp = await createTmpProfile('f035-group-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: opts.agentKind ?? 'claude',
    ...(opts.agentKind === 'codex' ? { codex: { binaryPath: 'codex' } } : {}),
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'], allowedChats: ['oc_grp'], requireMentionInGroup: true },
    preferences: {
      messageReply: 'card',
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

const panelOf = (card: unknown): string => {
  // the aiduCAT panel is the collapsible_panel element; return its JSON
  const json = JSON.stringify(card);
  const i = json.indexOf('collapsible_panel');
  return i < 0 ? '' : json.slice(i);
};

const workEvents = (answerText: string): AgentEvent[] =>
  [
    { type: 'system', sessionId: 'sess-g', model: 'aiduPARK' },
    { type: 'thinking', delta: '想一想' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    { type: 'usage', inputTokens: 10, outputTokens: 40, cachedInputTokens: 1000, callFinal: true },
    { type: 'tool_result', id: 't1', output: 'ok', isError: false },
    { type: 'text', delta: answerText },
    { type: 'usage', inputTokens: 12, outputTokens: 60, cachedInputTokens: 1100, callFinal: true },
    { type: 'usage', inputTokens: 22, outputTokens: 100, cachedInputTokens: 2100, cumulative: true },
    { type: 'done', sessionId: 'sess-g', terminationReason: 'normal' },
  ] as AgentEvent[];

describe('f0.3.5 group chats get the same panel card as DMs', () => {
  it('f035-group a group @mention streams a card (☤aiduCATing… first, panel, ✅Completed) — no markdown/post', async () => {
    const g = gate();
    const h = await setup({ events: workEvents('GROUP_ANSWER'), gate: g.promise, model: 'aiduPARK' });
    const info = vi.spyOn(log, 'info');
    await h.handlers.message?.(message('om_g1', '@Bridge hi', 'group'));
    await waitFor(() => h.order.includes('card-open'));
    expect(summaryOf(h.updates[0])).toBe('☤aiduCATing…');
    g.open();
    await waitFor(() => summaryOf(h.updates.at(-1)) === '✅Completed');
    await settle();
    const last = h.updates.at(-1);
    expect(JSON.stringify(last)).toContain('GROUP_ANSWER');
    const panel = panelOf(last);
    expect(panel).not.toBe('');
    expect(panel).toContain('💭 1');
    expect(panel).toContain('aiduPARK');
    // nothing went out as a markdown/post message
    expect(h.sent.filter((s) => 'markdown' in s.content)).toHaveLength(0);
    const modeLog = info.mock.calls.find((c) => c[1] === 'reply-mode');
    expect(modeLog?.[2]).toMatchObject({ mode: 'card', chatType: 'group' });
  });

  it('f035-group tool lines stay hidden in groups by default (f031-sec-#4), the panel itself stays', async () => {
    const h = await setup({ events: workEvents('A') });
    await h.handlers.message?.(message('om_g2', '@Bridge hi', 'group'));
    await waitFor(() => summaryOf(h.updates.at(-1)) === '✅Completed');
    const panel = panelOf(h.updates.at(-1));
    expect(panel).toContain('🛠️ 0');
    expect(panel).not.toContain('Bash');
  });

  it('f035-group showToolCallsInGroups=true shows the tools exactly like a DM', async () => {
    const hg = await setup({ events: workEvents('A'), showToolCallsInGroups: true });
    await hg.handlers.message?.(message('om_g3', '@Bridge hi', 'group'));
    await waitFor(() => summaryOf(hg.updates.at(-1)) === '✅Completed');
    const hd = await setup({ events: workEvents('A') });
    await hd.handlers.message?.(message('om_d3', 'hi'));
    await waitFor(() => summaryOf(hd.updates.at(-1)) === '✅Completed');
    expect(panelOf(hg.updates.at(-1))).toContain('🛠️ 1');
    expect(panelOf(hd.updates.at(-1))).toContain('🛠️ 1');
  });

  it('f035-group the card keeps a person @mention the agent wrote (<at user_id> → <at id>)', async () => {
    const h = await setup({ events: answer('请 <at user_id="ou_abc123">小明</at> 看一下') });
    await h.handlers.message?.(message('om_g4', '@Bridge hi', 'group'));
    await waitFor(() => summaryOf(h.updates.at(-1)) === '✅Completed');
    const json = JSON.stringify(h.updates.at(-1));
    expect(json).toContain('<at id=ou_abc123></at>');
    expect(json).not.toContain('user_id');
  });
});

describe('f0.3.5 turn TPS in /status (f0.3.6: not on the card)', () => {
  it('f035-tps a finished turn feeds the session average; f036: the card shows no ⚡ tok/s', async () => {
    const h = await setup({ events: workEvents('TPS_ANSWER'), stepMs: 60 });
    const info = vi.spyOn(log, 'info');
    await h.handlers.message?.(message('om_t1', 'hi'));
    await waitFor(() => summaryOf(h.updates.at(-1)) === '✅Completed');
    await settle();
    const tpsLog = info.mock.calls.find((c) => c[1] === 'turn-tps')?.[2] as
      | { outTok: number; genMs: number; tps: number | null }
      | undefined;
    expect(tpsLog).toBeDefined();
    // main-line per-call finals 40 + 60 = 100 (== the turn total)
    expect(tpsLog!.outTok).toBe(100);
    // the Bash window (tool_use → tool_result) is not generation time
    expect(tpsLog!.genMs).toBeGreaterThanOrEqual(200);
    expect(tpsLog!.tps).toBe(Math.round(100 / (tpsLog!.genMs / 1000)));
    // f0.3.6 (Wei): TPS only in /status — never on the card.
    expect(JSON.stringify(h.updates)).not.toContain('tok/s');
    expect(panelOf(h.updates.at(-1))).toContain('🛠️ 1');
    const st = h.sessions.getRaw('oc_dm')?.stats;
    expect(st?.genOut).toBe(100);
    expect(st?.genMs).toBe(tpsLog!.genMs);
    expect(st?.tpsAvg).toBe(tpsLog!.tps);
    // 📤 still counts the whole-turn output
    expect(st?.tokensOut).toBe(100);
  });

  it('f035-tps an interrupted turn shows no ⚡ and does not touch the average', async () => {
    const h = await setup({
      events: [
        { type: 'text', delta: 'x' },
        { type: 'usage', outputTokens: 50, callFinal: true },
        { type: 'done', terminationReason: 'interrupted' },
      ] as AgentEvent[],
      stepMs: 60,
    });
    await h.handlers.message?.(message('om_t2', 'hi'));
    await waitFor(() => summaryOf(h.updates.at(-1)) === '⭕️Stopped');
    await settle();
    expect(JSON.stringify(h.updates.at(-1))).not.toContain('tok/s');
    expect(h.sessions.getRaw('oc_dm')?.stats?.tpsAvg).toBeUndefined();
  });
});
