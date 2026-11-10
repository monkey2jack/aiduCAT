import type { NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';

/**
 * f0.3.5 (Wei 2026-11-02 02:03「直接跳出 aiduCATing…，就不需要飞书表情了」):
 * the moment a message is accepted (queued for a run) the user gets the
 * streaming card with the「☤aiduCATing…」placeholder — before the 0.6s
 * debounce, before waiting for a previous run on the same scope, before pool
 * acquire and agent spawn. It replaces the working reaction in card mode.
 *
 * The card is a normal SDK stream whose producer parks until the batch's run
 * either ADOPTS it (the run's own producer then drives this same card: stream
 * updates, 续卡, degrade, /stop, empty-run error — all unchanged) or DISCARDS
 * it (batch dropped by a command, shutdown, or the round ended before the
 * card was used, e.g. a policy reject / pre-run failure) — then it is recalled.
 */

export interface EarlyCardCtrl {
  readonly messageId?: string;
}

type Producer<C> = (ctrl: C) => Promise<void>;

interface StreamingChannel<C> {
  stream(
    chatId: string,
    input: { card: { initial: object; producer: Producer<C> } },
    options?: { replyTo?: string; replyInThread?: boolean },
  ): Promise<unknown>;
  recallMessage(messageId: string): Promise<void>;
}

type Decision<C> = { kind: 'adopt'; producer: Producer<C> } | { kind: 'discard' };

export class EarlyCard<C extends EarlyCardCtrl = EarlyCardCtrl> {
  private decide!: (d: Decision<C>) => void;
  private readonly decision = new Promise<Decision<C>>((resolve) => {
    this.decide = resolve;
  });
  private readonly result: Promise<unknown>;
  private messageId?: string;
  private failed = false;
  private status: 'open' | 'adopted' | 'discarded' = 'open';

  constructor(
    private readonly channel: StreamingChannel<C>,
    readonly chatId: string,
    initial: object,
    readonly sendOpts: { replyTo?: string; replyInThread?: boolean },
    private readonly scope: string,
  ) {
    this.result = channel.stream(
      chatId,
      {
        card: {
          initial,
          producer: async (ctrl) => {
            this.messageId = ctrl.messageId;
            const d = await this.decision;
            if (d.kind === 'adopt') await d.producer(ctrl);
          },
        },
      },
      sendOpts,
    );
    this.result.catch((err: unknown) => {
      this.failed = true;
      log.warn('early-card', 'open-failed', { scope, err: err instanceof Error ? err.message : String(err) });
    });
  }

  get state(): 'open' | 'adopted' | 'discarded' {
    return this.status;
  }

  /**
   * The run takes this card over. `fresh` opens a normal stream instead when
   * the placeholder never made it to Feishu. Returns the stream's promise
   * (resolves when the producer is done) — same contract as `channel.stream`.
   */
  adopt(producer: Producer<C>, fresh: () => Promise<unknown>): Promise<unknown> {
    if (this.status !== 'open' || this.failed) {
      this.discard('adopt-unavailable');
      return fresh();
    }
    this.status = 'adopted';
    this.decide({ kind: 'adopt', producer });
    log.info('early-card', 'adopted', { scope: this.scope });
    return this.result;
  }

  /** Not going to be used: finish the stream and recall the placeholder. */
  discard(reason: string): void {
    if (this.status !== 'open') return;
    this.status = 'discarded';
    this.decide({ kind: 'discard' });
    log.info('early-card', 'discarded', { scope: this.scope, reason });
    void this.result
      .then(async (res) => {
        const id = this.messageId ?? (res as { messageId?: string } | undefined)?.messageId;
        if (id) await this.channel.recallMessage(id);
      })
      .catch((err: unknown) =>
        log.warn('early-card', 'recall-failed', { scope: this.scope, err: err instanceof Error ? err.message : String(err) }),
      );
  }
}

/** One placeholder per scope for the batch that is still pending. */
export class EarlyCards<C extends EarlyCardCtrl = EarlyCardCtrl> {
  private readonly byScope = new Map<string, EarlyCard<C>>();

  constructor(
    private readonly open: (scope: string, msg: NormalizedMessage) => EarlyCard<C> | undefined,
  ) {}

  /** Called for every accepted message; opens a card only for the first of a batch. */
  ensure(scope: string, msg: NormalizedMessage): void {
    if (this.byScope.has(scope)) return;
    const card = this.open(scope, msg);
    if (card) this.byScope.set(scope, card);
  }

  /** The batch is flushing (or being dropped): hand its card over. */
  take(scope: string): EarlyCard<C> | undefined {
    const card = this.byScope.get(scope);
    this.byScope.delete(scope);
    return card;
  }

  /** f0.5 之后 (steer): a batch went back to the queue — give its card back. */
  restore(scope: string, card: EarlyCard<C> | undefined): void {
    if (!card) return;
    if (this.byScope.has(scope)) {
      card.discard('steer-restore-duplicate');
      return;
    }
    this.byScope.set(scope, card);
  }

  discardAll(reason: string): void {
    for (const [scope, card] of this.byScope) {
      this.byScope.delete(scope);
      card.discard(reason);
    }
  }
}

/** Same reply routing the flush uses (topic replies stay in their thread). */
export function earlySendOpts(msg: NormalizedMessage): { replyTo?: string; replyInThread?: boolean } {
  return msg.threadId ? { replyTo: msg.messageId, replyInThread: true } : {};
}
