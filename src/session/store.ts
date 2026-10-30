import { readFile } from 'node:fs/promises';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

/** f0.2+ 猴哥点单: session-lifetime counters for /status. /new resets. */
export interface SessionStats {
  /** f031: stats schema. Pre-f031 files carry old meanings (tokensIn = last
   * call's bare input) and are discarded on load rather than mixed in. */
  v: 2;
  startedAt: number;
  /** f031-#8: prompt size of the latest MAIN-LINE API call
   * (input + cache_read + cache_creation) = what the model actually loaded.
   * Sub-agent calls and whole-turn result totals never touch it. */
  contextTokens?: number;
  contextAt?: number;
  /** f031-#12: model the CLI reported at init for the latest run. */
  model?: string;
  /** f031-#10: cumulative over every finished turn (claude `result` usage). */
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreate: number;
  userMessages: number;
  agentMessages: number;
  /** Sum of API time of finished turns (TPS denominator, 猴哥点单 2026-10-21:
   * execution time, not wall clock). */
  activeMs: number;
  /** Output tokens / active seconds. */
  tpsAvg?: number;
}

/** f031-#10: usage as it arrives from the agent stream. */
export interface UsageSample {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cumulative?: boolean;
  sidechain?: boolean;
  durationMs?: number;
}

export interface SessionEntry {
  /** May be absent if the entry was created by /timeout before any run
   * recorded a session id. Treat absence as "no resumable session". */
  sessionId?: string;
  /** Pinned cwd for the resumable session. Absent for the same reason. */
  cwd?: string;
  updatedAt: number;
  /** f0.2+ /status: per-session cumulative stats, /new wipes them. */
  stats?: SessionStats;
  /** Per-scope idle-timeout override (minutes). 0 = explicitly off for this
   * scope, undefined = follow global default. Session resets preserve this
   * scope preference while removing the resumable session id/cwd. */
  idleTimeoutMinutes?: number;
}

type SessionMap = Record<string, SessionEntry>;

function validStats(raw: unknown): SessionStats | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<SessionStats>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (r.v !== 2 || !num(r.startedAt)) return undefined;
  return {
    v: 2,
    startedAt: r.startedAt,
    ...(num(r.contextTokens) ? { contextTokens: r.contextTokens } : {}),
    ...(num(r.contextAt) ? { contextAt: r.contextAt } : {}),
    ...(typeof r.model === 'string' ? { model: r.model } : {}),
    tokensIn: num(r.tokensIn) ? r.tokensIn : 0,
    tokensOut: num(r.tokensOut) ? r.tokensOut : 0,
    cacheRead: num(r.cacheRead) ? r.cacheRead : 0,
    cacheCreate: num(r.cacheCreate) ? r.cacheCreate : 0,
    userMessages: num(r.userMessages) ? r.userMessages : 0,
    agentMessages: num(r.agentMessages) ? r.agentMessages : 0,
    activeMs: num(r.activeMs) ? r.activeMs : 0,
    ...(num(r.tpsAvg) ? { tpsAvg: r.tpsAvg } : {}),
  };
}

export class SessionStore {
  private data: SessionMap = {};
  private saving: Promise<void> = Promise.resolve();
  /** f031-#11: user messages seen before the scope has an entry. */
  private readonly pendingUserMessages = new Map<string, number>();
  private readonly path: string;

