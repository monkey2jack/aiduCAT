import type { AgentEvent } from '../types';

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeRawEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  /** Set (non-null) when the event comes from a sub-agent (Task tool). */
  parent_tool_use_id?: string | null;
  message?: {
    content?: ContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd?: number;
}

type RawUsage = NonNullable<ClaudeRawEvent['usage']>;

/** f031-#8: any token field > 0 (cache-only snapshots are real, not empty). */
function hasTokens(u: RawUsage): boolean {
  return (
    (u.input_tokens ?? 0) > 0 ||
    (u.output_tokens ?? 0) > 0 ||
    (u.cache_read_input_tokens ?? 0) > 0 ||
    (u.cache_creation_input_tokens ?? 0) > 0
  );
}

function perCallUsage(u: RawUsage, evt: ClaudeRawEvent, callFinal = false): AgentEvent {
  return {
    type: 'usage',
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cachedInputTokens: u.cache_read_input_tokens,
    cacheCreationInputTokens: u.cache_creation_input_tokens,
    ...(evt.parent_tool_use_id ? { sidechain: true } : {}),
    ...(callFinal ? { callFinal: true } : {}),
  };
}

export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as ClaudeRawEvent;

  if (evt.type === 'system' && evt.subtype === 'init') {
    yield {
      type: 'system',
      sessionId: evt.session_id,
      cwd: evt.cwd,
      model: evt.model,
    };
    return;
  }

  if (evt.type === 'assistant' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        yield { type: 'text', delta: block.text };
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        yield { type: 'thinking', delta: block.thinking };
      } else if (block.type === 'tool_use' && block.id && block.name) {
        yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      }
    }
    // aiduCAT: assistant-message usage is zero-filled for gateway models (the
    // real per-call numbers ride on message_delta) — only surface it when it
    // actually carries tokens, so a zero snapshot never clobbers a good one.
    const u = evt.message.usage;
    if (u && hasTokens(u)) yield perCallUsage(u, evt);
    return;
  }

  // aiduCAT: with --include-partial-messages the CLI forwards raw Anthropic
  // stream events. `message_delta` carries the authoritative per-API-call
  // usage (input+cache tokens = the context this call actually loaded), which
  // is what the panel's live context readout needs.
  if (evt.type === 'stream_event') {
    const inner = (evt as { event?: { type?: string; usage?: ClaudeRawEvent['usage'] } }).event;
    if (inner?.type === 'message_delta' && inner.usage) {
      const u = inner.usage;
      // f0.3.5: one message_delta per API call = that call's final usage.
      if (hasTokens(u)) yield perCallUsage(u, evt, true);
    }
    return;
  }

  if (evt.type === 'user' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const output =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        yield {
          type: 'tool_result',
          id: block.tool_use_id,
          output,
          isError: block.is_error === true,
        };
      }
    }
    return;
  }

  if (evt.type === 'result') {
    if (evt.usage) {
      yield {
        type: 'usage',
        inputTokens: evt.usage.input_tokens,
        outputTokens: evt.usage.output_tokens,
        cachedInputTokens: evt.usage.cache_read_input_tokens,
        cacheCreationInputTokens: evt.usage.cache_creation_input_tokens,
        costUsd: evt.total_cost_usd,
        cumulative: true,
      };
    }
    yield { type: 'done', sessionId: evt.session_id, terminationReason: 'normal' };
  }
}
