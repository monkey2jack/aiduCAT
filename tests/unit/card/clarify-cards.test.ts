import { describe, expect, it } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState, type RunState } from '../../../src/card/run-state';
import { answeredClarifyCard, ClarifyCardStore, clarifyCardsFor } from '../../../src/card/clarify-cards';

const asked: RunState = {
  ...initialState,
  terminal: 'done',
  footer: 'done' as RunState['footer'],
  finalText: '前面的长回答，表格和分析都在这里。',
  clarify: { question: '用哪个方案？', options: ['A', 'B'], raw: '' },
};

describe('clarify answer keeps the whole card (2026-11-25)', () => {
  it('swaps only the form and the TBC prompt for the receipt', () => {
    const card = renderCard(asked, { model: 'M' });
    const s = JSON.stringify(card);
    expect(s).toContain('clarify_form');
    const out = JSON.stringify(answeredClarifyCard(card, '用哪个方案？', 'B'));
    expect(out).toContain('前面的长回答');
    expect(out).not.toContain('clarify_form');
    expect(out).not.toContain('下拉选择后点确认');
    expect(out).toContain('✅ **已选**：B');
    expect(out).toContain('⁉️ **TBC**：用哪个方案？');
  });

  it('returns undefined for a card without a clarify form', () => {
    const card = renderCard({ ...asked, clarify: undefined }, {});
    expect(answeredClarifyCard(card, 'q', 'a')).toBeUndefined();
  });

  it('store survives a restart, is 0600, and take() is one-shot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clarify-'));
    const file = join(dir, 'sessions.json');
    clarifyCardsFor(file).remember('om_1', { a: 1 });
    expect((statSync(`${file}.clarify-cards.json`).mode & 0o777).toString(8)).toBe('600');
    const fresh = new ClarifyCardStore(`${file}.clarify-cards.json`);
    expect(fresh.take('om_1')).toEqual({ a: 1 });
    expect(fresh.take('om_1')).toBeUndefined();
  });
});
