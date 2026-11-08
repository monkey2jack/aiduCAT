import { describe, expect, it } from 'vitest';
import { holdEmptyDone } from '../../../src/agent/claude/hold-empty-done.js';
import type { AgentEvent } from '../../../src/agent/types.js';

const done = (sessionId = 's'): AgentEvent => ({ type: 'done', sessionId, terminationReason: 'normal' });
const text = (delta: string): AgentEvent => ({ type: 'text', delta });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Yields each [delayMs, event] after its delay; `hangMs` keeps it open at the end. */
async function* source(steps: Array<[number, AgentEvent]>, hangMs = 0): AsyncGenerator<AgentEvent> {
  for (const [ms, evt] of steps) {
    if (ms) await sleep(ms);
    yield evt;
  }
  if (hangMs) await sleep(hangMs);
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** What a consumer sees up to (and including) the first done. */
async function untilDone(gen: AsyncGenerator<AgentEvent>): Promise<{ events: AgentEvent[]; atMs: number }> {
  const t0 = Date.now();
  const events: AgentEvent[] = [];
  for await (const e of gen) {
    events.push(e);
    if (e.type === 'done') break;
  }
  return { events, atMs: Date.now() - t0 };
}

describe('holdEmptyDone (prod 2026-11-08: empty result from a task-notification ended the turn)', () => {
  it('a normal turn (text, then done) passes through unchanged', async () => {
    const out = await collect(holdEmptyDone(source([[0, text('hi')], [0, done()]]), { holdMs: 1000 }));
    expect(out).toEqual([text('hi'), done()]);
  });

  it('empty done followed by the real answer: the first done is dropped, the turn ends after the answer', async () => {
    const gen = holdEmptyDone(
      source([
        [0, done('first')],
        [30, { type: 'thinking', delta: 'hm' }],
        [0, text('answer')],
        [0, done('second')],
      ]),
      { holdMs: 1000 },
    );
    const { events } = await untilDone(gen);
    expect(events).toEqual([{ type: 'thinking', delta: 'hm' }, text('answer'), done('second')]);
  });

  it('empty done and claude exits: the done is released when the stream ends', async () => {
    const out = await collect(holdEmptyDone(source([[0, done('only')]]), { holdMs: 5000 }));
    expect(out).toEqual([done('only')]);
  });

  it('empty done and claude neither continues nor exits: released after holdMs', async () => {
    const { events, atMs } = await untilDone(holdEmptyDone(source([[0, done('stuck')]], 2000), { holdMs: 80 }));
    expect(events).toEqual([done('stuck')]);
    expect(atMs).toBeGreaterThanOrEqual(70);
    expect(atMs).toBeLessThan(1500);
  });

  it('usage before an empty done is still forwarded', async () => {
    const usage: AgentEvent = { type: 'usage', outputTokens: 0, cumulative: true };
    const out = await collect(
      holdEmptyDone(source([[0, usage], [0, done('a')], [0, text('x')], [0, done('b')]]), { holdMs: 1000 }),
    );
    expect(out).toEqual([usage, text('x'), done('b')]);
  });

  it('a done after a tool call is not held', async () => {
    const tool: AgentEvent = { type: 'tool_use', id: 't1', name: 'Bash', input: {} };
    const { events, atMs } = await untilDone(holdEmptyDone(source([[0, tool], [0, done()]], 2000), { holdMs: 1500 }));
    expect(events).toEqual([tool, done()]);
    expect(atMs).toBeLessThan(500);
  });
});
