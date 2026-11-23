import { describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import type { AgentAdapter, AgentEvent, AgentRun } from '../../../src/agent/types';

describe('RunExecutor policy runtime options', () => {
  it('passes policy sandbox and permission mode into each agent run', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-policy',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const execution = await executor.submit({
      scopeId: 'scope-policy',
      policy: policy({
        sandbox: 'workspace-write',
        permissionMode: 'acceptEdits',
      }),
    });

    expect(agent.runOptions[0]).toMatchObject({
      runId: 'run-policy',
      sandbox: 'workspace-write',
      permissionMode: 'acceptEdits',
    });

    await collect(execution.subscribe());
  });

  it('forwards provider envOverrides into the agent run options', async () => {
    const agent = new FakeAgentAdapter({
      events: [{ type: 'done', terminationReason: 'normal' }],
    });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-env',
      now: () => 1000,
      postDoneExitGraceMs: 10,
    });

    const execution = await executor.submit({
      scopeId: 'scope-env',
      policy: policy(),
      envOverrides: { ANTHROPIC_BASE_URL: 'https://gw.example.com' },
    });

    expect(agent.runOptions[0]).toMatchObject({
      envOverrides: { ANTHROPIC_BASE_URL: 'https://gw.example.com' },
    });

    await collect(execution.subscribe());
  });
});

describe('ending a wedged stream after process exit', () => {
  function setup() {
    let exited = false;
    const run: AgentRun = {
      runId: 'stuck',
      events: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<AgentEvent>>(() => {}) }) },
      stop: async () => {},
      waitForExit: async () => exited,
    };
    const agent = { id: 'claude', displayName: 'Claude', isAvailable: async () => true, run: () => run } as AgentAdapter;
    const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({ agent, activeRuns, pool: new ProcessPool(() => 1), now: () => 1000 });
    return { executor, activeRuns, markExited: () => { exited = true; } };
  }

  it('does not release a live process and releases a stuck stream after exit', async () => {
    const { executor, activeRuns, markExited } = setup();
    const execution = await executor.submit({ scopeId: 'stuck-scope', policy: policy() });
    const result = collect(execution.subscribe());
    expect(await execution.closeExitedStream()).toBe(false);
    expect(activeRuns.get('stuck-scope')).toBeDefined();
    markExited();
    expect(await execution.closeExitedStream()).toBe(true);
    expect(await result).toEqual([{ type: 'error', message: 'agent stream did not close after exit', terminationReason: 'timeout' }]);
    expect(activeRuns.get('stuck-scope')).toBeUndefined();
    expect(await execution.closeExitedStream()).toBe(false);
  });

  it('can abort before the first subscriber starts', async () => {
    const { executor, markExited } = setup();
    const execution = await executor.submit({ scopeId: 'before-subscribe', policy: policy() });
    markExited();
    expect(await execution.closeExitedStream()).toBe(true);
    expect((await collect(execution.subscribe())).length).toBe(1);
  });
});

describe('post-terminal settle (pi-exit-hang 2026-11-23)', () => {
  function longLivedRun(): AgentRun {
    // A long-lived rpc child: its turn settles (done) but the PROCESS never
    // exits on its own and waitForExit always reports "still alive".
    return {
      runId: 'long-lived',
      events: (async function* (): AsyncGenerator<AgentEvent, void, void> {
        yield { type: 'done', terminationReason: 'normal' };
        await new Promise(() => {}); // stream stays open, like pi rpc
      })(),
      stop: async () => {},
      waitForExit: async () => false,
    };
  }

  function agentOf(run: AgentRun): AgentAdapter {
    return { id: 'pi', displayName: 'pi', isAvailable: async () => true, run: () => run } as AgentAdapter;
  }

  it('requestExit path: terminal releases the scope right after the tiny adapter grace', async () => {
    // Idempotent like the real adapter: exitRequestAt guard means only the
    // first call delivers; later calls are no-ops returning true.
    let deliveries = 0;
    let calls = 0;
    const run: AgentRun = {
      ...longLivedRun(),
      requestExit: async () => {
        calls += 1;
        if (deliveries > 0) return true;
        deliveries += 1;
        return true;
      },
      exitRequestGraceMs: 30,
    };
    const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({ agent: agentOf(run), activeRuns, pool: new ProcessPool(() => 1), now: () => 1000, postDoneExitGraceMs: 60_000 });
    const execution = await executor.submit({ scopeId: 'pi-scope', policy: policy() });
    // collect() resolves when the fanout finishes — i.e. after cleanup
    // (settleProcessAfterTerminal) has released the scope.
    const t0 = Date.now();
    await collect(execution.subscribe());
    const waited = Date.now() - t0;
    expect(calls).toBeGreaterThanOrEqual(1); // early-delivery + settle may both call
    expect(deliveries).toBe(1); // the adapter contract: idempotent
    expect(waited).toBeLessThan(5_000); // seconds, not the old 15s/30min
    expect(activeRuns.get('pi-scope')).toBeUndefined();
  });

  it('requestExit not delivered: settle falls back to stop within a hair of grace', async () => {
    let stops = 0;
    const run: AgentRun = {
      ...longLivedRun(),
      stop: async () => {
        stops += 1;
      },
      requestExit: async () => false,
      exitRequestGraceMs: 30,
    };
    const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({ agent: agentOf(run), activeRuns, pool: new ProcessPool(() => 1), now: () => 1000, postDoneExitGraceMs: 60_000 });
    const execution = await executor.submit({ scopeId: 'pi-scope-2', policy: policy() });
    const t0 = Date.now();
    await collect(execution.subscribe());
    expect(stops).toBe(1);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(activeRuns.get('pi-scope-2')).toBeUndefined();
  });

  it('legacy agents (no requestExit): blind waitForExit grace is unchanged', async () => {
    let exitsPolled = 0;
    const run: AgentRun = {
      ...longLivedRun(),
      waitForExit: async () => {
        exitsPolled += 1;
        return true;
      },
    };
    const activeRuns = new ActiveRuns();
    const executor = new RunExecutor({ agent: agentOf(run), activeRuns, pool: new ProcessPool(() => 1), now: () => 1000, postDoneExitGraceMs: 25 });
    const execution = await executor.submit({ scopeId: 'cc-scope', policy: policy() });
    await collect(execution.subscribe());
    expect(exitsPolled).toBe(1);
    expect(activeRuns.get('cc-scope')).toBeUndefined();
  });
});

function policy(overrides: Partial<RunPolicyAllow> = {}): RunPolicyAllow {
  return {
    ok: true,
    prompt: 'hello',
    requestedCwd: '/tmp/repo',
    cwdRealpath: '/tmp/repo',
    accessMode: 'workspace',
    sandbox: 'workspace-write',
    permissionMode: 'acceptEdits',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'fp',
    expiresAt: 2000,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}
