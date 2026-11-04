import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { log } from '../../../src/core/logger.js';
import { dmMessage, settle, setupStabChannel, waitFor, stabSdkMock, type StabHarness } from '../../helpers/stab-channel-harness.js';

vi.mock('@larksuite/channel', async (orig) => ({
  ...(await orig<typeof import('@larksuite/channel')>()),
  createLarkChannel: (o: unknown) =>
    (globalThis as { __stabSdkMock?: { createLarkChannel(o: unknown): unknown } }).__stabSdkMock!.createLarkChannel(o),
}));

vi.setConfig({ testTimeout: 20_000 });

const harnesses: StabHarness[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) {
    await h.disconnect();
    await h.tmp.cleanup();
  }
  stabSdkMock.channel = undefined;
  stabSdkMock.createLarkChannel.mockClear();
});

async function start(opts: Parameters<typeof setupStabChannel>[0]): Promise<StabHarness> {
  const h = await setupStabChannel(opts);
  harnesses.push(h);
  return h;
}

const doneOnly = [{ type: 'text', delta: 'ok' }, { type: 'done', terminationReason: 'normal' }] as AgentEvent[];

function sdkOpts(): Record<string, unknown> {
  return stabSdkMock.createLarkChannel.mock.calls[0]![0] as Record<string, unknown>;
}

describe('f031-stab channel connection options', () => {
  it('f031-stab-#1 keeps the 8s force-reconnect budget on SDK 0.7.x (connectTimeoutMs)', async () => {
    await start({ events: doneOnly });
    expect(sdkOpts().connectTimeoutMs).toBe(8_000);
    expect(sdkOpts().handshakeTimeoutMs).toBe(8_000);
  });

  it('f031-stab-#2 pingTimeout is no longer the 3s hair-trigger (upstream #252)', async () => {
    await start({ events: doneOnly });
    const ws = sdkOpts().wsConfig as { pingTimeout: number };
    expect(ws.pingTimeout).toBe(20);
  });
});

describe('f031-stab-#4 watchdog defaults reach the run', () => {
  it('f031-stab-#4 a run with no timeout configured gets idle 15min + tool cap 30min', async () => {
    const info = vi.spyOn(log, 'info');
    const h = await start({ events: doneOnly });
    await h.handlers.message?.(dmMessage('om_wd', 'hi'));
    await waitFor(() => info.mock.calls.some((c) => c[0] === 'flush' && c[1] === 'idle-watchdog'));
    const call = info.mock.calls.find((c) => c[0] === 'flush' && c[1] === 'idle-watchdog')!;
    expect(call[2]).toMatchObject({ idleTimeoutMs: 15 * 60_000, toolTimeoutMs: 30 * 60_000 });
  });
});

// ---------------------------------------------------------------------------
// f031-stab-#5: restart recovery (in-flight cards + queued messages on disk)
// ---------------------------------------------------------------------------
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTmpProfile } from '../../helpers/tmp-profile.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';

function journalPath(h: StabHarness): string {
  return join(h.tmp.profile, 'run-journal.json');
}

