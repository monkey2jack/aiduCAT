import { LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';

// f0.3.1 #3: @larksuite/channel 0.6.0 fires throttled card patches from a bare
// `setTimeout(() => this.doFire())`. A rejected patch (Feishu 230099/200570,
// a markdown image without img_key) had no catcher and surfaced as a process
// level unhandledRejection — 76 of them in production. The pnpm patch in
// patches/@larksuite__channel@0.6.0.patch routes that failure to the stream
// controller (`lastPatchError`) and lets the terminal flush still reject so
// aiduCAT's degrade chain runs.

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  unhandled.length = 0;
});

function feishuError(code: number): Error {
  return Object.assign(new Error(`Request failed: ${code}`), {
    response: { data: { code, msg: 'card content invalid' } },
  });
}

function makeChannel(patchCard: (messageId: string, card: unknown) => Promise<void>) {
  const channel = new LarkChannel({
    appId: 'cli_test',
    appSecret: 'not-a-secret',
    outbound: { streamThrottleMs: 10 },
  } as never);
  const sender = (channel as unknown as { sender: Record<string, unknown> }).sender;
  sender.sendOneWithFallback = async () => 'om_stream_card';
  sender.patchCard = patchCard;
  return channel;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('SDK card stream throttled patch failures (f031-#3)', () => {
  it('f031-#3 a failing throttled patch never becomes an unhandled rejection and is visible on the controller', async () => {
    process.on('unhandledRejection', onUnhandled);
    const err = feishuError(230099);
    let patches = 0;
    const channel = makeChannel(async () => {
      patches++;
      throw err;
    });
    const seen: unknown[] = [];

    const result = channel.stream('oc_chat', {
      card: {
        initial: { schema: '2.0', body: { elements: [] } },
        producer: async (ctrl) => {
          await ctrl.update({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'a' }] } });
          await sleep(60);
          seen.push((ctrl as unknown as { lastPatchError?: unknown }).lastPatchError);
          await ctrl.update({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'b' }] } });
          await sleep(60);
        },
      },
    });

    // The terminal flush still fails loudly so the caller can degrade.
    await expect(result).rejects.toBe(err);
    // Let any stray timer-driven rejection reach the process handler.
    await sleep(50);

    expect(patches).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toBe(err);
    expect(unhandled).toEqual([]);
  });

  it('f031-#3 a later successful patch clears lastPatchError', async () => {
    process.on('unhandledRejection', onUnhandled);
    let fail = true;
    const channel = makeChannel(async () => {
      if (fail) {
        fail = false;
        throw feishuError(230020);
      }
    });
    let after: unknown = 'unset';
    await channel.stream('oc_chat', {
      card: {
        initial: { schema: '2.0', body: { elements: [] } },
        producer: async (ctrl) => {
          await ctrl.update({ n: 1 });
          await sleep(40);
          await ctrl.update({ n: 2 });
          await sleep(40);
          after = (ctrl as unknown as { lastPatchError?: unknown }).lastPatchError;
        },
      },
    });
    expect(after).toBeUndefined();
    expect(unhandled).toEqual([]);
  });
});
