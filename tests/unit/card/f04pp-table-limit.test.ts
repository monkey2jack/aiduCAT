import { describe, expect, it } from 'vitest';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import { renderCardWithInfo, renderContinuationCard } from '../../../src/card/run-renderer.js';
import { CARD_TABLE_LIMIT, countTables, defangTables, paginateMarkdown } from '../../../src/card/paginate.js';

// f0.4++ fix (prod 2026-11-04 12:02): a 9-table answer was rejected by Feishu
// (230099 / ErrCode 11310 "card table number over limit") — normal and strict
// card both — and fell back to plain text. Max 5 tables per card now.

function stateWith(text: string, opts: { reasoning?: string } = {}): RunState {
  let s = initialState;
  if (opts.reasoning) s = reduce(s, { type: 'reasoning', delta: opts.reasoning } as never);
  s = reduce(s, { type: 'text', delta: text } as never);
  return reduce(s, { type: 'done', terminationReason: 'normal' } as never);
}

function markdownOf(card: object): string {
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
  return out.join('\n\n');
}

const table = (n: number) => `### 表 ${n}\n\n| 项 | 值 |\n|---|---|\n| a${n} | ${n} |\n| b${n} | ${n * 2} |`;
const nineTables = Array.from({ length: 9 }, (_, i) => table(i + 1)).join('\n\n');

describe('f0.4++ card table limit', () => {
  it('counts GFM tables, with or without leading pipes, ignoring code fences', () => {
    expect(countTables('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(1);
    expect(countTables('a | b\n--- | ---\n1 | 2')).toBe(1);
    expect(countTables('```\n| a | b |\n|---|---|\n```')).toBe(0);
    expect(countTables('just | a pipe')).toBe(0);
    expect(countTables(nineTables)).toBe(9);
  });

  it('pages carry at most 5 tables and keep every block in order', () => {
    const pages = paginateMarkdown(nineTables, 20_000, 20_000);
    expect(pages.length).toBe(2);
    for (const p of pages) expect(countTables(p)).toBeLessThanOrEqual(CARD_TABLE_LIMIT);
    expect(pages.join('\n\n')).toBe(nineTables);
  });

  it('a short 9-table answer goes to card 1 + 续 2/2, each within the limit', () => {
    const r = renderCardWithInfo(stateWith(nineTables), { model: 'm', startedAt: Date.now() });
    expect(countTables(markdownOf(r.card))).toBeLessThanOrEqual(CARD_TABLE_LIMIT);
    expect(r.answerTruncated).toBe(true);
    expect(r.continuations.length).toBe(1);
    const cont = renderContinuationCard(r.continuations[0]!, 2, 2);
    expect(countTables(markdownOf(cont))).toBe(9 - countTables(markdownOf(r.card)));
  });

  it('strict retry obeys the limit too', () => {
    const r = renderCardWithInfo(stateWith(nineTables), { strict: true });
    expect(countTables(markdownOf(r.card))).toBeLessThanOrEqual(CARD_TABLE_LIMIT);
  });

  it('5 tables stay on one card', () => {
    const five = Array.from({ length: 5 }, (_, i) => table(i + 1)).join('\n\n');
    const r = renderCardWithInfo(stateWith(five));
    expect(r.continuations).toEqual([]);
    expect(countTables(markdownOf(r.card))).toBe(5);
  });

  it('tables in the process panel are shown as code and cost nothing', () => {
    const five = Array.from({ length: 5 }, (_, i) => table(i + 1)).join('\n\n');
    const r = renderCardWithInfo(stateWith(five, { reasoning: `想一下\n\n${table(99)}` }), { model: 'm' });
    expect(countTables(markdownOf(r.card))).toBe(5);
    expect(defangTables(table(1))).toContain('```');
  });
});
