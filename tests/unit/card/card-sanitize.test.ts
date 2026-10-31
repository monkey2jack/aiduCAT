import { describe, expect, it } from 'vitest';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import {
  CARD_MAX_BYTES,
  answerPlainText,
  renderCardWithInfo,
  renderCard,
} from '../../../src/card/run-renderer.js';
import { sanitizeCardMarkdown } from '../../../src/card/sanitize.js';

// f0.3.1 #2: agent markdown went into the card verbatim. Feishu rejects a card
// whose markdown has `![](http…)` (needs an img_key: 230099/200570) and any
// card over 30KB (230025), and the run froze on "Thinking…".

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

function doneWith(text: string, extra: Partial<RunState> = {}): RunState {
  let s = reduce(initialState, { type: 'text', delta: text } as never);
  s = reduce(s, { type: 'done', terminationReason: 'normal' } as never);
  return { ...s, ...extra };
}

describe('card markdown sanitizing (f031-#2)', () => {
  it('f031-#2 turns markdown images into plain links', () => {
    expect(sanitizeCardMarkdown('看图 ![猫](https://ex.com/a.png) 完')).toBe('看图 [🖼 猫](https://ex.com/a.png) 完');
    expect(sanitizeCardMarkdown('![](https://ex.com/a.png)')).toBe('[🖼 图片](https://ex.com/a.png)');
    expect(sanitizeCardMarkdown('![x](data:image/png;base64,AAAA)')).toBe('🖼 x');
    expect(sanitizeCardMarkdown('![x](./local.png "t")')).toBe('🖼 x');
  });

  it('f031-#2 strips HTML tags outside code but keeps code untouched', () => {
    const md = '<div align="center"><img src="https://ex.com/b.png"/></div>\n<b>粗</b>\n`<span>`\n```html\n<p>keep</p>\n```';
    const out = sanitizeCardMarkdown(md);
    expect(out).not.toContain('<div');
    expect(out).not.toContain('<b>');
    expect(out).toContain('[🖼 图片](https://ex.com/b.png)');
    expect(out).toContain('粗');
    expect(out).toContain('`<span>`');
    expect(out).toContain('<p>keep</p>');
    expect(sanitizeCardMarkdown('a <br> b')).toBe('a \n b');
    expect(sanitizeCardMarkdown('1 < 2 and 3 > 2')).toBe('1 < 2 and 3 > 2');
  });

  it('f031-#2 rendered card with images + 60KB answer has no ![ and stays under 30KB', () => {
    const para = '这是一段很长的回答，带图 ![图](https://ex.com/p.png) 和 <font color="red">HTML</font>。\n';
    let long = '';
    while (Buffer.byteLength(long) < 60_000) long += para;
    const state = doneWith(long, {
      reasoning: { content: '想'.repeat(5000), active: false, segments: 3 },
    });
    const card = renderCard(state, { model: 'Gemini-3.8-Flash', startedAt: Date.now() - 5000 });
    const json = JSON.stringify(card);
    expect(json).not.toContain('![');
    expect(json).not.toContain('<font');
    expect(bytes(card)).toBeLessThan(30_000);
    expect(bytes(card)).toBeLessThanOrEqual(CARD_MAX_BYTES);
    // f03p-fix-#8: the rest continues on 「续 i/N」 cards, not a plain-text copy.
    expect(json).toContain('未完，见下一张卡');
    expect(renderCardWithInfo(state).answerTruncated).toBe(true);
    expect(renderCardWithInfo(state).continuations.length).toBeGreaterThan(0);
    // The plain-text fallback (rejected card) still carries the whole answer, images as links.
    const plain = answerPlainText(state);
    expect(plain).not.toContain('![');
    expect(Buffer.byteLength(plain)).toBeGreaterThan(40_000);
    expect(plain).toContain("https://ex.com/p.png");
  });

  it('f031-#2 hundreds of tool calls still fit the card budget', () => {
    let s: RunState = reduce(initialState, { type: 'text', delta: '短答案' } as never);
    for (let i = 0; i < 600; i++) {
      s = reduce(s, {
        type: 'tool_use',
        id: `t${i}`,
        name: 'Bash',
        input: { command: `echo ${'x'.repeat(70)} ${i}` },
      } as never);
    }
    s = reduce(s, { type: 'done', terminationReason: 'normal' } as never);
    const card = renderCard(s, {});
    expect(bytes(card)).toBeLessThanOrEqual(CARD_MAX_BYTES);
    expect(JSON.stringify(card)).toContain('短答案');
    expect(renderCardWithInfo(s).continuations).toHaveLength(0);
  });

  it('f031-#2 strict render drops image URLs and the panel body', () => {
    const state = doneWith('答 ![a](https://ex.com/a.png)', {
      reasoning: { content: 'secret reasoning', active: false, segments: 1 },
    });
    const json = JSON.stringify(renderCard(state, { strict: true }));
    expect(json).not.toContain('![');
    expect(json).not.toContain('https://ex.com/a.png');
    expect(json).not.toContain('secret reasoning');
    expect(json).toContain('答');
  });
});
