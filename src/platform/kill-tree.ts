import { log } from '../core/logger';
import { spawnProcess } from './spawn';

/** Best-effort, validated process-tree termination for agent shutdown. */
export async function killProcessTree(pid: number | undefined, why: string): Promise<void> {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    log.warn('run', 'kill-tree-invalid-pid', { pid: pid ?? null, why });
    return;
  }
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    return;
  }
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = (): void => { if (!finished) { finished = true; resolve(); } };
    const killer = spawnProcess('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true,
    });
    killer.once('error', (err) => {
      log.warn('run', 'kill-tree-failed', { pid, why, error: err.message });
      finish();
    });
    killer.once('exit', () => finish());
    setTimeout(finish, 5_000).unref();
  });
}
