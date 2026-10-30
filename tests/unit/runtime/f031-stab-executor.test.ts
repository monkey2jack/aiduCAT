import { describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor } from '../../../src/runtime/run-executor';

// f031-stab-#3: the old claude must really be gone before the next round on the
// same scope starts. Before the fix, cleanup released the scope first and then
// waited (up to 15s) for the old process, so the next message could spawn
// `claude --resume <same session>` while the old one was still flushing the
// transcript — the "have to send it twice" symptom.

class ControlledRun implements AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  exited = false;
  stopCalls = 0;
  private exitWaiters: Array<() => void> = [];
  constructor(opts: AgentRunOptions, events: AgentEvent[], private readonly exitOnStop = true) {
    this.runId = opts.runId;
    this.events = (async function* () {
      for (const e of events) yield e;
    })();
  }
  exit(): void {
    this.exited = true;
    for (const w of this.exitWaiters.splice(0)) w();
  }
  async stop(): Promise<void> {
    this.stopCalls++;
    if (this.exitOnStop) this.exit();
  }
  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.exitWaiters.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }
}

class ControlledAgent implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude';
  readonly runs: ControlledRun[] = [];
  spawnedAt: number[] = [];
  constructor(private readonly exitOnStop = true) {}
  async isAvailable() {
    return true;
  }
  run(opts: AgentRunOptions): AgentRun {
    const r = new ControlledRun(opts, [{ type: 'text', delta: 'hi' }, { type: 'done', terminationReason: 'normal' }] as AgentEvent[], this.exitOnStop);
    this.runs.push(r);
    this.spawnedAt.push(Date.now());
    return r;
  }
}

function policy(): RunPolicyAllow {
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
    expiresAt: Number.MAX_SAFE_INTEGER,
  } as RunPolicyAllow;
}

/** Consume like channel.ts does: stop at the terminal event, don't drain. */
async function consumeToTerminal(it: AsyncIterable<AgentEvent>): Promise<void> {
  for await (const e of it) if (e.type === 'done' || e.type === 'error') break;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(agent: ControlledAgent, graceMs: number) {
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 4);
  let n = 0;
  const executor = new RunExecutor({ agent, pool, activeRuns, postDoneExitGraceMs: graceMs, createRunId: () => `run-${++n}` });
  return { executor, activeRuns, pool };
}

describe('f031-stab-#3 next round waits for the previous claude to exit', () => {
  it('f031-stab-#3 same scope: the next run is not spawned until the old process exited', async () => {
    const agent = new ControlledAgent();
    const { executor, activeRuns } = make(agent, 5_000);
    const first = await executor.submit({ scopeId: 's', policy: policy() });
    await consumeToTerminal(first.subscribe());
    await sleep(20);
    // the card is done; the run no longer shows as active ...
    expect(activeRuns.get('s')).toBeUndefined();

    const second = executor.submit({ scopeId: 's', policy: policy() });
    await sleep(80);
    // ... but the next round must not start while the old claude is alive.
    expect(agent.runs).toHaveLength(1);

    agent.runs[0]!.exit();
    const exec2 = await second;
    expect(agent.runs).toHaveLength(2);
    await consumeToTerminal(exec2.subscribe());
    agent.runs[1]!.exit();
  });

  it('f031-stab-#3 an old process that never exits is killed after the grace, then the next run starts', async () => {
    const agent = new ControlledAgent();
    const { executor } = make(agent, 60);
    const first = await executor.submit({ scopeId: 's', policy: policy() });
    await consumeToTerminal(first.subscribe());
    const exec2 = await executor.submit({ scopeId: 's', policy: policy() });
    expect(agent.runs[0]!.stopCalls).toBeGreaterThanOrEqual(1);
    expect(agent.runs[0]!.exited).toBe(true);
    expect(agent.runs).toHaveLength(2);
    await consumeToTerminal(exec2.subscribe());
  });

  it('f031-stab-#3 a stuck stop() cannot block the scope forever (hard cap)', async () => {
    const agent = new ControlledAgent(false); // stop() never makes it exit
    const { executor } = make(agent, 30);
    const first = await executor.submit({ scopeId: 's', policy: policy() });
    await consumeToTerminal(first.subscribe());
    const t0 = Date.now();
    const exec2 = await executor.submit({ scopeId: 's', policy: policy() });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(agent.runs).toHaveLength(2);
    await consumeToTerminal(exec2.subscribe());
  });

  it('f031-stab-#3 an interrupted run (new message / idle timeout) is also waited for', async () => {
    const agent = new ControlledAgent(false);
    const { executor, activeRuns } = make(agent, 5_000);
    const first = await executor.submit({ scopeId: 's', policy: policy() });
    activeRuns.interrupt('s');
    await consumeToTerminal(first.subscribe());
    const second = executor.submit({ scopeId: 's', policy: policy() });
    await sleep(80);
    expect(agent.runs).toHaveLength(1);
    agent.runs[0]!.exit();
    const exec2 = await second;
    expect(agent.runs).toHaveLength(2);
    await consumeToTerminal(exec2.subscribe());
  });

  it('f031-stab-#3 other scopes are not held up by a draining run', async () => {
    const agent = new ControlledAgent();
    const { executor } = make(agent, 5_000);
    const first = await executor.submit({ scopeId: 'a', policy: policy() });
    await consumeToTerminal(first.subscribe());
    const other = await executor.submit({ scopeId: 'b', policy: policy() });
    expect(agent.runs).toHaveLength(2);
    agent.runs[0]!.exit();
    await consumeToTerminal(other.subscribe());
  });
});
