import { log } from '../../core/logger';
import type { AgentEvent } from '../types';

/**
 * Prod 2026-11-08 (嘟嘟「响应后撤回」): a background Bash from the previous turn
 * is stopped when that turn's `claude` exits, and Claude Code queues a
 * `<task-notification>` in the session. On the next `--resume` it answers the
 * notification first and emits a `result` with nothing in it (sometimes only
 * the synthetic「No response requested.」, which stream-json drops), then goes
 * on to answer the real prompt in the same process. Taking that first `result`
 * as the end of the turn left the card empty (recalled) and killed claude
 * 15 s later in the middle of the real answer.
 *
 * Rule: a `done` that closes a segment with nothing visible in it (no text,
 * thinking or tool call since the run started or since the previous `done`) is
 * held. Anything else arriving after it means claude kept going: drop the held
 * `done` and stream on. The stream ending (claude exited) or `holdMs` passing
 * with nothing new releases it unchanged. A `done` after visible output is
 * passed straight through, so normal turns end exactly as before.
 */
export async function* holdEmptyDone(
  source: AsyncGenerator<AgentEvent>,
  opts: { holdMs: number },
): AsyncGenerator<AgentEvent> {
  let visible = false;
  let held: AgentEvent | undefined;
  let pending: Promise<IteratorResult<AgentEvent>> | undefined;
  try {
    while (true) {
      pending ??= source.next();
      let step: IteratorResult<AgentEvent> | 'timeout';
      if (held) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), opts.holdMs);
        });
        step = await Promise.race([pending, timeout]);
        clearTimeout(timer);
      } else {
        step = await pending;
      }
      if (step === 'timeout') {
        // Claude neither continued nor exited: let the turn end as before.
        log.info('agent', 'empty-result-released', { reason: 'hold-timeout', holdMs: opts.holdMs });
        const out = held!;
        held = undefined;
        yield out;
        continue;
      }
      pending = undefined;
      if (step.done) break;
      const evt = step.value;
      if (held) {
        log.info('agent', 'empty-result-skipped', { next: evt.type });
        held = undefined;
      }
      if (evt.type === 'done') {
        if (!visible) {
          held = evt;
          continue;
        }
        visible = false;
        yield evt;
        continue;
      }
      // f0.5 之后 (steer): a message taken in mid-run starts a new segment.
      if (evt.type === 'steer') visible = false;
      if (evt.type === 'text' || evt.type === 'thinking' || evt.type === 'tool_use') visible = true;
      yield evt;
    }
    if (held) yield held;
  } finally {
    // A next() still in flight (released on timeout, then the consumer
    // stopped) must not block the consumer: close the source once it settles.
    if (pending) {
      void pending.then(
        () => source.return?.(undefined),
        () => {},
      );
    } else {
      await source.return?.(undefined);
    }
  }
}
