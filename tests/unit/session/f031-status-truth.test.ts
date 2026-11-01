import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { translateEvent } from '../../../src/agent/claude/stream-json';
import type { AgentEvent } from '../../../src/agent/types';
import { SessionStore } from '../../../src/session/store';
import { CLAUDE_USAGE_FIXTURE as F } from '../../helpers/claude-usage-fixture';

const dirs: string[] = [];
const stores: SessionStore[] = [];
afterEach(async () => {
  // let pending atomic writes land before removing their directory
  await Promise.all(stores.splice(0).map((s) => s.flush()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function store(): Promise<{ s: SessionStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'f031-status-'));
  dirs.push(dir);
  const path = join(dir, 'sessions.json');
  const s = new SessionStore(path);
  stores.push(s);
  s.set('chat-1', 'sess-1', '/ws');
  return { s, path };
}

function usageOf(raw: unknown): Extract<AgentEvent, { type: 'usage' }>[] {
  return [...translateEvent(raw)].filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');
}

/** Feed raw claude stream-json events through the same path channel.ts uses. */
function feed(s: SessionStore, raws: unknown[]): void {
  for (const raw of raws) for (const u of usageOf(raw)) s.recordUsage('chat-1', u);
}

describe('f031-#8 /status context = input + cache_read + cache_creation of the last main-line call', () => {
  it('f031-#8 counts cached prompt tokens, not just input_tokens', async () => {
    const { s } = await store();
    feed(s, [F.mainAssistant(F.calls[0]!), F.mainAssistant(F.calls[1]!)]);
    const last = F.calls[1]!;
    const expected = last.input_tokens + last.cache_read_input_tokens + last.cache_creation_input_tokens;
    expect(s.getRaw('chat-1')?.stats?.contextTokens).toBe(expected);
    // the old algorithm showed only input_tokens
    expect(expected).toBeGreaterThan(last.input_tokens * 5);
  });

  it('f031-#8 a sub-agent (sidechain) call never overwrites the main context', async () => {
    const { s } = await store();
    feed(s, [F.mainAssistant(F.calls[1]!), F.sidechainAssistant(F.subagentCall)]);
    const main = F.calls[1]!;
    expect(s.getRaw('chat-1')?.stats?.contextTokens).toBe(
      main.input_tokens + main.cache_read_input_tokens + main.cache_creation_input_tokens,
    );
  });

  it('f031-#8 the whole-turn result total never overwrites the context', async () => {
    const { s } = await store();
    feed(s, [F.mainAssistant(F.calls[1]!), F.result()]);
    const main = F.calls[1]!;
    expect(s.getRaw('chat-1')?.stats?.contextTokens).toBe(
      main.input_tokens + main.cache_read_input_tokens + main.cache_creation_input_tokens,
    );
  });

  it('f031-#8 an output-only message_delta (no input fields) keeps the context', async () => {
    const { s } = await store();
    feed(s, [
      F.mainAssistant(F.calls[1]!),
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', usage: { output_tokens: 812 } } },
    ]);
    const main = F.calls[1]!;
    expect(s.getRaw('chat-1')?.stats?.contextTokens).toBe(
      main.input_tokens + main.cache_read_input_tokens + main.cache_creation_input_tokens,
    );
  });

  it('f031-#8 cache-only usage (input_tokens 0) is not dropped by the zero filter', () => {
    expect(
      usageOf({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 90_000 } },
      }),
    ).toHaveLength(1);
  });
});

describe('f031-#9 /status counters survive a bot restart', () => {
  it('f031-#9 SessionStore.load keeps stats', async () => {
    const { s, path } = await store();
    s.recordMessage('chat-1', 'user');
    feed(s, [F.mainAssistant(F.calls[1]!), F.result()]);
    const before = s.getRaw('chat-1')?.stats;
    await s.flush();
    const reloaded = new SessionStore(path);
    stores.push(reloaded);
    await reloaded.load();
    const after = reloaded.getRaw('chat-1')?.stats;
    expect(after).toBeDefined();
    expect(after?.startedAt).toBe(before?.startedAt);
    expect(after?.contextTokens).toBe(before?.contextTokens);
    expect(after?.userMessages).toBe(1);
  });
});

describe('f031-#10 session totals come from each turn result (no per-snapshot guessing)', () => {
  it('f031-#10 📥/📤/🎯/TPS add up whole-turn result usage', async () => {
    const { s } = await store();
    // per-call snapshots arrive several times per call; they must not be summed
    feed(s, [F.mainAssistant(F.calls[0]!), F.mainAssistant(F.calls[0]!), F.mainAssistant(F.calls[1]!)]);
    feed(s, [F.result(), F.result()]);
    const r = F.turn;
    const st = s.getRaw('chat-1')?.stats;
    const inTurn = r.input_tokens + r.cache_read_input_tokens + r.cache_creation_input_tokens;
    expect(st?.tokensIn).toBe(inTurn * 2);
    expect(st?.tokensOut).toBe(r.output_tokens * 2);
    expect(st?.cacheRead).toBe(r.cache_read_input_tokens * 2);
    expect(st?.cacheCreate).toBe(r.cache_creation_input_tokens * 2);
    // f0.3.5: TPS is no longer derived from result (duration_api_ms is session-cumulative)
    expect(st?.tpsAvg).toBeUndefined();
  });

  it('f031-#10 a later call with a smaller output does not get lost', async () => {
    const { s } = await store();
    feed(s, [F.result({ output_tokens: 5000 }), F.result({ output_tokens: 300 })]);
    expect(s.getRaw('chat-1')?.stats?.tokensOut).toBe(5300);
  });
});

describe('f031-#11 user message counted even on a fresh scope', () => {
  it('f031-#11 first message of a never-seen scope is counted', async () => {
    const { s } = await store();
    s.recordMessage('chat-new', 'user');
    // no entry yet: channel reads "no entry" as first engagement (topic context)
    expect(s.getRaw('chat-new')).toBeUndefined();
    s.set('chat-new', 'sess-new', '/ws');
    expect(s.getRaw('chat-new')?.stats?.userMessages).toBe(1);
  });
});

describe('f031-#12 actual model reported by the CLI is remembered', () => {
  it('f031-#12 recordModel stores the init model', async () => {
    const { s } = await store();
    s.recordModel('chat-1', F.model);
    expect(s.getRaw('chat-1')?.stats?.model).toBe(F.model);
  });
});
