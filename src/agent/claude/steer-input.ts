import type { Writable } from 'node:stream';
import { log } from '../../core/logger';

/**
 * f0.5 之后 (steer, Wei 2026-11-10「插话」): claude's stdin as a live input.
 *
 * The run starts `claude -p --input-format stream-json --replay-user-messages`
 * and the prompt goes in as the first stream-json user line. stdin then stays
 * open, so a message the user sends while claude works can be written in as
 * another user line: claude reads it at its next step (between tool calls)
 * and carries on in the same turn — no restart (probed on summer, CC
 * 2.1.319). A message that lands as the turn is ending becomes a new turn in
 * the same process.
 *
 * `--replay-user-messages` echoes each user line back (`isReplay: true`) at
 * the moment claude takes it in; matching the echo to what we wrote is how
 * the bridge knows when to close the old card and start the new one.
 *
 * stdin is closed at a `result` when nothing written is still waiting, so
 * claude exits as before. Until then a `result` (end of the turn the message
 * did not make it into) is not the end of the run: its `done` is held back.
 */
export class SteerInput {
  private open = true;
  private initialSeen = false;
  private readonly initial: string;
  /** Written into stdin, not yet echoed back by claude (oldest first). */
  private readonly waiting: string[] = [];

  constructor(
    private readonly stdin: Writable,
    prompt: string,
  ) {
    this.initial = prompt;
    stdin.on('error', () => {
      this.open = false;
    });
    stdin.on('close', () => {
      this.open = false;
    });
    stdin.write(userLine(prompt), 'utf8');
  }

  /** Messages written but not yet taken in. */
  get pending(): number {
    return this.waiting.length;
  }

  steer(prompt: string): boolean {
    if (!this.open || this.stdin.destroyed || this.stdin.writableEnded) return false;
    this.waiting.push(prompt);
    this.stdin.write(userLine(prompt), 'utf8');
    log.info('agent', 'steer-written', { promptChars: prompt.length, waiting: this.waiting.length });
    return true;
  }

  /**
   * Look at one raw stream-json event before translation:
   * - `steer`: claude just took in a message written with `steer()`;
   * - `skip`: the echo of the first prompt (nothing to show);
   * - undefined: not ours, translate as usual.
   */
  classify(raw: unknown): 'steer' | 'skip' | undefined {
    const evt = raw as { type?: unknown; isReplay?: unknown; message?: { content?: unknown } } | null;
    if (!evt || evt.type !== 'user' || evt.isReplay !== true) return undefined;
    const text = userText(evt.message?.content);
    if (text === undefined) return undefined;
    if (this.waiting.length > 0 && same(this.waiting[0]!, text)) {
      this.waiting.shift();
      log.info('agent', 'steer-taken', { waiting: this.waiting.length });
      return 'steer';
    }
    if (!this.initialSeen && same(this.initial, text)) {
      this.initialSeen = true;
      return 'skip';
    }
    return undefined;
  }

  /**
   * A `result` arrived. True = a written message is still on its way in, so
   * this is not the end of the run (hold its `done`); otherwise stdin closes
   * and claude exits on its own.
   */
  onResult(): boolean {
    if (this.waiting.length > 0) {
      log.info('agent', 'steer-result-held', { waiting: this.waiting.length });
      return true;
    }
    this.close();
    return false;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    if (!this.stdin.destroyed && !this.stdin.writableEnded) this.stdin.end();
  }
}

export function userLine(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}

function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  let text = '';
  let any = false;
  for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      text += block.text;
      any = true;
    } else {
      return undefined; // tool_result etc. — never one of ours
    }
  }
  return any ? text : undefined;
}

function same(a: string, b: string): boolean {
  return a.trim() === b.trim();
}
