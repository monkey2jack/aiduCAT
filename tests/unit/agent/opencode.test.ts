import { describe, expect, it } from 'vitest';
import { buildOpencodeArgs, isSafeOpencodeSessionId } from '../../../src/agent/opencode/argv';
import { OpencodeStreamTranslator } from '../../../src/agent/opencode/jsonl';

describe('buildOpencodeArgs', () => {
  it('builds standard args with run, format and auto', () => {
    const args = buildOpencodeArgs({});
    expect(args).toEqual(['run', '--format', 'json', '--auto', '--thinking']);
  });

  it('includes session id when valid', () => {
    const args = buildOpencodeArgs({ sessionId: 'ses_12345' });
    expect(args).toContain('-s');
    expect(args).toContain('ses_12345');
  });

  it('rejects invalid session id', () => {
    expect(() => buildOpencodeArgs({ sessionId: '../escape' })).toThrow(/invalid opencode session id/);
  });

  it('includes model flag when specified', () => {
    const args = buildOpencodeArgs({ model: 'opencode/hy4-flash-free' });
    expect(args).toContain('-m');
    expect(args).toContain('opencode/hy4-flash-free');
  });

  it('appends effort to model flag when specified', () => {
    const args = buildOpencodeArgs({ model: 'opencode/hy4-flash-free', effort: 'high' });
    expect(args).toContain('-m');
    expect(args).toContain('opencode/hy4-flash-free#high');
  });

  it('configures attach with password and username', () => {
    const args = buildOpencodeArgs({
      attach: 'http://127.0.0.1:7737',
      password: 'secret',
      username: 'opencode',
    });
    expect(args).toContain('--attach');
    expect(args).toContain('http://127.0.0.1:7737');
    expect(args).toContain('-p');
    expect(args).toContain('secret');
    expect(args).toContain('-u');
    expect(args).toContain('opencode');
  });
});

describe('OpencodeStreamTranslator', () => {
  it('translates step_start to system event on first turn', () => {
    const translator = new OpencodeStreamTranslator();
    const events = translator.translate({
      type: 'step_start',
      timestamp: 1000,
      sessionID: 'ses_abc123',
      part: { id: 'prt_1', messageID: 'msg_1', type: 'step-start' },
    });
    expect(events).toEqual([
      { type: 'system', sessionId: 'ses_abc123' },
      { type: 'thinking', delta: '' },
    ]);
  });

  it('translates text delta', () => {
    const translator = new OpencodeStreamTranslator();
    translator.translate({ type: 'step_start', sessionID: 'ses_1' });
    const events = translator.translate({
      type: 'text',
      timestamp: 1005,
      sessionID: 'ses_1',
      part: { type: 'text', text: 'Hello, World!' },
    });
    expect(events).toEqual([{ type: 'text', delta: 'Hello, World!' }]);
  });

  it('translates tool_use and tool_result', () => {
    const translator = new OpencodeStreamTranslator();
    translator.translate({ type: 'step_start', sessionID: 'ses_1' });
    const events = translator.translate({
      type: 'tool_use',
      timestamp: 1010,
      sessionID: 'ses_1',
      part: {
        type: 'tool',
        tool: 'read',
        callID: 'call_99',
        state: {
          status: 'completed',
          input: { filePath: '/tmp/test' },
          output: 'file contents',
        },
      },
    });
    expect(events).toEqual([
      {
        type: 'tool_use',
        id: 'call_99',
        name: 'read',
        input: { filePath: '/tmp/test' },
      },
      {
        type: 'tool_result',
        id: 'call_99',
        output: 'file contents',
        isError: false,
      },
    ]);
  });

  it('translates step_finish usage and captures final stop', () => {
    const translator = new OpencodeStreamTranslator();
    translator.translate({ type: 'step_start', sessionID: 'ses_1' });
    translator.translate({
      type: 'text',
      sessionID: 'ses_1',
      part: { type: 'text', text: 'All done.' },
    });

    const stepFinishEvent = {
      type: 'step_finish',
      timestamp: 1020,
      sessionID: 'ses_1',
      part: {
        reason: 'stop',
        messageID: 'msg_1',
        tokens: {
          total: 100,
          input: 80,
          output: 20,
          reasoning: 5,
          cache: { read: 30, write: 0 },
        },
        cost: 0.002,
      },
    };

    const events = translator.translate(stepFinishEvent);
    expect(events).toEqual([
      {
        type: 'usage',
        inputTokens: 80,
        outputTokens: 20,
        cachedInputTokens: 30,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 5,
        costUsd: 0.002,
      },
    ]);

    const final = translator.consumeFinal(stepFinishEvent);
    expect(final).toEqual({
      sessionId: 'ses_1',
      reasonKind: 'stop',
      text: 'All done.',
    });
  });

  it('translates error events', () => {
    const translator = new OpencodeStreamTranslator();
    const events = translator.translate({
      type: 'error',
      message: 'Rate limit exceeded',
    });
    expect(events).toEqual([
      {
        type: 'error',
        message: 'Rate limit exceeded',
        terminationReason: 'failed',
      },
    ]);
    expect(translator.errorFromStream()).toBe('Rate limit exceeded');
  });
});
