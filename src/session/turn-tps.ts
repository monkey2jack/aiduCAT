import type { AgentEvent } from '../agent/types';

/**
 * f0.3.5: per-turn TPS, timed by aiduCAT itself.
 *
 * Why not the CLI's numbers: claude's `result.duration_api_ms` (and
 * `duration_ms`, `total_cost_usd`) are SESSION-cumulative on a resumed
 * session — verified on summer 2026-11-02, the transcript's `cost-state`
 * `totalAPIDuration` grows monotonically turn after turn (133,809 → … →
 * 4,993,514 ms over 43 turns). Summing it per turn gave activeMs ≈ 78M ms
 * (21.7 h) and a bogus 4 tok/s. `result.usage.output_tokens` IS per-turn
 * (Σ per-turn = 280,526 ≈ session total 307,994; Σ cumulative would be 5.9M).
 *
 * Denominator = model generation time of the turn: from the CLI being up
 * (system init — the model request starts right after) to the last model
 * output, minus every interval in which a tool is in flight (tool_use →
 * matching tool_result drains the set). Queueing, spawn and tool waits —
 * including a Task sub-agent's whole run, which happens inside its tool
 * window — never count.
 *
 * Numerator = main-line output tokens of this turn: Σ of the per-API-call
 * final usage (claude `message_delta`, `callFinal`) of main-line calls. Sub-
 * agent (sidechain) calls are excluded on both sides, as in f031-#8 where they
 * never touch the main context. If the whole-turn total (`result`) is also
 * known, the smaller of the two is used (guards against a gateway that sends
 * more than one delta per call). With no per-call finals (Codex, or a CLI
 * without partial messages) the whole-turn output is used.
 */
export interface TurnTps {
  /** Output tokens counted for this turn. */
  outputTokens: number;
  /** Model generation time (ms), tool windows removed. */
  genMs: number;
  /** Rounded tokens / second; undefined when there is nothing to divide. */
  tps?: number;
}

/** Below this the division is noise (a cached 1-token reply). */
export const MIN_GEN_MS = 200;

export class TurnTpsMeter {
  private readonly now: () => number;
  private segStart?: number;
  private lastOutAt?: number;
  private activeMs = 0;
  private readonly inFlight = new Set<string>();
  private callOut = 0;
  private sawCallFinal = false;
  private turnOut?: number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  observe(evt: AgentEvent): void {
    const t = this.now();
    if (this.segStart === undefined && this.inFlight.size === 0) this.segStart = t;
    switch (evt.type) {
      case 'tool_use': {
        // The tool_use block itself is model output.
        this.markOut(t);
        if (this.inFlight.size === 0) this.closeSegment(t);
        this.inFlight.add(evt.id);
        return;
      }
      case 'tool_result': {
        if (!this.inFlight.delete(evt.id)) return;
        // Next model request starts the moment the last tool returns.
        if (this.inFlight.size === 0) this.segStart = t;
        return;
      }
      case 'text':
      case 'thinking':
      case 'final_text':
        if (this.inFlight.size === 0) this.markOut(t);
        return;
      case 'usage': {
        if (evt.sidechain) return;
        if (evt.cumulative) {
          if (typeof evt.outputTokens === 'number') this.turnOut = (this.turnOut ?? 0) + evt.outputTokens;
          return;
        }
        if (evt.callFinal) {
          this.sawCallFinal = true;
          this.callOut += evt.outputTokens ?? 0;
        }
        // A call's final usage can land just after its tool_use (claude emits
        // the block first, then message_delta) — that time is already inside
        // the tool window, so only count it as output when no tool runs.
        if (this.inFlight.size === 0) this.markOut(t);
        return;
      }
      default:
        return;
    }
  }

  private markOut(t: number): void {
    this.lastOutAt = t;
  }

  private closeSegment(t: number): void {
    if (this.segStart !== undefined) this.activeMs += Math.max(0, t - this.segStart);
    this.segStart = undefined;
  }

  /** Close the turn; safe to call once at the terminal event. */
  finish(): TurnTps {
    let genMs = this.activeMs;
    if (this.inFlight.size === 0 && this.segStart !== undefined && this.lastOutAt !== undefined) {
      genMs += Math.max(0, this.lastOutAt - this.segStart);
    }
    let outputTokens: number;
    if (this.sawCallFinal && this.callOut > 0) {
      outputTokens = this.turnOut !== undefined && this.turnOut > 0 ? Math.min(this.callOut, this.turnOut) : this.callOut;
    } else {
      outputTokens = this.turnOut ?? 0;
    }
    const tps = genMs >= MIN_GEN_MS && outputTokens > 0 ? Math.round(outputTokens / (genMs / 1000)) : undefined;
    return { outputTokens, genMs, ...(tps !== undefined ? { tps } : {}) };
  }
}
