import { describe, expect, it } from 'vitest';
import { PiStreamTranslator } from '../../../src/agent/pi/jsonl';
import { renderModelsJson, PI_API_KEY_ENV } from '../../../src/agent/pi/models-file';

describe('PiStreamTranslator', () => {
  it('maps text deltas to text events', () => {
    const t = new PiStreamTranslator();
    const out = t.translate({
      type: 'message_update',
      usage: { input: 10, output: 1 },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '你好' },
    });
    expect(out.some((e) => e.type === 'text' && e.delta === '你好')).toBe(true);
    expect(out.some((e) => e.type === 'usage')).toBe(true);
  });

  it('maps thinking deltas', () => {
    const t = new PiStreamTranslator();
    const out = t.translate({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '想…' },
    });
    expect(out).toEqual([{ type: 'thinking', delta: '想…' }]);
  });

  it('maps tool lifecycle', () => {
    const t = new PiStreamTranslator();
    const start = t.translate({
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: 'ls' },
    });
    expect(start[0]).toMatchObject({ type: 'tool_use', id: 'c1', name: 'bash' });
    const end = t.translate({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'ok' }] },
      isError: false,
    });
    expect(end[0]).toMatchObject({ type: 'tool_result', id: 'c1', output: 'ok', isError: false });
  });

  it('emits steer when the steering queue drains', () => {
    const t = new PiStreamTranslator();
    t.noteSteerQueued();
    expect(t.translate({ type: 'queue_update', steering: ['x'], followUp: [] })).toEqual([]);
    const out = t.translate({ type: 'queue_update', steering: [], followUp: [] });
    expect(out).toEqual([{ type: 'steer' }]);
  });

  it('maps agent_settled to done', () => {
    const t = new PiStreamTranslator();
    expect(t.translate({ type: 'agent_settled', aborted: false })).toEqual([
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(t.hasSettled).toBe(true);
    const t2 = new PiStreamTranslator();
    expect(t2.translate({ type: 'agent_settled', aborted: true })).toEqual([
      { type: 'done', terminationReason: 'interrupted' },
    ]);
  });

  it('maps assistant error message_end to error with callFinal usage', () => {
    const t = new PiStreamTranslator();
    const out = t.translate({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '401 unauthorized',
        usage: { input: 5, output: 0 },
      },
    });
    const usage = out.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ callFinal: true, inputTokens: 5 });
    expect(out.some((e) => e.type === 'error' && e.message === '401 unauthorized')).toBe(true);
  });
});

describe('pi models.json', () => {
  it('renders only curated combos with env-interpolated key', () => {
    const text = renderModelsJson({
      baseUrl: 'https://10r.example.com/v1',
      models: [
        { id: 'GLM-5.3-Flash', contextWindow: 1000000 },
        { id: 'Gemini-3.8-Flash' },
      ],
    });
    const parsed = JSON.parse(text);
    const prov = parsed.providers['10router'];
    expect(prov.apiKey).toBe(`$${PI_API_KEY_ENV}`);
    expect(prov.authHeader).toBe(true);
    expect(prov.models).toHaveLength(2);
    expect(prov.models[0]).toMatchObject({ id: 'GLM-5.3-Flash', contextWindow: 1000000, maxTokens: 32000 });
    expect(prov.models[1].maxTokens).toBe(32000);
    expect(text).not.toContain('sk-');
  });
});
