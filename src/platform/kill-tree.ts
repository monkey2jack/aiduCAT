import { log } from '../core/logger';
import { spawnProcess } from './spawn';

/**
 * issue #9 (P2): kill an agent process AND everything it spawned.
 *
 * On Windows, `child.kill()` only terminates the direct child — claude/codex
 * resolve to a `.cmd` shim routed through `cmd.exe`, and the real CLI process
 * (plus any grandchild that inherited the stdout write handle) survives. That
 * is exactly how the 2026-11-08 orphan claude.exe hung around for two hours
 * holding a session file. `taskkill /T /F` walks the whole tree instead.
 *
 * POSIX keeps the plain SIGKILL: killing a process group would hit our own
 * group (the child is not spawned detached), and the bug this fixes is
 * Windows-specific.
 *
 * Best-effort: a pid that already exited makes taskkill fail harmlessly, so
 * this never throws.
 */
export async function killProcessTree(pid: number | undefined, why: string): Promise<void> {
  if (pid === undefined) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already dead / already reaped — nothing to do
    }
    return;
  }
  await new Promise<void>((resolve) => {
    // windowsHide: the daemon runs headless; a taskkill console flash on the
    // desktop would be alarming noise.
    const killer = spawnProcess('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const done = (): void => resolve();
    // taskkill exits non-zero when the pid is already gone — that is success
    // for us. Only a spawn failure (taskkill missing) is worth a log line.
    killer.on('exit', done);
    killer.on('error', () => {
      log.warn('run', 'kill-tree-spawn-failed', { pid, why });
      done();
    });
    // Belt and braces: taskkill finishes in milliseconds; never hang a caller
    // on it no matter what.
    setTimeout(done, 5_000).unref();
  });
}
