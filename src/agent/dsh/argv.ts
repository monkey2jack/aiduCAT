/**
 * DSH (DeepSeek Harness) adapter arguments.
 *
 *   dsh --profile <p> headless --json [--session-id <id>] -
 *
 * The task text rides on **stdin** (`-` argument), so message text is never
 * shell- or argv-interpreted — same philosophy as Hermes's `--query-file -`.
 * `--json` switches stdout to newline-delimited run events (session / status
 * / final), which the translator in `./jsonl.ts` maps onto aiduCAT's
 * `AgentEvent` stream. `--session-id` adopts a persisted session, which is
 * how multi-turn conversations resume.
 *
 * Everything after the launcher flags reaches the DSH app itself. There is
 * no model flag on the headless profile: the model comes from the profile's
 * `agent-default-model` config (patched in cordis.patch.yml), so /model on a
 * dsh profile intentionally shows only the "follow DSH config" option.
 */

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function isSafeDshSessionId(value: string | undefined): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

export interface BuildDshArgsInput {
  /** DSH profile under $DSH_HOME/profiles (default: headless). */
  profile?: string;
  /** DSH session id to adopt (`--session-id`). */
  resume?: string;
}

export function buildDshArgs(input: BuildDshArgsInput): string[] {
  const profile = input.profile ?? 'headless';
  if (!SAFE_ID.test(profile)) throw new Error('invalid dsh profile name');
  // The profile IS the headless app here; a bare `headless` word after the
  // flags would join the task argv and DSH rejects "`-` must be the only
  // task argument".
  const args = ['--profile', profile, '--json'];
  if (input.resume) {
    if (!isSafeDshSessionId(input.resume)) throw new Error('invalid dsh session id');
    args.push('--session-id', input.resume);
  }
  // "-" = read the task from stdin.
  args.push('-');
  return args;
}
