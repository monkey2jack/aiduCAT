import { afterEach, describe, expect, it, vi } from 'vitest';
import { processAgentStream } from '../../../src/bot/channel';
import type { AgentEvent } from '../../../src/agent/types';
import type { RunHandle } from '../../../src/bot/active-runs';

afterEach(() => vi.useRealTimers());

describe('watchdog stream recovery', () => {
  it('closes the exited stream after timeout and renders a timeout state', async () => {
    vi.useFakeTimers();
    let wake!: (v: IteratorResult<AgentEvent>) => void;
    const events: AsyncIterable<AgentEvent> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve) => { wake = resolve; }) }),
    };
    const stop = vi.fn(async () => {});
    const handle = { interrupted: false, run: { stop } } as unknown as RunHandle;
    const close = vi.fn(async () => {
      wake({ done: false, value: { type: 'error', message: 'stream closed', terminationReason: 'timeout' } });
      return true;
    });
    const flush = vi.fn(async () => {});
    const stats = { recordUsage: vi.fn(), recordMessage: vi.fn(), recordModel: vi.fn(), recordTurnTps: vi.fn() };
    const result = processAgentStream(close, handle, events, 'scope', { idleMs: 50 }, () => {}, flush, stats, 'claude');
    await vi.advanceTimersByTimeAsync(50);
    expect(stop).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    const state = await result;
    expect(close).toHaveBeenCalledTimes(1);
    expect(state.terminal).not.toBe('running');
    expect(flush).toHaveBeenCalled();
  });

  it('does not fire delayed recovery after a normal terminal event', async () => {
    vi.useFakeTimers();
    const events: AsyncIterable<AgentEvent> = { async *[Symbol.asyncIterator]() {
      yield { type: 'text', delta: 'hello' };
      yield { type: 'done', terminationReason: 'normal' };
    } };
    const handle = { interrupted: false, run: { stop: vi.fn(async () => {}) } } as unknown as RunHandle;
    const close = vi.fn(async () => true);
    const stats = { recordUsage: vi.fn(), recordMessage: vi.fn(), recordModel: vi.fn(), recordTurnTps: vi.fn() };
    const result = await processAgentStream(close, handle, events, 'scope', { idleMs: 50 }, () => {}, async () => {}, stats, 'claude');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(close).not.toHaveBeenCalled();
    expect(result.terminal).toBe('done');
  });

  it('retries when the process exits after the first recovery check', async () => {
    vi.useFakeTimers();
    let wake!: (v: IteratorResult<AgentEvent>) => void;
    const events: AsyncIterable<AgentEvent> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve) => { wake = resolve; }) }),
    };
    const handle = { interrupted: false, run: { stop: vi.fn(async () => {}) } } as unknown as RunHandle;
    const close = vi.fn().mockResolvedValueOnce(false).mockImplementationOnce(async () => {
      wake({ done: false, value: { type: 'error', message: 'stream closed', terminationReason: 'timeout' } });
      return true;
    });
    const stats = { recordUsage: vi.fn(), recordMessage: vi.fn(), recordModel: vi.fn(), recordTurnTps: vi.fn() };
    const result = processAgentStream(close, handle, events, 'scope', { idleMs: 50 }, () => {}, async () => {}, stats, 'claude');
    await vi.advanceTimersByTimeAsync(10_050);
    expect(close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await result).terminal).toBe('idle_timeout');
    expect(close).toHaveBeenCalledTimes(2);
  });
});
