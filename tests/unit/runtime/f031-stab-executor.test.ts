import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import type { RunPolicyAllow } from '../../../src/policy/run-policy';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { killProcessTree } from '../../../src/platform/kill-tree';

// issue #9 (P2): the drain-timeout hard kill must go through killProcessTree.
vi.mock('../../../src/platform/kill-tree', () => ({
  killProcessTree: vi.fn(async () => {}),
}));
const killTreeMock = vi.mocked(killProcessTree);
beforeEach(() => {
  killTreeMock.mockClear();
});

// f031-stab-#3: the old claude must really be gone before the next round on the
// same scope starts. Before the fix, cleanup released the scope first and then
// waited (up to 15s) for the old process, so the next message could spawn
// `claude --resume <same session>` while the old one was still flushing the
// transcript — the "have to send it twice" symptom.

class ControlledRun implements AgentRun {
  readonly runId: string;
  readonly pid = undefined;
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
  async forceKillTree(): Promise<void> {
    this.exit();
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

// issue #9 (P2): a run whose stop() never resolves and whose pid is set —
// the drain-timeout path must hard-kill it by pid.
class HangingStopRun implements AgentRun {
  readonly pid = 1234;
  readonly events: AsyncIterable<AgentEvent>;
  exited = false;
  constructor(runId: string) {
    this.runId = runId;
    this.events = (async function* () {
      yield { type: 'text', delta: 'hi' } as AgentEvent;
      yield { type: 'done', terminationReason: 'normal' } as AgentEvent;
    })();
  }
  readonly runId: string;
  async stop(): Promise<void> {
    await new Promise<never>(() => {});
  }
  async waitForExit(): Promise<boolean> {
    return this.exited ? Promise.resolve(true) : new Promise<boolean>(() => {});
  }
  async forceKillTree(): Promise<void> {
    this.exited = true;
  }
}

class HangingStopAgent implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude';
  readonly runs: HangingStopRun[] = [];
  async isAvailable() {
    return true;
  }
  run(opts: AgentRunOptions): AgentRun {
    const r = new HangingStopRun(opts.runId);
    this.runs.push(r);
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

function make(agent: ControlledAgent, graceMs: number, drainKillBudgetMs?: number) {
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 4);
  let n = 0;
  const executor = new RunExecutor({
    agent,
    pool,
    activeRuns,
    postDoneExitGraceMs: graceMs,
    ...(drainKillBudgetMs !== undefined ? { drainKillBudgetMs } : {}),
    createRunId: () => `run-${++n}`,
  });
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

// issue #9 (P1): a wedged event stream (child dead, grandchild holds stdout)
// used to freeze the slot forever — the watchdog's stop() was a no-op and
// nothing else could end the run. forceClose is the guaranteed hard exit.
describe('issue #9 forceClose hard exit', () => {
  class WedgedRun implements AgentRun {
    readonly runId: string;
    readonly pid = 4242;
    // A stream that never yields and never ends, no matter what.
    readonly events: AsyncIterable<AgentEvent> = new Promise<never>(() => {}) as never;
    forceKillCalls = 0;
    constructor(runId: string) {
      this.runId = runId;
    }
    async stop(): Promise<void> {}
    async waitForExit(): Promise<boolean> {
      return false;
    }
    async forceKillTree(): Promise<void> {
      this.forceKillCalls++;
    }
  }

  class WedgedAgent implements AgentAdapter {
    readonly id = 'claude';
    readonly displayName = 'Claude';
    readonly runs: WedgedRun[] = [];
    async isAvailable() {
      return true;
    }
    run(opts: AgentRunOptions): AgentRun {
      const r = new WedgedRun(opts.runId);
      this.runs.push(r);
      return r;
    }
  }

  it('forceClose injects a terminal error, releases the scope, and kills the tree', async () => {
    const agent = new WedgedAgent();
    const { executor, activeRuns } = make(agent as unknown as ControlledAgent, 5_000);
    const execution = await executor.submit({ scopeId: 's', policy: policy() });

    const consumer = (async () => {
      const out: AgentEvent[] = [];
      for await (const e of execution.subscribe()) {
        out.push(e);
        if (e.type === 'error' || e.type === 'done') break;
      }
      return out;
    })();

    await execution.forceClose('watchdog-idle-timeout');
    const events = await consumer;

    const last = events[events.length - 1];
    expect(last?.type).toBe('error');
    expect((last as { message?: string }).message).toContain('force-closed');
    expect((last as { terminationReason?: string }).terminationReason).toBe('timeout');
    // Slot released: the scope can take a new run right away.
    expect(activeRuns.get('s')).toBeUndefined();
    const next = await executor.submit({ scopeId: 's', policy: policy() });
    expect(agent.runs).toHaveLength(2);
    await next.forceClose('cleanup');
  });

  it('forceClose is idempotent and safe even if the run already terminated', async () => {
    const agent = new WedgedAgent();
    const { executor } = make(agent as unknown as ControlledAgent, 5_000);
    const execution = await executor.submit({ scopeId: 's', policy: policy() });
    await execution.forceClose('first');
    await execution.forceClose('second');
    expect(agent.runs[0]!.forceKillCalls).toBeGreaterThanOrEqual(1);
  });

  it('the previous-exit-timeout path calls forceKillTree instead of leaking the process', async () => {
    // stop() hangs forever (a wedged run); the scope's next submit hits the
    // drain cap and must hard-kill the tree instead of leaking the process.
    const agent = new HangingStopAgent();
    const { executor } = make(agent as unknown as ControlledAgent, 20, 100);
    const first = await executor.submit({ scopeId: 's', policy: policy() });
    await consumeToTerminal(first.subscribe());
    const t0 = Date.now();
    const second = await executor.submit({ scopeId: 's', policy: policy() });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(killTreeMock).toHaveBeenCalledWith(agent.runs[0]!.pid, expect.any(String));
    expect(agent.runs).toHaveLength(2);
    await consumeToTerminal(second.subscribe());
  }, 10_000);
});
