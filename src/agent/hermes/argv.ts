/**
 * f0.4+: argv for one Hermes Agent turn.
 *
 *   hermes [--profile <p>] chat --query-file - --format stream-json --source tool
 *          [--resume <session>] [-m <model>] (owner: --yolo | outsider: -t <safe> --ignore-rules)
 *
 * The prompt goes on stdin (`--query-file -`), so message text is never
 * shell- or argv-interpreted. Hermes freezes `-m/-t/--yolo/--ignore-rules` at
 * session creation and refuses a resume whose flags differ, so every turn of
 * one session repeats exactly the flags it was created with (the adapter
 * keeps owner and outsider sessions apart for that reason).
 */

/** Toolsets an outsider (non-owner) turn may get. Everything else — terminal,
 * file, code_execution, browser, memory, session_search, cronjob, delegation —
 * runs inside the owner's Hermes process with the owner's rights, so it is
 * never offered to people who are not the owner. */
export const HERMES_OUTSIDER_SAFE_TOOLSETS: readonly string[] = ['todo', 'web'];
export const HERMES_OUTSIDER_DEFAULT_TOOLSETS: readonly string[] = ['todo'];

export interface BuildHermesArgsInput {
  /** Hermes session id to resume (validated by the caller). */
  resume?: string;
  /** Forwarded to `-m`. Omitted = Hermes's own configured default. */
  model?: string;
  /** True for the bot owner's turn. */
  owner: boolean;
  /** Outsider toolsets; filtered to {@link HERMES_OUTSIDER_SAFE_TOOLSETS}. */
  outsiderToolsets?: readonly string[];
  /** Hermes profile (`hermes --profile <name>`), to keep aiduCAT's Hermes apart. */
  hermesProfile?: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_MODEL = /^[\w.:@/-]{1,120}$/;

export function isSafeHermesSessionId(value: string | undefined): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

export function outsiderToolsets(requested: readonly string[] | undefined): string[] {
  const wanted = requested && requested.length > 0 ? requested : HERMES_OUTSIDER_DEFAULT_TOOLSETS;
  const safe = wanted.filter((t) => HERMES_OUTSIDER_SAFE_TOOLSETS.includes(t));
  return safe.length > 0 ? [...new Set(safe)] : [...HERMES_OUTSIDER_DEFAULT_TOOLSETS];
}

export function buildHermesArgs(input: BuildHermesArgsInput): string[] {
  const args: string[] = [];
  if (input.hermesProfile) {
    if (!SAFE_ID.test(input.hermesProfile)) throw new Error('invalid hermes profile name');
    args.push('--profile', input.hermesProfile);
  }
  args.push('chat', '--query-file', '-', '--format', 'stream-json', '--source', 'tool');
  if (input.resume) {
    if (!isSafeHermesSessionId(input.resume)) throw new Error('invalid hermes session id');
    args.push('--resume', input.resume);
  }
  if (input.model) {
    if (!SAFE_MODEL.test(input.model)) throw new Error('invalid hermes model id');
    args.push('-m', input.model);
  }
  if (input.owner) {
    // Nobody can answer an approval prompt in a Feishu turn; the owner's
    // turn runs unattended, like Codex's approval_policy=never.
    args.push('--yolo');
  } else {
    args.push('-t', outsiderToolsets(input.outsiderToolsets).join(','), '--ignore-rules');
  }
  return args;
}
