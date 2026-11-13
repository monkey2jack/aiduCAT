import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun } from '../agent/types';
import { ActiveRuns, type RunHandle } from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import type { RunPolicyAllow } from '../policy/run-policy';
import { log } from '../core/logger';
import { RunRejected, SpawnFailed } from './errors';

export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
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
  /** Unblock a wedged stream only after confirming its process exited. */
  closeExitedStream(): Promise<boolean>;
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
}

export class RunExecutor {
  private readonly agent: AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;
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
      closeExitedStream: async () => {
        if (terminalSeen || !(await run.waitForExit(1))) return false;
        return fanout.abort({ type: 'error', message: 'agent stream did not close after exit', terminationReason: 'timeout' });
      },
      stop: async () => {
        handle.interrupted = true;
        await run.stop();
        await run.waitForExit(this.postDoneExitGraceMs);
        await cleanup(true);
      },
    };
  }

  /** f031-stab-#3: hold a new submit until the scope's previous process exited. */
  private async waitForPreviousExit(scopeId: string, prev: ScopeProcess): Promise<void> {
    const startedAt = this.now();
    log.info('run', 'wait-previous-exit', { scope: scopeId });
    let timer: NodeJS.Timeout | undefined;
    const capMs = this.postDoneExitGraceMs + DRAIN_KILL_BUDGET_MS;
    const outcome = await Promise.race([
      prev.exited.then(() => 'exited' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), capMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') {
      log.warn('run', 'previous-exit-timeout', { scope: scopeId, capMs });
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
  private aborted: AgentEvent | undefined;
  private wakeAbort: (() => void) | undefined;

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

  private start(): void {
    if (this.started) return;
    this.started = true;
    void this.pump();
  }

  abort(terminal: AgentEvent): boolean {
    if (this.done || this.aborted || (this.buffer.length && isTerminalEvent(this.buffer[this.buffer.length - 1]!))) return false;
    this.aborted = terminal;
    this.wakeAbort?.();
    this.start();
    return true;
  }

  private async pump(): Promise<void> {
    const iterator = this.source[Symbol.asyncIterator]();
    try {
      while (!this.aborted) {
        const next = iterator.next();
        const interrupted = new Promise<'aborted'>((resolve) => { this.wakeAbort = () => resolve('aborted'); });
        const value = await Promise.race([next, interrupted]);
        this.wakeAbort = undefined;
        if (value === 'aborted') {
          void next.catch(() => {});
          break;
        }
        if (value.done) break;
        const event = value.value;
        this.buffer.push(event);
        if (isTerminalEvent(event)) {
          this.onTerminal();
          this.wakeAll();
          break;
        }
        this.wakeAll();
      }
      if (this.aborted && !(this.buffer.length && isTerminalEvent(this.buffer[this.buffer.length - 1]!))) {
        this.buffer.push(this.aborted);
        this.onTerminal();
        this.wakeAll();
      }
    } catch (err) {
      this.error = err;
    } finally {
      this.wakeAbort = undefined;
      try {
        if (iterator.return) {
          const closing = iterator.return();
          if (this.aborted) void closing.catch(() => {});
          else await closing;
        }
      } catch (err) {
        this.error ??= err;
      }
      await this.onDone();
      this.done = true;
      this.wakeAll();
    }
  }

  private wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}
