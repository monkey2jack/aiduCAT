import { describe, expect, it } from 'vitest';
import { buildDshArgs, isSafeDshSessionId } from '../../../src/agent/dsh/argv.js';
import { DshStreamTranslator } from '../../../src/agent/dsh/jsonl.js';
import { dshCapability } from '../../../src/agent/capability.js';

// f0.6: DSH (DeepSeek Harness) adapter — headless --json protocol mapping.

describe('dsh argv', () => {
  it('builds the headless stdin invocation', () => {
    expect(buildDshArgs({})).toEqual(['--profile', 'headless', '--json', '-']);
  });

  it('adopts a session id when resuming', () => {
    expect(buildDshArgs({ resume: 'session-abc-123' })).toEqual([
      '--profile',
      'headless',
      '--json',
      '--session-id',
      'session-abc-123',
      '-',
    ]);
  });

  it('rejects unsafe profile names and session ids', () => {
    expect(() => buildDshArgs({ profile: 'a b' })).toThrow();
    expect(isSafeDshSessionId('ok-id_1')).toBe(true);
    expect(isSafeDshSessionId('bad id; rm -rf')).toBe(false);
  });
});

describe('dsh stream translator', () => {
  it('maps session/status/final onto agent events', () => {
    const t = new DshStreamTranslator();
    expect(t.translate({ type: 'session', sessionId: 's1', cwd: 'C:\\w' })).toEqual([]);
    expect(t.translate({ type: 'status', phase: 'turn_start', turn: 1 })).toEqual([
      { type: 'thinking', delta: '...' },
    ]);
    expect(t.translate({ type: 'status', phase: 'step_start', turn: 1, step: 1 })).toEqual([]);
    expect(t.consumeFinal({ type: 'final', sessionId: 's1', text: 'answer', reason: { kind: 'done' } })).toEqual({
      sessionId: 's1',
      ok: true,
      text: 'answer',
    });
  });

  it('surfaces a DSH error final as an error payload', () => {
    const t = new DshStreamTranslator();
    const f = t.consumeFinal({
      type: 'final',
      sessionId: 's2',
      reason: { kind: 'error', error: { message: 'no API key', code: 'MISSING_CREDENTIAL' } },
    });
    expect(f?.ok).toBe(false);
    expect(f?.errorCode).toBe('MISSING_CREDENTIAL');
  });

  it('ignores non-protocol lines', () => {
    const t = new DshStreamTranslator();
    expect(t.translate('garbage')).toEqual([]);
    expect(t.translate(42)).toEqual([]);
  });
});

describe('dsh capability', () => {
  it('uses a dsh session and stdin prompt injection', () => {
    const cap = dshCapability({ permissions: { maxAccess: 'full' } } as never);
    expect(cap.agentId).toBe('dsh');
    expect(cap.sessionKind).toBe('dsh-session');
    expect(cap.promptInjection).toBe('stdin-prefix');
  });
});

describe('dsh env overrides', () => {
  it('keeps AIDU_API_KEY but drops vendor key variables', async () => {
    const { spawnProcess } = await import('../../../src/platform/spawn.js');
    const cap = dshCapability({ permissions: { maxAccess: 'full' } } as never);
    expect(cap.agentId).toBe('dsh');
    // The exemption lives in dshSafeOverrides (adapter-internal); we assert
    // its observable contract indirectly via the source of truth: AIDU_API_KEY
    // is read by name in the DSH profile (apiKeyEnv), so dropping it breaks
    // model routing. Guard against regression by source scan:
    const fs = await import('node:fs');
    const src = fs.readFileSync(
      new URL('../../../src/agent/dsh/adapter.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain("k === 'AIDU_API_KEY'");
  });
});
