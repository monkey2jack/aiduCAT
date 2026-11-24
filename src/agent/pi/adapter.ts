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
  /**
   * Rewrite models.json from the live combo cache; returns the model ids
   * written, or undefined when the cache is cold (file left untouched).
   * Called before each spawn and when a requested model is missing from a
   * live child's catalog.
   */
  refreshCatalog?: () => string[] | undefined;
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
  /** Model ids in models.json when this child spawned (undefined = unknown). */
  catalog?: Set<string>;
}

export class PiAdapter implements AgentAdapter {
  readonly id = 'pi';
  readonly displayName = 'pi';

  private readonly binary: string;
  private readonly agentDir: string;
  private readonly baseUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly envPassthrough: readonly string[];
  private readonly defaultModel?: string;
  private readonly refreshCatalog?: () => string[] | undefined;
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
    this.refreshCatalog = opts.refreshCatalog;
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
    for (const sp of this.processes.values()) {
      try {
        sp.child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
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

    // A child loads models.json once at spawn. If the requested model is
    // missing from an idle child's catalog but the refreshed combo list has
    // it, recycle the child (same --session-id, so the conversation resumes).
    const idle = this.processes.get(sessionKey);
    if (model && idle && !idle.exited && !idle.active && idle.catalog && !idle.catalog.has(model)) {
      const fresh = this.safeRefreshCatalog();
      if (fresh?.includes(model)) {
        log.info('agent', 'pi-catalog-recycle', { model, pid: idle.child.pid ?? null });
        idle.exited = true;
        this.processes.delete(sessionKey);
        try { idle.child.kill('SIGTERM'); } catch { /* gone */ }
      }
    }
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
            push({
              type: 'thinking',
              delta: `\n（模型 ${model} 暂不可用：${String(res.error ?? '').slice(0, 120)}，本轮沿用当前模型）\n`,
            });
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
          log.warn('agent', 'pi-busy-abort-retry', { sessionKey: sp.sessionId });
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
            try { if (sp.child.pid) void killProcessTree(sp.child.pid, 'pi-busy-kill-wedged'); } catch { /* best effort */ }
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
    };
  }

  /** Get or spawn the RPC child for a session. */
  private ensureProcess(sessionKey: string, cwd: string, opts: AgentRunOptions): SessionProcess {
    const existing = this.processes.get(sessionKey);
    if (existing && !existing.exited && existing.active === undefined) {
      return existing;
    }
    if (existing && !existing.exited && existing.active) {
      // A run is already live on this session — should not happen (the
      // bridge serializes runs per scope), but fail safe by reusing it.
      return existing;
    }

    const catalogIds = this.safeRefreshCatalog();
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

    const args = [
      '--mode', 'rpc',
      // pi requires --model together with --provider; without an explicit
      // pick we pass neither and select via set_model after spawn.
      ...(this.defaultModel || opts.model ? ['--provider', PI_PROVIDER_ID, '--model', (opts.model ?? this.defaultModel) as string] : []),
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
      ...(catalogIds ? { catalog: new Set(catalogIds) } : {}),
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
      sp.exited = true;
      client.failAll(new Error(`pi exited (code ${code ?? 'null'} signal ${signal ?? 'null'})`));
      this.failActive(
        sp,
        `pi exited unexpectedly (code ${code ?? 'null'}): ${sp.stderrTail.slice(-300)}`,
      );
      // a recycled/replaced child must not evict its successor
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

  private safeRefreshCatalog(): string[] | undefined {
    try {
      return this.refreshCatalog?.();
    } catch (err) {
      log.warn('agent', 'pi-catalog-refresh-failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private dispatch(sp: SessionProcess, evt: Record<string, unknown> & { type: string }): void {
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
        // The translator holds the error until agent_settled: pi may still
        // auto-retry it, so never finish (or let the bridge kill pi) here.
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
        log.info('agent', 'pi-idle-reap', { session: key, pid: sp.child.pid ?? null });
        try {
          sp.child.kill('SIGTERM');
        } catch {
          // gone already
        }
        this.processes.delete(key);
      }
    }
  }
}
