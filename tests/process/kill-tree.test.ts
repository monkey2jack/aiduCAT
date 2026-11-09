import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { killProcessTree } from '../../src/platform/kill-tree';
import { spawnProcess } from '../../src/platform/spawn';

// issue #9 (P2): child.kill() cannot reach past a .cmd shim; taskkill /T /F
// must reap the whole tree. On this machine the real claude/codex shims are
// .cmd, so a tree kill that misses grandchildren would leave this test's
// child alive too.

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
    ),
  );
});

function tasklistHasPid(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawnProcess('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      windowsHide: true,
    });
    let out = '';
    probe.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
    probe.on('exit', () => resolve(out.includes(String(pid))));
    probe.on('error', () => resolve(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('killProcessTree (issue #9 P2)', () => {
  it('kills the whole tree: the child spawned by the target dies with it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kill-tree-test-'));
    cleanupDirs.push(dir);
    const parentPath = join(dir, 'parent.mjs');
    const childPath = join(dir, 'sleeper.mjs');
    const markerPath = join(dir, 'pid.json');
    await writeFile(
      childPath,
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(' + JSON.stringify(markerPath) + ', String(process.pid));',
        'setInterval(() => {}, 60_000);',
      ].join('\n'),
      'utf8',
    );
    await chmod(childPath, 0o755);
    await writeFile(
      parentPath,
      [
        'import { spawn } from "node:child_process";',
        'const child = spawn(process.execPath, [' + JSON.stringify(childPath) + '], { stdio: "ignore" });',
        'child.unref();',
        'setInterval(() => {}, 60_000);',
      ].join('\n'),
      'utf8',
    );
    await chmod(parentPath, 0o755);

    const parent = spawn(process.execPath, [parentPath], {
      stdio: 'ignore',
      windowsHide: true,
    });

    let childPid: number | undefined;
    for (let i = 0; i < 100 && !childPid; i++) {
      await sleep(30);
      try {
        const { readFile } = await import('node:fs/promises');
        const raw = await readFile(markerPath, 'utf8');
        childPid = Number(raw.trim());
      } catch {
        // marker not written yet
      }
    }
    expect(childPid).toBeGreaterThan(0);

    await sleep(100);
    expect(await tasklistHasPid(childPid!)).toBe(true);

    await killProcessTree(parent.pid, 'kill-tree-test');

    // Both parent and its child must be gone. Poll briefly: taskkill is fast
    // but the test should not flake on scheduling.
    let parentGone = false;
    let childGone = false;
    for (let i = 0; i < 50; i++) {
      await sleep(50);
      parentGone = !(await tasklistHasPid(parent.pid!));
      childGone = !(await tasklistHasPid(childPid!));
      if (parentGone && childGone) break;
    }
    expect(parentGone).toBe(true);
    expect(childGone).toBe(true);
  }, 15_000);

  it('does not throw for an already-dead pid', async () => {
    await expect(killProcessTree(-1, 'already-dead')).resolves.toBeUndefined();
  });
});
