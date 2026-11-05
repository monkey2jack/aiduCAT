import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { runtimeLockMetaFile, withProfileAndAppLocks } from '../../../src/runtime/locks';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(join(tmpdir(), 'bridge-locks-')),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runtime locks', () => {
  it('acquires profile lock before app lock and writes 0600 targets with metadata sidecars', async () => {
    const root = await makeRoot();
    const paths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    await mkdir(paths.userLockDir, { recursive: true });

    const metaFiles: string[] = [];
    const order = await withProfileAndAppLocks(paths, 'cli_test', 'codex', async (acquired) => {
      expect(acquired.map((lock) => lock.kind)).toEqual(['profile', 'app']);
      for (const lock of acquired) {
        const mode = (await stat(lock.target)).mode & 0o777;
        if (process.platform !== 'win32') {
          expect(mode).toBe(0o600);
        }
        const metaFile = `${lock.target}.meta.json`;
        metaFiles.push(metaFile);
        const meta = JSON.parse(await readFile(metaFile, 'utf8')) as {
          kind: string;
          pid: number;
          profile: string;
          agentKind: string;
          appId?: string;
          startedAt: string;
        };
        expect(meta.kind).toBe(lock.kind);
        expect(meta.pid).toBe(process.pid);
        expect(meta.profile).toBe('claude');
        expect(meta.agentKind).toBe('codex');
        expect(meta.startedAt).toEqual(expect.any(String));
        if (lock.kind === 'app') expect(meta.appId).toBe('cli_test');
      }
      return acquired.map((lock) => lock.kind);
    });

    expect(order).toEqual(['profile', 'app']);
    for (const metaFile of metaFiles) {
      await expect(stat(metaFile)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('keeps lock implementation realpath-safe and out of slow business code', async () => {
    const source = await readFile(join(process.cwd(), 'src/runtime/locks.ts'), 'utf8');

    expect(source).toMatch(/realpath:\s*false/);
    expect(source).not.toMatch(/RunPolicy|AgentAdapter|startChannel|createLarkChannel/);
  });

  it('surfaces holder metadata when profile or app locks conflict', async () => {
    const root = await makeRoot();
    const first = resolveAppPaths({ rootDir: root, profile: 'claude' });
    const second = resolveAppPaths({ rootDir: root, profile: 'codex-dev' });

    await withProfileAndAppLocks(first, 'cli_test', 'claude', async () => {
      await expect(
        withProfileAndAppLocks(first, 'cli_other', 'claude', async () => {}),
      ).rejects.toMatchObject({
        kind: 'profile',
        meta: {
          profile: 'claude',
          agentKind: 'claude',
          pid: process.pid,
        },
      });

      await expect(
        withProfileAndAppLocks(second, 'cli_test', 'codex', async () => {}),
      ).rejects.toMatchObject({
        kind: 'app',
        meta: {
          profile: 'claude',
          agentKind: 'claude',
          appId: 'cli_test',
          pid: process.pid,
        },
      });
    });

    await withProfileAndAppLocks(second, 'cli_new', 'codex', async () => {
      expect(true).toBe(true);
    });
  });

  it('reaps a lock whose holder pid is dead instead of failing', async () => {
    const root = await makeRoot();
    const paths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    await mkdir(paths.userLockDir, { recursive: true });

    // A child process killed with SIGKILL — its pid is provably dead, and it
    // stays dead long enough for the reap check (a freshly-exited pid can be
    // recycled by the OS, which would make the test flaky).
    const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { detached: true });
    const pid = child.pid;
    if (pid === undefined) throw new Error('failed to spawn child');
    await new Promise((r) => setTimeout(r, 300));
    process.kill(pid, 'SIGKILL');

    // proper-lockfile acquires by creating a sibling <target>.lock DIRECTORY.
    await mkdir(`${paths.profileLockFile}.lock`, { recursive: true });
    await writeFile(
      runtimeLockMetaFile(paths.profileLockFile),
      `${JSON.stringify({
        kind: 'profile',
        target: paths.profileLockFile,
        profile: 'claude',
        agentKind: 'claude',
        pid,
        startedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    // A live holder would block this; a dead one must be reaped automatically.
    await expect(
      withProfileAndAppLocks(paths, 'cli_reaped', 'claude', async () => {
        expect(true).toBe(true);
      }),
    ).resolves.toBeUndefined();

    // The stale lock directory and meta sidecar are gone, not merely
    // superseded by the new holder (which would leave a leftover dir).
    await expect(stat(`${paths.profileLockFile}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not reap a lock held by a live process', async () => {
    const root = await makeRoot();
    const paths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    await mkdir(paths.userLockDir, { recursive: true });

    await withProfileAndAppLocks(paths, 'cli_live', 'claude', async () => {
      // A second acquire for the same profile must still conflict — the live
      // holder must not be stolen.
      await expect(
        withProfileAndAppLocks(paths, 'cli_other', 'claude', async () => {}),
      ).rejects.toMatchObject({ kind: 'profile' });
    });
  });
});
