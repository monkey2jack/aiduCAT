import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun } from '../agent/types';
import { ActiveRuns, type RunHandle } from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import { log } from '../core/logger';
import { killProcessTree } from '../platform/kill-tree';
import type { RunPolicyAllow } from '../policy/run-policy';
import { RunRejected, SpawnFailed } from './errors';

export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
  /** issue #9 (P2): extra ms on top of postDoneExitGraceMs before a stuck previous run is tree-killed. */
  drainKillBudgetMs?: number;
}

export interface SubmitRunInput {
  scopeId: string;
  policy: RunPolicyAllow;
  sessionId?: string;
  threadId?: string;
  model?: string;
  /** claude-only reasoning effort (low..max), forwarded as --effort. */
  effort?: string;
  images?: readonly string[];
  stopGraceMs?: number;
  /** f0.2: per-run provider env (ANTHROPIC_* / OPENAI_*), applied last by the adapter. */
  envOverrides?: Record<string, string>;
  /** f03p-infra-#2: the bot owner started this run (see AgentRunOptions.ownerRun). */
  ownerRun?: boolean;
  nowait?: boolean;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export interface RunExecution {
  runId: string;
  scopeId: string;
  run: AgentRun;
  handle: RunHandle;
  subscribe(): AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  /**
   * issue #9 (P1): the watchdog's hard exit — force-close the event stream
   * with a synthetic terminal error and kill the process tree, regardless of
   * whether the stream was ever going to end on its own. Guarantees cleanup
   * (unregister / pool release / scope release) actually runs.
   */
  forceClose(reason: string): Promise<void>;
}

// fix(2026-10-30): 2s was too tight - claude often needs >2s to flush the
// session transcript on exit, and force-killing it mid-flush left pool
// residue that made the NEXT run die instantly (the send-twice bug).
const DEFAULT_POST_DONE_EXIT_GRACE_MS = 15000;
// f031-stab-#3: once grace + kill are spent, the next round on the scope goes
// ahead anyway (logged) — a wedged process must not block the chat forever.
const DRAIN_KILL_BUDGET_MS = 10_000;

/** f031-stab-#3: one per spawned run, until its process has exited. */
interface ScopeProcess {
  /** The run's turn is over (terminal event seen, or interrupted). */
  finished: () => boolean;
  /** Resolves once the process exited (or was killed). */
  exited: Promise<void>;
  /** issue #9 (P2): agent pid, for the tree kill on the timeout path. */
  pid: number | undefined;
}

export class RunExecutor {
  private readonly agent: AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;
  private readonly drainKillBudgetMs: number;
  /**
   * f031-stab-#3: the agent process currently owning each scope. It stays here
   * after its turn ends (card final, scope idle) until the process exits, and
   * the next submit on that scope waits for it — so two claude processes never
   * touch the same session (`--resume`) at once.
   */
  private readonly scopeProcs = new Map<string, ScopeProcess>();

  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? DEFAULT_POST_DONE_EXIT_GRACE_MS;
    this.drainKillBudgetMs = deps.drainKillBudgetMs ?? DRAIN_KILL_BUDGET_MS;
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const submittedAt = this.now();
    const prev = this.scopeProcs.get(input.scopeId);
    if (prev?.finished()) await this.waitForPreviousExit(input.scopeId, prev);
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }

    const release = input.nowait ? this.pool.tryAcquire() : await this.pool.acquire();
    if (!release) {
      releaseScope();
      throw new RunRejected('pool-full', 'process pool is full');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }

