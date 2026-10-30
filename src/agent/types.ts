import type { AgentAvailability } from './preflight';
import type { ClaudePermissionMode, CodexSandboxMode } from '../config/permissions';

export type { ClaudePermissionMode } from '../config/permissions';

export type AgentEvent =
  | { type: 'system'; sessionId?: string; threadId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'final_text'; content: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      cacheCreationInputTokens?: number;
      reasoningOutputTokens?: number;
      costUsd?: number;
      /** True for the terminal `result` event, whose usage is the whole-turn
       * cumulative billing total — NOT the live context-window fill. The panel
       * readout ignores cumulative snapshots and keeps the per-message one. */
      cumulative?: boolean;
      /** f031-#8: emitted by a sub-agent (claude `parent_tool_use_id` set) —
       * its prompt is not the main conversation's context. */
      sidechain?: boolean;
      /** f031-#10: API time of the turn (result `duration_api_ms`, falling
       * back to `duration_ms`); TPS denominator. Only on cumulative events. */
      durationMs?: number;
    }
  | {
      type: 'done';
      sessionId?: string;
      threadId?: string;
      terminationReason: 'normal' | 'interrupted' | 'timeout';
    }
  | { type: 'error'; message: string; terminationReason: 'failed' | 'interrupted' | 'timeout' };

/** f031-sec-#1: fail closed — every real run passes the policy's mode; a caller that forgets gets no bypass. */
export const CLAUDE_DEFAULT_PERMISSION_MODE: ClaudePermissionMode = 'default';

export interface AgentRunOptions {
  runId: string;
  prompt: string;
  cwd?: string;
  sessionId?: string;
  threadId?: string;
  model?: string;
  /** Claude Code reasoning effort forwarded as `--effort` (low..max). */
  effort?: string;
  /**
   * f0.2: per-run provider credential overrides. When set, these keys are
   * layered over the inherited process env for this run only — switching
   * providers in /model takes effect on the next run without restarting.
   */
  envOverrides?: Record<string, string>;
  images?: readonly string[];
  sandbox?: CodexSandboxMode;
  permissionMode?: ClaudePermissionMode;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run. Lets the agent (and any subprocess it spawned, e.g.
   * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
   * Adapters that don't kill via signals are free to ignore this. Defaults
   * are adapter-specific.
  */
  stopGraceMs?: number;
}

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  /**
   * Wait up to `timeoutMs` for the agent process to exit on its own.
   * Resolves true if it exited within the window, false if the timer
   * fired first (caller usually wants to fall back to stop()).
   *
   * Use this after a terminal stream event (`done` / `error`): the
   * stream-json `result` line arrives before claude has actually closed
   * stdout — there's a brief telemetry/cleanup tail in between. Calling
   * stop() in that window forces a SIGTERM and the run exits with code
   * 143 instead of 0; waiting it out lets it exit cleanly.
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
}

/**
 * The bridge bot's own IM identity, resolved by the channel after the WS
 * handshake (`/open-apis/bot/v3/info`). Injected into adapters so the agent
 * system prompt can state "this open_id is you" with the real value.
 */
export interface AgentBotIdentity {
  openId: string;
  name?: string;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  prepareRun?(opts: AgentRunOptions): Promise<void>;
  run(opts: AgentRunOptions): AgentRun;
  /**
   * Late-bound identity injection: the adapter is constructed before the
   * channel connects, so the channel calls this once botIdentity is known.
   * Adapters that don't bake identity into their prompts may omit it.
   */
  setBotIdentity?(identity: AgentBotIdentity): void;
}
