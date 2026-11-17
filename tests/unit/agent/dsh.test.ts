import { describe, expect, it } from 'vitest';
import {
  buildDshArgs,
  isSafeDshSessionId,
  isDshPermissionPreset,
  DSH_PERMISSION_PRESETS,
  DSH_UNATTENDED_APPROVAL,
} from '../../../src/agent/dsh/argv.js';
import { DshStreamTranslator } from '../../../src/agent/dsh/jsonl.js';
import { dshCapability, usesSessionId } from '../../../src/agent/capability.js';

// f0.6: DSH (DeepSeek Harness) adapter — headless --json protocol mapping.
//
// The event vocabulary asserted here mirrors DeepSeek Harness 0.2.2-rc.3
// (@deepseek-ai/dsh-headless/src/json-stream.ts), and the sample payloads are
// copied from a live `dsh --profile headless --json -` run.

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

  it('pins the access preset and the unattended approval policy', () => {
    expect(buildDshArgs({ permissionMode: 'workspace-write', approvalPolicy: 'never' })).toEqual([
      '--profile',
      'headless',
      '--json',
      '--permission-mode',
      'workspace-write',
      '--approval-policy',
      'never',
      '-',
    ]);
    // Both options are applied on resume too, so an unattended continuation
    // cannot silently inherit a looser saved selection.
    expect(
      buildDshArgs({ resume: 'session-x', permissionMode: 'read-only', approvalPolicy: 'never' }),
    ).toContain('--session-id');
  });

  it('maps aiduCAT access levels onto the exact DSH preset names', () => {
    // aiduCAT's CodexSandboxMode and DSH's shipped presets share these three
    // names; verified live — DSH aborts on any other value instead of falling
    // back, so the bridge only ever passes a member of this list.
    expect(DSH_PERMISSION_PRESETS).toEqual(['read-only', 'workspace-write', 'danger-full-access']);
    expect(isDshPermissionPreset('workspace-write')).toBe(true);
    expect(isDshPermissionPreset('danger-full-access')).toBe(true);
    expect(isDshPermissionPreset('workspace')).toBe(false);
    expect(isDshPermissionPreset(undefined)).toBe(false);
    expect(DSH_UNATTENDED_APPROVAL).toBe('never');
  });

  it('refuses a preset DSH would abort on', () => {
    expect(() => buildDshArgs({ permissionMode: 'bogus' as never })).toThrow(/permission preset/);
    expect(() => buildDshArgs({ approvalPolicy: 'sometimes' as never })).toThrow(/approval policy/);
  });
});

