import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingQueue } from '../../../src/bot/pending-queue';
import { SteerInput, userLine } from '../../../src/agent/claude/steer-input';
import { initialState, markSteered, reduce } from '../../../src/card/run-state';
import { renderCard } from '../../../src/card/run-renderer';
import { renderText } from '../../../src/card/text-renderer';
import { PassThrough } from 'node:stream';

const msg = (id: string): NormalizedMessage => ({ messageId: id, chatId: 'c', senderId: 'u', content: id }) as never;

describe('f0.5 之后 steer — PendingQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a blocked scope without a steerable run keeps accumulating (old behavior)', () => {
    const flushed: string[][] = [];
    const steered: string[][] = [];
    const q = new PendingQueue(600, (_s, b) => flushed.push(b.map((m) => m.messageId)), {
      canSteer: () => false,
      onSteer: (_s, b) => steered.push(b.map((m) => m.messageId)),
    });
    q.block('s');
    q.push('s', msg('a'));
    vi.advanceTimersByTime(5000);
    expect(flushed).toEqual([]);
    expect(steered).toEqual([]);
    q.unblock('s');
    vi.advanceTimersByTime(600);
    expect(flushed).toEqual([['a']]);
  });

  it('a blocked scope with a steerable run debounces and hands the batch to onSteer', () => {
    const steered: string[][] = [];
    let live = false;
    const q = new PendingQueue(600, () => {}, {
      canSteer: () => live,
      onSteer: (_s, b) => steered.push(b.map((m) => m.messageId)),
    });
    q.block('s');
    q.push('s', msg('a'));
    vi.advanceTimersByTime(1000);
    expect(steered).toEqual([]);
    live = true;
    q.poke('s');
    q.push('s', msg('b'));
    vi.advanceTimersByTime(600);
    expect(steered).toEqual([['a', 'b']]);
  });

  it('restore puts a batch back in front; it waits while blocked and flushes after unblock', () => {
    const flushed: string[][] = [];
    const q = new PendingQueue(600, (_s, b) => flushed.push(b.map((m) => m.messageId)));
    q.block('s');
    q.push('s', msg('c'));
    q.restore('s', [msg('a'), msg('b')]);
    vi.advanceTimersByTime(5000);
    expect(flushed).toEqual([]);
    q.unblock('s');
    vi.advanceTimersByTime(600);
    expect(flushed).toEqual([['a', 'b', 'c']]);
  });
});

describe('f0.5 之后 steer — SteerInput', () => {
  const replay = (text: string) => ({ type: 'user', isReplay: true, message: { role: 'user', content: [{ type: 'text', text }] } });

  it('writes the prompt as a stream-json user line and matches echoes', () => {
    const stdin = new PassThrough();
    let written = '';
    stdin.on('data', (c) => (written += c));
    const input = new SteerInput(stdin, 'first');
    expect(input.classify(replay('first'))).toBe('skip');
    expect(input.steer('second')).toBe(true);
    expect(written).toBe(userLine('first') + userLine('second'));
    // a queued task-notification or anything else is not ours
    expect(input.classify(replay('<task-notification>x</task-notification>'))).toBeUndefined();
    expect(input.classify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } })).toBeUndefined();
    expect(input.onResult()).toBe(true); // still waiting → hold the done
    expect(input.classify(replay('second'))).toBe('steer');
    expect(input.onResult()).toBe(false); // nothing waiting → stdin closes
    expect(stdin.writableEnded).toBe(true);
    expect(input.steer('third')).toBe(false);
  });
});

describe('f0.5 之后 steer — card', () => {
  it('a steered card closes its tools and reads ↪️Steered', () => {
    let s = reduce(initialState, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } });
    s = markSteered(s);
    expect(s.terminal).toBe('steered');
    expect(JSON.stringify(renderCard(s, {}))).toContain('↪️Steered');
    expect(renderText(s)).toContain('已插话');
  });
});