describe('f031-stab-#5 restart recovery', () => {
  it('f031-stab-#5 an in-flight card left by the previous process is closed as "服务重启，请重发"', async () => {
    const tmp = await createTmpProfile('stab-restart-');
    await writeFile(
      join(tmp.profile, 'run-journal.json'),
      JSON.stringify({
        v: 1,
        inflight: {
          oc_dm: { runKey: 'k1', chatId: 'oc_dm', replyTo: 'om_old', cardMessageId: 'om_card_old', startedAt: Date.now() - 5_000 },
          oc_md: { runKey: 'k2', chatId: 'oc_md', replyTo: 'om_old2', startedAt: Date.now() - 5_000 },
        },
        queued: {},
      }),
    );
    const h = await start({ tmp, withAppPaths: true, events: doneOnly });
    await waitFor(() => h.updateCardCalls.length >= 1 && h.sent.length >= 1);
    const patched = h.updateCardCalls.find((c) => c.messageId === 'om_card_old');
    expect(patched).toBeDefined();
    expect(JSON.stringify(patched!.card)).toContain('服务重启');
    expect(JSON.stringify(patched!.card)).toContain('请重发');
    // no card yet (markdown/text mode, or died before the card opened) → a text notice
    const notice = h.sent.find((s) => s.chatId === 'oc_md');
    expect(String(notice?.content.text ?? '')).toContain('服务重启');
    expect(notice?.options).toMatchObject({ replyTo: 'om_old2' });
    // handled → gone from the journal
    await h.disconnect();
    const after = JSON.parse(await readFile(join(tmp.profile, 'run-journal.json'), 'utf8'));
    expect(after.inflight).toEqual({});
    harnesses.splice(harnesses.indexOf(h), 1);
    await tmp.cleanup();
  });

  it('f031-stab-#5 fresh queued messages are re-queued and answered; stale ones get an explicit 请重发', async () => {
    const tmp = await createTmpProfile('stab-restart-');
    const msg = (id: string, chatId: string, content: string) => ({
      messageId: id, chatId, chatType: 'p2p', senderId: 'ou_user', senderName: 'User', content,
      rawContentType: 'text', resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: Date.now(),
    });
    await writeFile(
      join(tmp.profile, 'run-journal.json'),
      JSON.stringify({
        v: 1,
        inflight: {},
        queued: {
          oc_dm: [{ storedAt: Date.now() - 2_000, msg: msg('om_q1', 'oc_dm', 'REPLAY_SENTINEL 问题') }],
          oc_old: [{ storedAt: Date.now() - 3 * 3_600_000, msg: msg('om_q2', 'oc_old', 'too old') }],
        },
      }),
    );
    const agent = new FakeAgentAdapter({ id: 'claude', displayName: 'Claude', events: doneOnly });
    const h = await start({ tmp, withAppPaths: true, agent });
    await waitFor(() => agent.runOptions.length >= 1 && h.sent.some((s) => s.chatId === 'oc_old'));
    expect(agent.runOptions[0]!.prompt).toContain('REPLAY_SENTINEL');
    expect(agent.runOptions.some((o) => o.prompt.includes('too old'))).toBe(false);
    const stale = h.sent.find((s) => s.chatId === 'oc_old')!;
    expect(String(stale.content.text)).toContain('请重发');
    harnesses.splice(harnesses.indexOf(h), 1);
    await h.disconnect();
    await tmp.cleanup();
  });

  it('f031-stab-#5 queued messages and the in-flight card are on disk (0600) while a run is going, and cleared after', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let paused = false;
    const h = await start({
      withAppPaths: true,
      events: [doneOnly, doneOnly],
      onUpdate: async () => {
        if (!paused) {
          paused = true;
          await gate;
        }
      },
    });
    await h.handlers.message?.(dmMessage('om_a', 'first'));
    await waitFor(() => paused);
    await h.handlers.message?.(dmMessage('om_b', 'QUEUED_SENTINEL'));
    // CI flake (2026-11-04, ubuntu runner): a fixed 200ms was not always
    // enough for the journal write — poll until both entries are on disk.
    let during: { inflight: Record<string, unknown>; queued: unknown } = { inflight: {}, queued: {} };
    for (let i = 0; i < 50; i++) {
      try {
        during = JSON.parse(await readFile(journalPath(h), 'utf8'));
      } catch {
        // not written yet
      }
      if (during.inflight?.oc_dm && JSON.stringify(during.queued).includes('QUEUED_SENTINEL')) break;
      await settle(100);
    }
    expect(during.inflight.oc_dm).toMatchObject({ chatId: 'oc_dm', cardMessageId: 'om_stream_1' });
    expect(JSON.stringify(during.queued)).toContain('QUEUED_SENTINEL');
    expect((await stat(journalPath(h))).mode & 0o777).toBe(0o600);
    release();
    await waitFor(() => h.agent.runOptions.length >= 2);
    await settle(400);
    await settle(300);
    const after = JSON.parse(await readFile(journalPath(h), 'utf8'));
    expect(after).toMatchObject({ inflight: {}, queued: {} });
  });
});

