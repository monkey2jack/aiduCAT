import type { AgentEvent } from '../types';

/**
 * f0.5++: DSH (DeepSeek Harness) `headless --json` → aiduCAT agent events.
 *
 * Protocol (DeepSeek Harness 0.2.2-rc.3, one JSON object per stdout line;
 * authoritative source: `@deepseek-ai/dsh-headless/src/json-stream.ts`):
 *
 *   {type:"session",     sessionId, cwd}
 *   {type:"status",      phase:"turn_start"|"step_start"|"step_end"|"turn_end",
 *                        turn, step?, usage?, reason?}
 *   {type:"thinking",    text}   committed reasoning block
 *   {type:"text",        text}   committed answer block
 *   {type:"tool_call",   callId, tool, input}
 *   {type:"tool_result", callId, status:"completed"|"error", result, error?}
 *   {type:"error",       message}                      usage error; no `final` follows
 *   {type:"final",       sessionId, reason, text}      terminal (reason may be null)
 *
 * Four protocol facts shape this translator:
 *
 * 1. `text` / `thinking` are projected from COMMITTED assistant messages, so
 *    each carries a whole block — not a token delta — and arrives at the step's
 *    commit point rather than live. aiduCAT accumulates `text` deltas and
 *    starts a new block after a tool, which is exactly the block structure DSH
 *    reports, so each block is emitted verbatim.
 * 2. Every string except the terminal `final` is capped at 8 KiB and flagged
 *    with `truncated: true`. A capped block would leave half an answer on the
 *    card, so it is dropped here and the lossless `final.text` supplies the
 *    whole answer instead (see {@link DshStreamTranslator.needsTerminalText}).
 * 3. `status.step_end.usage` is ONE step's provider usage. DSH reports
 *    `inputTokens` EXCLUDING cache reads — verified against a live run:
 *    input 2267 + cacheRead 4096 + output 5 = total 6368 — which is the claude
 *    shape, so it maps without codex's cached-token subtraction and must NOT be
 *    marked cumulative, because the card's context readout ignores those.
 * 4. `final.reason` is `null` when the final turn never closed, so a missing
 *    reason means the run did not complete; the adapter combines that with the
 *    process exit code rather than trusting either alone.
 */

/** One step's provider usage, as DSH reports it. */
export interface DshUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** The captured terminal `final` event. */
export interface DshFinal {
  sessionId: string;
  /**
   * Durable turn reason kind (`completed` / `error` / …), or `undefined` when
   * the stream carried no terminal reason (`reason: null`).
   */
  reasonKind: string | undefined;
  /** The lossless answer. Never truncated by the projection. */
  text: string;
  errorCode?: string;
  errorMessage?: string;
}

export class DshStreamTranslator {
  private sessionId: string | undefined;
  /** Answer blocks emitted as stream deltas, concatenated for comparison. */
  private readonly answerParts: string[] = [];
  /** True once the projection capped an answer block, making the stream partial. */
  private answerCapped = false;
  /** Message from a stream-level `error` event (usage error; no `final`). */
  private streamError: string | undefined;
  private toolSeq = 0;

  /** Translate one parsed line; the terminal `final` is captured, not emitted. */
  translate(raw: unknown): AgentEvent[] {
    if (!isRecord(raw) || typeof raw.type !== 'string') return [];
    switch (raw.type) {
      case 'session': {
        const id = str(raw.sessionId);
        if (id) this.sessionId = id;
        return [];
      }
      case 'status':
        return this.translateStatus(raw);
      case 'text':
        return this.translateText(raw);
      case 'thinking': {
        const text = typeof raw.text === 'string' ? raw.text : '';
        if (!text) return [];
        return [{ type: 'thinking', delta: text }];
      }
      case 'tool_call': {
        const id = str(raw.callId) ?? `dsh-tool-${++this.toolSeq}`;
        const name = str(raw.tool) ?? 'tool';
        return [{ type: 'tool_use', id, name, input: raw.input ?? {} }];
      }
      case 'tool_result': {
        const id = str(raw.callId) ?? `dsh-tool-${this.toolSeq}`;
        const result = raw.result;
        return [
          {
            type: 'tool_result',
            id,
            output: typeof result === 'string' ? result : JSON.stringify(result ?? ''),
            isError: str(raw.status) === 'error',
          },
        ];
      }
      case 'error': {
        // A usage error (bad flag, unknown option) ends the stream with an
        // `error` event and no `final`; keep the text for the adapter.
        this.streamError = str(raw.message) ?? 'dsh error';
        return [];
      }
      case 'final':
        return []; // captured by `consumeFinal`
      default:
        return [];
    }
  }

