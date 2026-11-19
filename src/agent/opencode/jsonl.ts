import type { AgentEvent } from "../types";

export interface OpencodeFinal {
  sessionId: string;
  reasonKind: string | undefined;
  text: string;
  errorCode?: string;
  errorMessage?: string;
}

export class OpencodeStreamTranslator {
  private sessionId: string | undefined;
  private readonly answerParts: string[] = [];
  private streamError: string | undefined;
  private seenToolCallIds = new Set<string>();
  private emittedSystem = false;
  private model: string | undefined;

  translate(raw: unknown): AgentEvent[] {
    if (!isRecord(raw) || typeof raw.type !== "string") return [];

    const rawSessionId = str(raw.sessionID);
    if (rawSessionId && !this.sessionId) {
      this.sessionId = rawSessionId;
    }

    const events: AgentEvent[] = [];

    const rawModel = str(raw.model) ?? (isRecord(raw.part) ? str(raw.part.model) : undefined);
    if (rawModel && !this.model) {
      this.model = rawModel;
    }

    if (this.sessionId && !this.emittedSystem) {
      this.emittedSystem = true;
      events.push({ type: "system", sessionId: this.sessionId, ...(this.model ? { model: this.model } : {}) });
    } else if (rawModel && this.model !== rawModel) {
      this.model = rawModel;
      events.push({ type: "system", sessionId: this.sessionId, model: this.model });
    }

    switch (raw.type) {
      case "step_start": {
        events.push({ type: "thinking", delta: "" });
        break;
      }

      case "text": {
        const part = isRecord(raw.part) ? raw.part : undefined;
        const text = part && typeof part.text === "string" ? part.text : "";
        if (text) {
          this.answerParts.push(text);
          events.push({ type: "text", delta: text });
        }
        break;
      }

      case "thinking":
      case "reasoning": {
        const part = isRecord(raw.part) ? raw.part : undefined;
        const text = part && typeof part.text === "string" ? part.text : "";
        if (text) {
          events.push({ type: "thinking", delta: text });
        }
        break;
      }

      case "tool_use": {
        const part = isRecord(raw.part) ? raw.part : undefined;
        if (!part) break;
        const callId = str(part.callID) ?? str(part.id) ?? `opencode-tool-${this.seenToolCallIds.size + 1}`;
        const name = str(part.tool) ?? "tool";
        const state = isRecord(part.state) ? part.state : undefined;

        if (!this.seenToolCallIds.has(callId)) {
          this.seenToolCallIds.add(callId);
          events.push({
            type: "tool_use",
            id: callId,
            name,
            input: state?.input ?? {},
          });
        }

        if (state && (state.status === "completed" || state.status === "error")) {
          const output = state.output;
          events.push({
            type: "tool_result",
            id: callId,
            output: typeof output === "string" ? output : JSON.stringify(output ?? ""),
            isError: state.status === "error",
          });
        }
        break;
      }

      case "step_finish": {
        const part = isRecord(raw.part) ? raw.part : undefined;
        if (!part) break;
        const tokens = isRecord(part.tokens) ? part.tokens : undefined;
        const cache = tokens && isRecord(tokens.cache) ? tokens.cache : undefined;

        if (tokens) {
          const inTok = num(tokens.input);
          const outTok = num(tokens.output);
          const cacheRead = num(cache?.read);
          const cacheWrite = num(cache?.write);
          const reasoning = num(tokens.reasoning);
          const cost = num(part.cost);

          events.push({
            type: "usage",
            inputTokens: inTok,
            outputTokens: outTok,
            cachedInputTokens: cacheRead,
            cacheCreationInputTokens: cacheWrite,
            reasoningOutputTokens: reasoning,
            costUsd: cost,
            callFinal: true,
          });

          events.push({
            type: "usage",
            inputTokens: inTok,
            outputTokens: outTok,
            cachedInputTokens: cacheRead,
            cacheCreationInputTokens: cacheWrite,
            reasoningOutputTokens: reasoning,
            costUsd: cost,
            cumulative: true,
          });
        }
        break;
      }

      case "error":
      case "step_failed": {
        const msg = str(raw.message) ?? (isRecord(raw.error) ? str(raw.error.message) : undefined) ?? "opencode step failed";
        this.streamError = msg;
        events.push({
          type: "error",
          message: msg,
          terminationReason: "failed",
        });
        break;
      }

      default:
        break;
    }

    return events;
  }

  consumeFinal(raw: unknown): OpencodeFinal | undefined {
    if (!isRecord(raw)) return undefined;

    if (raw.type === "step_finish") {
      const part = isRecord(raw.part) ? raw.part : undefined;
      const reason = str(part?.reason);
      if (reason === "stop") {
        return {
          sessionId: this.sessionId ?? str(raw.sessionID) ?? "",
          reasonKind: "stop",
          text: this.answerParts.join(""),
        };
      }
    }

    if (raw.type === "error" || raw.type === "step_failed") {
      const msg = str(raw.message) ?? (isRecord(raw.error) ? str(raw.error.message) : undefined) ?? "opencode error";
      return {
        sessionId: this.sessionId ?? str(raw.sessionID) ?? "",
        reasonKind: "error",
        text: this.answerParts.join(""),
        errorMessage: msg,
      };
    }

    return undefined;
  }

  currentSessionId(): string | undefined {
    return this.sessionId;
  }

  errorFromStream(): string | undefined {
    return this.streamError;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
