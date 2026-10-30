/**
 * f031-stab-#4: per-run watchdog for a hung agent.
 *
 *  - idle: no stream event for `idleMs` while NO tool is in flight → fire.
 *    (A tool can legitimately be silent for long — lark-cli waiting on OAuth,
 *    a long build — so the idle timer pauses while any tool is open.)
 *  - tool: any single tool call open longer than `toolMs` → fire, even
 *    though events may still trickle in. This is the hard cap that the
 *    paused idle timer could never provide: a wedged Bash/MCP call used to
 *    keep the scope blocked until someone typed /stop.
 *
 * Pure timer bookkeeping; the caller decides what "fire" does (stop the run,
 * mark the card).
 */
/** Idle watchdog + per-tool hard cap for one run (ms; undefined = off). */
export interface RunTimeouts {
  idleMs?: number;
  toolMs?: number;
}

export type WatchdogFire =
  | { kind: 'idle'; ms: number }
  | { kind: 'tool'; ms: number; toolName: string };

export interface RunWatchdogOptions {
  idleMs?: number;
  toolMs?: number;
  onFire: (fire: WatchdogFire) => void;
  now?: () => number;
}

export class RunWatchdog {
  private readonly idleMs?: number;
  private readonly toolMs?: number;
  private readonly onFire: (fire: WatchdogFire) => void;
  private readonly now: () => number;
  private readonly tools = new Map<string, { name: string; startedAt: number }>();
  private idleTimer: NodeJS.Timeout | undefined;
  private toolTimer: NodeJS.Timeout | undefined;
  private fired: WatchdogFire | undefined;

  constructor(opts: RunWatchdogOptions) {
    this.idleMs = opts.idleMs && opts.idleMs > 0 ? opts.idleMs : undefined;
    this.toolMs = opts.toolMs && opts.toolMs > 0 ? opts.toolMs : undefined;
    this.onFire = opts.onFire;
    this.now = opts.now ?? Date.now;
  }

  get firedWith(): WatchdogFire | undefined {
    return this.fired;
  }

  get inFlight(): number {
    return this.tools.size;
  }

  start(): void {
    this.rearm();
  }

  toolStarted(id: string, name: string): void {
    if (!this.tools.has(id)) this.tools.set(id, { name, startedAt: this.now() });
    this.rearm();
  }

  toolFinished(id: string): void {
    this.tools.delete(id);
    this.rearm();
  }

  /** Any other stream activity. */
  activity(): void {
    this.rearm();
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.toolTimer) clearTimeout(this.toolTimer);
    this.idleTimer = undefined;
    this.toolTimer = undefined;
  }

  private rearm(): void {
    if (this.fired) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.idleMs && this.tools.size === 0) {
      const ms = this.idleMs;
      this.idleTimer = setTimeout(() => this.fire({ kind: 'idle', ms }), ms);
    }
    if (this.toolTimer) clearTimeout(this.toolTimer);
    this.toolTimer = undefined;
    if (this.toolMs && this.tools.size > 0) {
      let oldest: { name: string; startedAt: number } | undefined;
      for (const t of this.tools.values()) if (!oldest || t.startedAt < oldest.startedAt) oldest = t;
      const ms = this.toolMs;
      const wait = Math.max(0, oldest!.startedAt + ms - this.now());
      const name = oldest!.name;
      this.toolTimer = setTimeout(() => this.fire({ kind: 'tool', ms, toolName: name }), wait);
    }
  }

  private fire(fire: WatchdogFire): void {
    if (this.fired) return;
    this.fired = fire;
    this.dispose();
    this.onFire(fire);
  }
}