    const runId = this.createRunId();
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    const runOptions = {
      runId,
      prompt: input.policy.prompt,
      cwd: input.policy.cwdRealpath,
      sessionId: input.sessionId,
      threadId: input.threadId,
      model: input.model,
      effort: input.effort,
      images: input.images,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs,
      envOverrides: input.envOverrides,
      ownerRun: input.ownerRun === true,
    };
    let run: AgentRun;
    try {
      await this.agent.prepareRun?.(runOptions);
    } catch (err) {
      release();
      releaseScope();
      if (err instanceof SpawnFailed) throw err;
      throw new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    try {
      run = this.agent.run(runOptions);
    } catch (err) {
      release();
      releaseScope();
      throw new SpawnFailed('agent spawn failed', err);
    }
    const dimensions = {
      runId,
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id,
      scope: input.scopeId,
      source: input.observability?.source ?? 'unknown',
      stage: input.observability?.stage ?? 'submit',
    };
    log.info('run', 'started', {
      ...dimensions,
      queueWaitMs,
      accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
    });

    let handle: RunHandle;
    try {
      handle = this.activeRuns.register(input.scopeId, run);
    } catch (err) {
      releaseScope();
      release();
      await run.stop().catch(() => {});
      throw new RunRejected(
        'run-already-active',
        err instanceof Error ? err.message : 'another run is already active for this scope',
      );
    }
    // f031-stab-#3: the scope is handed back only after the process is gone.
    // The handle is unregistered as soon as the turn ends (/status and
    // interrupts see it as idle), but `scopeProcs` holds the next submit on
    // this scope until exit — clean exit within the grace, else stop()
    // (SIGTERM → SIGKILL). `alreadyStopped` = execution.stop() already did it.
    let terminalSeen = false;
    let drained!: () => void;
    const proc: ScopeProcess = {
      finished: () => terminalSeen || handle.interrupted || this.activeRuns.get(input.scopeId)?.run !== run,
      exited: new Promise<void>((resolve) => {
        drained = resolve;
      }),
      pid: run.pid,
    };
    this.scopeProcs.set(input.scopeId, proc);
    let cleaning: Promise<void> | undefined;
    const cleanup = (alreadyStopped: boolean): Promise<void> => {
      cleaning ??= (async () => {
        this.activeRuns.unregister(input.scopeId, run);
        try {
          if (!alreadyStopped) {
            const exited = await run.waitForExit(this.postDoneExitGraceMs);
            if (!exited) {
              log.warn('run', 'post-done-exit-timeout', {
                ...dimensions,
                graceMs: this.postDoneExitGraceMs,
              });
              await run.stop().catch((err) => {
                log.warn('run', 'post-done-stop-failed', {
                  ...dimensions,
                  err: err instanceof Error ? err.message : String(err),
                });
              });
            }
          }
        } finally {
          release();
          if (this.scopeProcs.get(input.scopeId) === proc) this.scopeProcs.delete(input.scopeId);
          drained();
        }
      })();
      return cleaning;
    };
    const fanout = new EventFanout(observeRunEvents(run.events, {
      dimensions,
      startedAt,
      now: this.now,
    }), async () => {
      await cleanup(false);
    }, () => {
      // Runs synchronously before consumers see the terminal event, so a
      // follow-up submit can never slip in between "card done" and cleanup.
      terminalSeen = true;
      void cleanup(false);
    });

    return {
      runId,
      scopeId: input.scopeId,
      run,
      handle,
      subscribe: () => fanout.subscribe(),
      stop: async () => {
        handle.interrupted = true;
        await run.stop();
        await run.waitForExit(this.postDoneExitGraceMs);
        await cleanup(true);
      },
      forceClose: async (reason: string) => {
        handle.interrupted = true;
        // issue #9 (P1): hard exit — synthetic terminal first (so consumers
        // wind down and cleanup runs via onTerminal), then kill the tree so a
        // grandchild-inherited stdout handle can't wedge the next run either.
        fanout.abort(reason, {
          type: 'error',
          message: `run force-closed: ${reason}`,
          terminationReason: 'timeout',
        });
        await cleanup(false).catch(() => {});
        await run.forceKillTree();
      },
    };
  }

