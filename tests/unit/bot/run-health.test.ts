import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { RunHealthMonitor } from '../../../src/bot/run-health.js';
import type { AgentKind } from '../../../src/config/profile-schema.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import {
  dmMessage, setupStabChannel, stabSdkMock, summaryOf, waitFor, type StabHarness,
} from '../../helpers/stab-channel-harness.js';

vi.mock('@larksuite/channel', async (orig) => ({
  ...(await orig<typeof import('@larksuite/channel')>()),
  createLarkChannel: (o: unknown) =>
    (globalThis as { __stabSdkMock?: { createLarkChannel(o: unknown): unknown } })
      .__stabSdkMock!.createLarkChannel(o),
}));

const harnesses: StabHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.disconnect();
    await h.tmp.cleanup();
  }
  stabSdkMock.channel = undefined;
});

const RAW_ERROR = 'MISSING_CREDENTIAL secret-value';
const failed: AgentEvent = { type: 'error', message: RAW_ERROR, terminationReason: 'failed' };

async function start(agentKind: AgentKind, owner: string) {
  const h = await setupStabChannel({
    agent: new FakeAgentAdapter({ id: agentKind }),
    botOwnerId: owner,
    configPatch: (cfg) => ({ ...cfg, agentKind }),
  });
  harnesses.push(h);
  return h;
}

async function run(h: StabHarness, events: AgentEvent[], summary = '❌Failed') {
  const chatId = `oc_health_private_${h.agent.runs.length}`;
  const previous = h.updates.length;
  h.agent.setEvents(events);
  await h.handlers.message?.(dmMessage(`om_${chatId}`, 'hello', { chatId }));
  await waitFor(() => h.updates.slice(previous).some((card) => summaryOf(card) === summary) ||
    h.sent.some((sent) => sent.chatId === chatId && summaryOf(sent.content.card) === summary));
}

const notices = (h: StabHarness) => h.sent.filter(({ content }) =>
  typeof content.text === 'string' && content.text.includes('连续失败'),
);

describe('RunHealthMonitor', () => {
  it('stays quiet below the default threshold then emits only the fixed diagnostic text', () => {
    const m = new RunHealthMonitor();
    expect(m.recordFailure()).toMatchObject({ notify: false, reason: 'counting' });
    expect(m.recordFailure()).toMatchObject({ notify: false, reason: 'counting' });
    expect(m.recordFailure()).toEqual({
      notify: true,
      consecutiveFailures: 3,
      message: '⚠️ aiduCAT DSH 连续失败 3 轮，桥接可能已不可用。\n' +
        '排查：发 `/doctor` 看自检，或查看服务日志 winsw2.out.log / bridge-*.jsonl。',
    });
  });

  it('enforces the default cooldown, including when the first notice occurs at time zero', () => {
    let now = 0;
    const m = new RunHealthMonitor({ threshold: 1, now: () => now });
    expect(m.recordFailure().notify).toBe(true);
    now = 30 * 60_000 - 1;
    expect(m.recordFailure()).toMatchObject({ notify: false, reason: 'cooldown' });
    now++;
    expect(m.recordFailure().notify).toBe(true);
  });

  it('a success resets its streak without resetting cooldown', () => {
    const m = new RunHealthMonitor({ threshold: 2 });
    m.recordFailure();
    expect(m.recordFailure().notify).toBe(true);
    expect(m.recordSuccess()).toMatchObject({ notify: false, consecutiveFailures: 0 });
    expect(m.recordFailure()).toMatchObject({ notify: false, reason: 'counting' });
    expect(m.recordFailure()).toMatchObject({ notify: false, reason: 'cooldown' });
  });
});

describe('channel run-health alerts', () => {
  it('keeps DSH streaks, cooldowns and recipients independent and omits private details', async () => {
    const a = await start('dsh', 'ou_owner_a');
    const b = await start('dsh', 'ou_owner_b');
    for (let i = 0; i < 2; i++) await Promise.all([run(a, [failed]), run(b, [failed])]);
    expect(notices(a)).toHaveLength(0);
    expect(notices(b)).toHaveLength(0);

    await run(a, [failed]);
    expect(notices(b)).toHaveLength(0);
    await run(b, [failed]);
    for (const [h, owner] of [[a, 'ou_owner_a'], [b, 'ou_owner_b']] as const) {
      expect(notices(h)).toHaveLength(1);
      const { chatId, content } = notices(h)[0]!;
      expect(chatId).toBe(owner);
      expect(content.text).toContain('DSH 连续失败 3 轮');
      expect(content.text).not.toContain(RAW_ERROR);
      expect(content.text).not.toContain('oc_health_private_');
    }
  }, 10_000);

  it.each<AgentKind>(['claude', 'codex', 'hermes'])('%s failures do not alert', async (kind) => {
    const h = await start(kind, 'ou_owner');
    for (let i = 0; i < 3; i++) await run(h, [failed]);
    expect(notices(h)).toHaveLength(0);
  });
});
