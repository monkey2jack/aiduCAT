import type { NormalizedMessage } from '@larksuite/channel';
import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

/**
 * f031-stab-#5: what a restart would otherwise lose, kept on disk.
 *
 *  - `inflight`: one entry per scope whose run is in progress — the chat to
 *    answer in and, once it exists, the streaming card's message id. On the
 *    next start the card is closed as "服务重启，请重发" (or a text notice is
 *    sent when there is no card yet) instead of spinning on Thinking forever.
 *  - `queued`: messages accepted by intake but not yet handed to a run (the
 *    600ms debounce window, or waiting behind the current run). On the next
 *    start fresh ones are re-queued; stale ones get an explicit "请重发".
 *
 * The file holds user message text, so it is written 0600, holds only what is
 * still pending, and every entry is dropped as soon as it is handled.
 */

export interface InflightEntry {
  runKey: string;
  chatId: string;
  replyTo?: string;
  replyInThread?: boolean;
  /** streaming card message id, once the card exists (card mode only) */
  cardMessageId?: string;
  startedAt: number;
}

export interface QueuedEntry {
  storedAt: number;
  msg: NormalizedMessage;
}

interface JournalFile {
  v: 1;
  inflight: Record<string, InflightEntry>;
  queued: Record<string, QueuedEntry[]>;
}

export interface JournalSnapshot {
  inflight: Array<[scope: string, entry: InflightEntry]>;
  queued: Array<[scope: string, entries: QueuedEntry[]]>;
}

export class RunJournal {
  private readonly path: string | undefined;
  private data: JournalFile = { v: 1, inflight: {}, queued: {} };
  private saving: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly now: () => number;

  /** `path` undefined = in-memory only (tests / no profile dir). */
  constructor(path: string | undefined, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
  }

  /**
   * Read what the previous process left behind and start from an empty
   * journal (the caller recovers the snapshot). Unreadable → empty.
   */
  async takeOver(): Promise<JournalSnapshot> {
    let prev: JournalFile | undefined;
    if (this.path) {
      try {
        const raw = JSON.parse(await readFile(this.path, 'utf8')) as Partial<JournalFile>;
        if (raw && raw.v === 1) {
          prev = { v: 1, inflight: raw.inflight ?? {}, queued: raw.queued ?? {} };
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn('journal', 'load-failed', { err: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    this.data = { v: 1, inflight: {}, queued: {} };
    if (prev) this.persist();
    return {
      inflight: Object.entries(prev?.inflight ?? {}),
      queued: Object.entries(prev?.queued ?? {}).filter(([, list]) => Array.isArray(list) && list.length > 0),
    };
  }

  queue(scope: string, msg: NormalizedMessage): void {
    const list = (this.data.queued[scope] ??= []);
    list.push({ storedAt: this.now(), msg: slimMessage(msg) });
    this.persist();
  }

  dequeue(scope: string, messageIds: readonly string[]): void {
    const list = this.data.queued[scope];
    if (!list) return;
    const drop = new Set(messageIds);
    const rest = list.filter((e) => !drop.has(e.msg.messageId));
    if (rest.length === list.length) return;
    if (rest.length) this.data.queued[scope] = rest;
    else delete this.data.queued[scope];
    this.persist();
  }

  startRun(scope: string, entry: Omit<InflightEntry, 'startedAt'>): void {
    this.data.inflight[scope] = { ...entry, startedAt: this.now() };
    this.persist();
  }

  setCard(scope: string, runKey: string, cardMessageId: string): void {
    const e = this.data.inflight[scope];
    if (!e || e.runKey !== runKey || e.cardMessageId === cardMessageId) return;
    e.cardMessageId = cardMessageId;
    this.persist();
  }

  endRun(scope: string, runKey: string): void {
    if (this.data.inflight[scope]?.runKey !== runKey) return;
    delete this.data.inflight[scope];
    this.persist();
  }

  /**
   * Stop writing (bridge disconnect / restart). What is on disk stays as the
   * hand-over for the next start; late cleanups from dying runs must not
   * erase it or clobber the successor's file.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.saving;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private persist(): void {
    if (this.closed || !this.path) return;
    const path = this.path;
    const body = `${JSON.stringify(this.data)}\n`;
    this.saving = this.saving
      .then(() => writeFileAtomic(path, body, { mode: 0o600 }))
      .catch((err: unknown) => log.fail('journal', err, { step: 'persist' }));
  }
}

/** Keep what a replayed batch needs; drop the bulky raw event. */
function slimMessage(msg: NormalizedMessage): NormalizedMessage {
  const raw = msg.raw as { sender?: { sender_type?: unknown }; message?: { content?: unknown } } | undefined;
  const slimRaw =
    raw && (raw.sender?.sender_type !== undefined || (msg.rawContentType === 'interactive' && raw.message?.content))
      ? {
          ...(raw.sender?.sender_type !== undefined ? { sender: { sender_type: raw.sender.sender_type } } : {}),
          ...(msg.rawContentType === 'interactive' && raw.message?.content
            ? { message: { content: raw.message.content } }
            : {}),
        }
      : undefined;
  const { raw: _drop, ...rest } = msg;
  return slimRaw ? { ...rest, raw: slimRaw } : rest;
}
