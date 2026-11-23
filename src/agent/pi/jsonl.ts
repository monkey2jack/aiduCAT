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
 *  - assistant message_end with stopReason 'error' → error
 *  - auto_retry_* are informational and surface as nothing (run-watchdog
 *    already has its own timeout machinery)
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
          out.push({
            type: 'error',
            message: msg.errorMessage ?? 'pi run failed',
            terminationReason: 'failed',
          });
        }
        break;
      }
      case 'agent_settled': {
        this.settled = true;
        out.push({
          type: 'done',
          terminationReason: evt.aborted === true ? 'interrupted' : 'normal',
        });
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
