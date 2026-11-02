/**
 * f0.4+: the session id aiduCAT stores for a Hermes scope.
 *
 * Hermes freezes a session's launch policy (model, toolsets, --yolo,
 * --ignore-rules). An owner session resumed by an outsider turn is refused,
 * and an outsider session resumed without flags silently keeps the outsider's
 * restricted tools. So one aiduCAT scope keeps two Hermes sessions — the
 * owner's (`o`) and the outsiders' (`x`) — each with the model it was created
 * with. Outsiders never see the owner's conversation and the owner never
 * inherits the outsiders' restrictions.
 *
 *   hermes1|o=<sessionId>@<model>|x=<sessionId>@<model>
 *
 * The model part is URI-encoded; empty = Hermes default.
 */
import { isSafeHermesSessionId } from './argv';

export type HermesSlotName = 'o' | 'x';

export interface HermesSlot {
  sessionId: string;
  model: string;
}

export type HermesSessionKey = Partial<Record<HermesSlotName, HermesSlot>>;

const PREFIX = 'hermes1';

export function parseHermesSessionKey(raw: string | undefined): HermesSessionKey {
  const out: HermesSessionKey = {};
  if (!raw || !raw.startsWith(`${PREFIX}|`)) return out;
  for (const part of raw.split('|').slice(1)) {
    const m = /^([ox])=([^@|]+)@(.*)$/.exec(part);
    if (!m) continue;
    const sessionId = m[2]!;
    if (!isSafeHermesSessionId(sessionId)) continue;
    let model = '';
    try {
      model = decodeURIComponent(m[3] ?? '');
    } catch {
      continue;
    }
    out[m[1] as HermesSlotName] = { sessionId, model };
  }
  return out;
}

export function formatHermesSessionKey(key: HermesSessionKey): string | undefined {
  const parts: string[] = [];
  for (const slot of ['o', 'x'] as const) {
    const v = key[slot];
    if (v && isSafeHermesSessionId(v.sessionId)) {
      parts.push(`${slot}=${v.sessionId}@${encodeURIComponent(v.model)}`);
    }
  }
  return parts.length > 0 ? [PREFIX, ...parts].join('|') : undefined;
}

/** The session this turn resumes, or undefined for a fresh one. */
export function resumeFor(key: HermesSessionKey, slot: HermesSlotName, model: string): string | undefined {
  const v = key[slot];
  return v && v.model === model ? v.sessionId : undefined;
}

export function withSlot(
  key: HermesSessionKey,
  slot: HermesSlotName,
  sessionId: string,
  model: string,
): HermesSessionKey {
  return { ...key, [slot]: { sessionId, model } };
}

/** Short form for /status: the owner's session first. */
export function hermesSessionDisplay(raw: string | undefined): string | undefined {
  const key = parseHermesSessionKey(raw);
  const parts: string[] = [];
  if (key.o) parts.push(key.o.sessionId);
  if (key.x) parts.push(`其他人 ${key.x.sessionId}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
