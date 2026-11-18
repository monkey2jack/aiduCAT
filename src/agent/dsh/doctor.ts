/**
 * f0.5++: what /doctor says about a DSH profile.
 *
 * A DSH profile has three moving parts an operator cannot see from the outside:
 * how the binary was found, which profile document is actually in use, and
 * whether the model routing still mirrors the desktop. Each of them has caused
 * a real incident, so /doctor states all three instead of "agent: ok".
 *
 * The profile name is resolved once and passed to every reader, so the version
 * probe, the model list and the mirror check all describe the SAME profile the
 * run uses — not three different ideas of it.
 */

import { checkAgentVersion } from '../preflight';
import { readDshProfileModels, resolveDshProfileName } from '../models';
import { discoverDshLaunch, dshSearchSummary, isLaunchSpecUsable } from './launch';
import { inspectModelRouting } from './profile-sync';

export interface DshDoctorInput {
  /** `dsh.binaryPath` from the profile config, when set. */
  configuredBinary?: string;
  /** `dsh.profile` from the profile config, when set. */
  configuredProfile?: string;
  /** Skip the `--version` probe (it spawns the Electron CLI, which is slow). */
  skipVersion?: boolean;
}

/**
 * Build the DSH lines for /doctor. Never throws: a broken install must produce
 * a diagnostic line, not a failed command.
 */
export async function describeDshRuntime(input: DshDoctorInput): Promise<string[]> {
  const lines: string[] = [];
  const launch = discoverDshLaunch(input.configuredBinary);

  if (!launch) {
    lines.push(`dsh binary: NOT FOUND (looked in ${dshSearchSummary()})`);
    return lines;
  }

  lines.push(`dsh binary: ${launch.command}`);
  lines.push(`dsh launch: ${launch.source} (${launch.detail})`);
  if (launch.prefixArgs.length > 0) {
    lines.push(`dsh argv prefix: ${launch.prefixArgs.join(' ')}`);
  }
  if (!isLaunchSpecUsable(launch)) {
    lines.push('dsh binary check: path exists but the CLI entry is missing (reinstall or set dsh.binaryPath)');
  }

  try {
    if (input.skipVersion) {
      lines.push('dsh version: not probed');
    } else {
      const version = await checkAgentVersion({
        agentId: 'dsh',
        agentName: 'DeepSeek Harness',
        command: launch.command,
        binaryPath: launch.command,
        args: [...launch.prefixArgs, '--version'],
        ...(Object.keys(launch.env).length > 0 ? { env: { ...launch.env } } : {}),
        timeoutMs: 30_000,
      });
      lines.push(`dsh version: ${version.trim().split('\n')[0] ?? version}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lines.push(`dsh version: check failed (${message.slice(0, 160)})`);
  }

  const profile = resolveDshProfileName(input.configuredProfile);
  const models = readDshProfileModels(profile);
  lines.push(`dsh profile: ${profile}`);
  lines.push(
    `dsh model: ${models.model ?? '(unknown)'} via provider ${models.provider ?? '(unknown)'}` +
      ` · ${models.models.length} model(s) declared`,
  );

  const mirror = inspectModelRouting(input.configuredProfile);
  switch (mirror.status) {
    case 'no-home':
      lines.push('dsh model source: DSH_HOME is unset — routing cannot be mirrored from the desktop');
      return lines;
    case 'target-unsafe':
      lines.push(
        `dsh model source: BLOCKED — the run profile path failed a safety check; the mirror will not touch it (profile "${mirror.profile}")`,
      );
      return lines;
    case 'target-missing':
      lines.push(
        `dsh model source: BLOCKED — no run profile at ${mirror.target}; aiduCAT does not create profiles. Run dsh once with --profile to create it, or set dsh.binaryPath and dsh.profile explicitly`,
      );
      return lines;
    case 'target-unmanaged':
      lines.push(
        'dsh model source: BLOCKED — the run profile is hand-written or customised; the mirror never overwrites it. Model comes from the file as-is',
      );
      return lines;
    case 'source-missing':
      lines.push(`dsh model source: desktop profile missing (${mirror.source}) — keeping the run profile as-is`);
      return lines;
    case 'source-invalid':
      lines.push(
        `dsh model source: desktop profile unreadable or declares an unsupported routing (${mirror.source}) — keeping the run profile as-is`,
      );
      return lines;
    case 'in-sync':
      lines.push(
        `dsh model source: mirrored from desktop, in sync${mirror.targetMtime ? ` (${mirror.targetMtime})` : ''}`,
      );
      return lines;
    case 'stale':
      lines.push('dsh model source: desktop changed — the next turn / /model will re-mirror');
      return lines;
  }
}