import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { dmMessage, settle, setupStabChannel, stabSdkMock, waitFor, type StabHarness } from '../../helpers/stab-channel-harness.js';

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

// tenant token succeeds (so a cot attempt really reaches message_cot), message_cot fails.
const fakeFeishuFetch = async (input: unknown): Promise<Response> =>
  String(input).includes('tenant_access_token')
    ? new Response(JSON.stringify({ code: 0, tenant_access_token: 't-fake', expire: 7200 }), { status: 200 })
    : new Response('{}', { status: 500 });

const doneOnly = [{ type: 'text', delta: 'ok' }, { type: 'done', terminationReason: 'normal' }] as AgentEvent[];

describe('f03p-slim channel honours the feature switches', () => {
  it('f03p-slim-#3 meeting.enabled but features.meeting=false: no meeting manager is created', async () => {
    const h = await start({
      events: doneOnly,
      configPatch: (c) => ({ ...c, meeting: { ...(c.meeting as object), enabled: true }, features: { ...(c.features as object), meeting: false } }),
    });
    expect(h.controls.meeting).toBeUndefined();
  });

  it('f03p-slim-#3 meeting.enabled and the switch on (default): the manager is there as before', async () => {
    const h = await start({
      events: doneOnly,
      configPatch: (c) => ({ ...c, meeting: { ...(c.meeting as object), enabled: true } }),
    });
    expect(h.controls.meeting).toBeDefined();
  });

  it('f03p-slim-#4 cot preference on but features.cot=false: no message_cot call, the card still answers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFeishuFetch);
    const h = await start({
      events: doneOnly,
      configPatch: (c) => ({
        ...c,
        preferences: { ...(c.preferences as object), cotMessages: 'detailed' },
        features: { ...(c.features as object), cot: false },
      }),
    });
    await h.handlers.message?.(dmMessage('om_cot_off', 'hi'));
    await waitFor(() => h.updates.length > 0);
    await settle(300);
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('message_cot'))).toBe(false);
  });

  it('f03p-slim-#4 cot on (default switch): the cot path is still tried', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFeishuFetch);
    const h = await start({
      events: doneOnly,
      configPatch: (c) => ({ ...c, preferences: { ...(c.preferences as object), cotMessages: 'detailed' } }),
    });
    await h.handlers.message?.(dmMessage('om_cot_on', 'hi'));
    await waitFor(() => fetchSpy.mock.calls.some((c) => String(c[0]).includes('message_cot')));
  });
});
