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
