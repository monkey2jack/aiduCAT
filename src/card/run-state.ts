import type { AgentEvent } from '../agent/types';
import { stripLeakedThinking } from './thinking-leak';

/** 'stopped' = the round ended (stop/timeout/error) before this tool returned. */
export type ToolStatus = 'running' | 'done' | 'error' | 'stopped';

export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: string;
}

export type Block =
  /** `raw`: f031-stab-#6 — the text as streamed, kept only when leaked
   * thinking was stripped from `content` (needed to keep merging deltas). */
  | { kind: 'text'; content: string; streaming: boolean; raw?: string }
  | { kind: 'tool'; tool: ToolEntry };

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | null;
export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';

/** aiduCAT clarify: one parsed [CLARIFY]{...} marker emitted by the agent. */
export interface ClarifyQuestion {
  question: string;
  options: string[];
  /** Raw marker line, stripped from the visible text block. */
  raw: string;
}

export interface RunState {
  blocks: Block[];
  finalText?: string;
  reasoning: { content: string; active: boolean; segments: number };
  footer: FooterStatus;
  terminal: Terminal;
  errorMsg?: string;
  /** Set when terminal === 'idle_timeout' — how long claude was idle before
   * the watchdog gave up (so the message can say "N 分钟无响应"). */
  idleTimeoutMinutes?: number;
  /** f031-stab-#4: set when the per-tool hard cap (not plain idle) fired. */
  timeoutTool?: string;
  /** aiduCAT clarify: last parsed question marker (rendered as option buttons
   * under the answer when the run ends waiting on user input). */
  clarify?: ClarifyQuestion;
  /** aiduCAT: latest token usage seen this run (assistant messages carry
   * per-message usage; the result event carries the final one). Drives the
   * context-window percentage in the panel header. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
}

export const initialState: RunState = {
  blocks: [],
  // segments: count of distinct thinking bursts (💭 in the aiduCAT panel).
  reasoning: { content: '', active: false, segments: 0 },
  footer: 'thinking',
  terminal: 'running',
};

/**
 * aiduCAT clarify marker: the bridge system prompt teaches the agent to emit
 * a single line `[CLARIFY]{"question":"...","options":["a","b"]}` when it
 * needs the user to pick. Parsed here so the renderer can turn it into
 * buttons and the text block stays clean. Tolerant of unescaped markers
 * split across stream deltas by re-scanning the accumulated text block.
 */
export function parseClarifyMarker(
  text: string,
): { clarify: ClarifyQuestion; cleaned: string } | null {
  const markerRegex = /\[CLARIFY\](\{[\s\S]*?\})(?:\n|$)/;
  const match = markerRegex.exec(text);
  if (!match) return null;
  const json = match[1] ?? '';
  try {
    const parsed = JSON.parse(json) as { question?: unknown; options?: unknown };
    const question = typeof parsed.question === 'string' ? parsed.question.trim() : '';
    const options = Array.isArray(parsed.options)
      ? parsed.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '')
      : [];
    // Not a well-formed clarify — leave the text alone (fail-open) rather
    // than swallow something the model emitted for a different purpose.
    if (!question || options.length === 0) return null;
    const start = match.index ?? 0;
    return {
      clarify: { question, options: options.slice(0, 8), raw: match[0] },
      cleaned:
        text.slice(0, start) + text.slice(start + match[0].length).replace(/^\n+/, ''),
    };
  } catch {
    return null;
  }
}

/**
 * f031-stab-#289: a round that ends abnormally (stop, timeout, error) closes
 * every tool still waiting for its result as 'stopped' — otherwise the
 * finished card lists it exactly like a completed call.
 */
function stopRunningTools(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === 'tool' && b.tool.status === 'running'
      ? { ...b, tool: { ...b.tool, status: 'stopped' as const } }
      : b,
  );
}

function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === 'text' && b.streaming ? { ...b, streaming: false } : b,
  );
}

