import type { SandboxMode } from '../../config/profile-schema';

export interface BuildCodexArgsInput {
  cwd: string;
  sandbox: SandboxMode;
  threadId?: string;
  images?: readonly string[];
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  /** Forwarded to `codex exec --model`. Omitted uses the Codex default. */
  model?: string;
  /** Forwarded to `codex exec -c model_reasoning_effort="..."`. */
  effort?: string;
  /** f031-sec-#4: explicit vars for Codex shells on top of `inherit="core"`. */
  shellEnv?: Record<string, string>;
}

function tomlInlineTable(env: Record<string, string>): string {
  const entries = Object.entries(env)
    .filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string')
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return `{${entries.join(',')}}`;
}

export function buildCodexArgs(input: BuildCodexArgsInput): string[] {
  if (
    input.sandbox !== 'read-only' &&
    input.sandbox !== 'workspace-write' &&
    input.sandbox !== 'danger-full-access'
  ) {
    throw new Error(`unsafe sandbox mode: ${input.sandbox}`);
  }

  const globalFlags = [
    '--sandbox',
    input.sandbox,
    ...(input.model ? ['--model', input.model] : []),
    ...(input.effort ? ['-c', `model_reasoning_effort="${input.effort}"`] : []),
    '-c',
    'approval_policy="never"',
    '-c',
    'shell_environment_policy.inherit="core"',
    ...(input.shellEnv && Object.keys(input.shellEnv).length > 0
      ? ['-c', `shell_environment_policy.set=${tomlInlineTable(input.shellEnv)}`]
      : []),
    ...(input.ignoreUserConfig === true ? ['--ignore-user-config'] : []),
    ...(input.ignoreRules === false ? [] : ['--ignore-rules']),
    '--skip-git-repo-check',
    '-C',
    input.cwd,
  ];

  const imageFlags = (input.images ?? []).flatMap((path) => ['--image', path]);

  if (input.threadId) {
    return [
      'exec',
      ...globalFlags,
      'resume',
      '--json',
      ...imageFlags,
      input.threadId,
      '-',
    ];
  }

  return [
    'exec',
    '--json',
    ...globalFlags,
    ...imageFlags,
    ...(imageFlags.length > 0 ? ['--'] : []),
    '-',
  ];
}
