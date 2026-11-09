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
      /** f0.3.5: the final usage of ONE API call (claude `message_delta`),
       * so per-call output can be summed exactly once per call for TPS.
       * (f031-#10's `durationMs` from result `duration_api_ms` is gone: it is
       * session-cumulative on a resumed session; aiduCAT times turns itself.) */
      callFinal?: boolean;
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
  /**
   * f03p-infra-#2: true only when the bot owner started this run. Anything
   * else (undefined included) is treated as a non-owner run: no owner-only
   * settings tokens, no owner passthrough env.
   */
  ownerRun?: boolean;
}

export interface AgentRun {
  readonly runId: string;
  /** OS pid of the agent process, once spawned; undefined until/unless it is. */
  readonly pid: number | undefined;
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
  /**
   * issue #9 (P1): the watchdog's last-resort exit. Kills the agent process
   * tree (Windows: `taskkill /T /F`, so grandchilds holding the stdout write
   * handle die too) and must not throw even if the process is already gone.
   * Unlike stop() this works after the child exited — the event stream can
   * still be wedged on a grandchild-inherited stdout handle.
   */
  forceKillTree(): Promise<void>;
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
