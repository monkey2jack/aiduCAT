/**
 * f0.5++: DSH (DeepSeek Harness) adapter arguments.
 *
 *   dsh --profile <p> --json [--permission-mode <preset>]
 *       [--approval-policy <ask|never>] [--session-id <id>] -
 *
 * The task text rides on **stdin** (`-` argument), so message text is never
 * shell- or argv-interpreted — same philosophy as Hermes's `--query-file -`.
 * `--json` switches stdout to newline-delimited run events (session / status /
 * text / thinking / tool_call / tool_result / final), which the translator in
 * `./jsonl.ts` maps onto aiduCAT's `AgentEvent` stream. `--session-id` adopts a
 * persisted session, which is how multi-turn conversations resume.
 *
 * There is no per-invocation model flag on the headless profile: the model
 * comes from the profile's `agent-default-model` config (patched in
 * cordis.patch.yml). /model therefore switches it with a `--patch` overlay,
 * which replaces that row. Permission and approval, by contrast, ARE
 * per-invocation.
 */

import { isAbsolute } from 'node:path';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function isSafeDshSessionId(value: string | undefined): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

/**
 * The permission presets the shipped DSH profiles define. Verified live against
 * DeepSeek Harness 0.2.2-rc.3:
 *
 *   dsh --profile headless --permission-mode <bad> --json -
 *   → permission: unknown preset "<bad>" (known: read-only, workspace-write,
 *     danger-full-access)
 *
 * aiduCAT's `CodexSandboxMode` uses exactly these three names, so the mapping
 * is the identity — but the value is still validated, because DSH ABORTS the
 * run on an unknown preset instead of falling back to the profile default.
 */
export const DSH_PERMISSION_PRESETS = ['read-only', 'workspace-write', 'danger-full-access'] as const;

export type DshPermissionPreset = (typeof DSH_PERMISSION_PRESETS)[number];

export function isDshPermissionPreset(value: string | undefined): value is DshPermissionPreset {
  return typeof value === 'string' && (DSH_PERMISSION_PRESETS as readonly string[]).includes(value);
}

/**
 * Headless has no live approval-response channel, so a bridged turn must never
 * park waiting for one. `never` makes a call that needs human approval fail
 * instead of hanging; the sandbox preset above is what actually grants access.
 */
export const DSH_UNATTENDED_APPROVAL = 'never' as const;

export interface BuildDshArgsInput {
  /** DSH profile under $DSH_HOME/profiles (default: headless). */
  profile?: string;
  /**
   * Absolute path to an extra patch overlay applied after the profile layer.
   * This is how /model switches the DSH model: the overlay replaces the
   * `agent-default-model` row, since DSH itself has no `--model` flag.
   */
  patch?: string;
  /** Exact DSH permission preset to pin for this task, including on resume. */
  permissionMode?: DshPermissionPreset;
  /** Approval policy applied after the preset is selected. */
  approvalPolicy?: 'ask' | 'never';
  /** DSH session id to adopt (`--session-id`). */
  resume?: string;
}

export function buildDshArgs(input: BuildDshArgsInput): string[] {
  const profile = input.profile ?? 'headless';
  if (!SAFE_ID.test(profile)) throw new Error('invalid dsh profile name');
  // The profile IS the headless app here; a bare `headless` word after the
  // flags would join the task argv and DSH rejects "`-` must be the only
  // task argument".
  const args = ['--profile', profile];
  // Launcher flags must precede the app's own arguments: everything after them
  // reaches the headless runner, which would reject `--patch` as unknown.
  if (input.patch !== undefined) {
    if (!isAbsolute(input.patch)) throw new Error('invalid dsh patch path');
    args.push('--patch', input.patch);
  }
  args.push('--json');
  if (input.permissionMode !== undefined) {
    if (!isDshPermissionPreset(input.permissionMode)) {
      throw new Error(`invalid dsh permission preset: ${input.permissionMode}`);
    }
    args.push('--permission-mode', input.permissionMode);
  }
  if (input.approvalPolicy !== undefined) {
    if (input.approvalPolicy !== 'ask' && input.approvalPolicy !== 'never') {
      throw new Error(`invalid dsh approval policy: ${input.approvalPolicy}`);
    }
    args.push('--approval-policy', input.approvalPolicy);
  }
  if (input.resume) {
    if (!isSafeDshSessionId(input.resume)) throw new Error('invalid dsh session id');
    args.push('--session-id', input.resume);
  }
  // "-" = read the task from stdin.
  args.push('-');
  return args;
}
