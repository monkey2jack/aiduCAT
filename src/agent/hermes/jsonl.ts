import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

/**
 * f0.4+: Hermes Agent `chat --format stream-json` → aiduCAT agent events.
 *
 * Protocol (Hermes 0.22, one JSON object per stdout line):
 *   system{subtype:init, model, session_id}   (session_id is empty at init)
 *   text{text}                                streamed answer delta
 *   tool_use{name, tool_call_id?, input?}
 *   tool_result{name, tool_call_id?, output, duration_ms, is_error}
 *   result{session_id, exit_code, text, tokens{input,output,total,cache_read,cache_write}, error?, replay_gap?}
 *
 * Reasoning is not part of the protocol, so a Hermes card has no thinking
 * section. `tokens` is the whole turn (every API call summed) — marked
 * cumulative so the card's context readout ignores it. Hermes `input`
 * already excludes cache reads (claude shape).
 */

export interface HermesResult {
  sessionId: string;
  exitCode: number;
  text: string;
  error?: string;
  replayGap: boolean;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** Hermes refuses a resume whose launch flags differ from the session's. */
export const HERMES_RESUME_REFUSED = 'Resume retains gateway session policy';

export class HermesStreamTranslator {
  private sawText = false;
  private toolSeq = 0;
  private readonly pendingByName = new Map<string, string[]>();
  private result: HermesResult | undefined;
  private model: string | undefined;

  /** Translate one parsed line; the terminal `result` is captured, not emitted. */
  translate(raw: unknown): AgentEvent[] {
    if (!isRecord(raw) || typeof raw.type !== 'string') return [];
    switch (raw.type) {
      case 'system': {
        const model = str(raw.model);
        if (model) this.model = model;
        return [];
      }
      case 'text': {
        const delta = str(raw.text);
        if (!delta) return [];
        this.sawText = true;
        return [{ type: 'text', delta }];
      }
      case 'tool_use': {
        const name = str(raw.name) ?? 'tool';
        const id = str(raw.tool_call_id) ?? `hermes-tool-${++this.toolSeq}`;
        const queue = this.pendingByName.get(name) ?? [];
        queue.push(id);
        this.pendingByName.set(name, queue);
        return [{ type: 'tool_use', id, name, input: isRecord(raw.input) ? raw.input : {} }];
      }
      case 'tool_result': {
        const name = str(raw.name) ?? 'tool';
        const queue = this.pendingByName.get(name) ?? [];
        let id = str(raw.tool_call_id);
        if (id) {
          const at = queue.indexOf(id);
          if (at >= 0) queue.splice(at, 1);
        } else {
          id = queue.shift() ?? `hermes-tool-${++this.toolSeq}`;
        }
        return [{
          type: 'tool_result',
          id,
          output: typeof raw.output === 'string' ? raw.output : JSON.stringify(raw.output ?? ''),
          isError: raw.is_error === true,
        }];
      }
      case 'result': {
        const tokens = isRecord(raw.tokens) ? raw.tokens : undefined;
        this.result = {
          sessionId: str(raw.session_id) ?? '',
          exitCode: typeof raw.exit_code === 'number' ? raw.exit_code : 1,
          text: str(raw.text) ?? '',
          ...(str(raw.error) ? { error: str(raw.error) } : {}),
          replayGap: raw.replay_gap === true,
          ...(tokens
            ? {
                usage: {
                  input: num(tokens.input),
                  output: num(tokens.output),
                  cacheRead: num(tokens.cache_read),
                  cacheWrite: num(tokens.cache_write),
                },
              }
            : {}),
        };
        return [];
      }
      default:
        log.warn('jsonl', 'unknown_event', { agent: 'hermes', eventType: raw.type });
        return [];
    }
  }

  getResult(): HermesResult | undefined {
    return this.result;
  }

  getModel(): string | undefined {
    return this.model;
  }

  /** True when the turn was refused before it started because its flags differ from the session's. */
  resumeRefused(): boolean {
    return Boolean(this.result && this.result.exitCode !== 0 && this.result.error?.startsWith(HERMES_RESUME_REFUSED));
  }

  /**
   * Events that close a turn from its captured result. `sessionKey` is the
   * aiduCAT session id to record (already updated by the adapter).
   */
  finishEvents(opts: { sessionKey?: string; stopped: boolean }): AgentEvent[] {
    const r = this.result;
    const events: AgentEvent[] = [];
    const ok = r?.exitCode === 0 || r?.exitCode === 130;
    if (r && ok && (!this.sawText || r.replayGap) && r.text.trim()) {
      events.push({ type: 'final_text', content: r.text });
    }
    if (r?.usage && (r.usage.input > 0 || r.usage.output > 0)) {
      events.push({
        type: 'usage',
        inputTokens: r.usage.input,
        outputTokens: r.usage.output,
        cachedInputTokens: r.usage.cacheRead,
        cacheCreationInputTokens: r.usage.cacheWrite,
        cumulative: true,
      });
    }
    if (opts.sessionKey) events.push({ type: 'system', sessionId: opts.sessionKey });
    if (opts.stopped || r?.exitCode === 130) {
      events.push({ type: 'done', ...(opts.sessionKey ? { sessionId: opts.sessionKey } : {}), terminationReason: 'interrupted' });
      return events;
    }
    if (r && r.exitCode === 0) {
      events.push({ type: 'done', ...(opts.sessionKey ? { sessionId: opts.sessionKey } : {}), terminationReason: 'normal' });
      return events;
    }
    const detail = r?.error ?? (r?.text || undefined);
    events.push({
      type: 'error',
      message: truncate(`hermes exited with code ${r?.exitCode ?? 1}${detail ? `: ${detail}` : ''}`, 4096),
      terminationReason: 'failed',
    });
    return events;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