export function reduce(state: RunState, evt: AgentEvent): RunState {
  switch (evt.type) {
    case 'text': {
      const last = state.blocks[state.blocks.length - 1];
      const rawMerged =
        last && last.kind === 'text' && last.streaming ? (last.raw ?? last.content) + evt.delta : evt.delta;
      // f031-stab-#6 (#148): leaked <think>…</think> never reaches the card.
      const merged = stripLeakedThinking(rawMerged);
      const raw = merged === rawMerged ? {} : { raw: rawMerged };
      const parsed = parseClarifyMarker(merged);
      if (parsed) {
        const block: Block = { kind: 'text', content: parsed.cleaned, streaming: false };
        return {
          ...state,
          blocks:
            last && last.kind === 'text' && last.streaming
              ? [...state.blocks.slice(0, -1), block]
              : [...state.blocks, block],
          clarify: parsed.clarify,
          reasoning: { ...state.reasoning, active: false },
          footer: 'streaming',
        };
      }
      if (merged.includes('[CLARIFY]')) {
        // Marker started but not complete yet (stream deltas can split it
        // anywhere). Keep the full merged text in the block so the sentinel
        // survives into the next delta — the renderer strips everything from
        // the sentinel on, so users never see marker fragments.
        const block: Block = { kind: 'text', content: merged, streaming: true, ...raw };
        return {
          ...state,
          blocks:
            last && last.kind === 'text' && last.streaming
              ? [...state.blocks.slice(0, -1), block]
              : [...state.blocks, block],
          reasoning: { ...state.reasoning, active: false },
          footer: 'streaming',
        };
      }
      const block: Block = { kind: 'text', content: merged, streaming: true, ...raw };
      return {
        ...state,
        blocks:
          last && last.kind === 'text' && last.streaming
            ? [...state.blocks.slice(0, -1), block]
            : [...state.blocks, block],
        reasoning: { ...state.reasoning, active: false },
        footer: 'streaming',
      };
    }

    case 'final_text': {
      // f0.2 clarify fix: the final answer frequently converges here (gateway
      // runs emit final_text, not streamed text deltas) — parse the clarify
      // marker out of it exactly like the text path, or the buttons never
      // appear (2026-10-19 猴哥 clarify 测试失败根因).
      const content = stripLeakedThinking(evt.content);
      const parsed = parseClarifyMarker(content);
      if (parsed) return { ...state, finalText: parsed.cleaned, clarify: parsed.clarify };
      return { ...state, finalText: content };
    }

    case 'usage':
      // aiduCAT: keep the latest per-message usage snapshot for the context
      // readout. The terminal `result` event carries the whole-turn CUMULATIVE
      // billing total (summed across every tool round) — using it would show a
      // wildly inflated, capped 100%. Only per-message snapshots reflect the
      // live context-window fill, so cumulative ones are ignored here.
      if (evt.cumulative || evt.sidechain) return state;
      return {
        ...state,
        usage: {
          inputTokens: evt.inputTokens,
          outputTokens: evt.outputTokens,
          cachedInputTokens: evt.cachedInputTokens,
          cacheCreationInputTokens: evt.cacheCreationInputTokens,
        },
      };

    case 'thinking': {
      // A new thinking burst (previous burst was closed by text/tool) bumps
      // the segment counter shown as 💭 count in the aiduCAT meta panel.
      const startedNewSegment = !state.reasoning.active;
      return {
        ...state,
        reasoning: {
          content: state.reasoning.content + evt.delta,
          active: true,
          segments: state.reasoning.segments + (startedNewSegment ? 1 : 0),
        },
        footer: 'thinking',
      };
    }

    case 'tool_use': {
      const tool: ToolEntry = {
        id: evt.id,
        name: evt.name,
        input: evt.input,
        status: 'running',
      };
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'tool_running',
      };
    }

    case 'tool_result': {
      const blocks = state.blocks.map((b) => {
        if (b.kind !== 'tool' || b.tool.id !== evt.id) return b;
        return {
          ...b,
          tool: {
            ...b.tool,
            status: evt.isError ? ('error' as const) : ('done' as const),
            output: evt.output,
          },
        };
      });
      return { ...state, blocks };
    }

    case 'error': {
      const terminal =
        evt.terminationReason === 'interrupted'
          ? 'interrupted'
          : evt.terminationReason === 'timeout'
            ? 'idle_timeout'
            : 'error';
      return {
        ...state,
        blocks: stopRunningTools(state.blocks),
        terminal,
        errorMsg: terminal === 'error' ? evt.message : state.errorMsg,
        footer: null,
      };
    }

    case 'done': {
      const terminal =
        evt.terminationReason === 'interrupted'
          ? 'interrupted'
          : evt.terminationReason === 'timeout'
            ? 'idle_timeout'
            : 'done';
      const closed = closeStreamingText(state.blocks);
      return {
        ...state,
        blocks: terminal === 'done' ? closed : stopRunningTools(closed),
        reasoning: { ...state.reasoning, active: false },
        terminal,
        footer: null,
      };
    }

    default:
      return state;
  }
}

export function markInterrupted(state: RunState): RunState {
  return {
    ...state,
    blocks: stopRunningTools(closeStreamingText(state.blocks)),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'interrupted',
    footer: null,
  };
}

export function markIdleTimeout(state: RunState, minutes: number, toolName?: string): RunState {
  return {
    ...state,
    blocks: stopRunningTools(closeStreamingText(state.blocks)),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'idle_timeout',
    footer: null,
    idleTimeoutMinutes: minutes,
    ...(toolName ? { timeoutTool: toolName } : {}),
  };
}

/** f031-stab-#4: the one-line, user-facing reason for a timeout terminal. */
export function timeoutNotice(state: RunState): string {
  const mins = state.idleTimeoutMinutes ?? 0;
  if (state.timeoutTool) {
    return `⏱ 工具「${state.timeoutTool}」运行超过 ${mins} 分钟没有结果，已自动停止本轮。可以直接重发，或换个做法再试。`;
  }
  return `⏱ ${mins} 分钟没有任何进展，已自动停止本轮。可以直接重发，或换个说法再试。`;
}

/**
 * fix(2026-10-30): terminal marker for an empty run - the agent process
 * exited without producing any substantive event (text/thinking/tool/
 * usage). Surfaced as an error so the user sees a visible failure card
 * instead of a silent empty Done card.
 */
export const EMPTY_RUN_MESSAGE = 'agent 没有产出任何内容（可能进程刚启动就退出了），请重发一次。';

export function markEmptyRun(state: RunState): RunState {
  return {
    ...state,
    blocks: stopRunningTools(closeStreamingText(state.blocks)),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'error',
    // f0.3.1 #4: keep a real error from the agent; otherwise say why it's red.
    errorMsg: state.errorMsg || EMPTY_RUN_MESSAGE,
    footer: null,
  };
}

export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state;
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'done',
    footer: null,
  };
}