  /** f031-stab-#3: hold a new submit until the scope's previous process exited. */
  private async waitForPreviousExit(scopeId: string, prev: ScopeProcess): Promise<void> {
    const startedAt = this.now();
    log.info('run', 'wait-previous-exit', { scope: scopeId });
    let timer: NodeJS.Timeout | undefined;
    const capMs = this.postDoneExitGraceMs + this.drainKillBudgetMs;
    const outcome = await Promise.race([
      prev.exited.then(() => 'exited' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), capMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') {
      log.warn('run', 'previous-exit-timeout', { scope: scopeId, capMs });
      // issue #9 (P2): the wedged previous run must not linger as an orphan
      // holding its session file open (the 2026-11-08 two-hour orphan). Kill
      // the whole tree, fire-and-forget — the next submit must not wait on
      // the killer, only on `exited`/cap, both already accounted for above.
      void killProcessTree(prev.pid, 'previous-exit-timeout');
      if (this.scopeProcs.get(scopeId) === prev) this.scopeProcs.delete(scopeId);
    } else {
      log.info('run', 'previous-exited', { scope: scopeId, waitedMs: this.now() - startedAt });
    }
  }
}

function observeRunEvents(
  events: AsyncIterable<AgentEvent>,
  opts: {
    dimensions: Record<string, unknown>;
    startedAt: number;
    now: () => number;
  },
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      for await (const event of events) {
        if (event.type === 'done') {
          log.info('run', 'completed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
          });
          yield event;
          return;
        }
        if (event.type === 'error') {
          log.warn('run', 'failed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
            error: event.message,
          });
          yield event;
          return;
        }
        yield event;
      }
    },
  };
}

class EventFanout {
  private readonly source: AsyncIterable<AgentEvent>;
  private readonly onDone: () => Promise<void>;
  private readonly onTerminal: () => void;
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private started = false;
  private done = false;
  private error: unknown;
  private abortRequested = false;
  private abortWaker: (() => void) | undefined;
  private syntheticTerminal: AgentEvent | undefined;

  constructor(source: AsyncIterable<AgentEvent>, onDone: () => Promise<void>, onTerminal: () => void = () => {}) {
    this.source = source;
    this.onDone = onDone;
    this.onTerminal = onTerminal;
  }

  subscribe(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async (): Promise<IteratorResult<AgentEvent>> => {
            this.start();
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            if (this.done) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              const wake = (): void => {
                this.waiters.delete(wake);
                resolve();
              };
              this.waiters.add(wake);
            });
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  /**
   * issue #9 (P1): the pump can be parked forever inside the source's
   * for-await (child exited, grandchild holds the stdout write handle).
   * End the stream anyway: a real next() that later resolves is raced against
   * an abort promise, the winner defines the outcome, and a synthetic
   * terminal event is appended so every consumer reaches a terminal state.
   * A run must always have an exit that does not depend on the stream
   * cooperating.
   */
  abort(reason: string, terminal: AgentEvent): void {
    if (this.abortRequested || this.done) return;
    this.abortRequested = true;
    this.syntheticTerminal = terminal;
    log.warn('run', 'stream-force-closed', { reason });
    this.abortWaker?.();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    const it = this.source[Symbol.asyncIterator]();
    try {
      while (true) {
        const abortPromise = this.abortRequested
          ? undefined
          : new Promise<{ kind: 'aborted' }>((resolve) => {
              this.abortWaker = () => resolve({ kind: 'aborted' });
            });
        const nextPromise = it.next();
        const outcome = abortPromise
          ? await Promise.race([nextPromise.then((r) => ({ kind: 'next' as const, r })), abortPromise])
          : ({ kind: 'next' as const, r: await nextPromise });
        if (outcome.kind !== 'next') {
          // Park the abandoned next() behind .catch so a late rejection
          // (stream error after abort) can't become an unhandledRejection.
          void nextPromise.catch(() => {});
          break;
        }
        if (outcome.r.done === true) break;
        const event = outcome.r.value;
        this.buffer.push(event);
        if (isTerminalEvent(event)) {
          this.onTerminal();
          this.wakeAll();
          break;
        }
        // Non-terminal events must reach consumers as they arrive — streaming
        // cards, TPS timing and the watchdog all depend on real-time delivery.
        this.wakeAll();
      }
    } catch (err) {
      // An abort raced a failing source: the synthetic terminal wins — the
      // forced close is the point of this path.
      if (this.abortRequested) {
        this.finishWithSynthetic();
      } else {
        this.error = err;
      }
    } finally {
      this.abortWaker = undefined;
      this.finishWithSynthetic();
      await this.onDone();
      this.done = true;
      this.wakeAll();
    }
  }

  private finishWithSynthetic(): void {
    if (!this.abortRequested) return;
    const terminal = this.syntheticTerminal;
    if (!terminal) return;
    const last = this.buffer[this.buffer.length - 1];
    if (last && isTerminalEvent(last)) return;
    this.buffer.push(terminal);
    this.onTerminal();
    this.wakeAll();
  }

  private wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}
