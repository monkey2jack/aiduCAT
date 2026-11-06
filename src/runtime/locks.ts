import { chmod, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lockfile from 'proper-lockfile';
import type { AppPaths } from '../config/app-paths';
import type { AgentKind } from '../config/profile-schema';

export type RuntimeLockKind = 'profile' | 'app';

export interface AcquiredRuntimeLock {
  kind: RuntimeLockKind;
  target: string;
  release(): Promise<void>;
}

export interface RuntimeLockMeta {
  kind: RuntimeLockKind;
  target: string;
  profile: string;
  agentKind: AgentKind;
  appId?: string;
  pid: number;
  startedAt: string;
}

export class RuntimeLockConflictError extends Error {
  constructor(
    readonly kind: RuntimeLockKind,
    readonly target: string,
    readonly meta: RuntimeLockMeta | undefined,
    cause: unknown,
  ) {
    super(`runtime ${kind} lock is already held: ${target}`);
    this.name = 'RuntimeLockConflictError';
    this.cause = cause;
  }
}

export async function withProfileAndAppLocks<T>(
  paths: Pick<AppPaths, 'profile' | 'profileLockFile' | 'appLockFile'>,
  appId: string,
  agentKind: AgentKind,
  fn: (locks: AcquiredRuntimeLock[]) => Promise<T> | T,
): Promise<T> {
  const acquired: AcquiredRuntimeLock[] = [];
  try {
    acquired.push(
      await acquireRuntimeLock({
        kind: 'profile',
        target: paths.profileLockFile,
        profile: paths.profile,
        agentKind,
      }),
    );
    acquired.push(
      await acquireRuntimeLock({
        kind: 'app',
        target: paths.appLockFile(appId),
        profile: paths.profile,
        agentKind,
        appId,
      }),
    );
    return await fn([...acquired]);
  } finally {
    for (const lock of acquired.reverse()) {
      await lock.release().catch(() => {});
    }
  }
}

export async function acquireAppRuntimeLock(
  paths: Pick<AppPaths, 'profile' | 'appLockFile'>,
  appId: string,
  agentKind: AgentKind,
): Promise<AcquiredRuntimeLock> {
  return acquireRuntimeLock({
    kind: 'app',
    target: paths.appLockFile(appId),
    profile: paths.profile,
    agentKind,
    appId,
  });
}

export async function acquireProfileRuntimeLock(
  paths: Pick<AppPaths, 'profile' | 'profileLockFile'>,
  agentKind: AgentKind,
): Promise<AcquiredRuntimeLock> {
  return acquireRuntimeLock({
    kind: 'profile',
    target: paths.profileLockFile,
    profile: paths.profile,
    agentKind,
  });
}

export function runtimeLockMetaFile(target: string): string {
  return `${target}.meta.json`;
}

/**
 * Whether a pid is still running. `EPERM` means the process exists but belongs
 * to another user — treat it as alive, never as a stale-holder to reap.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reap a lock whose holder process is gone.
 *
 * proper-lockfile only treats a lock as stale after `stale` ms of no mtime
 * heartbeat (30s here). A daemon killed with SIGKILL / `taskkill /F` never runs
 * its release path, so its lock lingers for a full 30s — long enough that an
 * immediate `restart` (or the supervisor's boot-time auto-start) hits every
 * profile lock as held and fails to bring any bot up.
 *
 * We only remove the lock when the recorded holder pid is provably dead, so a
 * slow-but-live holder (heartbeat late, or on another user) is never stolen
 * from. Returns true if a stale lock was cleared.
 */
async function reapIfHolderDead(target: string): Promise<boolean> {
  const meta = await readRuntimeLockMeta(target);
  if (!meta || isPidAlive(meta.pid)) return false;
  // Two starters can race here: if another process reaped this lock and took
  // it in the meantime, the sidecar now names a different (live) holder.
  // Re-read right before removing so we never delete a freshly taken lock.
  const again = await readRuntimeLockMeta(target);
  if (!again || again.pid !== meta.pid || again.startedAt !== meta.startedAt) return false;
  // proper-lockfile acquires by creating a sibling `<target>.lock` DIRECTORY;
  // its release unlinks that dir and the meta sidecar.
  await rm(`${target}.lock`, { recursive: true, force: true }).catch(() => {});
  await unlink(runtimeLockMetaFile(target)).catch(() => {});
  return true;
}

export async function readRuntimeLockMeta(target: string): Promise<RuntimeLockMeta | undefined> {
  try {
    const parsed = JSON.parse(await readFile(runtimeLockMetaFile(target), 'utf8')) as unknown;
    return isRuntimeLockMeta(parsed) ? parsed : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

export async function checkRuntimeLock(target: string): Promise<{
  locked: boolean;
  meta?: RuntimeLockMeta;
  uncertain?: boolean;
  error?: string;
}> {
  try {
    const locked = await lockfile.check(target, { realpath: false });
    if (!locked) return { locked: false };
    const meta = await readRuntimeLockMeta(target);
    if (!meta) {
      return { locked: true, uncertain: true, error: 'missing-or-invalid-runtime-lock-meta' };
    }
    return { locked: true, meta };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { locked: false };
    return {
      locked: true,
      uncertain: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function acquireRuntimeLock(
  meta: Omit<RuntimeLockMeta, 'pid' | 'startedAt'>,
): Promise<AcquiredRuntimeLock> {
  await mkdir(dirname(meta.target), { recursive: true });
  await writeFile(meta.target, '', { flag: 'a', mode: 0o600 });
  await chmod(meta.target, 0o600);

  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(meta.target, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
    });
  } catch (err) {
    // Force-killed holders (SIGKILL / `taskkill /F`) leave their lock behind
    // for the full 30s stale window. If the recorded holder is provably dead,
    // clear it and retry once — otherwise a restart right after a kill fails.
    if (await reapIfHolderDead(meta.target)) {
      try {
        release = await lockfile.lock(meta.target, {
          realpath: false,
          stale: 30_000,
          update: 10_000,
        });
      } catch (retryErr) {
        throw new RuntimeLockConflictError(
          meta.kind,
          meta.target,
          await readRuntimeLockMeta(meta.target),
          retryErr,
        );
      }
    } else {
      throw new RuntimeLockConflictError(meta.kind, meta.target, await readRuntimeLockMeta(meta.target), err);
    }
  }

  const fullMeta: RuntimeLockMeta = {
    ...meta,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const metaFile = runtimeLockMetaFile(meta.target);
  await writeFile(metaFile, `${JSON.stringify(fullMeta, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(metaFile, 0o600);

  return {
    kind: meta.kind,
    target: meta.target,
    async release() {
      await unlink(metaFile).catch(() => {});
      await release();
    },
  };
}

function isRuntimeLockMeta(value: unknown): value is RuntimeLockMeta {
  if (!value || typeof value !== 'object') return false;
  const meta = value as Partial<RuntimeLockMeta>;
  return (
    (meta.kind === 'profile' || meta.kind === 'app') &&
    typeof meta.target === 'string' &&
    typeof meta.profile === 'string' &&
    (meta.agentKind === 'claude' || meta.agentKind === 'codex' || meta.agentKind === 'hermes') &&
    typeof meta.pid === 'number' &&
    typeof meta.startedAt === 'string' &&
    (meta.appId === undefined || typeof meta.appId === 'string')
  );
}
