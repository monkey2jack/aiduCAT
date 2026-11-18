import { afterEach, describe, expect, it, vi } from 'vitest';
import { reply, replyOnce } from '../../../src/commands/index.js';

// f0.5++ hotfix: the command reply send once hung forever inside the SDK
// (production: /new reset the session and never answered, silently). Each
// attempt is now bounded by a timeout and retried once; audit-rejected text
// falls back to the audit-safe notice. These tests pin those bounds.

const AUDIT_SAFE = '命令已处理。';

function ctxFor(send: ReturnType<typeof vi.fn>) {
  return {
    channel: { send },
    msg: { chatId: 'oc_x', messageId: 'om_1' },
    chatMode: 'p2p',
  } as never;
}

describe('command reply bounds (f0.5++ hotfix)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends once and resolves when the send succeeds', async () => {
    const send = vi.fn().mockResolvedValue({});
    await reply(ctxFor(send), '已开始新会话。');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toEqual({ markdown: '已开始新会话。' });
  });

  it('rejects at the timeout when the send hangs forever (replyOnce)', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => new Promise(() => {}));
    const pending = replyOnce(ctxFor(send), 'x');
    const settled = expect(pending).rejects.toThrow(/timed out after 15000ms/);
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
  });

  it('retries a hung send once with the same content, then gives up bounded', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => new Promise(() => {}));
    const pending = reply(ctxFor(send), '已开始新会话。');
    const settled = expect(pending).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000); // first attempt times out → retry
    await vi.advanceTimersByTimeAsync(15_000); // retry times out → give up
    await settled;
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toEqual({ markdown: '已开始新会话。' });
  });

  it('swaps to the audit-safe notice when the text is audit-rejected', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('not pass the audit'), { code: 230028 }))
      .mockResolvedValue({});
    await reply(ctxFor(send), '某条会被审计拦下的文本');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toEqual({ markdown: AUDIT_SAFE });
  });

  it('gives up after the audit-safe fallback fails once', async () => {
    vi.useFakeTimers();
    const reject = Object.assign(new Error('not pass the audit'), { code: 230028 });
    const send = vi.fn().mockRejectedValue(reject);
    const pending = reply(ctxFor(send), '某条会被审计拦下的文本');
    const settled = expect(pending).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000); // fallback attempt times out
    await settled;
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toEqual({ markdown: AUDIT_SAFE });
  });
});
