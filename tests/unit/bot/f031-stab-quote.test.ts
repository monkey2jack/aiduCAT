import { describe, expect, it, vi } from 'vitest';
import { fetchTopicContext } from '../../../src/bot/quote';

// f031-stab-#6 (upstream PR #309, quote.ts only; issue #213): without
// card_msg_content_type=user_card_content Feishu returns the v1 fallback body
// ("请升级至最新版本客户端") for CardKit 2.0 cards in a topic — every aiduCAT
// card is 2.0, so topic context fed the model that placeholder.
describe('f031-stab-#6-309 topic context asks for the real card content', () => {
  it('f031-stab-#6-309 im.v1.message.list is called with card_msg_content_type=user_card_content', async () => {
    const list = vi.fn(async () => ({ data: { items: [], has_more: false } }));
    const channel = { rawClient: { im: { v1: { message: { list } } } } } as never;
    await fetchTopicContext(channel, 'omt_1', { maxMessages: 10 });
    expect(list).toHaveBeenCalledTimes(1);
    expect((list.mock.calls[0] as unknown as [{ params: Record<string, unknown> }])[0].params).toMatchObject({
      container_id_type: 'thread',
      container_id: 'omt_1',
      card_msg_content_type: 'user_card_content',
    });
  });
});
