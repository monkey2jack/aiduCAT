import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  daemonLogDir,
  daemonStderrPath,
  daemonStdoutPath,
  windowsTaskName,
  windowsLauncherCmdPath,
  windowsLauncherVbsPath,
} from './paths';
import { paths } from '../config/paths';

export interface LauncherInputs {
  /** Absolute path to node.exe. */
  nodePath: string;
  /** Absolute path to the bridge CLI entry. */
  bridgeEntryPath: string;
  /** PATH for the child process; baked into the .cmd via `set PATH=`. */
  envPath: string;
  /** Service id (profile name, or the reserved supervisor id) — drives the
   * task name and log paths. */
  profile: string;
  /** CLI args after the entry path, e.g. `['run', '--profile', 'claude']` or
   * `['run', '--web-ui']`. */
  runArgs: string[];
  /** Root directory for config/profile state. */
  channelHome: string;
}

/**
 * Generate the .cmd wrapper script that the scheduled task actually invokes.
 *
 * schtasks `/TR` can accept a direct command, but we need stdout/stderr
 * redirection + a PATH override so child tools (lark-cli, claude) resolve
 * correctly when the daemon runs under Task Scheduler. A `.cmd` script
 * is the natural place for both.
 *
 * `@echo off` keeps the script's own commands out of the daemon log.
 * `>>` / `2>>` append (not truncate) so log history is preserved across
 * daemon restarts.
 */
export function buildLauncherCmd(inputs: LauncherInputs): string {
  // Profile names / flags are validated safe tokens (no spaces).
  const runArgs = inputs.runArgs.join(' ');
  return [
    '@echo off',
    `set "LARK_CHANNEL_HOME=${inputs.channelHome}"`,
    `set "PATH=${inputs.envPath}"`,
    `"${inputs.nodePath}" "${inputs.bridgeEntryPath}" ${runArgs} >> "${daemonStdoutPath(inputs.profile)}" 2>> "${daemonStderrPath(inputs.profile)}"`,
    '',
  ].join('\r\n');
}

/**
 * VBS wrapper that hides the console window Task Scheduler would otherwise
 * allocate when it launches the .cmd launcher directly.
 *
 * wscript.exe is a GUI-subsystem host: it never allocates a console of its own.
 * `WScript.Shell.Run(cmd, 0, True)` then launches the .cmd with window style
 * `0` (hidden) and `bWaitOnReturn = True`, so the daemon never parks a visible
 * console window on the desktop, and wscript.exe stays alive as the task's
 * tracked process for as long as the daemon runs.
 *
 * That tracking is what `endTask` depends on — it locates this wscript.exe and
 * kills its tree, because `schtasks /End` on its own ends only the
 * directly-launched process and leaves the cmd/node children as orphans.
 *
 * VBScript is still shipped on Windows 10/11 as an optional feature but remains
 * available by default; if it ever goes missing this wrapper simply fails to run
 * and the log will show the task failing (not silently broken).
 */
export function buildLauncherVbs(cmdPath: string): string {
  return [
    'Option Explicit',
    'Dim shell',
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run """${cmdPath}""", 0, True`,
    'Set shell = Nothing',
    '',
  ].join('\r\n');
}

/** `-like` treats `* ? [ ]` as wildcards, so wrap them to match a literal path. */
function likeLiteral(path: string): string {
  return path.replace(/([\[\]*?])/g, '[$1]');
}

/**
 * PowerShell that kills the launcher process tree for a service.
 *
 * `schtasks /End` ends only the process the task launched *directly* — with the
 * hidden launcher that is wscript.exe — and leaves the `cmd.exe` and `node.exe`
 * it spawned running as orphans, so `stop` would report success while the bot
 * kept answering. Find the launcher process by its command line (not by parsing
 * `schtasks` output, which is localized) and kill its whole tree.
 *
 * Matches both the current layout (wscript → launcher.vbs) and a task installed
 * before this change (cmd → launcher.cmd), so upgrading is seamless.
 */
export function buildKillTreeScript(serviceId: string): string {
  const matches = [windowsLauncherVbsPath(serviceId), windowsLauncherCmdPath(serviceId)]
    .map((p) => `$_.CommandLine -like '*${likeLiteral(p).replace(/'/g, "''")}*'`)
    .join(' -or ');
  return (
    'Get-CimInstance Win32_Process | ' +
    `Where-Object { $_.Name -in 'wscript.exe','cmd.exe' -and (${matches}) } | ` +
    'ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>&1 | Out-Null }'
  );
}

