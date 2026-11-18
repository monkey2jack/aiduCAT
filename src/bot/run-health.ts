/** Per-bridge watchdog for consecutive DSH failures. */
export interface RunHealthOptions {
  /** Consecutive failures before the first notice. */
  threshold?: number;
  /** Minimum gap between notices. */
  cooldownMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
}

export type RunHealthDecision =
  | { notify: false; consecutiveFailures: number; reason: 'ok' | 'counting' | 'cooldown' }
  | { notify: true; consecutiveFailures: number; message: string };

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30 * 60_000;

export class RunHealthMonitor {
  private consecutiveFailures = 0;
  private lastNoticeAt: number | undefined;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: RunHealthOptions = {}) {
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = opts.now ?? Date.now;
  }

  recordSuccess(): RunHealthDecision {
    this.consecutiveFailures = 0;
    return { notify: false, consecutiveFailures: 0, reason: 'ok' };
  }

  // Accept no run details: the owner DM must not include errors or chat identifiers.
  recordFailure(): RunHealthDecision {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < this.threshold) {
      return {
        notify: false,
        consecutiveFailures: this.consecutiveFailures,
        reason: 'counting',
      };
    }
    const at = this.now();
    if (this.lastNoticeAt !== undefined && at - this.lastNoticeAt < this.cooldownMs) {
      return {
        notify: false,
        consecutiveFailures: this.consecutiveFailures,
        reason: 'cooldown',
      };
    }
    this.lastNoticeAt = at;
    return {
      notify: true,
      consecutiveFailures: this.consecutiveFailures,
      message: `⚠️ aiduCAT DSH 连续失败 ${this.consecutiveFailures} 轮，桥接可能已不可用。\n` +
        '排查：发 `/doctor` 看自检，或查看服务日志 winsw2.out.log / bridge-*.jsonl。',
    };
  }
}
