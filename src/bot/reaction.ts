import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

/**
 * Add a "Get" (了解) reaction to a message to give users an instant
 * "I got your message" cue while Claude is still working. 猴哥钦定 emoji
 * (aiduCAT f0.1). Card mode doesn't need the thinking footer — the
 * streaming card already shows live status; the reaction is the arrival cue.
 *
 * Returns the reaction id on success, undefined on any failure. Failures
 * are logged but never thrown — losing a decoration must not break the
 * actual reply flow.
 */
export async function addWorkingReaction(
  channel: LarkChannel,
  messageId: string,
  /** f0.3.4: latency fields (atMs/sinceMsgMs) measured when the call STARTED. */
  timing?: { atMs: number; sinceMsgMs?: number },
): Promise<string | undefined> {
  try {
    const id = await channel.addReaction(messageId, 'Get');
    if (id) {
      log.info('reaction', 'added', {
        messageId,
        reactionId: id,
        ...(timing ? { requestedAtMs: timing.atMs, sinceMsgMs: timing.sinceMsgMs, doneAtMs: Date.now() } : {}),
      });
    }
    return id;
  } catch (err) {
    log.warn('reaction', 'add-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Remove a previously-added reaction. Tolerates errors silently — best
 * effort cleanup; a leftover reaction is harmless. */
export async function removeReaction(
  channel: LarkChannel,
  messageId: string,
  reactionId: string,
): Promise<void> {
  try {
    await channel.removeReaction(messageId, reactionId);
    log.info('reaction', 'removed', { messageId, reactionId });
  } catch (err) {
    log.warn('reaction', 'remove-failed', {
      messageId,
      reactionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
