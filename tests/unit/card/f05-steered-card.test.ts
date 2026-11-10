import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState, markSteered, reduce } from '../../../src/card/run-state';

// f0.5 之后 (Wei 2026-11-10「↪️Steered 没有显示」): ended cards carry no
// status row, so a steered card must show the hand-off as a visible row.
describe('steered card', () => {
  it('shows ↪️Steered in the body, not only the chat-list summary', () => {
    let s = reduce(initialState, { type: 'text', delta: '正在看…' } as never);
    s = markSteered(s);
    const json = JSON.stringify(renderCard(s));
    const body = JSON.stringify((renderCard(s) as { body: unknown }).body);
    expect(body).toContain('↪️Steered');
    expect(json).toContain('"streaming_mode":false');
  });
  it('a finished card still has no status row', () => {
    const s = reduce(reduce(initialState, { type: 'text', delta: 'ok' } as never), { type: 'done', terminationReason: 'normal' } as never);
    expect(JSON.stringify((renderCard(s) as { body: unknown }).body)).not.toContain('Steered');
  });
});
