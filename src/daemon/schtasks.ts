import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  daemonLogDir,
  daemonStderrPath,
  daemonStdoutPath,
  windowsTaskName,
  windowsLauncherCmdPath,
  windowsLauncherVbsPath,
  SUPERVISOR_SERVICE_ID,
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
 * A PowerShell `Where-Object` clause matching the service's launcher processes
 * by command line — the `wscript.exe` of the current hidden launcher, or the
 * `cmd.exe` of a task installed before that change. Matching the process (not
 * parsing `schtasks` output, which is localized and codepage-encoded) is what
 * makes every query below work on non-English Windows.
 */
function launcherMatchClause(serviceId: string): string {
  return [windowsLauncherVbsPath(serviceId), windowsLauncherCmdPath(serviceId)]
    .map((p) => `$_.CommandLine -like '*${likeLiteral(p).replace(/'/g, "''")}*'`)
    .join(' -or ');
}

/**
 * PowerShell that kills the launcher process tree for a service.
 *
 * `schtasks /End` ends only the process the task launched *directly* — with the
 * hidden launcher that is wscript.exe — and leaves the `cmd.exe` and `node.exe`
 * it spawned running as orphans, so `stop` would report success while the bot
 * kept answering. Killing the tree from the launcher down reaches all of them.
 *
 * Also matches the daemon `node.exe` by its own command line (entry + args read
 * from the on-disk launcher.cmd): after the launcher hosts die first, the node
 * orphan no longer has a live parent to match, yet it still holds the host lock
 * — leaving `start` to time out behind it.
 */
export function buildKillTreeScript(serviceId: string): string {
  const parts = [`($_.Name -in 'wscript.exe','cmd.exe' -and (${launcherMatchClause(serviceId)}))`];
  const daemon = daemonMatchClause(serviceId);
  if (daemon) parts.push(daemon);
  return (
    'Get-CimInstance Win32_Process | ' +
    `Where-Object { ${parts.join(' -or ')} } | ` +
    'ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>&1 | Out-Null }'
  );
}

/**
 * Match the daemon node.exe by the launcher's own command line: the bridge
 * entry plus its run flags (`run --web-ui` / `run --profile X`), taken from the
 * generated launcher.cmd so the pattern always mirrors what was installed.
 */
function daemonMatchClause(serviceId: string): string | null {
  let content: string;
  try {
    content = readFileSync(windowsLauncherCmdPath(serviceId), 'utf8');
  } catch {
    return null; // unregistered — nothing to match against
  }
  const nodeLine = content.split(/\r?\n/).find((l) => l.includes('lark-channel-bridge'));
  if (!nodeLine) return null;
  const invocation = nodeLine.split('>>')[0] ?? nodeLine;
  const args = invocation.slice(invocation.indexOf('run ')).trim();
  if (!args.startsWith('run')) return null;
  return (
    `$_.Name -eq 'node.exe' -and ` +
    `($_.CommandLine -like '*lark-channel-bridge.mjs*') -and ($_.CommandLine -like '*${likeLiteral(args)}*')`
  );
}

/** Best-effort: kill the launcher tree. See buildKillTreeScript. */
function killLauncherTree(serviceId: string): void {
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', buildKillTreeScript(serviceId)], {
    encoding: 'utf8',
  });
}

/**
 * Remove the supervisor's host-lock file so a `start` right after `stop` isn't
 * blocked by a stale lock.
 *
 * The host lock (`runtime/host-lock.ts`) uses proper-lockfile with
 * `stale: 30_000, retries: 0`. A process killed by `taskkill /F` never releases
 * its lock, and the next supervisor would treat it as held and exit with
 * "control plane already running" for up to 30s — so `stop` then `start` fails.
 *
 * Only called from `endTask` after the launcher tree is confirmed dead, so we
 * never delete a lock a live supervisor is holding. Best-effort, Windows-only.
 */
