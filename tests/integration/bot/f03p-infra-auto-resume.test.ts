import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { dmMessage, settle, setupStabChannel, stabSdkMock, waitFor, type StabHarness } from '../../helpers/stab-channel-harness.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

vi.mock('@larksuite/channel', async (orig) => ({
  ...(await orig<typeof import('@larksuite/channel')>()),
  createLarkChannel: (o: unknown) =>
    (globalThis as { __stabSdkMock?: { createLarkChannel(o: unknown): unknown } }).__stabSdkMock!.createLarkChannel(o),
}));
vi.setConfig({ testTimeout: 20_000 });

// f03p-infra-#6: a round cut off by a restart is continued once, automatically,
// in the same Claude session, if the restart took ≤ 10 minutes.

const harnesses: StabHarness[] = [];
const tmps: TmpProfile[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.disconnect().catch(() => undefined);
  await Promise.all(tmps.splice(0).map((t) => t.cleanup()));
  stabSdkMock.channel = undefined;
});

const doneOnly = [{ type: 'text', delta: 'ok' }, { type: 'done', terminationReason: 'normal' }] as AgentEvent[];

function resumeMsg() {
  const m = dmMessage('om_orig', '');
  return { ...m, createTime: Date.now() - 60_000 };
}

async function boot(opts: {
  inflight: Record<string, unknown>;
  closedAt?: number;
  session?: boolean;
  events?: AgentEvent[] | AgentEvent[][];
}): Promise<{ h: StabHarness; agent: FakeAgentAdapter; tmp: TmpProfile }> {
  const tmp = await createTmpProfile('f03p-resume-');
  tmps.push(tmp);
  const cwd = await realpath(tmp.workspace);
  if (opts.session !== false) {
    await writeFile(join(tmp.profile, 'sessions.json'), JSON.stringify({ oc_dm: { sessionId: 'sess-prev', cwd, updatedAt: Date.now() } }));
  }
  await writeFile(
    join(tmp.profile, 'run-journal.json'),
    JSON.stringify({
      v: 1,
      inflight: { oc_dm: { runKey: 'k-old', chatId: 'oc_dm', replyTo: 'om_orig', cardMessageId: 'om_card_old', startedAt: Date.now() - 90_000, ...opts.inflight } },
      queued: {},
      ...(opts.closedAt !== undefined ? { closedAt: opts.closedAt } : {}),
    }),
  );
  const agent = new FakeAgentAdapter({ id: 'claude', displayName: 'Claude', events: (opts.events ?? doneOnly) as never });
  const h = await setupStabChannel({ tmp, withAppPaths: true, agent });
  harnesses.push(h);
  return { h, agent, tmp };
}

async function journalWithInflight(path: string) {
  // the journal is written asynchronously; wait for the round's entry to land
  for (let i = 0; i < 100; i++) {
    const j = JSON.parse(await readFile(path, 'utf8').catch(() => '{}'));
    if (j.inflight?.oc_dm) return j;
    await settle(20);
  }
  throw new Error('journal entry never appeared');
}

function cardText(h: StabHarness, id: string): string {
  return JSON.stringify(h.updateCardCalls.filter((c) => c.messageId === id).map((c) => c.card));
}

