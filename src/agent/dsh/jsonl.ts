import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

/**
 * DSH `headless --json` → aiduCAT agent events.
 *
 * Protocol (DeepSeek Harness 0.2.2-rc.3, one JSON object per stdout line):
 *   {type:"session", sessionId, cwd}
 *   {type:"status",  phase:"turn_start"|"step_start"|"step_end"|"turn_end", turn, step?}
 *   {type:"final",   sessionId, reason:{kind:"done"|"error", error?:{message, code}}, text}
 *
 * Design notes:
 *  - There is no streaming text delta and no tool events in this protocol —
 *    the whole answer arrives in the terminal `final`. To keep the Feishu
 *    card alive during long turns we emit `thinking` heartbeats on
 *    step/turn status lines (they count as substantive events for the
 *    empty-run guard) and carry the answer as one `text` delta right before
 *    `done`.
 *  - Usage is not part of the protocol; no `usage` events are emitted and
 *    the card's context readout stays empty. This is honest: DSH does not
 *    expose per-turn token counts on this profile.
 */

export interface DshFinal {
  sessionId: string;
  ok: boolean;
  text: string;
  errorCode?: string;
  errorMessage?: string;
}

export class DshStreamTranslator {
  private sessionId: string | undefined;

  /** Translate one parsed line; the terminal `final` is captured, not emitted. */
  translate(raw: unknown): AgentEvent[] {
    if (!isRecord(raw) || typeof raw.type !== 'string') return [];
    switch (raw.type) {
      case 'session': {
        const id = str(raw.sessionId);
        if (id) this.sessionId = id;
        return [];
      }
      case 'status': {
        // Heartbeat: keeps the idle watchdog and the empty-run guard fed.
        // One thinking pulse per turn only - status lines arrive per step and
        // each 'thinking' event bumps the card's 💭 segment counter, so
        // per-step pulses would show a fake burst counter.
        const phase = str(raw.phase);
        if (phase === 'turn_start') {
          return [{ type: 'thinking', delta: '...' }];
        }
        if (phase === 'turn_end') return [{ type: 'thinking', delta: '' }];
        return [];
      }
      case 'final': {
        return []; // captured by the adapter via `consume()`
      }
      default:
        return [];
    }
  }

  /** Inspect one line and, if it is the terminal `final`, capture its payload. */
  consumeFinal(raw: unknown): DshFinal | undefined {
    if (!isRecord(raw) || raw.type !== 'final') return undefined;
    const sessionId = str(raw.sessionId) ?? this.sessionId ?? '';
    const reason = isRecord(raw.reason) ? raw.reason : {};
    const kind = str(reason.kind);
    const err = isRecord(reason.error) ? reason.error : {};
    const text = typeof raw.text === 'string' ? raw.text : '';
    if (kind === 'error') {
      return {
        sessionId,
        ok: false,
        text,
        errorCode: str(err.code) ?? 'dsh-error',
        errorMessage: str(err.message) ?? 'DSH run failed',
      };
    }
    return { sessionId, ok: true, text };
  }

  currentSessionId(): string | undefined {
    return this.sessionId;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
