import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import { initialState, reduce, type RunState } from '../../../src/card/run-state';
import { renderCard } from '../../../src/card/run-renderer';

// f031-stab-#6 (upstream PR #148 idea, issue #147, hand-ported): some
// gateway models (GLM / Kimi / DeepSeek via 10router) leak their reasoning
// into the text stream — "<think>…</think>" or just a dangling "</think>"
// after the reasoning. Only the answer may reach the card.

const RT_CLOSE = '</' + 'redacted_' + 'thinking>';

function run(deltas: string[], extra: AgentEvent[] = []): RunState {
  let s = initialState;
  for (const d of deltas) s = reduce(s, { type: 'text', delta: d } as AgentEvent);
  for (const e of extra) s = reduce(s, e);
  return reduce(s, { type: 'done', terminationReason: 'normal' } as AgentEvent);
}

function answer(s: RunState): string {
  return s.blocks.filter((b) => b.kind === 'text').map((b) => (b as { content: string }).content).join('|');
}

describe('f031-stab-#6-148 leaked thinking is filtered out of the answer', () => {
  it('f031-stab-#6-148 a dangling </think> drops the reasoning before it', () => {
    const s = run(['好的，用户想要', '一个总结。我先想想……', '</think>', '\n\n这是总结：ANSWER']);
    expect(answer(s)).not.toContain('用户想要');
    expect(answer(s)).not.toContain('</think>');
    expect(answer(s)).toContain('ANSWER');
  });

  it('f031-stab-#6-148 a full <think>…</think> block split across deltas is removed', () => {
    const s = run(['<thi', 'nk>secret plan', ' more</th', 'ink>visible ANSWER']);
    expect(answer(s)).toBe('visible ANSWER');
  });

  it('f031-stab-#6-148 an unclosed <think> hides everything after it while streaming', () => {
    let s = initialState;
    s = reduce(s, { type: 'text', delta: 'intro <think>still thinking' } as AgentEvent);
    expect(JSON.stringify(renderCard(s))).not.toContain('still thinking');
  });

  it('f031-stab-#6-148 reasoning keeps hidden across deltas until the block closes', () => {
    let s = initialState;
    s = reduce(s, { type: 'text', delta: '<think>abc' } as AgentEvent);
    s = reduce(s, { type: 'text', delta: ' SECRET_DELTA' } as AgentEvent);
    expect(JSON.stringify(renderCard(s))).not.toContain('SECRET_DELTA');
    s = reduce(s, { type: 'text', delta: '</think>shown' } as AgentEvent);
    expect(answer(s)).toBe('shown');
  });

  it('f031-stab-#6-148 upstream case: English reasoning + </redacted_thinking> before a Chinese answer', () => {
    const s = run([
      "Let me proceed with the rewrite. I'll be efficient by using Edit",
      ' with substantial old_string replacements.',
      RT_CLOSE,
      '我对 PDF 里的 Table 1-6 实际结构有清楚了。',
    ]);
    expect(answer(s)).not.toContain('Let me proceed');
    expect(answer(s)).toContain('我对 PDF');
  });

  it('f031-stab-#6-148 final_text (gateway / codex) is cleaned the same way', () => {
    let s = initialState;
    s = reduce(s, { type: 'final_text', content: '<think>x</think>FINAL' } as AgentEvent);
    expect(s.finalText).toBe('FINAL');
  });

  it('f031-stab-#6-148 tags inside a fenced code block in the answer are left alone', () => {
    const code = '答案如下：\n```html\n<think>demo</think>\n```\n结束';
    const s = run([code]);
    expect(answer(s)).toBe(code);
  });
});