describe('dsh stream translator', () => {
  it('reports the session id and never emits it as a text event', () => {
    const t = new DshStreamTranslator();
    expect(t.translate({ type: 'session', sessionId: 's1', cwd: 'C:\\w' })).toEqual([]);
    expect(t.currentSessionId()).toBe('s1');
  });

  it('heartbeats on turn/step boundaries with an empty delta', () => {
    const t = new DshStreamTranslator();
    // Empty deltas keep the idle watchdog and the empty-run guard fed without
    // writing placeholder characters into the reasoning section.
    expect(t.translate({ type: 'status', phase: 'turn_start', turn: 1 })).toEqual([
      { type: 'thinking', delta: '' },
    ]);
    expect(t.translate({ type: 'status', phase: 'step_start', turn: 1, step: 1 })).toEqual([
      { type: 'thinking', delta: '' },
    ]);
    expect(t.translate({ type: 'status', phase: 'turn_end', turn: 1 })).toEqual([
      { type: 'thinking', delta: '' },
    ]);
  });

  it('maps committed reasoning and answer blocks', () => {
    const t = new DshStreamTranslator();
    expect(t.translate({ type: 'thinking', text: 'weighing options' })).toEqual([
      { type: 'thinking', delta: 'weighing options' },
    ]);
    expect(t.translate({ type: 'text', text: 'PROBE-OK' })).toEqual([
      { type: 'text', delta: 'PROBE-OK' },
    ]);
    // An empty block is not worth an event.
    expect(t.translate({ type: 'thinking', text: '' })).toEqual([]);
    expect(t.translate({ type: 'text', text: '' })).toEqual([]);
  });

  it('maps tool calls and their results, including failures', () => {
    const t = new DshStreamTranslator();
    expect(t.translate({ type: 'tool_call', callId: 'c1', tool: 'pwsh', input: { command: 'ls' } })).toEqual([
      { type: 'tool_use', id: 'c1', name: 'pwsh', input: { command: 'ls' } },
    ]);
    expect(
      t.translate({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'file.txt' }),
    ).toEqual([{ type: 'tool_result', id: 'c1', output: 'file.txt', isError: false }]);
    expect(
      t.translate({ type: 'tool_result', callId: 'c2', status: 'error', result: { code: 'EACCES' } }),
    ).toEqual([{ type: 'tool_result', id: 'c2', output: '{"code":"EACCES"}', isError: true }]);
  });

  it('maps step usage with claude semantics and never marks it cumulative', () => {
    const t = new DshStreamTranslator();
    // Live sample: input EXCLUDES cache reads (2267 + 4096 + 5 = total 6368),
    // so no codex-style subtraction applies. The card ignores cumulative
    // snapshots, so `cumulative` must stay unset for the context readout.
    const events = t.translate({
      type: 'status',
      phase: 'step_end',
      turn: 1,
      step: 1,
      usage: { inputTokens: 2267, outputTokens: 5, totalTokens: 6368, cacheReadTokens: 4096 },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'usage',
      inputTokens: 2267,
      outputTokens: 5,
      cachedInputTokens: 4096,
    });
    expect(events[0]).not.toHaveProperty('cumulative');
    // A step whose attempts could not all report usage omits it entirely.
    expect(t.translate({ type: 'status', phase: 'step_end', turn: 1, step: 2 })).toEqual([]);
  });

  it('captures the terminal reason kind so a null reason is distinguishable', () => {
    const t = new DshStreamTranslator();
    const ok = t.consumeFinal({
      type: 'final',
      sessionId: 's1',
      reason: { kind: 'completed' },
      text: 'answer',
    });
    expect(ok).toMatchObject({ sessionId: 's1', reasonKind: 'completed', text: 'answer' });
    expect(ok?.errorCode).toBeUndefined();

    // reason: null — the final turn never closed. The adapter must not treat
    // this as success, so the kind stays undefined rather than defaulting.
    const open = t.consumeFinal({ type: 'final', sessionId: 's1', reason: null, text: '' });
    expect(open?.reasonKind).toBeUndefined();
  });

  it('surfaces a failed final as an error payload', () => {
    const t = new DshStreamTranslator();
    const f = t.consumeFinal({
      type: 'final',
      sessionId: 's2',
      reason: { kind: 'error', error: { message: 'no API key', code: 'MISSING_CREDENTIAL' } },
    });
    expect(f?.reasonKind).toBe('error');
    expect(f?.errorCode).toBe('MISSING_CREDENTIAL');
    expect(f?.errorMessage).toBe('no API key');
  });

  it('keeps a usage-error message from a stream-level error event', () => {
    const t = new DshStreamTranslator();
    expect(t.translate({ type: 'error', message: 'unknown option --bogus' })).toEqual([]);
    expect(t.errorFromStream()).toBe('unknown option --bogus');
  });

  it('ignores non-protocol lines', () => {
    const t = new DshStreamTranslator();
    expect(t.translate('garbage')).toEqual([]);
    expect(t.translate(42)).toEqual([]);
    expect(t.consumeFinal({ type: 'status', phase: 'turn_start' })).toBeUndefined();
  });

  describe('terminal answer handling', () => {
    it('does not repeat an answer whose blocks already reconstruct it', () => {
      const t = new DshStreamTranslator();
      t.translate({ type: 'text', text: 'Hello ' });
      t.translate({ type: 'text', text: 'world' });
      expect(t.needsTerminalText('Hello world')).toBe(false);
    });

    it('asks for the terminal answer when nothing was streamed', () => {
      const t = new DshStreamTranslator();
      expect(t.needsTerminalText('only terminal')).toBe(true);
      expect(t.needsTerminalText('')).toBe(false);
    });

    it('drops a capped block and defers to the lossless terminal answer', () => {
      const t = new DshStreamTranslator();
      // Every non-terminal projected string is capped at 8 KiB and flagged;
      // showing the fragment would leave half an answer on the card.
      expect(t.translate({ type: 'text', text: 'partial fragment', truncated: true })).toEqual([]);
      expect(t.needsTerminalText('the whole answer')).toBe(true);
    });

    it('defers to the terminal answer when streamed blocks differ from it', () => {
      const t = new DshStreamTranslator();
      t.translate({ type: 'text', text: 'streamed' });
      expect(t.needsTerminalText('a different terminal answer')).toBe(true);
    });
  });
});

describe('dsh capability', () => {
  it('uses a dsh session and stdin prompt injection', () => {
    const cap = dshCapability({ permissions: { maxAccess: 'full' } } as never);
    expect(cap.agentId).toBe('dsh');
    expect(cap.sessionKind).toBe('dsh-session');
    expect(cap.promptInjection).toBe('stdin-prefix');
  });

  it('resumes DSH by session id', () => {
    // DSH adopts a persisted Session through `--session-id`, so it must be in
    // the sessionId family — a miss here silently drops multi-turn context.
    expect(usesSessionId('dsh')).toBe(true);
    expect(usesSessionId('claude')).toBe(true);
    expect(usesSessionId('hermes')).toBe(true);
    expect(usesSessionId('codex')).toBe(false);
  });
});

describe('dsh env overrides', () => {
  it('keeps AIDU_API_KEY but drops vendor key variables', async () => {
    // The exemption lives in dshSafeOverrides (adapter-internal), so assert its
    // observable contract via the source of truth: AIDU_API_KEY is read by name
    // in the DSH profile (apiKeyEnv), so dropping it breaks model routing and
    // DSH silently falls back to the built-in `deepseek-official` default.
    const fs = await import('node:fs');
    const src = fs.readFileSync(
      new URL('../../../src/agent/dsh/adapter.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain("k === 'AIDU_API_KEY'");
    // The filter must still drop everything that looks like a credential, or a
    // /model provider switch could leak keys into the DSH environment.
    expect(src).toContain('KEY|TOKEN|SECRET|PASS');
  });
});
