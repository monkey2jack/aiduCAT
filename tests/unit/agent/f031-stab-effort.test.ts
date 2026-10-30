import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// f031-stab-#15 (audit-quality #15): `--effort` was forwarded to the Claude
// CLI whatever the model was. Behind the 10router gateway a non-Claude model
// (Gemini-3.8-Flash, GPT, GLM, Kimi…) gets Anthropic effort/thinking settings
// it does not support. Only Claude models get --effort; others drop it (logged
// once per model). Dudu's Claude-Opus-4.6 keeps it — no behaviour change there.

const spawnMock = vi.hoisted(() => ({ spawnProcess: vi.fn() }));
vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import { ClaudeAdapter, isClaudeModelId } from '../../../src/agent/claude/adapter';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(child, {
    pid: 1,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: 0,
    signalCode: null,
    kill: vi.fn(),
  });
  return child;
}

function argsFor(opts: { model?: string; effort?: string; envOverrides?: Record<string, string> }): string[] {
  spawnMock.spawnProcess.mockReset();
  const child = fakeChild();
  spawnMock.spawnProcess.mockReturnValue(child);
  new ClaudeAdapter().run({ runId: 'r', prompt: 'hi', cwd: '/tmp', ...opts } as never);
  // f031 merge: end the fake child's lifecycle so the temp system-prompt dir is removed.
  child.emit('exit', 0, null);
  return spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
}

beforeEach(() => spawnMock.spawnProcess.mockReset());

describe('f031-stab-#15 --effort only for Claude models', () => {
  it('f031-stab-#15 non-Claude gateway model: no --effort', () => {
    for (const model of ['Gemini-3.8-Flash', 'gpt-5', 'glm-4.6', 'kimi-k2', 'deepseek-v3']) {
      expect(argsFor({ model, effort: 'max' })).not.toContain('--effort');
    }
  });

  it('f031-stab-#15 Claude models (ids, aliases, gateway names) keep --effort', () => {
    for (const model of ['Claude-Opus-4.6', 'claude-sonnet-4-6', 'opus', 'sonnet', 'haiku', 'opusplan', 'cu/claude-opus-5-5']) {
      const args = argsFor({ model, effort: 'high' });
      expect(args[args.indexOf('--effort') + 1]).toBe('high');
    }
  });

  it('f031-stab-#15 no --model: judged by ANTHROPIC_MODEL override, else assumed Claude', () => {
    expect(argsFor({ effort: 'high', envOverrides: { ANTHROPIC_MODEL: 'Gemini-3.8-Flash' } })).not.toContain('--effort');
    expect(argsFor({ effort: 'high' })).toContain('--effort');
  });

  it('f031-stab-#15 ultra still maps to max for Claude', () => {
    const args = argsFor({ model: 'claude-opus-4-8', effort: 'ultra' });
    expect(args[args.indexOf('--effort') + 1]).toBe('max');
  });

  it('f031-stab-#15 isClaudeModelId', () => {
    expect(isClaudeModelId(undefined)).toBe(true);
    expect(isClaudeModelId('Gemini-3.8-Flash')).toBe(false);
    expect(isClaudeModelId('Claude-Opus-4.6')).toBe(true);
  });
});
