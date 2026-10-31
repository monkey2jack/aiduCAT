import { createHash } from 'node:crypto';
import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';
import {
  answerPlainText,
  continuationPlainText,
  renderCardWithInfo,
  renderContinuationCard,
  type RunCardRenderOptions,
} from '../card/run-renderer';
import type { RunState } from '../card/run-state';

/**
 * f0.3.1 #1: what happens after Feishu rejected the streaming card.
 *
 * Before this, a rejected final patch left the card frozen on "Thinking…" and
 * the answer was lost (production: 230099/200570 image markdown, 200800). Now
 * every path ends with the answer or an explicit error on screen:
 *   1. strict retry — the same card re-rendered without image URLs, 12KB answer,
 *      no reasoning/tool list (patched in place, or sent fresh if no card yet)
 *   2. plain-text IM message with the whole answer
 *   3. one-line "卡片发送失败" notice
 * and the stuck card is closed with a short error/done note when step 1 failed.
 */

export const CARD_FAILED_NOTICE = '⚠️ 卡片发送失败，本轮回答没能送达，请重发一次。';
const TEXT_FALLBACK_HEADER = '（卡片显示失败，以下是纯文本答案）';

type SendOpts = { replyTo?: string; replyInThread?: boolean };
type CardChannel = Pick<LarkChannel, 'send' | 'updateCard'>;

/** Feishu business code from an SDK/axios error (`code` or `response.data.code`). */
export function larkErrorCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const nested = (err as { response?: { data?: { code?: unknown } } }).response?.data?.code;
  if (typeof nested === 'number') return nested;
  const top = (err as { code?: unknown }).code;
  if (typeof top === 'number') return top;
  const m = /\b(2\d{5})\b/.exec(err instanceof Error ? err.message : '');
  return m ? Number(m[1]) : undefined;
}

/**
 * f0.3.1 #6: record a rejected card by fingerprint only — sha256 prefix, byte
 * length, Feishu code. The old /tmp/aiduCAT-rejected-card.json dump wrote the
 * whole conversation in clear text and grew forever.
 */
export function logRejectedCard(card: object, err: unknown, step: string, scope?: string): void {
  const json = JSON.stringify(card);
  log.warn('card', 'rejected', {
    ...(scope ? { scope } : {}),
    step,
    code: larkErrorCode(err),
    bytes: Buffer.byteLength(json, 'utf8'),
    sha256: createHash('sha256').update(json).digest('hex').slice(0, 16),
  });
}

/** A minimal finished card with no agent content — the most likely to be accepted. */
export function closingCard(note: string, summary = '❌卡片显示失败'): object {
  return {
    schema: '2.0',
    config: { streaming_mode: false, summary: { content: summary } },
    body: { elements: [{ tag: 'markdown', content: note, text_size: 'notation' }] },
  };
}

async function sendText(channel: CardChannel, chatId: string, text: string, sendOpts: SendOpts): Promise<void> {
  const r = await channel.send(chatId, { text }, sendOpts);
  if (!r?.messageId?.trim()) throw new Error('text reply missing message receipt');
}

/**
 * f03p-fix-#8: send the rest of a long answer as ordered 「续 i/N」 cards
 * (card 1 is the streaming card). Replaces the old「📄 全文」plain-text copy,
 * which repeated card 1 unformatted. Only when Feishu rejects a continuation
 * card does that page and everything after it go out as plain text, once.
 */
export async function sendContinuationCards(input: {
  channel: CardChannel;
  chatId: string;
  scope: string;
  pages: string[];
  sendOpts: SendOpts;
}): Promise<'cards' | 'text' | 'none'> {
  const { channel, chatId, scope, pages, sendOpts } = input;
  if (pages.length === 0) return 'none';
  const total = pages.length + 1;
  for (let i = 0; i < pages.length; i++) {
    const card = renderContinuationCard(pages[i]!, i + 2, total);
    try {
      const r = await channel.send(chatId, { card }, sendOpts);
      if (!r?.messageId?.trim()) throw new Error('continuation card missing message receipt');
    } catch (err) {
      logRejectedCard(card, err, 'continuation-card', scope);
      const header = `（卡片显示失败，以下是纯文本 续 ${i + 2}/${total}${i + 2 < total ? ` 至 ${total}/${total}` : ''}）`;
      try {
        await sendText(channel, chatId, `${header}\n\n${continuationPlainText(pages.slice(i))}`, sendOpts);
        log.info('outbound', 'continuation-text', { scope, from: i + 2, total });
        return 'text';
      } catch (textErr) {
        log.fail('outbound', textErr, { scope, step: 'continuation-text' });
        return 'none';
      }
    }
  }
  log.info('outbound', 'continuation-cards', { scope, total });
  return 'cards';
}

export async function deliverAfterCardFailure(input: {
  channel: CardChannel;
  chatId: string;
  scope: string;
  state: RunState;
  sendOpts: SendOpts;
  renderOptions: RunCardRenderOptions;
  /** The streaming card's message id, when the card exists and can be patched. */
  messageId?: string;
  err: unknown;
  rejectedCard: object;
  step: string;
}): Promise<'strict-card' | 'text' | 'notice'> {
  const { channel, chatId, scope, state, sendOpts, messageId } = input;
  logRejectedCard(input.rejectedCard, input.err, input.step, scope);

  // 1. strict retry
  const strict = renderCardWithInfo(state, { ...input.renderOptions, strict: true });
  try {
    if (messageId) {
      await channel.updateCard(messageId, strict.card);
    } else {
      const r = await channel.send(chatId, { card: strict.card }, sendOpts);
      if (!r?.messageId?.trim()) throw new Error('strict card missing message receipt');
    }
    log.info('card', 'degraded', { scope, step: 'strict-card', patched: Boolean(messageId) });
    await sendContinuationCards({ channel, chatId, scope, pages: strict.continuations, sendOpts });
    return 'strict-card';
  } catch (err) {
    logRejectedCard(strict.card, err, 'strict-retry', scope);
  }

  // 2. plain-text answer, 3. explicit notice
  let delivered: 'text' | 'notice' | undefined;
  const text = answerPlainText(state);
  if (text) {
    try {
      await sendText(channel, chatId, `${TEXT_FALLBACK_HEADER}\n\n${text}`, sendOpts);
      delivered = 'text';
      log.info('card', 'degraded', { scope, step: 'text', chars: text.length });
    } catch (err) {
      log.fail('outbound', err, { scope, step: 'text-fallback' });
    }
  }
  if (!delivered) {
    try {
      await sendText(channel, chatId, CARD_FAILED_NOTICE, sendOpts);
      log.info('card', 'degraded', { scope, step: 'notice' });
    } catch (err) {
      log.fail('outbound', err, { scope, step: 'notice' });
    }
    delivered = 'notice';
  }

  // Close the frozen card so it no longer says "Thinking…".
  if (messageId) {
    const note =
      delivered === 'text' ? '⚠️ 卡片显示失败，答案已用纯文本消息发送。' : '⚠️ 卡片发送失败，请重发一次。';
    try {
      await channel.updateCard(messageId, closingCard(note));
    } catch (err) {
      log.warn('card', 'close-failed', { scope, code: larkErrorCode(err) });
    }
  }
  return delivered;
}
