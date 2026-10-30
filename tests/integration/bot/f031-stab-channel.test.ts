import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { setupStabChannel, stabSdkMock, type StabHarness } from '../../helpers/stab-channel-harness.js';

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