function clearStaleHostLock(serviceId: string): void {
  if (serviceId !== SUPERVISOR_SERVICE_ID) return; // only the supervisor holds a host lock
  // proper-lockfile acquires a lock by CREATING A SIBLING DIRECTORY named
  // `<target>.lock`, not by writing a file. So for target
  // `.../registry/locks/supervisor.lock` the artifact to remove is
  // `.../registry/locks/supervisor.lock.lock/` (verified on disk: it is a dir).
  // A plain file rmSync would fail on it, hence recursive.
  try {
    rmSync(`${paths.hostLockFile}.lock`, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

interface TaskStatus {
  /** Raw Get-ScheduledTask State: Running / Ready / Disabled / ... */
  state: string;
  /** pids of the launcher hosts (wscript.exe / cmd.exe) still alive. */
  launcherPids: number[];
  /** pid of the node daemon in this service's launcher tree, when found. */
  nodePid?: number;
  /** LastTaskResult (0 = ok); absent when the task never ran. */
  lastResult?: number;
}

/**
 * Read the task's state and its live launcher processes in one PowerShell call.
 *
 * Everything here is deliberately language-independent: `Get-ScheduledTask`
 * returns enum state names and numeric results regardless of the OS UI
 * language, and the launcher processes are matched by command line. Parsing
 * `schtasks` text instead (see the git history) broke on non-English Windows,
 * where the output is localized *and* encoded in the local codepage — that made
 * `isRunning()` always false, so `stop` never killed the daemon.
 */
function queryStatus(serviceId: string): TaskStatus {
  const clause = launcherMatchClause(serviceId);
  const script =
    `$task = Get-ScheduledTask -TaskName '${windowsTaskName(serviceId)}' -ErrorAction SilentlyContinue; ` +
    "$state = if ($task) { $task.State.ToString() } else { 'Absent' }; " +
    `$launchers = Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'wscript.exe','cmd.exe' -and (${clause}) }; ` +
    '$pids = ($launchers | ForEach-Object { $_.ProcessId }) -join ","; ' +
    // The daemon is the node.exe whose parent is one of the launcher hosts.
    '$lp = @($launchers | ForEach-Object { $_.ProcessId }); ' +
    '$node = Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $lp -contains $_.ParentProcessId } | Select-Object -First 1; ' +
    '$info = Get-ScheduledTaskInfo -TaskName ' +
    `'${windowsTaskName(serviceId)}' -ErrorAction SilentlyContinue; ` +
    '$result = if ($info -and $info.LastRunTime) { $info.LastTaskResult } else { "" }; ' +
    '"$state|$pids|$($node.ProcessId)|$result"';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  });
  const [state = 'Absent', pids = '', nodePid = '', result = ''] = (r.stdout ?? '').trim().split('|');
  return {
    state,
    launcherPids: pids
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
    ...(nodePid && Number(nodePid) > 0 ? { nodePid: Number(nodePid) } : {}),
    ...(result !== '' && !Number.isNaN(Number(result)) ? { lastResult: Number(result) } : {}),
  };
}

/** Whether the daemon is up *right now*, with or without a registered task. */
function isServiceRunning(serviceId: string): boolean {
  const s = queryStatus(serviceId);
  // A launcher tree means the daemon is up even if the task itself was
  // disabled or ended (the node child survives `/End`).
  return s.launcherPids.length > 0;
}

/**
 * The PATH to bake into launcher.cmd — the *registry* PATH, not the caller's.
 *
 * A Task Scheduler session inherits PATH from the registry (User + Machine),
 * never from whichever shell ran `start`. Baking in `process.env.PATH` instead
 * poisons the daemon when installation runs from a non-native shell (git-bash
 * hands over POSIX-style `/e/...` entries with no codex/claude dirs, and the
 * bot then fails `binary check` forever). Read the two registry scopes through
 * PowerShell; fall back to the current env only if that somehow fails.
 */
function resolveLauncherEnvPath(): string {
  const script =
    "[Environment]::GetEnvironmentVariable('PATH','User') + ';' + " +
    "[Environment]::GetEnvironmentVariable('PATH','Machine')";
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
    });
    // Empty registry scopes yield stray semicolons; a real Windows PATH has
    // backslashes. Anything else (POSIX-style, empty) must not be trusted.
    const got = (r.stdout ?? '').split(';').map((p) => p.trim()).filter(Boolean).join(';');
    if (r.status === 0 && got.includes('\\')) return got;
  } catch {
    /* fall through */
  }
  return process.env.PATH ?? '';
}

async function writeLauncherScripts(profile: string, runArgs: string[] = ['run']): Promise<void> {
  const bridgeEntryPath = process.argv[1];
  if (!bridgeEntryPath) {
    throw new Error('cannot determine bridge entry path (process.argv[1] is empty)');
  }
  const content = buildLauncherCmd({
    nodePath: process.execPath,
    bridgeEntryPath,
    envPath: resolveLauncherEnvPath(),
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
  // Only once the tree is gone: drop the now-orphaned host lock so an
  // immediate `start` can acquire it instead of waiting out the 30s stale
  // window (proper-lockfile does not release locks of force-killed processes).
  if (isServiceRunning(profile) === false) clearStaleHostLock(profile);
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
 * Whether the service is up — i.e. its launcher process tree is alive.
 *
 * Not simply "the task is Running": after `schtasks /End` (or a task that was
 * disabled while the daemon kept going) the task may read Ready/Disabled while
 * its node child is still online. Sharing one signal with `endTask` is what
 * makes `stop` able to find and kill that leftover daemon.
 */
export function isTaskRunning(profile: string): boolean {
  return isServiceRunning(profile);
}

/**
 * Status text for `parseStatus`. Synthesized in English from language-independent
 * queries rather than echoed from `schtasks` (which is localized and codepage-
 * encoded on non-English Windows, so English regexes never matched).
 */
export function describeTask(profile: string): string {
  const s = queryStatus(profile);
  const lines = [`Status: ${s.launcherPids.length > 0 ? 'Running' : 'Ready'}`, `Task State: ${s.state}`];
  const pid = s.nodePid ?? s.launcherPids[0];
  if (pid) lines.push(`Process ID: ${pid}`);
  if (s.lastResult !== undefined) lines.push(`Last Result: ${s.lastResult}`);
  return lines.join('\n');
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
