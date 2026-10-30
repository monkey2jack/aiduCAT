/**
 * f031-#8: claude stream-json usage shapes. Numbers are copied from usage
 * fields only (no conversation text) — see notes/f031-taskbook.md 「功能审查」.
 */
export interface CallUsage {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
}

const model = 'claude-opus-4-1';

const calls: CallUsage[] = [
  { input_tokens: 4210, cache_read_input_tokens: 148_000, cache_creation_input_tokens: 1_900, output_tokens: 600 },
  { input_tokens: 4386, cache_read_input_tokens: 151_200, cache_creation_input_tokens: 1_200, output_tokens: 900 },
];
const subagentCall: CallUsage = {
  input_tokens: 3, cache_read_input_tokens: 11_000, cache_creation_input_tokens: 2_500, output_tokens: 300,
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
