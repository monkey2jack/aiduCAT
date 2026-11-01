import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { translateEvent } from '../../../src/agent/claude/stream-json.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { statusCard, type StatusInfo } from '../../../src/card/templates.js';
import { renderCard } from '../../../src/card/run-renderer.js';
import { initialState, type RunState } from '../../../src/card/run-state.js';
import { SessionStore } from '../../../src/session/store.js';
import { MIN_GEN_MS, TurnTpsMeter } from '../../../src/session/turn-tps.js';
import { sanitizeCardMarkdown } from '../../../src/card/sanitize.js';

// f0.3.5: TPS = main-line output / model generation time timed by aiduCAT.
// Real-data fact (summer 嘟嘟, 2026-11-02): claude's duration_api_ms is
// session-cumulative on a resumed session; output_tokens in result is per turn.

function clocked() {
  let t = 1_000;
  const m = new TurnTpsMeter(() => t);
  return {
    m,
    at(ms: number, e: AgentEvent) {
      t = ms;
      m.observe(e);
    },
  };
}

const done: AgentEvent = { type: 'done', terminationReason: 'normal' };

describe('f035 TurnTpsMeter', () => {
  it('generation time excludes tool windows; output = Σ per-call finals', () => {
    const { m, at } = clocked();
    at(0, { type: 'system', sessionId: 's' });
    at(1_000, { type: 'thinking', delta: 'a' });
    at(2_000, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }); // gen 0→2000
    at(2_050, { type: 'usage', outputTokens: 100, callFinal: true }); // inside tool window
    at(60_000, { type: 'tool_result', id: 't1', output: '', isError: false }); // 58s tool
    at(61_000, { type: 'text', delta: 'b' });
    at(63_000, { type: 'usage', outputTokens: 300, callFinal: true }); // gen 60000→63000
    at(63_010, { type: 'usage', outputTokens: 400, cumulative: true });
    at(63_020, done);
    const r = m.finish();
    expect(r.genMs).toBe(2_000 + 3_000);
    expect(r.outputTokens).toBe(400);
    expect(r.tps).toBe(80);
  });

  it('parallel tools: the window lasts until the LAST one returns', () => {
    const { m, at } = clocked();
    at(0, { type: 'system' });
    at(1_000, { type: 'tool_use', id: 'a', name: 'Bash', input: {} });
    at(1_001, { type: 'tool_use', id: 'b', name: 'Read', input: {} });
    at(5_000, { type: 'tool_result', id: 'a', output: '', isError: false });
    at(9_000, { type: 'tool_result', id: 'b', output: '', isError: false });
    at(10_000, { type: 'usage', outputTokens: 200, callFinal: true });
    expect(m.finish().genMs).toBe(1_000 + 1_000);
  });

  it('sub-agent (sidechain) output and time never count (f031-#8 rule)', () => {
    const { m, at } = clocked();
    at(0, { type: 'system' });
    at(1_000, { type: 'tool_use', id: 'task', name: 'Task', input: {} });
    at(2_000, { type: 'text', delta: 'sub' });
    at(3_000, { type: 'usage', outputTokens: 9_999, callFinal: true, sidechain: true });
    at(30_000, { type: 'tool_result', id: 'task', output: '', isError: false });
    at(31_000, { type: 'usage', outputTokens: 100, callFinal: true });
    at(31_001, { type: 'usage', outputTokens: 10_099, cumulative: true }); // even if result included it
    const r = m.finish();
    expect(r.genMs).toBe(1_000 + 1_000);
    expect(r.outputTokens).toBe(100);
  });

  it('per-call sum larger than the turn total → the turn total wins (gateway double delta)', () => {
    const { m, at } = clocked();
    at(0, { type: 'system' });
    at(1_000, { type: 'usage', outputTokens: 500, callFinal: true });
    at(1_001, { type: 'usage', outputTokens: 500, callFinal: true });
    at(1_002, { type: 'usage', outputTokens: 500, cumulative: true });
    expect(m.finish().outputTokens).toBe(500);
  });

  it('no per-call finals (Codex / no partial messages) → whole-turn output', () => {
    const { m, at } = clocked();
    at(0, { type: 'system', threadId: 'th' });
    at(4_000, { type: 'final_text', content: 'x' });
    at(4_001, { type: 'usage', outputTokens: 800, cumulative: true });
    const r = m.finish();
    expect(r.outputTokens).toBe(800);
    expect(r.genMs).toBe(4_000);
    expect(r.tps).toBe(200);
  });

  it('nothing to divide → no tps (no invented number)', () => {
    const { m, at } = clocked();
    at(0, { type: 'system' });
    at(MIN_GEN_MS - 1, { type: 'usage', outputTokens: 3, callFinal: true });
    expect(m.finish().tps).toBeUndefined();
    const z = clocked();
    z.at(0, { type: 'system' });
    z.at(5_000, { type: 'text', delta: 'x' });
    expect(z.m.finish().tps).toBeUndefined();
  });
});

