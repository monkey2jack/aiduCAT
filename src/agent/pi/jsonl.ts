import type { AgentEvent } from '../types';
import type { RpcEvent } from './rpc-client';

/**
 * f0.6+ (pi): translate pi RPC session events into aiduCAT AgentEvents.
 *
 * Mapping (docs/json.md + rpc-commands.md):
 *  - message_update{text_delta,thinking_delta} → text / thinking deltas
 *  - message_update.usage is the per-response cumulative usage snapshot;
 *    it is the LIVE context-window fill (not a whole-session billing total
 *    like codex's turn.completed), so it maps to a plain per-message usage
 *  - tool_execution_start/end → tool_use / tool_result
 *  - queue_update → steer marker when a queued steering message is taken
 *    in (its queue empties), mirroring claude's --replay-user-messages echo
 *  - agent_settled → done (aborted → interrupted)
 *  - assistant message_end with stopReason 'error' → error, but DEFERRED
 *    until agent_settled: pi auto-retries retryable provider errors (429,
 *    overloaded, socket closed, fetch failed…) after message_end, so an
 *    error is only terminal once pi settles without a successful retry.
 *    Emitting it early made the bridge end the run, abort pi mid-retry and
 *    SIGKILL it (2026-11-24 Hangzhou "chats break after a few turns").
 *  - auto_retry_start → a short thinking note (the card shows we are
 *    waiting on the upstream, not hung); clears the pending error
 *  - auto_retry_end{success:false} → pending error = finalError
 */

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  cost?: { total?: number };
}

interface AssistantMessage {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: Usage;
}

export class PiStreamTranslator {
  private sawText = false;
  private steeringOutstanding = 0;
  private settled = false;
  /** Error held back until agent_settled (pi may still auto-retry it). */
  private pendingError: string | undefined;

  /** Mark that the bridge queued a steer (its queue_update will confirm). */
  noteSteerQueued(): void {
    this.steeringOutstanding += 1;
  }

  get hasSettled(): boolean {
    return this.settled;
  }

  translate(evt: RpcEvent): AgentEvent[] {
    const out: AgentEvent[] = [];
    switch (evt.type) {
      case 'message_update': {
        const usage = evt.usage as Usage | undefined;
        const sub = evt.assistantMessageEvent as
          | { type?: string; delta?: string; contentIndex?: number }
          | undefined;
        if (!sub) break;
        if (sub.type === 'text_delta' && typeof sub.delta === 'string') {
          this.sawText = true;
          out.push({ type: 'text', delta: sub.delta });
        } else if (sub.type === 'thinking_delta' && typeof sub.delta === 'string') {
          out.push({ type: 'thinking', delta: sub.delta });
        }
        if (usage && (sub.type === 'text_delta' || sub.type === 'thinking_delta')) {
          out.push(usageEvent(usage));
        }
        break;
      }
      case 'tool_execution_start': {
        out.push({
          type: 'tool_use',
          id: String(evt.toolCallId ?? ''),
          name: String(evt.toolName ?? 'tool'),
          input: evt.args,
        });
        break;
      }
      case 'tool_execution_end': {
        out.push({
          type: 'tool_result',
          id: String(evt.toolCallId ?? ''),
          output: stringifyResult(evt.result),
          isError: evt.isError === true,
        });
        break;
      }
      case 'queue_update': {
        const steering = Array.isArray(evt.steering) ? (evt.steering as unknown[]) : [];
        if (this.steeringOutstanding > 0 && steering.length === 0) {
          // pi took the queued steering message in. The adapter emits the
          // steer event itself on send (pi's echo is unreliable), so only
          // clear the counter here to avoid closing the card twice.
          this.steeringOutstanding = 0;
        }
        break;
      }
      case 'message_end': {
        const msg = evt.message as AssistantMessage | undefined;
        if (msg?.role !== 'assistant') break;
        if (msg.usage) {
          const base = usageEvent(msg.usage);
          if (base.type === 'usage') {
            out.push({ ...base, callFinal: true });
            out.push({ ...base, cumulative: true });
          }
        }
        if (msg.stopReason === 'error') {
          this.pendingError = msg.errorMessage ?? 'pi run failed';
        } else {
          // a later successful response supersedes an earlier failure
          this.pendingError = undefined;
        }
        break;
      }
      case 'auto_retry_start': {
        this.pendingError = undefined;
        const attempt = Number(evt.attempt ?? 0);
        const max = Number(evt.maxAttempts ?? 0);
        const secs = Math.round(Number(evt.delayMs ?? 0) / 1000);
        out.push({
          type: 'thinking',
          delta: `\n（上游繁忙，${secs} 秒后自动重试 ${attempt}/${max}）\n`,
        });
        break;
      }
      case 'auto_retry_end': {
        if (evt.success === false) {
          this.pendingError = String(evt.finalError ?? this.pendingError ?? 'pi run failed');
        } else {
          this.pendingError = undefined;
        }
        break;
      }
      case 'agent_settled': {
        this.settled = true;
        const aborted = evt.aborted === true;
        const err = this.pendingError;
        this.pendingError = undefined;
        if (err && !aborted) {
          out.push({ type: 'error', message: err, terminationReason: 'failed' });
        } else {
          out.push({
            type: 'done',
            terminationReason: aborted ? 'interrupted' : 'normal',
          });
        }
        break;
      }
      default:
        break;
    }
    return out;
  }

  /** True when at least one text delta was produced (empty-turn detection). */
  get producedText(): boolean {
    return this.sawText;
  }
}

function usageEvent(u: Usage): AgentEvent {
  return {
    type: 'usage',
    ...(typeof u.input === 'number' ? { inputTokens: u.input } : {}),
    ...(typeof u.output === 'number' ? { outputTokens: u.output } : {}),
    ...(typeof u.cacheRead === 'number' ? { cachedInputTokens: u.cacheRead } : {}),
    ...(typeof u.cacheWrite === 'number' ? { cacheCreationInputTokens: u.cacheWrite } : {}),
    ...(typeof u.reasoning === 'number' ? { reasoningOutputTokens: u.reasoning } : {}),
    ...(typeof u.cost?.total === 'number' ? { costUsd: u.cost.total } : {}),
  };
}

function stringifyResult(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        parts.push(String((block as { text?: unknown }).text ?? ''));
      } else {
        parts.push(JSON.stringify(block));
      }
    }
    return parts.join('\n');
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