describe('f03p-infra-#6 auto-continue after a restart', () => {
  it('f03p-infra-#6 within 10 min: old card says 服务重启后自动继续 and the same session is resumed once with 接着刚才的继续', async () => {
    const { h, agent } = await boot({ inflight: { resumeMsg: resumeMsg() }, closedAt: Date.now() - 5_000 });
    await waitFor(() => agent.runOptions.length >= 1);
    expect(cardText(h, 'om_card_old')).toContain('服务重启后自动继续');
    expect(cardText(h, 'om_card_old')).not.toContain('请重发');
    const run = agent.runOptions[0]!;
    expect(run.prompt).toContain('服务重启，接着刚才的继续');
    expect(run.sessionId).toBe('sess-prev');
    await settle(500);
    expect(agent.runOptions).toHaveLength(1);
    expect(h.sent.some((s) => String(s.content.text ?? '').includes('请重发'))).toBe(false);
  });

  it('f03p-infra-#6 the resumed round is marked, so a second restart does not loop', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tmp = await createTmpProfile('f03p-resume-');
    tmps.push(tmp);
    const cwd = await realpath(tmp.workspace);
    await writeFile(join(tmp.profile, 'sessions.json'), JSON.stringify({ oc_dm: { sessionId: 'sess-prev', cwd, updatedAt: Date.now() } }));
    await writeFile(
      join(tmp.profile, 'run-journal.json'),
      JSON.stringify({ v: 1, inflight: { oc_dm: { runKey: 'k-old', chatId: 'oc_dm', replyTo: 'om_orig', startedAt: Date.now() - 1_000, resumeMsg: resumeMsg() } }, queued: {}, closedAt: Date.now() - 1_000 }),
    );
    let paused = false;
    const h = await setupStabChannel({
      tmp,
      withAppPaths: true,
      events: [doneOnly],
      onUpdate: async () => {
        if (!paused) {
          paused = true;
          await gate;
        }
      },
    });
    harnesses.push(h);
    await waitFor(() => paused);
    const during = await journalWithInflight(join(tmp.profile, 'run-journal.json'));
    expect(during.inflight.oc_dm.autoResumed).toBe(true);
    expect(JSON.stringify(during.inflight)).not.toContain('服务重启，接着刚才的继续'); // no prompt text kept
    release();
  });

  it('f03p-infra-#6 an already auto-resumed round that is cut off again → 请重发, no second auto-continue', async () => {
    const { h, agent } = await boot({ inflight: { resumeMsg: resumeMsg(), autoResumed: true }, closedAt: Date.now() - 5_000 });
    await waitFor(() => h.updateCardCalls.some((c) => c.messageId === 'om_card_old'));
    expect(cardText(h, 'om_card_old')).toContain('请重发');
    await settle(600);
    expect(agent.runOptions).toHaveLength(0);
  });

  it('f03p-infra-#6 restart took longer than 10 min → 请重发', async () => {
    const { h, agent } = await boot({ inflight: { resumeMsg: resumeMsg() }, closedAt: Date.now() - 11 * 60_000 });
    await waitFor(() => h.updateCardCalls.some((c) => c.messageId === 'om_card_old'));
    expect(cardText(h, 'om_card_old')).toContain('请重发');
    await settle(600);
    expect(agent.runOptions).toHaveLength(0);
  });

  it('f03p-infra-#6 no session to resume → 请重发', async () => {
    const { h, agent } = await boot({ inflight: { resumeMsg: resumeMsg() }, closedAt: Date.now() - 5_000, session: false });
    await waitFor(() => h.updateCardCalls.some((c) => c.messageId === 'om_card_old'));
    expect(cardText(h, 'om_card_old')).toContain('请重发');
    await settle(600);
    expect(agent.runOptions).toHaveLength(0);
  });

  it('f03p-infra-#6 journal from 0.3.1 (no resume info) → 请重发 as before', async () => {
    const { h, agent } = await boot({ inflight: {}, closedAt: Date.now() - 5_000 });
    await waitFor(() => h.updateCardCalls.some((c) => c.messageId === 'om_card_old'));
    expect(cardText(h, 'om_card_old')).toContain('请重发');
    await settle(600);
    expect(agent.runOptions).toHaveLength(0);
  });

  it('f03p-infra-#6 the auto-continue itself fails → one explicit 请重发', async () => {
    const failing = [{ type: 'error', message: 'boom', terminationReason: 'failed' }] as AgentEvent[];
    const { h, agent } = await boot({ inflight: { resumeMsg: resumeMsg() }, closedAt: Date.now() - 5_000, events: [failing] });
    await waitFor(() => agent.runOptions.length >= 1);
    await waitFor(() => h.sent.some((s) => String(s.content.text ?? '').includes('自动继续没成功')));
    const notice = h.sent.find((s) => String(s.content.text ?? '').includes('自动继续没成功'))!;
    expect(String(notice.content.text)).toContain('请重发');
  });

  it('f03p-infra-#6 a normal round journals the resume info without the user text', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let paused = false;
    const h = await setupStabChannel({
      withAppPaths: true,
      events: [doneOnly],
      onUpdate: async () => {
        if (!paused) {
          paused = true;
          await gate;
        }
      },
    });
    harnesses.push(h);
    await h.handlers.message?.(dmMessage('om_x', 'SECRET_USER_TEXT 问题'));
    await waitFor(() => paused);
    const during = await journalWithInflight(join(h.tmp.profile, 'run-journal.json'));
    expect(during.inflight.oc_dm.resumeMsg).toMatchObject({ messageId: 'om_x', chatId: 'oc_dm', senderId: 'ou_user', content: '' });
    expect(during.inflight.oc_dm.autoResumed).toBeUndefined();
    expect(JSON.stringify(during.inflight)).not.toContain('SECRET_USER_TEXT');
    release();
    tmps.push(h.tmp);
  });
});