/** Best-effort: kill the launcher tree. See buildKillTreeScript. */
function killLauncherTree(serviceId: string): void {
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', buildKillTreeScript(serviceId)], {
    encoding: 'utf8',
  });
}

async function writeLauncherScripts(profile: string, runArgs: string[] = ['run']): Promise<void> {
  const bridgeEntryPath = process.argv[1];
  if (!bridgeEntryPath) {
    throw new Error('cannot determine bridge entry path (process.argv[1] is empty)');
  }
  const content = buildLauncherCmd({
    nodePath: process.execPath,
    bridgeEntryPath,
    envPath: process.env.PATH ?? '',
    profile,
    runArgs,
    channelHome: paths.rootDir,
  });
  const cmdPath = windowsLauncherCmdPath(profile);
  await mkdir(dirname(cmdPath), { recursive: true });
  // f031-sec-M4: daemon stdout/stderr logs are owner-only.
  await mkdir(daemonLogDir(profile), { recursive: true, mode: 0o700 });
  await writeFile(cmdPath, content, 'utf8');
  await writeFile(windowsLauncherVbsPath(profile), buildLauncherVbs(cmdPath), 'utf8');
}

interface SchtasksResult {
  ok: boolean;
  stderr: string;
  stdout: string;
}

function runSchtasks(args: string[]): SchtasksResult {
  const r = spawnSync('schtasks', args, { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    stderr: r.stderr ?? '',
    stdout: r.stdout ?? '',
  };
}

/**
 * Create (or overwrite) the scheduled task. Trigger: ONLOGON.
 * `/RL LIMITED` runs as the current user without admin elevation.
 * `/F` overwrites if the task already exists.
 *
 * The /TR value is the VBS wrapper, which launches the .cmd launcher hidden
 * (see buildLauncherVbs) — pointing /TR at the .cmd directly would park a
 * visible console window on the desktop for as long as the daemon runs.
 * Schtasks treats /TR as a command line, so the value is quoted to keep
 * spaces in the path intact.
 */
export async function installTask(
  profile: string,
  runArgs: string[] = ['run'],
): Promise<SchtasksResult> {
  await writeLauncherScripts(profile, runArgs);
  const created = runSchtasks([
    '/Create',
    '/F',
    '/SC',
    'ONLOGON',
    '/RL',
    'LIMITED',
    '/TN',
    windowsTaskName(profile),
    '/TR',
    `wscript.exe //B "${windowsLauncherVbsPath(profile)}"`,
  ]);
  if (!created.ok) return created;
  // schtasks has no switches for these settings; a follow-up PowerShell pass
  // makes the task survive battery-only laptops and never get killed after
  // 72h (the defaults are DisallowStartIfOnBatteries=true + PT72H limit).
  const psScript =
    `$t = Get-ScheduledTask -TaskName '${windowsTaskName(profile)}' -ErrorAction Stop; ` +
    `$t.Settings.ExecutionTimeLimit = 'PT0S'; ` +
    `$t.Settings.DisallowStartIfOnBatteries = $false; ` +
    `$t.Settings.StopIfGoingOnBatteries = $false; ` +
    `$t.Settings.AllowStartIfOnBatteries = $true; ` +
    'Set-ScheduledTask -InputObject $t | Out-Null';
  const ps = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psScript],
    { encoding: 'utf8' },
  );
  if (ps.status !== 0) {
    // Task is registered and usable; surface the settings failure but don't
    // fail the whole install over cosmetic defaults.
    return {
      ok: true,
      stdout: created.stdout,
      stderr: `${created.stderr}\nwarning: task registered but settings tweak failed: ${ps.stderr ?? ''}`.trim(),
    };
  }
  return created;
}

