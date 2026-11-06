import { describe, expect, it } from 'vitest';
import { LOADING_IMG_KEY, awaitingAgent, renderCard } from '../../../src/card/run-renderer.js';
import { initialState, markInterrupted, markEmptyRun, reduce, type RunState } from '../../../src/card/run-state.js';
import { statusCard, type StatusInfo } from '../../../src/card/templates.js';

// f0.3.6 (Wei 2026-11-02): two-stage placeholder. f0.4+ (Wei 2026-11-04):
// the placeholder is already a one-line panel「[icon] aiduCATing…」, ☤ gone — until the agent's first thinking / tool call / answer text;
// then the panel joins the same card. TPS is no longer on the card.

const json = (s: RunState, model = 'aiduPARK') => JSON.stringify(renderCard(s, { model, startedAt: Date.now() - 3_000 }));
const elements = (s: RunState) =>
  (renderCard(s, { model: 'aiduPARK', startedAt: Date.now() }) as { body: { elements: Array<{ tag: string; content?: string }> } }).body.elements;

describe('f0.3.6 two-stage placeholder card (f0.4+: panel from the start, no ☤)', () => {
  const panel = (s: RunState) => elements(s).find((e) => e.tag === 'collapsible_panel') as
    | { header: { title: { content: string }; icon: { tag: string }; vertical_align: string } }
    | undefined;

  it('received: exactly one element, 「aiduCATing [dots]」, no panel — no counters, no ☤', () => {
    const els = elements(initialState);
    // f0.4++ (Wei 2026-11-06): just「aiduCATing [loading dots]」, no panel
    expect(els).toHaveLength(1);
    expect(els[0]!.tag).toBe('column_set');
    expect(panel(initialState)).toBeUndefined();
    const j = json(initialState);
    expect(j).toContain('"content":"☤aiduCATing"');
    expect(j).toContain(LOADING_IMG_KEY);
    expect(j).not.toContain('💭');
    expect(j).toContain('"streaming_mode":true');
    expect(awaitingAgent(initialState)).toBe(true);
  });

  it('first thinking → Thinking… flush-left above a one-line panel', () => {
    const s = reduce(initialState, { type: 'thinking', delta: '想一想' });
    expect(awaitingAgent(s)).toBe(false);
    const els = elements(s);
    expect(els.map((e) => e.tag)).toEqual(['column_set', 'collapsible_panel']);
    expect(JSON.stringify(els[0])).toContain('"content":"☤Thinking"');
    const h = panel(s)!.header;
    expect(h.title.content).not.toContain('\n');
    expect(h.title.content).toContain('💭 1');
    expect(h.vertical_align).toBe('center');
  });

  it('first tool call → Processing… flush-left above the panel', () => {
    const s = reduce(initialState, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } });
    expect(elements(s).map((e) => e.tag)).toEqual(['column_set', 'collapsible_panel']);
    expect(JSON.stringify(elements(s)[0])).toContain('"content":"☤Processing"');
    expect(panel(s)!.header.title.content).not.toContain('Processing');
  });

  it('tool call hidden by group prefs (tool blocks filtered) still brings the panel', () => {
    const s = reduce(initialState, { type: 'tool_use', id: 't1', name: 'Bash', input: {} });
    const filtered = { ...s, blocks: s.blocks.filter((b) => b.kind !== 'tool') };
    expect(awaitingAgent(filtered)).toBe(false);
    expect(json(filtered)).toContain('🛠️ 0');
  });

  it('pure text turn: the panel appears together with the first answer text', () => {
    const s = reduce(initialState, { type: 'text', delta: '你好' });
    const els = elements(s);
    expect(els.map((e) => e.tag)).toEqual(['markdown', 'column_set', 'collapsible_panel']);
    expect(els[0]!.content).toBe('你好');
    expect(JSON.stringify(els[1])).toContain('"content":"☤aiduCATing"');
    const done = reduce(s, { type: 'done', terminationReason: 'normal' });
    const j = json(done);
    expect(j).toContain('collapsible_panel');
    expect(j).toContain('💭 0 · 🛠️ 0');
    expect(j).not.toContain('tok/s');
    // ended: back to one line, no status word
    expect(panel(done)!.header.title.content).not.toContain('aiduCATing');
    expect(panel(done)!.header.vertical_align).toBe('center');
  });

  it('final_text only (gateway) also ends the placeholder stage', () => {
    const s = reduce(initialState, { type: 'final_text', content: 'FINAL' });
    expect(awaitingAgent(s)).toBe(false);
    expect(json(s)).toContain('collapsible_panel');
  });

  it('terminal states keep the panel even with no agent output (⭕️Stop / ❌Error unchanged)', () => {
    const stopped = markInterrupted(initialState);
    expect(json(stopped)).toContain('collapsible_panel');
    expect(json(stopped)).toContain('"color":"yellow"');
    const empty = markEmptyRun(initialState);
    expect(json(empty)).toContain('collapsible_panel');
    expect(json(empty)).toContain('"color":"red"');
  });

  it('a running state that left received never goes back to no-panel', () => {
    let s = reduce(initialState, { type: 'thinking', delta: 'a' });
    s = reduce(s, { type: 'usage', outputTokens: 3 });
    expect(json(s)).toContain('collapsible_panel');
  });
});

describe('f0.3.6 TPS only in /status', () => {
  const info: StatusInfo = {
    profileName: 'claude', cwd: '/ws', sessionStale: false, agentName: 'Claude Code',
    runtimeAccess: { label: 'runtime', value: 'ok' }, activeRun: false, ownerState: 'idle',
    scope: 'oc_1', chatMode: 'p2p',
  };
  it('/status keeps the session-average ⚡ (same 口径)', () => {
    const st = { startedAt: Date.now(), tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreate: 0, userMessages: 0, agentMessages: 0 };
    expect(JSON.stringify(statusCard({ ...info, sessionStats: { ...st, tpsAvg: 62 } }))).toContain('⚡ 62 tok/s');
  });
  it('a finished card has no ⚡ even when the turn was measured', () => {
    const s = { ...reduce(reduce(initialState, { type: 'text', delta: 'x' }), { type: 'done', terminationReason: 'normal' }), turnTps: 59 } as RunState;
    expect(json(s)).not.toContain('⚡');
  });
});