  constructor(path: string = paths.sessionsFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const raw = JSON.parse(text) as Record<string, Partial<SessionEntry>>;
      this.data = {};
      for (const [chatId, entry] of Object.entries(raw)) {
        if (!entry || typeof entry.updatedAt !== 'number') continue;
        // Drop entries without a `cwd`/`sessionId` pair *unless* there's
        // some other persisted state worth keeping (e.g. an idle-timeout
        // override). Resuming a session whose cwd we don't know about
        // would hang claude on a missing jsonl, so resume keys still need
        // the full pair; but a bare timeout override is fine on its own.
        const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
        const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined;
        const idleTimeoutMinutes =
          typeof entry.idleTimeoutMinutes === 'number' ? entry.idleTimeoutMinutes : undefined;
        // f031-#9: stats must survive a restart (they used to be dropped
        // here, so every bot restart silently reset /status counters).
        const stats = validStats(entry.stats);
        const hasSession = sessionId !== undefined && cwd !== undefined;
        if (!hasSession && idleTimeoutMinutes === undefined && !stats) continue;
        this.data[chatId] = {
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          updatedAt: entry.updatedAt,
          ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
          ...(stats ? { stats } : {}),
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  /**
   * Return the session id for this chat if it was created in the given cwd.
   * Sessions recorded in a different cwd are stale — claude can't resume
   * them from a different working directory.
   */
  resumeFor(chatId: string, cwd: string): string | undefined {
    const entry = this.data[chatId];
    if (!entry) return undefined;
    if (entry.cwd !== cwd) return undefined;
    return entry.sessionId;
  }

  getRaw(chatId: string): SessionEntry | undefined {
    return this.data[chatId];
  }

  set(chatId: string, sessionId: string, cwd: string): void {
    // Preserve idleTimeoutMinutes across run starts — it's a per-scope
    // preference, not per-run-instance state. /new (clear) wipes it.
    const prev = this.data[chatId];
    const pendingUser = this.pendingUserMessages.get(chatId);
    this.pendingUserMessages.delete(chatId);
    const stats = prev?.stats ?? (pendingUser ? { ...this.#freshStats(), userMessages: pendingUser } : undefined);
    this.data[chatId] = {
      sessionId,
      cwd,
      updatedAt: Date.now(),
      ...(prev?.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
        : {}),
      ...(stats ? { stats } : {}),
    };
    this.schedulePersist();
  }

  #freshStats(): SessionStats {
    return {
      v: 2,
      startedAt: Date.now(),
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheCreate: 0,
      userMessages: 0,
      agentMessages: 0,
      activeMs: 0,
    };
  }

  /**
   * f031-#8/#10: one usage event from the agent stream.
   * - per-call, main-line → context = input + cache_read + cache_creation
   *   (only when the event carries input-side fields; output-only deltas and
   *   sub-agent calls leave it alone).
   * - cumulative (claude `result`, once per turn) → session totals + TPS.
   *   Per-call snapshots repeat several times per call, so summing them would
   *   over-count; the turn total is exact.
   */
  recordUsage(chatId: string, u: UsageSample): void {
    const entry = this.data[chatId];
    if (!entry) return;
    const st: SessionStats = entry.stats ?? this.#freshStats();
    const prompt =
      (u.inputTokens ?? 0) + (u.cachedInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
    if (u.cumulative) {
      st.tokensIn += prompt;
      st.tokensOut += u.outputTokens ?? 0;
      st.cacheRead += u.cachedInputTokens ?? 0;
      st.cacheCreate += u.cacheCreationInputTokens ?? 0;
      st.activeMs += Math.max(0, u.durationMs ?? 0);
      if (st.activeMs > 0) st.tpsAvg = Math.round(st.tokensOut / (st.activeMs / 1000));
    } else if (!u.sidechain && prompt > 0) {
      st.contextTokens = prompt;
      st.contextAt = Date.now();
    } else {
      return;
    }
    entry.stats = st;
    this.schedulePersist();
  }

  /** f031-#12: the model the CLI actually ran (system init). */
  recordModel(chatId: string, model: string | undefined): void {
    const entry = this.data[chatId];
    if (!entry || !model) return;
    const st: SessionStats = entry.stats ?? this.#freshStats();
    if (st.model === model) return;
    st.model = model;
    entry.stats = st;
    this.schedulePersist();
  }

  /** f0.2+: count one user/agent message into session stats. */
  recordMessage(chatId: string, who: "user" | "agent"): void {
    const entry = this.data[chatId];
    if (!entry) {
      // f031-#11: a brand-new scope has no entry when its first message
      // arrives. Don't create one (channel uses "no entry" to mean "first
      // engagement" for topic context) — hold the count until set().
      if (who === "user") this.pendingUserMessages.set(chatId, (this.pendingUserMessages.get(chatId) ?? 0) + 1);
      return;
    }
    const st: SessionStats = entry.stats ?? this.#freshStats();
    if (who === "user") st.userMessages += 1;
    else st.agentMessages += 1;
    entry.stats = st;
    this.schedulePersist();
  }

  clear(chatId: string): void {
    this.pendingUserMessages.delete(chatId);
    const prev = this.data[chatId];
    if (!prev) {
      // /new on a brand-new scope: still lay down a stats skeleton so the
      // /status card has a session start to show (2026-10-21 猴哥点单).
      this.data[chatId] = { updatedAt: Date.now(), stats: this.#freshStats() };
      this.schedulePersist();
      return;
    }
    // Keep the entry alive with a fresh stats skeleton: updatedAt becomes the
    // new session start; idleTimeout preference survives; old counters go.
    this.data[chatId] = {
      updatedAt: Date.now(),
      stats: this.#freshStats(),
      ...(prev.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
        : {}),
    };
    this.schedulePersist();
    this.schedulePersist();
  }

  /** Per-scope idle-timeout override. `undefined` means no override set. */
  getIdleTimeoutMinutes(chatId: string): number | undefined {
    return this.data[chatId]?.idleTimeoutMinutes;
  }

  setIdleTimeoutMinutes(chatId: string, minutes: number): void {
    const clamped = Math.min(Math.max(Math.floor(minutes), 0), 120);
    const prev = this.data[chatId];
    this.data[chatId] = {
      ...(prev ?? { updatedAt: Date.now() }),
      idleTimeoutMinutes: clamped,
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  /** Remove the override so this scope falls back to the global default.
   * Returns true if something was actually removed. */
  clearIdleTimeoutOverride(chatId: string): boolean {
    const prev = this.data[chatId];
    if (!prev || prev.idleTimeoutMinutes === undefined) return false;
    const { idleTimeoutMinutes: _, ...rest } = prev;
    this.data[chatId] = { ...rest, updatedAt: Date.now() };
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
          mode: 0o600,
        });
      })
      .catch((err: unknown) => {
        log.fail('session', err, { step: 'persist' });
      });
  }
}
