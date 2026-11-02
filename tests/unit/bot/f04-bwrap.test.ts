import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bwrapMissingHint } from '../../../src/agent/claude/bwrap-check.js';
import { buildNonOwnerSettings } from '../../../src/agent/claude/owner-only-settings.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { PreRunError, preRunFailureText } from '../../../src/bot/channel.js';
import {
  AGENT_FAILED_PUBLIC_NOTICE,
  PRE_RUN_FAILED_PUBLIC_NOTICE,
  briefAgentError,
  errorAudienceOf,
  presentAgentErrors,
  userFacingAgentError,
} from '../../../src/bot/user-facing-error.js';
import { answerPlainText } from '../../../src/card/run-renderer.js';
import { initialState, reduce } from '../../../src/card/run-state.js';

const RAW =
  'claude exited with code 1: Claude Code could not start: bubblewrap is required for subprocess env scrubbing and isolation. Install with: sudo apt-get install -y bubblewrap, set sandbox.bwrapPath in managed settings, or set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0 to disable (loses subprocess isolation).';

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
async function* from(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  yield* events;
}

describe('f04-bwrap user-facing agent errors', () => {
  it('only the owner in a private chat is the owner-dm audience', () => {
    expect(errorAudienceOf({ ok: true, reason: 'owner' }, 'p2p')).toBe('owner-dm');
    expect(errorAudienceOf({ ok: true, reason: 'owner' }, 'group')).toBe('public');
    expect(errorAudienceOf({ ok: true, reason: 'allowed-chat' }, 'group')).toBe('public');
    expect(errorAudienceOf({ ok: true, reason: 'allowed-user' }, 'p2p')).toBe('public');
    expect(errorAudienceOf({ ok: true, reason: 'allowed-admin' }, 'p2p')).toBe('public');
    expect(errorAudienceOf(undefined, 'p2p')).toBe('public');
  });

  it('public gets the fixed notice; owner gets one short line', () => {
    expect(userFacingAgentError(RAW, 'public')).toBe(AGENT_FAILED_PUBLIC_NOTICE);
    const owner = userFacingAgentError(RAW, 'owner-dm');
    expect(owner).toContain('bubblewrap');
    expect(owner).not.toContain('apt-get');
    expect(owner).not.toContain('exited with code');
    const other = briefAgentError(`claude exited with code 2: ${'x'.repeat(400)}\nsecond line`);
    expect(other.startsWith('claude 进程异常退出（code 2）')).toBe(true);
    expect(other.length).toBeLessThanOrEqual(160);
    expect(other).not.toContain('\n');
  });

  it('presentAgentErrors rewrites failed errors only; card state never carries the raw text', async () => {
    const events: AgentEvent[] = [
      { type: 'text', delta: 'hi' },
      { type: 'error', message: RAW, terminationReason: 'failed' },
    ];
    const out = await collect(presentAgentErrors(from(events), 'public'));
    expect(out[0]).toEqual(events[0]);
    expect(out[1]).toMatchObject({ type: 'error', message: AGENT_FAILED_PUBLIC_NOTICE, terminationReason: 'failed' });

    const passthrough: AgentEvent[] = [
      { type: 'error', message: 'stopped', terminationReason: 'interrupted' },
      { type: 'error', message: 'idle', terminationReason: 'timeout' },
      { type: 'done', terminationReason: 'normal' },
    ];
    expect(await collect(presentAgentErrors(from(passthrough), 'public'))).toEqual(passthrough);

    let state = initialState;
    for (const e of await collect(presentAgentErrors(from([events[1]!]), 'public'))) state = reduce(state, e);
    expect(state.terminal).toBe('error');
    expect(answerPlainText(state)).toContain(AGENT_FAILED_PUBLIC_NOTICE);
    expect(answerPlainText(state)).not.toContain('bubblewrap');
  });

  it('pre-run failure: public gets the notice, owner keeps the reason', () => {
    const err = new PreRunError('run-setup', new Error('EACCES: permission denied, open /secret/path'));
    expect(preRunFailureText(err, 'public')).toBe(PRE_RUN_FAILED_PUBLIC_NOTICE);
    expect(preRunFailureText(err, 'public')).not.toContain('/secret/path');
    expect(preRunFailureText(err, 'owner-dm')).toContain('EACCES');
  });

  it('isolation is not switched off: non-owner settings still set SCRUB=1', () => {
    const s = buildNonOwnerSettings({ configDir: '/x/.claude', settingsEnvNames: [], home: '/x' });
    expect(s.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
  });

  it('startup check: warns only on Linux when bwrap is not on PATH', () => {
    expect(bwrapMissingHint('darwin', '')).toBeUndefined();
    expect(bwrapMissingHint('linux', '')).toMatch(/bubblewrap/);
    const dir = mkdtempSync(join(tmpdir(), 'f04-bwrap-path-'));
    try {
      writeFileSync(join(dir, 'bwrap'), '#!/bin/sh\n');
      chmodSync(join(dir, 'bwrap'), 0o755);
      expect(bwrapMissingHint('linux', dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CHANGELOG has the fix under 「f0.4 之后的修复」', () => {
    const changelog = readFileSync(join(__dirname, '../../../CHANGELOG.md'), 'utf8');
    const section = changelog.slice(changelog.indexOf('f0.4 之后的修复'));
    expect(section).toMatch(/bubblewrap/);
  });
});
