import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunWatchdog, type WatchdogFire } from '../../../src/bot/run-watchdog';
import { getRunIdleTimeoutMs, getRunToolTimeoutMs } from '../../../src/config/schema';
import { initialState, markIdleTimeout } from '../../../src/card/run-state';
import { renderCard } from '../../../src/card/run-renderer';
import { renderText } from '../../../src/card/text-renderer';

// f031-stab-#4: idle watchdog on by default (15 min) + a hard cap per tool call,
// and the card says plainly what happened.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const MIN = 60_000;

describe('f031-stab-#4 defaults', () => {
  it('f031-stab-#4 idle timeout defaults to 15 minutes; explicit 0 still turns it off', () => {
    expect(getRunIdleTimeoutMs({ preferences: {} } as never)).toBe(15 * MIN);
    expect(getRunIdleTimeoutMs({} as never)).toBe(15 * MIN);
    expect(getRunIdleTimeoutMs({ preferences: { runIdleTimeoutMinutes: 0 } } as never)).toBeUndefined();
    expect(getRunIdleTimeoutMs({ preferences: { runIdleTimeoutMinutes: 7 } } as never)).toBe(7 * MIN);
  });

  it('f031-stab-#4 a single tool call is capped at 30 minutes by default; 0 turns it off', () => {
    expect(getRunToolTimeoutMs({ preferences: {} } as never)).toBe(30 * MIN);
    expect(getRunToolTimeoutMs({ preferences: { runToolTimeoutMinutes: 0 } } as never)).toBeUndefined();
    expect(getRunToolTimeoutMs({ preferences: { runToolTimeoutMinutes: 45 } } as never)).toBe(45 * MIN);
  });
});

describe('f031-stab-#4 RunWatchdog', () => {
  it('f031-stab-#4 idle fires after silence with no tool in flight', () => {
    const fires: WatchdogFire[] = [];
    const w = new RunWatchdog({ idleMs: 15 * MIN, toolMs: 30 * MIN, onFire: (f) => fires.push(f) });
    w.start();
    vi.advanceTimersByTime(14 * MIN);
    w.activity();
    vi.advanceTimersByTime(14 * MIN);
    expect(fires).toEqual([]);
    vi.advanceTimersByTime(1 * MIN + 1);
    expect(fires).toEqual([{ kind: 'idle', ms: 15 * MIN }]);
  });

  it('f031-stab-#4 a hung tool is cut off by the hard cap even though idle is paused', () => {
    const fires: WatchdogFire[] = [];
    const w = new RunWatchdog({ idleMs: 15 * MIN, toolMs: 30 * MIN, onFire: (f) => fires.push(f) });
    w.start();
    w.toolStarted('t1', 'Bash');
    vi.advanceTimersByTime(29 * MIN);
    // other events (e.g. another tool finishing) must not reset the cap
    w.toolStarted('t2', 'Read');
    w.toolFinished('t2');
    w.activity();
    expect(fires).toEqual([]);
    vi.advanceTimersByTime(1 * MIN + 1);
    expect(fires).toEqual([{ kind: 'tool', ms: 30 * MIN, toolName: 'Bash' }]);
  });

  it('f031-stab-#4 a tool that finishes in time re-arms the idle timer', () => {
    const fires: WatchdogFire[] = [];
    const w = new RunWatchdog({ idleMs: 15 * MIN, toolMs: 30 * MIN, onFire: (f) => fires.push(f) });
    w.start();
    w.toolStarted('t1', 'Bash');
    vi.advanceTimersByTime(20 * MIN);
    w.toolFinished('t1');
    vi.advanceTimersByTime(14 * MIN);
    expect(fires).toEqual([]);
    vi.advanceTimersByTime(1 * MIN + 1);
    expect(fires[0]?.kind).toBe('idle');
    w.dispose();
  });
});

describe('f031-stab-#4 the card says what happened', () => {
  it('f031-stab-#4 idle timeout shows a visible note on the card (not only ⚠️Timeout)', () => {
    const card = JSON.stringify(renderCard(markIdleTimeout(initialState, 15)));
    expect(card).toContain('15 分钟');
    expect(card).toContain('重发');
  });

  it('f031-stab-#4 tool timeout names the tool on the card and in text mode', () => {
    const st = markIdleTimeout(initialState, 30, 'Bash');
    const card = JSON.stringify(renderCard(st));
    expect(card).toContain('Bash');
    expect(card).toContain('30 分钟');
    expect(renderText(st)).toContain('Bash');
  });
});
