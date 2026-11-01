import { describe, expect, it, vi } from 'vitest';
import { EarlyCard, EarlyCards, earlySendOpts } from '../../../src/bot/early-card.js';

// f0.3.5: the「☤aiduCATing…」placeholder card — adopt / discard / failure.

type Ctrl = { messageId?: string; update?: (c: unknown) => Promise<void> };

function fakeChannel(opts: { fail?: boolean } = {}) {
  const calls: Array<{ initial: unknown; opts: unknown }> = [];
  const recalled: string[] = [];
  const channel = {
    stream: vi.fn(async (_chat: string, input: { card: { initial: object; producer: (c: Ctrl) => Promise<void> } }, o?: unknown) => {
      calls.push({ initial: input.card.initial, opts: o });
      if (opts.fail) throw new Error('230099 rejected');
      await input.card.producer({ messageId: 'om_early' });
      return { messageId: 'om_early' };
    }),
    recallMessage: vi.fn(async (id: string) => {
      recalled.push(id);
    }),
  };
  return { channel, calls, recalled };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('f035 EarlyCard', () => {
  it('adopt hands the same stream to the run producer', async () => {
    const f = fakeChannel();
    const card = new EarlyCard<Ctrl>(f.channel, 'oc_1', { p: 1 }, {}, 's');
    const seen: string[] = [];
    const res = await card.adopt(async (ctrl) => {
      seen.push(ctrl.messageId ?? '');
    }, async () => ({ messageId: 'fresh' }));
    expect(seen).toEqual(['om_early']);
    expect(res).toEqual({ messageId: 'om_early' });
    expect(f.channel.stream).toHaveBeenCalledTimes(1);
    expect(card.state).toBe('adopted');
    card.discard('late'); // no-op once adopted
    await tick();
    expect(f.recalled).toEqual([]);
  });

  it('discard finishes the stream and recalls the placeholder', async () => {
    const f = fakeChannel();
    const card = new EarlyCard<Ctrl>(f.channel, 'oc_1', {}, {}, 's');
    card.discard('dropped');
    await tick();
    await tick();
    expect(f.recalled).toEqual(['om_early']);
    // a discarded card is never adopted — the run opens its own
    const fresh = vi.fn(async () => ({ messageId: 'fresh' }));
    await expect(card.adopt(async () => {}, fresh)).resolves.toEqual({ messageId: 'fresh' });
  });

  it('a placeholder Feishu rejected → the run opens a fresh card', async () => {
    const f = fakeChannel({ fail: true });
    const card = new EarlyCard<Ctrl>(f.channel, 'oc_1', {}, {}, 's');
    await tick();
    const fresh = vi.fn(async () => ({ messageId: 'fresh' }));
    await expect(card.adopt(async () => {}, fresh)).resolves.toEqual({ messageId: 'fresh' });
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('EarlyCards: one card per pending batch; take() frees the slot for the next batch', () => {
    const f = fakeChannel();
    const open = vi.fn((scope: string) => new EarlyCard<Ctrl>(f.channel, scope, {}, {}, scope));
    const reg = new EarlyCards<Ctrl>(open);
    const msg = { messageId: 'om_1', chatId: 'oc_1' } as never;
    reg.ensure('s', msg);
    reg.ensure('s', msg);
    expect(open).toHaveBeenCalledTimes(1);
    expect(reg.take('s')).toBeDefined();
    reg.ensure('s', msg);
    expect(open).toHaveBeenCalledTimes(2);
    reg.discardAll('shutdown');
    expect(reg.take('s')).toBeUndefined();
  });

  it('topic replies stay in their thread', () => {
    expect(earlySendOpts({ messageId: 'om_t', threadId: 'omt_1' } as never)).toEqual({ replyTo: 'om_t', replyInThread: true });
    expect(earlySendOpts({ messageId: 'om_p' } as never)).toEqual({});
  });
});
