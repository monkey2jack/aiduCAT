import { describe, expect, it } from 'vitest';
import { LOADING_IMG_KEY, renderCard } from '../../../src/card/run-renderer.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';

// f0.3.6: the received placeholder has no panel; header tests use a running
// state the agent has already started on (answer streaming).
const started: RunState = { ...initialState, footer: 'streaming' };

/** Extract the collapsible_panel header title markdown from a rendered card. */
function panelTitle(card: object): string {
  const json = JSON.stringify(card);
  const m = json.match(/"title":\{"tag":"markdown","content":"((?:[^"\\]|\\.)*)"/);
  if (!m) throw new Error(`no panel title in card: ${json.slice(0, 200)}`);
  return JSON.parse(`"${m[1]}"`);
}

/** f0.4+ (revised 11-04 00:44): the status word is a flush-left markdown
 *  line right above the panel; the received placeholder is the panel title. */
function statusLine(card: object): string | null {
  // f0.4++ (Wei 2026-11-06): a column_set「word [loading dots]」— no「…」text.
  type Row = { tag: string; columns?: Array<{ elements: Array<{ tag: string; content?: string; icon?: { img_key?: string } }> }> };
  const els = (card as { body: { elements: Row[] } }).body.elements;
  const row = els.find((e) => e.tag === 'column_set' && e.columns?.[1]?.elements[0]?.icon?.img_key === LOADING_IMG_KEY);
  return row ? row.columns![0]!.elements[0]!.content! : null;
}

describe('one-line minimal panel header (f0.2+ 猴哥点单 2026-10-20)', () => {
  it('modelID · 💭n · 🛠️n · ⏱️ns — one line, no effort/ctx', () => {
    const card = renderCard(started, {
      model: 'Gemini-3.8-Flash',
      effort: 'max',
      contextWindow: 1048576,
      startedAt: Date.now() - 5_000,
    });
    expect(panelTitle(card)).toBe('Gemini-3.8-Flash · 💭 0 · 🛠️ 0 · ⏱️ 5s');
    expect(panelTitle(card)).not.toContain('25k/1M');
    expect(panelTitle(card)).not.toContain('Max');
  });

  it('counts reflect thinking segments / tool blocks and ticking elapsed', () => {
    let state = reduce(initialState, { type: 'thinking', delta: 'a' });
    state = reduce(state, { type: 'thinking', delta: 'b' });
    state = reduce(state, { type: 'tool_use', id: 't1', name: 'Bash', input: {} });
    const card = renderCard(state, { model: 'M', startedAt: Date.now() - 2_000 });
    const title = panelTitle(card);
    expect(title).toContain('💭 1');
    expect(title).toContain('🛠️ 1');
    expect(title).toContain('⏱️ 2s');
  });

  it('elapsed formats as m+s past the minute', () => {
    const card = renderCard(started, { model: 'M', startedAt: Date.now() - 65_000 });
    expect(panelTitle(card)).toContain('⏱️ 1m5s');
  });
});

describe('status word flush-left above the panel (f0.4+, no ☤)', () => {
  it('f0.3.5: default running state (placeholder) renders aiduCATing [dots], no panel', () => {
    const card = renderCard(initialState, { model: 'M' });
    expect(statusLine(card)).toBe('☤aiduCATing');
    expect(JSON.stringify(card)).not.toContain('collapsible_panel');
  });

  it('thinking renders Thinking…', () => {
    const state = reduce(initialState, { type: 'thinking', delta: 'hmm' });
    const card = renderCard(state, { model: 'M' });
    expect(statusLine(card)).toBe('☤Thinking');
  });

  it('tool running renders Running…', () => {
    const state = reduce(initialState, { type: 'tool_use', id: 't1', name: 'Bash', input: {} });
    const card = renderCard(state, { model: 'M' });
    expect(statusLine(card)).toBe('☤Running');
  });

  it('no status line once the run ends', () => {
    const state = reduce(initialState, { type: 'done', terminationReason: 'normal' });
    const card = renderCard(state, { model: 'M' });
    expect(statusLine(card)).toBeNull();
  });

  it('old words Reasoning/Tooling no longer appear in user-facing text', () => {
    const state = reduce(initialState, { type: 'tool_use', id: 't1', name: 'Bash', input: {} });
    const json = JSON.stringify(renderCard(state, { model: 'M' }));
    expect(json).not.toContain('Tooling');
    expect(json).not.toContain('Reasoning...');
  });
});
