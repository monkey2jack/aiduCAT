import { LarkChannel } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';

// f031-stab-#7 (upstream issue #289, unfixed upstream): in markdown reply mode
// (group chats) one failed streaming update set `streamingFailed` forever, so
// the terminal frame — the only one WITHOUT the "🧰 正在调用工具…" footer —
// was silently skipped and the card stayed on the footer after the run had
// finished. Also: setContent() bypassed the 250ms throttle entirely, which is
// what made 230020 rate-limit failures likely in the first place.
// Fixed in patches/@larksuite__channel@0.7.1.patch.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeChannel(update: (content: string, n: number) => Promise<void>, throttleMs = 10) {
  const channel = new LarkChannel({
    appId: 'cli_test',
    appSecret: 'not-a-secret',
    outbound: { streamThrottleMs: throttleMs, streamThrottleChars: Number.MAX_SAFE_INTEGER },
  } as never);
  const sender = (channel as unknown as { sender: Record<string, unknown> }).sender;
  const pushed: string[] = [];
  let n = 0;
  sender.createCardInstance = async () => 'card_1';
  sender.sendCardByReference = async () => 'om_md_1';
  sender.finishStreamingCard = async () => {};
  sender.updateCardElementContent = async (_card: string, _el: string, content: string) => {
    n++;
    pushed.push(content);
    await update(content, n);
  };
  return { channel, pushed };
}

const rateLimited = () =>
  Object.assign(new Error('Request failed with status code 400'), { response: { data: { code: 230020 } } });

describe('f031-stab-#7 markdown stream terminal frame (#289)', () => {
  it('f031-stab-#7 after a mid-stream update failure the final frame (no tool footer) is still pushed', async () => {
    const { channel, pushed } = makeChannel(async (_c, n) => {
      if (n === 1) throw rateLimited();
    });
    await channel.stream('oc_chat', {
      markdown: async (ctrl) => {
        await ctrl.setContent('working\n\n_🧰 正在调用工具…_');
        await sleep(40);
        await ctrl.setContent('working more\n\n_🧰 正在调用工具…_');
        await sleep(40);
        await ctrl.setContent('FINAL ANSWER');
      },
    });
    expect(pushed.at(-1)).toBe('FINAL ANSWER');
  });

  it('f031-stab-#7 if the final frame cannot be delivered either, the stream rejects so aiduCAT can degrade', async () => {
    const { channel } = makeChannel(async () => {
      throw rateLimited();
    });
    const result = channel.stream('oc_chat', {
      markdown: async (ctrl) => {
        await ctrl.setContent('working\n\n_🧰 正在调用工具…_');
        await sleep(40);
        await ctrl.setContent('FINAL ANSWER');
      },
    });
    await expect(result).rejects.toMatchObject({ response: { data: { code: 230020 } } });
  });

  it('f031-stab-#7 setContent respects the time throttle (no push per call)', async () => {
    const { channel, pushed } = makeChannel(async () => {}, 200);
    await channel.stream('oc_chat', {
      markdown: async (ctrl) => {
        for (let i = 0; i < 20; i++) {
          await ctrl.setContent(`step ${i}`);
          await sleep(5);
        }
      },
    });
    // 20 calls in ~100ms with a 200ms throttle: a couple of pushes, not 20.
    expect(pushed.length).toBeLessThanOrEqual(4);
    expect(pushed.at(-1)).toBe('step 19');
  });
});
