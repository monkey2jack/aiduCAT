import { chmod, lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * f03p-infra-#1: on start, make the data dir owner-only — every directory
 * 0700, every regular file 0600 (a file with the owner-exec bit, such as
 * `secrets-getter`, becomes 0700). Older versions and hand edits left
 * `profiles/`, `registry/`, media and old logs at 0775/0664.
 *
 * Idempotent (only entries whose mode differs are touched), never follows
 * symlinks, never throws: a failed entry is counted and skipped so startup
 * is never blocked by it. The sibling `<root>-workspaces` tree is the user's
 * work and is left alone.
 */
export interface TightenResult {
  changed: number;
  failed: number;
  scanned: number;
}

const MAX_ENTRIES = 50_000;

export async function tightenDataDirPermissions(rootDir: string): Promise<TightenResult> {
  const result: TightenResult = { changed: 0, failed: 0, scanned: 0 };
  if (process.platform === 'win32') return result;
  // A data dir pointed at $HOME or / by mistake (LARK_CHANNEL_HOME=~) must
  // never turn into a recursive chmod of the whole home / disk.
  const abs = resolve(rootDir);
  if (abs === resolve(homedir()) || dirname(abs) === abs || dirname(dirname(abs)) === dirname(abs)) {
    return result;
  }
  const visit = async (path: string): Promise<void> => {
    if (result.scanned >= MAX_ENTRIES) return;
    let info;
    try {
      info = await lstat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') result.failed++;
      return;
    }
    result.scanned++;
    if (info.isSymbolicLink()) return;
    const isDir = info.isDirectory();
    if (!isDir && !info.isFile()) return;
    const current = info.mode & 0o777;
    const target = isDir || (current & 0o100) !== 0 ? 0o700 : 0o600;
    if (current !== target) {
      try {
        await chmod(path, target);
        result.changed++;
      } catch {
        result.failed++;
      }
    }
    if (!isDir) return;
    let names: string[];
    try {
      names = await readdir(path);
    } catch {
      result.failed++;
      return;
    }
    for (const name of names) await visit(join(path, name));
  };
  try {
    await visit(rootDir);
  } catch {
    result.failed++;
  }
  return result;
}