  private translateStatus(raw: Record<string, unknown>): AgentEvent[] {
    switch (str(raw.phase)) {
      case 'turn_start':
      case 'step_start':
      case 'turn_end':
        // Heartbeat with an EMPTY delta. DSH commits text/thinking only at a
        // step boundary, so a long step would otherwise leave the run silent
        // and trip the idle watchdog; an empty delta re-arms it and keeps the
        // empty-run guard fed without writing placeholder characters into the
        // 💭 section, which real `thinking` blocks then fill verbatim.
        return [{ type: 'thinking', delta: '' }];
      case 'step_end': {
        const usage = isRecord(raw.usage) ? raw.usage : undefined;
        return usage ? [usageEvent(usage)] : [];
      }
      default:
        return [];
    }
  }

  private translateText(raw: Record<string, unknown>): AgentEvent[] {
    const text = typeof raw.text === 'string' ? raw.text : '';
    if (!text) return [];
    if (raw.truncated === true) {
      // Hold back a capped block: it is a fragment, and the terminal answer is
      // the only complete copy. Any earlier uncapped blocks stay on the card;
      // the adapter emits the whole answer as `final_text` when it arrives.
      this.answerCapped = true;
      return [];
    }
    this.answerParts.push(text);
    return [{ type: 'text', delta: text }];
  }

  /** Inspect one line and, if it is the terminal `final`, capture its payload. */
  consumeFinal(raw: unknown): DshFinal | undefined {
    if (!isRecord(raw) || raw.type !== 'final') return undefined;
    const sessionId = str(raw.sessionId) ?? this.sessionId ?? '';
    const reason = isRecord(raw.reason) ? raw.reason : undefined;
    const kind = reason ? str(reason.kind) : undefined;
    const err = reason && isRecord(reason.error) ? reason.error : undefined;
    const text = typeof raw.text === 'string' ? raw.text : '';
    return {
      sessionId,
      reasonKind: kind,
      text,
      ...(err
        ? {
            errorCode: str(err.code) ?? 'dsh-error',
            errorMessage: str(err.message) ?? 'DSH run failed',
          }
        : {}),
    };
  }

  currentSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Message from a stream-level `error` event, when the stream carried one. */
  errorFromStream(): string | undefined {
    return this.streamError;
  }

  /**
   * Whether the terminal answer must also be emitted as `final_text`.
   *
   * The card deduplicates a terminal answer that its streamed blocks already
   * cover, so it is emitted only when the streamed copy cannot stand alone:
   * nothing was streamed, a block was capped, or the blocks do not reconstruct
   * the terminal text exactly.
   */
  needsTerminalText(terminalText: string): boolean {
    if (!terminalText) return false;
    if (this.answerCapped) return true;
    if (this.answerParts.join('') === terminalText) return false;
    // The last committed block often repeats the terminal answer verbatim
    // (e.g. a tool turn whose final block is the result). Emitting it again
    // would only add an event the card then discards.
    if (this.answerParts.some((part) => part.includes(terminalText))) return false;
    return true;
  }
}

function usageEvent(usage: Record<string, unknown>): AgentEvent {
  return {
    type: 'usage',
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    cachedInputTokens: num(usage.cacheReadTokens),
    cacheCreationInputTokens: num(usage.cacheWriteTokens),
    reasoningOutputTokens: num(usage.reasoningTokens),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