// ---------------------------------------------------------------------------
// f031-stab-#6 upstream #299 / #183: answer must survive a failed streaming
// update. Card mode is covered by the f0.3.1 degrade chain
// (card-stream-failure.test.ts); this checks the markdown path (group chats
// reply in markdown) with the same upstream scenario.
// ---------------------------------------------------------------------------
describe('f031-stab-#6-299 markdown stream update fails mid-run', () => {
  it('f031-stab-#6-299 the full answer still arrives when a markdown update fails mid-run', async () => {
    const events = [
      { type: 'text', delta: 'part one. ' },
      { type: 'text', delta: 'part two ANSWER_END' },
      { type: 'done', terminationReason: 'normal' },
    ] as AgentEvent[];
    const h = await start({
      events,
      configPatch: (cfg) => ({ ...cfg, preferences: { ...(cfg.preferences as object), messageReply: 'markdown' } }),
      markdownSetContent: (_md, n) => {
        if (n === 2) throw Object.assign(new Error('Request failed with status code 400'), { response: { data: { code: 230020 } } });
      },
    });
    await h.handlers.message?.(dmMessage('om_md', 'hi'));
    await waitFor(() => h.sent.some((s) => JSON.stringify(s.content).includes('ANSWER_END')), 8000);
  });

  it('f031-stab-#6-299 the answer arrives as a message when the final markdown flush is rejected', async () => {
    const events = [
      { type: 'text', delta: 'FINAL_FLUSH_ANSWER' },
      { type: 'done', terminationReason: 'normal' },
    ] as AgentEvent[];
    const h = await start({
      events,
      configPatch: (cfg) => ({ ...cfg, preferences: { ...(cfg.preferences as object), messageReply: 'markdown' } }),
      markdownFailTerminal: Object.assign(new Error('Request failed with status code 400'), { response: { data: { code: 230099 } } }),
    });
    await h.handlers.message?.(dmMessage('om_md2', 'hi'));
    await waitFor(() => h.sent.some((s) => JSON.stringify(s.content).includes('FINAL_FLUSH_ANSWER')), 8000);
  });
});

// ---------------------------------------------------------------------------
// f031-stab-#16 (audit-quality #16): a pre-run step (attachments, quote, topic
// context, run setup) that throws used to be swallowed by log.fail('flush') —
// Dudu got nothing at all. Now she gets an explicit error reply.
// ---------------------------------------------------------------------------
import { MediaCache } from '../../../src/media/cache.js';

describe('f031-stab-#16 pre-run failures reach the user', () => {
  it('f031-stab-#16 attachment step throws → explicit error reply, no agent run', async () => {
    vi.spyOn(MediaCache.prototype, 'resolve').mockRejectedValue(new Error('ENOSPC: no space left on device'));
    // f0.4 之后的修复 (bwrap): the owner's private chat keeps the reason …
    const h = await start({ events: doneOnly, botOwnerId: 'ou_user' });
    await h.handlers.message?.(dmMessage('om_pre1', '看看这个'));
    await waitFor(() => h.sent.length >= 1);
    const text = String(h.sent[0]!.content.text ?? h.sent[0]!.content.markdown ?? '');
    expect(text).toContain('出错');
    expect(text).toContain('ENOSPC');
    expect(text).toContain('重发');
    expect(h.sent[0]!.options).toMatchObject({ replyTo: 'om_pre1' });
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('f04-bwrap pre-run failure for a non-owner: friendly notice, no raw error', async () => {
    vi.spyOn(MediaCache.prototype, 'resolve').mockRejectedValue(new Error('ENOSPC: no space left on device'));
    const h = await start({ events: doneOnly, botOwnerId: 'ou_someone_else' });
    await h.handlers.message?.(dmMessage('om_pre1b', '看看这个'));
    await waitFor(() => h.sent.length >= 1);
    const text = String(h.sent[0]!.content.text ?? h.sent[0]!.content.markdown ?? '');
    expect(text).toContain('暂时没能处理');
    expect(text).not.toContain('ENOSPC');
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('f031-stab-#16 the scope is not left blocked: the next message runs normally', async () => {
    const spy = vi.spyOn(MediaCache.prototype, 'resolve').mockRejectedValueOnce(new Error('boom'));
    const h = await start({ events: doneOnly });
    await h.handlers.message?.(dmMessage('om_pre2', 'first'));
    await waitFor(() => h.sent.length >= 1);
    spy.mockRestore();
    await h.handlers.message?.(dmMessage('om_pre3', 'second'));
    await waitFor(() => h.agent.runOptions.length >= 1);
    expect(h.agent.runOptions[0]!.prompt).toContain('second');
  });
});
