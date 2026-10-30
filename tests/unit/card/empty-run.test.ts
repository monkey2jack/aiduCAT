import { describe, expect, it } from 'vitest';
import { EMPTY_RUN_MESSAGE, initialState, markEmptyRun, reduce } from '../../../src/card/run-state.js';

// fix(2026-10-30): empty-run regression - a claude process dying right after
// spawn emits only system+done with zero substantive events. The channel
// guard now routes such runs through markEmptyRun so the user gets a visible
// failure card instead of a silent empty Done card ("send twice" bug).
describe('empty-run guard (send-twice bug)', () => {
  it('markEmptyRun flips a done state into a visible error terminal', () => {
    const done = reduce(initialState, {
      type: 'done',
      terminationReason: 'normal',
    } as never);
    expect(done.terminal).toBe('done');

    const marked = markEmptyRun(done);
    expect(marked.terminal).toBe('error');
    expect(marked.footer).toBeNull();
  });

  it('markEmptyRun also closes out a running state', () => {
    const marked = markEmptyRun(initialState);
    expect(marked.terminal).toBe('error');
  });

  it('f031-#4 markEmptyRun carries a reason, keeping a real agent error if there is one', () => {
    const done = reduce(initialState, { type: 'done', terminationReason: 'normal' } as never);
    expect(markEmptyRun(done).errorMsg).toBe(EMPTY_RUN_MESSAGE);
    const failed = reduce(initialState, { type: 'error', message: 'claude exited 1', terminationReason: 'failed' } as never);
    expect(markEmptyRun(failed).errorMsg).toBe('claude exited 1');
  });
});
