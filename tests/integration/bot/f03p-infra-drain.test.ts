import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { getShutdownDrainMs } from '../../../src/config/schema.js';
import { buildUnit } from '../../../src/daemon/systemd.js';
import { buildPlist } from '../../../src/daemon/launchd.js';
import { dmMessage, settle, setupStabChannel, stabSdkMock, waitFor, type StabHarness } from '../../helpers/stab-channel-harness.js';

vi.mock('@larksuite/channel', async (orig) => ({
  ...(await orig<typeof import('@larksuite/channel')>()),
  createLarkChannel: (o: unknown) =>
    (globalThis as { __stabSdkMock?: { createLarkChannel(o: unknown): unknown } }).__stabSdkMock!.createLarkChannel(o),
}));
vi.setConfig({ testTimeout: 20_000 });

const harnesses: StabHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.disconnect().catch(() => undefined);
    await h.tmp.cleanup();
  }
  stabSdkMock.channel = undefined;
});

const doneOnly = [{ type: 'text', delta: 'ok' }, { type: 'done', terminationReason: 'normal' }] as AgentEvent[];

async function gated(): Promise<{ h: StabHarness; release: () => void; paused: () => boolean }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let isPaused = false;
  const h = await setupStabChannel({
    withAppPaths: true,
    events: [doneOnly, doneOnly, doneOnly],
    onUpdate: async () => {
      if (!isPaused) {
        isPaused = true;
        await gate;
      }
    },
  });
  harnesses.push(h);
  return { h, release, paused: () => isPaused };
}

