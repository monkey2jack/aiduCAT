import type { NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';

interface PendingEntry {
  messages: NormalizedMessage[];
  timer?: NodeJS.Timeout;
}

export type FlushHandler = (scope: string, batch: NormalizedMessage[]) => void;

/** f031-stab-#5: lets the run journal mirror what is queued (not flushed). */
export interface PendingQueueHooks {
  onPush?(scope: string, msg: NormalizedMessage): void;
  onDrop?(scope: string, msgs: readonly NormalizedMessage[]): void;
}

/**
 * Per-scope debounce queue. `scope` is the session scope string (typically
 * `chatId` for p2p / regular group, `chatId:threadId` for topic groups).
 * Accumulates messages within the same scope inside a quiet window, then
 * flushes as a single batch.
 *
 * `block(scope)` pauses the debounce timer while an agent run is active on
 * that scope — pushed messages still accumulate but no flush fires until
 * `unblock(scope)`, which arms a fresh quiet window.
 *
 * Commands should bypass this queue — they're cheap and should be responsive.
 */
export class PendingQueue {
  private readonly map = new Map<string, PendingEntry>();
  private readonly blocked = new Set<string>();
  /** f03p-infra-#5: shutdown drain — keep accepting, never flush. */
  private frozen = false;
  private readonly delayMs: number;
  private readonly onFlush: FlushHandler;
  private readonly hooks: PendingQueueHooks;

  constructor(delayMs: number, onFlush: FlushHandler, hooks: PendingQueueHooks = {}) {
    this.delayMs = delayMs;
    this.onFlush = onFlush;
    this.hooks = hooks;
  }

  push(scope: string, msg: NormalizedMessage): number {
    this.hooks.onPush?.(scope, msg);
    const existing = this.map.get(scope);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.messages.push(msg);
      existing.timer = this.blocked.has(scope) ? undefined : this.armTimer(scope);
      return existing.messages.length;
    }
    this.map.set(scope, {
      messages: [msg],
      timer: this.blocked.has(scope) ? undefined : this.armTimer(scope),
    });
    return 1;
  }

  cancel(scope: string): NormalizedMessage[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    this.hooks.onDrop?.(scope, entry.messages);
    return entry.messages;
  }

  /** Drop in-memory state only (shutdown): the journal keeps the hand-over. */
  cancelAll(): void {
    for (const entry of this.map.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.map.clear();
    this.blocked.clear();
  }

  /**
   * f03p-infra-#5: graceful shutdown. Messages keep being accepted (and
   * mirrored to the run journal through onPush) but no batch is flushed any
   * more, so no new round starts; the next process replays them.
   */
  freeze(): void {
    this.frozen = true;
    for (const entry of this.map.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  get isFrozen(): boolean {
    return this.frozen;
  }

  /** Pause the debounce timer; pushed messages keep accumulating. */
  block(scope: string): void {
    if (this.blocked.has(scope)) return;
    this.blocked.add(scope);
    const entry = this.map.get(scope);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    log.info('queue', 'blocked', { scope, queued: entry?.messages.length ?? 0 });
  }

  /** Resume the debounce timer; arms a fresh quiet window if anything queued. */
  unblock(scope: string): void {
    if (!this.blocked.has(scope)) return;
    this.blocked.delete(scope);
    const entry = this.map.get(scope);
    log.info('queue', 'unblocked', { scope, queued: entry?.messages.length ?? 0 });
    if (!entry || entry.messages.length === 0) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = this.armTimer(scope);
  }

  private armTimer(scope: string): NodeJS.Timeout | undefined {
    if (this.frozen) return undefined;
    return setTimeout(() => this.flush(scope), this.delayMs);
  }

  private flush(scope: string): void {
    if (this.frozen) return;
    const entry = this.map.get(scope);
    if (!entry) return;
    this.map.delete(scope);
    try {
      this.onFlush(scope, entry.messages);
    } catch (err) {
      log.fail('queue', err, { scope, batchSize: entry.messages.length });
    }
  }
}