describe('f035 claude stream-json', () => {
  it('result no longer carries a duration; message_delta usage is a call final', () => {
    const res = [...translateEvent({
      type: 'result', subtype: 'success', session_id: 's', duration_ms: 99_000_000, duration_api_ms: 78_000_000,
      total_cost_usd: 70, usage: { input_tokens: 1, output_tokens: 2 },
    })];
    expect(res[0]).toMatchObject({ type: 'usage', cumulative: true, outputTokens: 2 });
    expect(res[0]).not.toHaveProperty('durationMs');
    const delta = [...translateEvent({
      type: 'stream_event', parent_tool_use_id: null,
      event: { type: 'message_delta', usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 9 } },
    })];
    expect(delta[0]).toMatchObject({ type: 'usage', outputTokens: 7, callFinal: true });
    const asst = [...translateEvent({
      type: 'assistant', parent_tool_use_id: null,
      message: { content: [], usage: { input_tokens: 5, output_tokens: 7 } },
    })];
    expect(asst[0]).not.toHaveProperty('callFinal');
  });
});

describe('f035 SessionStore TPS', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  async function mk() {
    const d = await mkdtemp(join(tmpdir(), 'f035-'));
    dirs.push(d);
    return join(d, 'sessions.json');
  }

  it('average = Σ output / Σ generation seconds; result usage alone never sets it', async () => {
    const s = new SessionStore(await mk());
    s.set('c', 'sess', '/ws');
    s.recordUsage('c', { outputTokens: 1_000, cumulative: true });
    expect(s.getRaw('c')?.stats?.tpsAvg).toBeUndefined();
    s.recordTurnTps('c', 1_000, 10_000);
    s.recordTurnTps('c', 3_000, 10_000);
    const st = s.getRaw('c')?.stats;
    expect(st?.tpsAvg).toBe(200);
    expect(st?.genOut).toBe(4_000);
    expect(st?.genMs).toBe(20_000);
    s.recordTurnTps('c', 0, 5_000); // nothing measured → ignored
    expect(s.getRaw('c')?.stats?.genMs).toBe(20_000);
    await s.flush(); // no write may land after the temp dir is removed
  });

  it('migration: the old wrong activeMs/tpsAvg (嘟嘟 78M ms → 4 tok/s) are dropped, other counters kept', async () => {
    const path = await mk();
    await writeFile(path, JSON.stringify({
      oc_x: {
        sessionId: 's', cwd: '/ws', updatedAt: 1,
        stats: {
          v: 2, startedAt: 1, tokensIn: 204_354_312, tokensOut: 280_526, cacheRead: 195_059_006, cacheCreate: 0,
          userMessages: 43, agentMessages: 40, activeMs: 78_227_379, tpsAvg: 4, contextTokens: 59_640,
        },
      },
    }));
    const s = new SessionStore(path);
    await s.load();
    const st = s.getRaw('oc_x')?.stats;
    expect(st?.tpsAvg).toBeUndefined();
    expect(st).not.toHaveProperty('activeMs');
    expect(st?.genMs).toBe(0);
    expect(st?.tokensOut).toBe(280_526);
    expect(st?.userMessages).toBe(43);
    expect(st?.contextTokens).toBe(59_640);
    s.recordTurnTps('oc_x', 600, 10_000);
    await s.flush();
    const saved = JSON.parse(await readFile(path, 'utf8')).oc_x.stats;
    expect(saved.tpsAvg).toBe(60);
    expect(saved.activeMs).toBeUndefined();
    const again = new SessionStore(path);
    await again.load();
    expect(again.getRaw('oc_x')?.stats?.tpsAvg).toBe(60);
  });
});

describe('f035 display', () => {
  const info: StatusInfo = {
    profileName: 'claude', cwd: '/ws', sessionStale: false, agentName: 'Claude Code',
    runtimeAccess: { label: 'runtime', value: 'ok' }, activeRun: false, ownerState: 'idle',
    scope: 'oc_1', chatMode: 'p2p',
  };
  it('/status shows — until a turn is measured, then the average', () => {
    expect(JSON.stringify(statusCard(info))).toContain('⚡ — tok/s');
    const st = { startedAt: Date.now(), tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreate: 0, userMessages: 0, agentMessages: 0 };
    expect(JSON.stringify(statusCard({ ...info, sessionStats: { ...st, tpsAvg: 57 } }))).toContain('⚡ 57 tok/s');
  });

  it('card panel shows ⚡ only once the turn is finished', () => {
    const base: RunState = { ...initialState, blocks: [{ kind: 'text', content: 'hi' }] as RunState['blocks'] };
    const running = JSON.stringify(renderCard({ ...base, turnTps: 42 }, { model: 'm' }));
    expect(running).not.toContain('tok/s');
    const finished = JSON.stringify(renderCard({ ...base, terminal: 'done', footer: null as never, turnTps: 42 }, { model: 'm' }));
    expect(finished).toContain('⚡ 42 tok/s');
    const unknown = JSON.stringify(renderCard({ ...base, terminal: 'done', footer: null as never }, { model: 'm' }));
    expect(unknown).not.toContain('tok/s');
  });
});

describe('f035 card mentions (groups use cards now)', () => {
  it('person mention → card form; @all still defused; other tags still stripped', () => {
    expect(sanitizeCardMarkdown('hi <at user_id="ou_a1">A</at>!')).toBe('hi <at id=ou_a1></at>!');
    expect(sanitizeCardMarkdown('<at id="ou_b2"></at>')).toBe('<at id=ou_b2></at>');
    expect(sanitizeCardMarkdown('<at user_id="all">所有人</at>')).toBe('@所有人');
    expect(sanitizeCardMarkdown('<div>x</div><at user_id="evil">e</at>')).toBe('xe');
    expect(sanitizeCardMarkdown('`<at user_id="ou_c">c</at>`')).toBe('`<at user_id="ou_c">c</at>`');
  });
});