describe('f03p-infra-#5 graceful shutdown: drain in-flight rounds before stopping', () => {
  it('f03p-infra-#5 PendingQueue.freeze(): queued messages stay queued, nothing flushes', async () => {
    const flushed: string[] = [];
    const q = new PendingQueue(20, (scope) => flushed.push(scope));
    q.freeze();
    q.push('s', dmMessage('m1', 'a'));
    q.block('t');
    q.unblock('t');
    await settle(80);
    expect(flushed).toEqual([]);
  });

  it('f03p-infra-#5 drain waits for the running round to finish, takes no new round, journals what arrives', async () => {
    const { h, release, paused } = await gated();
    await h.handlers.message?.(dmMessage('om_a', 'first'));
    await waitFor(paused);
    let drainDone: { drained: boolean; remaining: number } | undefined;
    const draining = h.drain(10_000).then((r) => {
      drainDone = r;
    });
    await settle(50);
    // same chat, during drain → queued (journal), plus a one-time notice
    await h.handlers.message?.(dmMessage('om_b', 'DURING_DRAIN_SENTINEL'));
    // another chat during drain → also only queued
    await h.handlers.message?.(dmMessage('om_c', 'OTHER_CHAT', { chatId: 'oc_other' }));
    await settle(800);
    expect(drainDone).toBeUndefined();
    expect(h.agent.runOptions).toHaveLength(1);
    const notices = h.sent.filter((s) => String(s.content.text ?? '').includes('重启'));
    expect(notices.map((n) => n.chatId).sort()).toEqual(['oc_dm', 'oc_other']);
    release();
    await draining;
    expect(drainDone).toEqual({ drained: true, remaining: 0 });
    await settle(800);
    expect(h.agent.runOptions).toHaveLength(1); // nothing new started after the round ended
    await h.disconnect();
    harnesses.splice(harnesses.indexOf(h), 1);
    const journal = JSON.parse(await readFile(join(h.tmp.profile, 'run-journal.json'), 'utf8'));
    expect(journal.inflight).toEqual({});
    expect(JSON.stringify(journal.queued)).toContain('DURING_DRAIN_SENTINEL');
    expect(JSON.stringify(journal.queued)).toContain('OTHER_CHAT');
    expect(typeof journal.closedAt).toBe('number');
    await h.tmp.cleanup();
  });

  it('f03p-infra-#5 drain gives up after the cap; the unfinished round is left in the journal for the next start', async () => {
    const { h, paused } = await gated();
    await h.handlers.message?.(dmMessage('om_a', 'long one'));
    await waitFor(paused);
    const r = await h.drain(300);
    expect(r).toEqual({ drained: false, remaining: 1 });
    await h.disconnect();
    harnesses.splice(harnesses.indexOf(h), 1);
    const journal = JSON.parse(await readFile(join(h.tmp.profile, 'run-journal.json'), 'utf8'));
    expect(Object.keys(journal.inflight)).toEqual(['oc_dm']);
    await h.tmp.cleanup();
  });

  it('f03p-infra-#5 a round killed by the stop signal itself (systemd KillMode=control-group) stays in the journal for auto-continue', async () => {
    const agent = new HoldAgent();
    const h = await setupStabChannel({ withAppPaths: true, agent: agent as never });
    harnesses.push(h);
    await h.handlers.message?.(dmMessage('om_a', 'long one'));
    await waitFor(() => agent.live.length === 1);
    const draining = h.drain(10_000);
    await settle(50);
    agent.live[0]!.killedFromOutside(); // the agent dies from the same SIGTERM → interrupted
    expect(await draining).toEqual({ drained: true, remaining: 0 });
    await h.disconnect();
    harnesses.splice(harnesses.indexOf(h), 1);
    const journal = JSON.parse(await readFile(join(h.tmp.profile, 'run-journal.json'), 'utf8'));
    expect(Object.keys(journal.inflight)).toEqual(['oc_dm']);
    await h.tmp.cleanup();
  });

  it('f03p-infra-#5 a round the user /stops during the drain is NOT continued after the restart', async () => {
    const agent = new HoldAgent();
    const h = await setupStabChannel({ withAppPaths: true, agent: agent as never });
    harnesses.push(h);
    await h.handlers.message?.(dmMessage('om_a', 'long one'));
    await waitFor(() => agent.live.length === 1);
    const draining = h.drain(10_000);
    await settle(50);
    await h.handlers.message?.(dmMessage('om_stop', '/stop'));
    expect((await draining).drained).toBe(true);
    await h.disconnect();
    harnesses.splice(harnesses.indexOf(h), 1);
    const journal = JSON.parse(await readFile(join(h.tmp.profile, 'run-journal.json'), 'utf8'));
    expect(journal.inflight).toEqual({});
    await h.tmp.cleanup();
  });

  it('f03p-infra-#5 a second signal (abort) ends the drain at once', async () => {
    const { h, paused } = await gated();
    await h.handlers.message?.(dmMessage('om_a', 'long one'));
    await waitFor(paused);
    const ac = new AbortController();
    const t0 = Date.now();
    const p = h.drain(60_000, ac.signal);
    setTimeout(() => ac.abort(), 100);
    expect(await p).toEqual({ drained: false, remaining: 1 });
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('f03p-infra-#5 nothing in flight → drain returns at once', async () => {
    const h = await setupStabChannel({ withAppPaths: true, events: doneOnly });
    harnesses.push(h);
    const t0 = Date.now();
    expect(await h.drain(60_000)).toEqual({ drained: true, remaining: 0 });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('f03p-infra-#5 after an orderly shutdown, queued messages are judged by downtime, not by how long they waited in the drain', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { createTmpProfile } = await import('../../helpers/tmp-profile.js');
    const { FakeAgentAdapter } = await import('../../helpers/fake-agent.js');
    const tmp = await createTmpProfile('f03p-replay-');
    const m = { ...dmMessage('om_q', 'WAITED_IN_DRAIN'), createTime: Date.now() };
    await writeFile(
      join(tmp.profile, 'run-journal.json'),
      JSON.stringify({ v: 1, inflight: {}, queued: { oc_dm: [{ storedAt: Date.now() - 15 * 60_000, msg: m }] }, closedAt: Date.now() - 60_000 }),
    );
    const agent = new FakeAgentAdapter({ id: 'claude', displayName: 'Claude', events: doneOnly });
    const h = await setupStabChannel({ tmp, withAppPaths: true, agent });
    harnesses.push(h);
    await waitFor(() => agent.runOptions.length >= 1);
    expect(agent.runOptions[0]!.prompt).toContain('WAITED_IN_DRAIN');
  });

  it('f03p-infra-#5 shutdownDrainMinutes: default 10, 0 = off, clamped to 60', () => {
    expect(getShutdownDrainMs({ preferences: {} } as never)).toBe(10 * 60_000);
    expect(getShutdownDrainMs({ preferences: { shutdownDrainMinutes: 0 } } as never)).toBe(0);
    expect(getShutdownDrainMs({ preferences: { shutdownDrainMinutes: 3 } } as never)).toBe(3 * 60_000);
    expect(getShutdownDrainMs({ preferences: { shutdownDrainMinutes: 999 } } as never)).toBe(60 * 60_000);
  });

  it('f03p-infra-#5 generated service files give the drain room (systemd TimeoutStopSec, launchd ExitTimeOut)', () => {
    const inputs = { nodePath: '/n', bridgeEntryPath: '/b', envPath: '/bin', profile: 'claude', runArgs: ['run'], channelHome: '/h/.aiducat' };
    expect(buildUnit(inputs as never)).toContain('TimeoutStopSec=660');
    expect(buildUnit(inputs as never)).toContain('KillMode=mixed');
    expect(buildPlist(inputs as never)).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>660<\/integer>/);
  });

  it('f03p-infra-#5 SIGTERM path drains (graceful) and a second signal forces exit', async () => {
    const src = await readFile(join(process.cwd(), 'src/cli/commands/start.ts'), 'utf8');
    expect(src).toContain('graceful: true');
    expect(src).toContain('drainAbort.abort()');
  });
});

/** An agent whose run keeps going until stopped (by /stop) or killed from outside. */
class HoldAgent {
  readonly id = 'claude';
  readonly displayName = 'Claude';
  readonly runOptions: unknown[] = [];
  readonly live: Array<{ killedFromOutside(): void }> = [];
  async isAvailable(): Promise<boolean> {
    return true;
  }
  setBotIdentity(): void {}
  run(opts: { runId: string }) {
    this.runOptions.push(opts);
    let end!: () => void;
    const ended = new Promise<void>((r) => {
      end = r;
    });
    this.live.push({ killedFromOutside: () => end() });
    return {
      runId: opts.runId,
      events: (async function* () {
        yield { type: 'text', delta: 'half' } as AgentEvent;
        await ended;
        yield { type: 'done', terminationReason: 'interrupted' } as AgentEvent;
      })(),
      async stop() {
        end();
      },
      async waitForExit() {
        return true;
      },
    };
  }
}
