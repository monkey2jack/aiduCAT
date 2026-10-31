import { describe, expect, it } from 'vitest';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import * as renderer from '../../../src/card/run-renderer.js';
import { CARD_MAX_BYTES, renderCardWithInfo } from '../../../src/card/run-renderer.js';
import { longChinese, longCode, manyTables } from '../../helpers/long-answers.js';

// f03p-fix-#8 (猴哥, production 10:14): a 17,451-char answer was cut at the
// card budget and then re-sent whole as plain text — the card overflowed into
// unformatted text and the content appeared twice. Now a long answer becomes
// card 1 (up to the budget, cut at a paragraph/code/table boundary) + ordered
// 「续 i/N」 continuation cards, nothing repeated, no plain-text copy.

const NOTE = '…（未完，见下一张卡）';
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
const renderContinuationCard = (renderer as unknown as {
  renderContinuationCard: (page: string, index: number, total: number, opts?: object) => object;
}).renderContinuationCard;

function stateWith(text: string, done = true): RunState {
  let s = reduce(initialState, { type: 'text', delta: text } as never);
  if (done) s = reduce(s, { type: 'done', terminationReason: 'normal' } as never);
  return s;
}

function markdownOf(card: object): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.tag === 'markdown' && typeof o.content === 'string') out.push(o.content);
      Object.values(o).forEach(walk);
    }
  };
  walk(card);
  return out;
}

function allCards(text: string): { first: object; conts: object[]; total: number } {
  const r = renderCardWithInfo(stateWith(text), { model: 'Gemini-3.8-Flash', startedAt: Date.now() - 5000 });
  const pages = (r as unknown as { continuations?: string[] }).continuations ?? [];
  const total = pages.length + 1;
  return { first: r.card, conts: pages.map((p, i) => renderContinuationCard(p, i + 2, total)), total };
}

function common(text: string) {
  const c = allCards(text);
  expect(c.total).toBeGreaterThanOrEqual(2);
  const cards = [c.first, ...c.conts];
  cards.forEach((card, i) => {
    const json = JSON.stringify(card);
    expect(bytes(card), `card ${i + 1}`).toBeLessThan(30_000);
    expect(bytes(card), `card ${i + 1}`).toBeLessThanOrEqual(CARD_MAX_BYTES);
    expect(json).not.toContain('![');
    expect(json).not.toContain('已截断');
    expect(json).not.toContain('纯文本');
    const md = markdownOf(card).join('\n');
    // fences balanced per card, no HTML outside code
    expect((md.match(/^```/gm) ?? []).length % 2, `card ${i + 1} fences`).toBe(0);
    const prose = md.replace(/```[\s\S]*?```/g, '');
    expect(prose).not.toMatch(/<\/?[a-zA-Z][^>]*>/);
    if (i < cards.length - 1) expect(json, `card ${i + 1} note`).toContain(NOTE);
    else expect(json).not.toContain(NOTE);
    if (i > 0) expect(json).toContain(`续 ${i + 1}/${c.total}`);
  });
  return { ...c, cards, mds: cards.map((card) => markdownOf(card).join('\n\n')) };
}

const ids = (mds: string[], re: RegExp) => mds.flatMap((m) => [...m.matchAll(re)].map((x) => Number(x[1])));

describe('f03p-fix-#8 long answers become continuation cards', () => {
  it('17k Chinese: split at paragraph boundaries, every paragraph once and in order', () => {
    const text = longChinese();
    expect(text.length).toBeGreaterThanOrEqual(17_451);
    const { mds } = common(text);
    const seen = ids(mds, /〔P(\d+)〕这是第/g).filter((v, i, a) => a.indexOf(v) === i);
    const all = ids([text], /〔P(\d+)〕这是第/g).filter((v, i, a) => a.indexOf(v) === i);
    expect(seen).toEqual(all);
    // each paragraph appears whole, in exactly one card
    for (const p of text.split('\n\n').filter((p) => p.startsWith('〔P'))) {
      expect(mds.filter((m) => m.includes(p)).length, p.slice(0, 12)).toBe(1);
    }
    expect(mds.join('\n')).toContain('[🖼 图](https://ex.com/a.png)');
  });

  it('long code block: split between lines, fence reopened, every line exactly once', () => {
    const { mds } = common(longCode());
    const lines = ids(mds, /const v(\d+) =/g);
    expect(lines).toEqual(Array.from({ length: 2_500 }, (_, i) => i));
    for (const m of mds.slice(1)) {
      if (m.includes('const v')) expect(m).toMatch(/```ts\n/);
    }
    expect(mds.join('\n').match(/代码结束/g)).toHaveLength(1);
  });

  it('many tables: split between rows, header repeated, every row exactly once', () => {
    const { mds } = common(manyTables());
    const rows = mds.flatMap((m) => [...m.matchAll(/\| (r\d+-\d+) \|/g)].map((x) => x[1]));
    const expected = [
      ...Array.from({ length: 8 }, (_, t) => Array.from({ length: 80 }, (_, i) => `r${t}-${i}`)).flat(),
      ...Array.from({ length: 400 }, (_, i) => `r8-${i}`),
    ];
    expect(rows).toEqual(expected);
    // the 400-row table is split across cards
    expect(mds.filter((m) => m.includes('| r8-')).length).toBeGreaterThanOrEqual(2);
    // every table fragment in every card starts with the header + separator
    for (const m of mds) {
      const blocks = m.split(/\n{2,}/).filter((b) => b.includes('| r'));
      for (const b of blocks) expect(b.split('\n').slice(0, 2).join('\n')).toBe('| 编号 | 值 | 说明 |\n|---|---|---|');
    }
  });

  it('while streaming, the card shows the first part with the new note and stays under 30KB', () => {
    const card = renderCardWithInfo(stateWith(longChinese(), false)).card;
    const json = JSON.stringify(card);
    expect(bytes(card)).toBeLessThan(30_000);
    expect(json).toContain(NOTE);
    expect(json).not.toContain('已截断');
  });

  it('a short answer has no continuation and no note', () => {
    const r = renderCardWithInfo(stateWith('短答案'));
    expect((r as unknown as { continuations?: string[] }).continuations ?? []).toHaveLength(0);
    expect(JSON.stringify(r.card)).not.toContain(NOTE);
  });
});
