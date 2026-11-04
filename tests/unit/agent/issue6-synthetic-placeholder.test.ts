import { describe, expect, it } from 'vitest';
import { translateEvent } from '../../../src/agent/claude/stream-json.js';

// issue #6 (iMissNan): gateway models end a turn on a tool call; Claude Code
// then emits its own "No response requested." (model <synthetic>), which used
// to land on the card as the answer.

const asst = (text: string, extra: Record<string, unknown> = {}, model = '<synthetic>') => ({
  type: 'assistant',
  message: { model, content: [{ type: 'text', text }] },
  ...extra,
});
const texts = (raw: unknown) => [...translateEvent(raw)].filter((e) => e.type === 'text');

describe('issue #6 synthetic placeholder', () => {
  it('drops Claude Code\'s「No response requested.」placeholder', () => {
    expect(texts(asst('No response requested.'))).toEqual([]);
    expect(texts(asst('  no response requested \n'))).toEqual([]);
  });
  it('keeps synthetic API errors visible', () => {
    expect(texts(asst('API Error: 401 key required', { isApiErrorMessage: true }))).toHaveLength(1);
    expect(texts(asst('No response requested.', { isApiErrorMessage: true }))).toHaveLength(1);
  });
  it('keeps the same words from a real model', () => {
    expect(texts(asst('No response requested.', {}, 'gemini-3.8-flash'))).toHaveLength(1);
  });
  it('keeps other synthetic text', () => {
    expect(texts(asst('Not logged in · Please run /login'))).toHaveLength(1);
  });
});