/** Start the task now (regardless of trigger). */
export function runTask(profile: string): SchtasksResult {
  return runSchtasks(['/Run', '/TN', windowsTaskName(profile)]);
}

/**
 * End the running instance. Task stays registered for next logon.
 *
 * `schtasks /End` only ends the process the task launched directly. With the
 * hidden launcher that is wscript.exe, and it leaves cmd.exe / node.exe running
 * as orphans — so `stop` would report success while the bot keeps answering.
 * Kill the launcher tree as well.
 */
export function endTask(profile: string): SchtasksResult {
  const ended = runSchtasks(['/End', '/TN', windowsTaskName(profile)]);
  killLauncherTree(profile);
  return ended;
}

/** Disable autostart (task stays registered but ONLOGON trigger won't fire). */
export function disableTask(profile: string): SchtasksResult {
  return runSchtasks(['/Change', '/TN', windowsTaskName(profile), '/Disable']);
}

/** Re-enable autostart. Called from installTask is unnecessary — /Create /F
 * resets the enabled flag. Only needed if you Disabled and want it back. */
export function enableTask(profile: string): SchtasksResult {
  return runSchtasks(['/Change', '/TN', windowsTaskName(profile), '/Enable']);
}

/** End + disable. The cross-platform "stop = stay stopped" semantic. */
export function endAndDisable(profile: string): SchtasksResult {
  const ended = endTask(profile);
  // If the task wasn't running, /End fails; we still want to disable.
  const disabled = disableTask(profile);
  // Surface whichever signal is more informative — disable result wins
  // because the autostart prevention is the user-visible effect.
  return disabled.ok ? disabled : ended.ok ? disabled : ended;
}

/** Schtasks has no native restart — end, wait, run. */
export async function restartTask(profile: string): Promise<SchtasksResult> {
  endTask(profile); // best-effort; ignore if not running
  await waitUntilStopped(profile);
  return runTask(profile);
}

/**
 * `schtasks /Query` returns 0 iff the task is registered. We toss the
 * output (it's verbose); use describeTask for full state.
 */
export function isTaskRegistered(profile: string): boolean {
  const r = spawnSync('schtasks', ['/Query', '/TN', windowsTaskName(profile)], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return r.status === 0;
}

/**
 * Parse `/Query /V /FO LIST` output for the current run state. Looks for
 * `Status: Running` in the verbose listing. Other states include
 * "Ready" (registered, not currently running) and "Disabled".
 */
export function isTaskRunning(profile: string): boolean {
  const r = runSchtasks(['/Query', '/V', '/FO', 'LIST', '/TN', windowsTaskName(profile)]);
  if (!r.ok) return false;
  return /Status:\s+Running/i.test(r.stdout);
}

export function describeTask(profile: string): string {
  const r = runSchtasks(['/Query', '/V', '/FO', 'LIST', '/TN', windowsTaskName(profile)]);
  return r.stdout || r.stderr || '';
}

export async function waitUntilStopped(profile: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isTaskRunning(profile)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function deleteTask(profile: string): Promise<SchtasksResult> {
  const r = runSchtasks(['/Delete', '/F', '/TN', windowsTaskName(profile)]);
  // Remove both launcher scripts too; best-effort.
  if (existsSync(windowsLauncherCmdPath(profile))) {
    await rm(windowsLauncherCmdPath(profile), { force: true });
  }
  if (existsSync(windowsLauncherVbsPath(profile))) {
    await rm(windowsLauncherVbsPath(profile), { force: true });
  }
  return r;
}
