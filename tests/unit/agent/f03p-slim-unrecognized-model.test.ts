import { describe, expect, it } from 'vitest';
import { classifyClaudeStderrLine, createClaudeStderrClassifier } from '../../../src/agent/claude/adapter';

const line = (m: string) => `[claude-code:unrecognized_model] {"model":"${m}","query_source":"sdk"}`;

describe('f03p-slim-#8 Claude Code unrecognized_model notice', () => {
  it('f03p-slim-#8 logged once per model per bridge process, then dropped', () => {
    const c = createClaudeStderrClassifier();
    expect(c(line('Gemini-3.8-Flash'))).toBe('info');
    expect(c(line('Gemini-3.8-Flash'))).toBe('skip');
    expect(c(line('Gemini-3.8-Flash'))).toBe('skip');
    expect(c(line('GPT-6'))).toBe('info');
    expect(c('[claude-code:unrecognized_model] not-json')).toBe('info');
  });

  it('f03p-slim-#8 other stderr lines stay warnings; blank lines are skipped', () => {
    const c = createClaudeStderrClassifier();
    expect(c('Error: something broke')).toBe('warn');
    expect(c('Error: something broke')).toBe('warn');
    expect(c('   ')).toBe('skip');
  });

  it('f03p-slim-#8 the module-level classifier is shared across runs (one adapter process)', () => {
    const m = `Model-${Date.now()}`;
    expect(classifyClaudeStderrLine(line(m))).toBe('info');
    expect(classifyClaudeStderrLine(line(m))).toBe('skip');
  });
});
