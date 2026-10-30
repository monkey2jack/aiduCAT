/**
 * f031-#8: claude stream-json usage shapes with REAL numbers taken (usage
 * fields only, no conversation text) from 嘟嘟's production transcripts on
 * 2026-10-31: the last two main-line calls of a 3210-call session (10router
 * gateway: input_tokens excludes the cache, cache_creation is 0) and one
 * sub-agent call. Turn total / API time are derived, not observed.
 */
export interface CallUsage {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
}

const model = 'Claude-Opus-4.6';

const calls: CallUsage[] = [
  { input_tokens: 4585, cache_read_input_tokens: 543_763, cache_creation_input_tokens: 0, output_tokens: 291 },
  { input_tokens: 4387, cache_read_input_tokens: 544_304, cache_creation_input_tokens: 0, output_tokens: 903 },
];
const subagentCall: CallUsage = {
  input_tokens: 8436, cache_read_input_tokens: 30_532, cache_creation_input_tokens: 0, output_tokens: 930,
};
const turn: CallUsage = {
  input_tokens: calls[0]!.input_tokens + calls[1]!.input_tokens,
  cache_read_input_tokens: calls[0]!.cache_read_input_tokens + calls[1]!.cache_read_input_tokens,
  cache_creation_input_tokens: calls[0]!.cache_creation_input_tokens + calls[1]!.cache_creation_input_tokens,
  output_tokens: calls[0]!.output_tokens + calls[1]!.output_tokens,
};
const durationApiMs = 42_000;

export const CLAUDE_USAGE_FIXTURE = {
  model,
  calls,
  subagentCall,
  turn,
  durationApiMs,
  mainAssistant: (u: CallUsage) => ({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { model, content: [], usage: { ...u, service_tier: 'standard' } },
  }),
  sidechainAssistant: (u: CallUsage) => ({
    type: 'assistant',
    parent_tool_use_id: 'toolu_subagent',
    message: { model, content: [], usage: { ...u, service_tier: 'standard' } },
  }),
  result: (over: Partial<CallUsage> = {}) => ({
    type: 'result',
    subtype: 'success',
    session_id: 'sess-1',
    duration_ms: durationApiMs + 9_000,
    duration_api_ms: durationApiMs,
    total_cost_usd: 0.5,
    usage: { ...turn, ...over },
  }),
};
