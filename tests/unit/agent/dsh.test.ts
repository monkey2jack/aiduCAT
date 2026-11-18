import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDshArgs,
  isSafeDshSessionId,
  isDshPermissionPreset,
  DSH_PERMISSION_PRESETS,
  DSH_UNATTENDED_APPROVAL,
} from '../../../src/agent/dsh/argv.js';
import { resolveTurnPatch } from '../../../src/agent/dsh/adapter.js';
import { DshStreamTranslator } from '../../../src/agent/dsh/jsonl.js';
import { dshCapability, usesSessionId } from '../../../src/agent/capability.js';

// f0.5++: DSH (DeepSeek Harness) adapter — headless --json protocol mapping.
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

  it('places the model overlay before the app arguments', () => {
    // --patch is a launcher flag: it must precede --json, because everything
    // after the launcher flags reaches the headless runner, which would reject
    // an unknown `--patch` option and end the turn.
    const args = buildDshArgs({
      patch: resolve('dsh-model.yml'),
      permissionMode: 'workspace-write',
      approvalPolicy: 'never',
    });
    expect(args.indexOf('--patch')).toBeGreaterThan(args.indexOf('--profile'));
    expect(args.indexOf('--patch')).toBeLessThan(args.indexOf('--json'));
    // A relative path is refused: the child may run in a different cwd.
    expect(() => buildDshArgs({ patch: 'relative.yml' })).toThrow(/patch path/);
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

describe('dsh private patch (p2p only — 真假猴王 fix)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
  });

  async function tempDir(): Promise<string> {
    const { realpath } = await import('node:fs/promises');
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'dsh-priv-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  async function fixture(dir: string, name: string, body: string): Promise<string> {
    const file = join(dir, name);
    await writeFile(file, body, 'utf8');
    return file;
  }

  const MODEL = '- id: agent-default-model\n  config:\n    model: "GLM-5.3-Flash"\n';
  const PRIVATE = '# private overlay\n- insert:\n    - id: mcp-aidumei\n';

  it('never rides on group/topic/non-IM turns, even when configured', async () => {
    const dir = await tempDir();
    const priv = await fixture(dir, 'private.yml', PRIVATE);
    const model = await fixture(dir, 'GLM-5.3-Flash.yml', MODEL);
    const mergedDir = join(dir, 'merged');
    expect(
      resolveTurnPatch({
        modelPatch: model,
        privatePatchPath: priv,
        isPrivate: false,
        turnPatchDir: mergedDir,
      }),
    ).toEqual({ patch: model, privateApplied: false });
    // A group turn must not even create the merge directory.
    expect(existsSync(mergedDir)).toBe(false);
  });

  it('passes the private overlay straight through on a p2p turn', async () => {
    const dir = await tempDir();
    const priv = await fixture(dir, 'private.yml', PRIVATE);
    // No per-turn rewrite: the static file is handed to --patch as-is.
    expect(
      resolveTurnPatch({
        modelPatch: undefined,
        privatePatchPath: priv,
        isPrivate: true,
        turnPatchDir: join(dir, 'merged'),
      }),
    ).toEqual({ patch: priv, privateApplied: true });
  });

  it('merges the model overlay and the private patch into one stable file', async () => {
    const dir = await tempDir();
    const priv = await fixture(dir, 'private.yml', PRIVATE);
    const model = await fixture(dir, 'GLM-5.3-Flash.yml', MODEL);
    const mergedDir = join(dir, 'merged');
    const first = resolveTurnPatch({
      modelPatch: model,
      privatePatchPath: priv,
      isPrivate: true,
      turnPatchDir: mergedDir,
    });
    expect(first.privateApplied).toBe(true);
    // One --patch flag, both documents — model rows first, directives after,
    // the same shape the desktop profile's own patch uses.
    const merged = readFileSync(first.patch!, 'utf8');
    expect(merged.indexOf('- id: agent-default-model')).toBeLessThan(merged.indexOf('- insert:'));
    // Stable name: a long-lived deployment does not accumulate files.
    const again = resolveTurnPatch({
      modelPatch: model,
      privatePatchPath: priv,
      isPrivate: true,
      turnPatchDir: mergedDir,
    });
    expect(again.patch).toBe(first.patch);
  });

  it('soft-fails to the model patch when the private file is missing', async () => {
    const dir = await tempDir();
    const model = await fixture(dir, 'GLM-5.3-Flash.yml', MODEL);
    expect(
      resolveTurnPatch({
        modelPatch: model,
        privatePatchPath: join(dir, 'nope.yml'),
        isPrivate: true,
        turnPatchDir: join(dir, 'merged'),
      }),
    ).toEqual({ patch: model, privateApplied: false });
  });

  it('cannot merge without a turn-patch directory and says so', async () => {
    const dir = await tempDir();
    const priv = await fixture(dir, 'private.yml', PRIVATE);
    const model = await fixture(dir, 'GLM-5.3-Flash.yml', MODEL);
    expect(
      resolveTurnPatch({
        modelPatch: model,
        privatePatchPath: priv,
        isPrivate: true,
        turnPatchDir: undefined,
      }),
    ).toEqual({ patch: model, privateApplied: false });
  });
});
