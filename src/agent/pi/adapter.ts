import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import { log } from '../../core/logger';
import { buildAgentEnv } from '../../platform/agent-env';
import { spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { killProcessTree } from '../../platform/kill-tree';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type { AgentAdapter, AgentBotIdentity, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { PiRpcClient } from './rpc-client';
import { PiStreamTranslator } from './jsonl';
import { PI_API_KEY_ENV, PI_PROVIDER_ID } from './models-file';

/**
 * f0.6+ (pi): the sixth agent — pi (@earendil-works/pi-coding-agent).
 *
 * Unlike cc/codex/opencode (one process per turn), pi runs as a LONG-LIVED
 * RPC child (`pi --mode rpc`) per Feishu session. One AgentRun = one prompt
 * sent to that child; the child's event stream is demultiplexed back to the
 * active run. This buys three things the per-turn agents had to hack:
 *  - steer is a native RPC command (`{"type":"steer"}`), no stdin replay
 *    echo matching like claude's SteerInput;
 *  - /new is `new_session`, /stop is `abort`, /status is `get_session_stats`
 *    (whose contextUsage is the live window fill — no rollout-file tail
 *    parsing like codex's history-usage.ts);
 *  - model switches are `set_model`, effective immediately, no respawn.
 *
 * Process lifecycle: children are keyed by sessionId (the bridge pins one
 * via --session-id, so a crashed child respawns onto the same on-disk
 * session). An idle child is reaped after IDLE_REAP_MS with no active run.
 */

const IDLE_REAP_MS = 30 * 60_000;
const PROMPT_TIMEOUT_MS = 60 * 60_000;

/**
 * pi-exit-hang (2026-11-23): the executor waits this long for the child to
 * die after `requestExit()` before escalating to stop() + tree-kill. Tiny on
 * purpose: the request is delivered in-process; pi either exits promptly or
 * is wedged (see EXIT_REQUEST_ESCALATE_MS below).
 */
const PI_EXIT_REQUEST_GRACE_MS = 5_000;

/**
 * pi-exit-hang (2026-11-23): how long a requestExit()ed child has to die
 * before the adapter escalates from stdin-close + SIGTERM to a hard SIGKILL.
 * pi's rpc mode exits on stdin EOF (rpc-mode.js onInputEnd → shutdown) and on
 * the FIRST SIGTERM; a SECOND signal during shutdown force-exits. The observed
 * hang class is an extension/MCP dispose keeping the event loop alive after
 * the first signal — the escalation is what actually reaps it.
 */
const EXIT_REQUEST_ESCALATE_MS = 30_000;

export interface PiAdapterOptions {
  binary: string;
  /** Dedicated pi agent dir (models.json lives here), per profile. */
  agentDir: string;
  /** Base URL of the 10router gateway (for logging/diagnostics). */
  baseUrl?: string;
  /** Resolver for the gateway API key — called at spawn, never stored. */
  apiKey?: string;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
  envPassthrough?: readonly string[];
  /** Profile's preferred model — sent as --provider/--model at every spawn. */
  model?: string;
}

type PiChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

interface LiveRun {
  runId: string;
  translator: PiStreamTranslator;
  push: (e: AgentEvent) => void;
  finish: () => void;
  steerCount: number;
}

interface SessionProcess {
  child: PiChild;
  client: PiRpcClient;
  sessionId: string;
  cwd: string;
  active?: LiveRun;
  lastUsed: number;
  exited: boolean;
  stderrTail: string;
  /** pi-exit-hang: epoch ms when a requestExit() was delivered to the child. */
  exitRequestAt?: number;
}

export class PiAdapter implements AgentAdapter {
  readonly id = 'pi';
  readonly displayName = 'pi';
  /**
   * pi-exit-hang (2026-11-23): runs serialize on the long-lived rpc child and
   * the adapter reaps its own processes (requestExit escalation + idle
   * reaper). The executor must release the scope at the terminal event —
   * waiting for process death held dudu-pi's chat for half-hour stretches.
   */
  readonly releasesScopeAtTerminal = true;

  private readonly binary: string;
  private readonly agentDir: string;
  private readonly baseUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly envPassthrough: readonly string[];
  private readonly defaultModel?: string;
  private botIdentity: AgentBotIdentity | undefined;

  private readonly processes = new Map<string, SessionProcess>();
  private readonly reaper: NodeJS.Timeout;

  constructor(opts: PiAdapterOptions) {
    this.binary = opts.binary;
    this.agentDir = opts.agentDir;
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
    this.envPassthrough = opts.envPassthrough ?? [];
    this.defaultModel = opts.model;
    this.reaper = setInterval(() => this.reapIdle(), 60_000);
    this.reaper.unref();
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'pi' as never,
      agentName: 'pi',
      command: this.binary,
      binaryPath: this.binary,
      timeoutMs: 15_000,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'pi binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  /** Kill every child (service shutdown). */
  async dispose(): Promise<void> {
    clearInterval(this.reaper);
    // pi-exit-hang: graceful delivered shutdown + SIGKILL escalation instead
    // of a bare SIGTERM — pi treats the first signal as "dispose gracefully",
    // which an extension/MCP can wedge; the escalation is what reaps it.
    for (const sp of this.processes.values()) {
      this.beginExitRequest(sp, 'dispose');
    }
    // Give the graceful path a beat before the process itself goes away.
    await new Promise((r) => setTimeout(r, 1_500));
    this.processes.clear();
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for PiAdapter.run');
    const cwd = opts.cwd;
    const prompt = prefixBridgeSystemPrompt(opts.prompt, this.botIdentity);
    const model = opts.model;
    const sessionKey = opts.sessionId ?? `new:${opts.runId}`;
    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    let queue: AgentEvent[] = [];
    let notify: (() => void) | undefined;
    let finished = false;
    let stopped = false;

    const push = (e: AgentEvent): void => {
      queue.push(e);
      notify?.();
    };
    const finish = (): void => {
      if (finished) return;
      finished = true;
      notify?.();
    };

    const events = (async function* (): AsyncGenerator<AgentEvent, void, void> {
      while (true) {
        while (queue.length > 0) {
          const e = queue.shift()!;
          yield e;
        }
        if (finished) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
          // safety: never park forever even if a notification is missed
          setTimeout(resolve, 1_000);
        });
        notify = undefined;
      }
    })();

    const sp = this.ensureProcess(sessionKey, cwd, opts);

    const live: LiveRun = {
      runId: opts.runId,
      translator: new PiStreamTranslator(),
      push,
      finish,
      steerCount: 0,
    };
    sp.active = live;
    sp.lastUsed = Date.now();

    void (async () => {
      try {
        if (model) {
          const res = await sp.client.request(
            { type: 'set_model', provider: PI_PROVIDER_ID, modelId: model },
            10_000,
          );
          if (!res.success) {
            log.warn('agent', 'pi-set-model-failed', { model, error: res.error });
          }
        }
        let sendRes = await sp.client.request(
          { type: 'prompt', message: prompt },
          15_000,
        );
        // f0.6+ cut-over fix: a pi child can stay wedged "already processing"
        // after a timed-out/aborted run. Abort, give it a moment to settle, then
        // retry once; on a second rejection kill the wedged child so the next
        // message spawns a clean one instead of leaving it poisoned.
        if (!sendRes.success && /already processing/i.test(String(sendRes.error ?? ''))) {
          // (pi-exit-hang branch: drive-by typecheck fix — was sp.sessionKey,
          // a field that does not exist; the local sessionKey is the same key.)
          log.warn('agent', 'pi-busy-abort-retry', { sessionKey });
          await sp.client.request({ type: 'abort' }, 5_000).catch(() => undefined);
          await new Promise((r) => setTimeout(r, 2_500));
          sendRes = await sp.client.request(
            { type: 'prompt', message: prompt },
            15_000,
          );
        }
        if (!sendRes.success) {
          if (/already processing/i.test(String(sendRes.error ?? ''))) {
            log.warn('agent', 'pi-busy-kill-wedged-child', { pid: sp.child.pid });
            // (pi-exit-hang branch: drive-by typecheck fix — added the missing
            // "why" argument killProcessTree requires.)
            try { await killProcessTree(sp.child.pid, 'pi-busy-kill'); } catch { /* best effort */ }
          }
          push({
            type: 'error',
            message: `pi prompt rejected: ${sendRes.error ?? 'unknown'}`,
            terminationReason: 'failed',
          });
          finish();
          return;
        }
        // pi does not broadcast its session id on the event stream; get_state
        // is the canonical read. Emit the bridge's `system` event so the
        // session store can resume this session on later turns (/new then
        // continue, or respawn after a crash).
        if (!opts.sessionId) {
          const state = await sp.client.request({ type: 'get_state' }, 5_000);
          const sid = (state.data as { sessionId?: string } | undefined)?.sessionId;
          if (state.success && sid) {
            sp.sessionId = sid;
            push({ type: 'system', sessionId: sid });
          }
        } else {
          push({ type: 'system', sessionId: opts.sessionId });
        }
        // Watchdog: a run that never settles (process hung, stream lost)
        // must not hold the conversation slot forever.
        const watchdog = setTimeout(() => {
          if (!live.translator.hasSettled && sp.active === live) {
            push({
              type: 'error',
              message: 'pi run timed out without agent_settled',
              terminationReason: 'timeout',
            });
            finish();
          }
        }, PROMPT_TIMEOUT_MS);
        watchdog.unref();
      } catch (err) {
        push({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
          terminationReason: 'failed',
        });
        finish();
      }
    })();

    return {
      runId: opts.runId,
      events,
      steer: (text: string): boolean => {
        if (stopped || sp.exited || sp.active !== live) return false;
        const ok = sp.client.send({ type: 'steer', message: text });
        if (ok) {
          live.translator.noteSteerQueued();
          live.steerCount += 1;
          log.info('agent', 'pi-steer-sent', { runId: opts.runId, chars: text.length });
          // f0.6+ cut-over fix: pi 1.6 RPC does not reliably emit a
          // queue_update echo, so surface the steer marker ourselves —
          // same semantics as claude's SteerInput: this card ends here
          // and the queued batch's card carries the run onward.
          push({ type: 'steer' });
        }
        return ok;
      },
      stop: async (): Promise<void> => {
        stopped = true;
        sp.client.send({ type: 'clear_queue' });
        sp.client.send({ type: 'abort' });
        // Give pi a grace window to emit agent_settled; if it doesn't,
        // terminate the run locally so the slot frees up.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (!finished) {
              push({ type: 'done', terminationReason: 'interrupted' });
              finish();
            }
            resolve();
          }, stopGraceMs);
          const check = setInterval(() => {
            if (finished) {
              clearInterval(check);
              clearTimeout(timer);
              resolve();
            }
          }, 100);
          check.unref?.();
        });
      },
      requestExit: async (): Promise<boolean> => {
        // pi-exit-hang: graceful, delivered shutdown — pi's rpc mode exits on
        // stdin EOF (onInputEnd → shutdown) and honours the first SIGTERM as
        // a graceful-dispose request. SIGKILL escalation is armed inside.
        if (sp.exited || sp.child.pid === undefined) return false;
        this.beginExitRequest(sp, `run ${opts.runId} terminal`);
        return true;
      },
      waitForExit: (timeoutMs: number): Promise<boolean> => {
        if (finished) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          const t0 = Date.now();
          const tick = (): void => {
            if (finished) return resolve(true);
            if (Date.now() - t0 >= timeoutMs) return resolve(false);
            setTimeout(tick, 100);
          };
          tick();
        });
      },
      forceKillTree: async (): Promise<void> => {
        if (sp.child.pid) await killProcessTree(sp.child.pid, 'pi-force-kill');
      },
      exitRequestGraceMs: PI_EXIT_REQUEST_GRACE_MS,
    };
  }

  /** Get or spawn the RPC child for a session. */
  private ensureProcess(sessionKey: string, cwd: string, opts: AgentRunOptions): SessionProcess {
    const existing = this.processes.get(sessionKey);
    // pi-exit-hang: a child with a delivered exit request is dying (stdin EOF
    // / SIGTERM / SIGKILL escalation in flight) — never hand it a new prompt;
    // spawn a fresh one on the same pinned session instead.
    if (existing && !existing.exited && existing.exitRequestAt === undefined && existing.active === undefined) {
      return existing;
    }
    if (existing && !existing.exited && existing.exitRequestAt === undefined && existing.active) {
      // A run is already live on this session — should not happen (the
      // bridge serializes runs per scope), but fail safe by reusing it.
      return existing;
    }

    const larkEnv = buildLarkChannelEnv(this.larkChannel, { forAgent: true });
    const env = buildAgentEnv({
      agent: 'pi' as never,
      overrides: {
        ...larkEnv,
        PI_CODING_AGENT_DIR: this.agentDir,
        ...(this.apiKey ? { [PI_API_KEY_ENV]: this.apiKey } : {}),
      ...(process.env.AIDUMEI_PI_STATE_DIR ? { AIDUMEI_PI_STATE_DIR: process.env.AIDUMEI_PI_STATE_DIR } : {}),
        ...(opts.envOverrides ?? {}),
      },
      passthrough: this.envPassthrough,
    });

    // (pi-exit-hang branch: drive-by typecheck fix — pick the model first so
    // the spread cannot produce an `undefined` array element.)
    const modelPick = opts.model ?? this.defaultModel;
    const args = [
      '--mode', 'rpc',
      // pi requires --model together with --provider; without an explicit
      // pick we pass neither and select via set_model after spawn.
      ...(modelPick ? ['--provider', PI_PROVIDER_ID, '--model', modelPick] : []),
      '--session-dir', join(this.agentDir, 'sessions'),
      ...(opts.sessionId ? ['--session-id', opts.sessionId] : []),
      '--name', '飞书·嘟嘟',
    ];
    const child = spawnProcess(this.binary, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as PiChild;

    const client = new PiRpcClient(child.stdin);
    const sp: SessionProcess = {
      child,
      client,
      sessionId: sessionKey,
      cwd,
      lastUsed: Date.now(),
      exited: false,
      stderrTail: '',
    };

    child.stderr.on('data', (chunk: Buffer) => {
      sp.stderrTail = (sp.stderrTail + chunk.toString('utf8')).slice(-4000);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      client.feed(chunk.toString('utf8'));
    });
    client.onEvent((evt) => this.dispatch(sp, evt));
    child.on('error', (err) => {
      log.warn('agent', 'pi-spawn-error', { message: err.message });
      sp.exited = true;
      this.failActive(sp, `pi spawn error: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'pi-exit', { pid: child.pid ?? null, code, signal, session: sessionKey });
      // pi-exit-hang: record how long death took after a requestExit() so the
      // 日志 can prove the grace is honoured (echo check per the 2026-11-23 ticket).
      const pid = child.pid;
      if (pid !== undefined && sp.exitRequestAt !== undefined) {
        log.info('agent', 'pi-exit-after-request', {
          pid,
          session: sessionKey,
          delayMs: Date.now() - sp.exitRequestAt,
          signal: signal ?? null,
          code: code ?? null,
        });
      }
      sp.exited = true;
      client.failAll(new Error(`pi exited (code ${code ?? 'null'} signal ${signal ?? 'null'})`));
      this.failActive(
        sp,
        `pi exited unexpectedly (code ${code ?? 'null'}): ${sp.stderrTail.slice(-300)}`,
      );
      // pi-exit-hang: a replacement child may already own this map slot (a
      // dying child can be swapped out by ensureProcess while its exit event
      // is still in flight) — only delete our own entry, never the new one.
      if (this.processes.get(sessionKey) === sp) this.processes.delete(sessionKey);
    });

    log.info('agent', 'pi-spawn', {
      pid: child.pid ?? null,
      session: sessionKey,
      cwd,
      model: opts.model,
      agentDir: this.agentDir,
      baseUrl: this.baseUrl,
    });
    this.processes.set(sessionKey, sp);
    return sp;
  }

  /**
   * pi-exit-hang: deliver an exit request (stdin EOF + SIGTERM) and arm the
   * SIGKILL escalation. Idempotent per child; safe to call from both the
   * executor (requestExit) and the idle reaper.
   */
  private beginExitRequest(sp: SessionProcess, reason: string): void {
    const pid = sp.child.pid;
    if (sp.exited || pid === undefined || sp.exitRequestAt !== undefined) return;
    sp.exitRequestAt = Date.now();
    try {
      sp.child.stdin?.end();
    } catch {
      // stdin already closed — pi will still see the SIGTERM
    }
    try {
      sp.child.kill('SIGTERM');
    } catch {
      // already gone
    }
    log.info('agent', 'pi-request-exit', { pid, reason });
    const timer = setTimeout(() => {
      if (sp.exited || sp.child.exitCode !== null || sp.child.signalCode !== null) return;
      log.warn('agent', 'pi-exit-escalate-sigkill', {
        pid,
        reason,
        afterMs: EXIT_REQUEST_ESCALATE_MS,
      });
      try {
        sp.child.kill('SIGKILL');
      } catch {
        // gone already
      }
    }, EXIT_REQUEST_ESCALATE_MS);
    timer.unref?.();
  }

  private dispatch(sp: SessionProcess, evt: Record<string, unknown> & { type: string }): void {
    // pi-exit-hang: ANY inbound protocol activity means the child is alive and
    // in use (extension UI requests included) — refresh the idle clock.
    sp.lastUsed = Date.now();
    const live = sp.active;
    if (!live) return;
    // Capture pi's own session id for the bridge's session store.
    if (evt.type === 'message_start') {
      // no-op: session id arrives via get_state if needed; pinned by us anyway
    }
    for (const e of live.translator.translate(evt)) {
      live.push(e);
      if (e.type === 'system' && e.sessionId) {
        sp.sessionId = e.sessionId;
      }
    }
    if (evt.type === 'agent_settled') {
      sp.active = undefined;
      sp.lastUsed = Date.now();
      live.finish();
    } else if (evt.type === 'message_end') {
      const msg = evt.message as { role?: string; stopReason?: string } | undefined;
      if (msg?.role === 'assistant' && msg.stopReason === 'error') {
        // The translator already emitted the error event; agent_settled
        // follows immediately after in pi's stream, so don't finish here.
      }
    }
  }

  private failActive(sp: SessionProcess, message: string): void {
    const live = sp.active;
    if (!live) return;
    sp.active = undefined;
    live.push({ type: 'error', message, terminationReason: 'failed' });
    live.finish();
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const [key, sp] of this.processes) {
      if (sp.active) continue;
      if (sp.exited || now - sp.lastUsed > IDLE_REAP_MS) {
        // pi-exit-hang: reap = request an exit (stdin EOF + SIGTERM, SIGKILL
        // escalation armed) instead of a bare SIGTERM — pi treats the first
        // signal as "shut down gracefully", and when an extension/MCP dispose
        // wedges the loop only the escalation actually reaps it.
        log.info('agent', 'pi-idle-reap', { session: key, pid: sp.child.pid ?? null });
        this.beginExitRequest(sp, 'idle-reap');
        this.processes.delete(key);
      }
    }
  }
}
