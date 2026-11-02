import { lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * f0.4 之后的修复 (bwrap): a non-owner run sets CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
 * which makes Claude Code (≥ 2.1.3xx on Linux) start its bubblewrap sandbox.
 * To keep sandboxed commands from creating supply-chain files, the sandbox
 * pre-creates EMPTY placeholders for them in the run's cwd (seen on summer,
 * Claude Code 2.1.316: `.env*`, `package.json`, lockfiles, `.npmrc`,
 * `node_modules/.bin`, `.claude/{agents,commands}` …) and leaves them there.
 * The cwd is the profile workspace the owner's own runs share, so an empty
 * `package.json` would linger and break npm there.
 *
 * After a non-owner run we remove only what that run left behind: a name from
 * this list that did NOT exist before the run and is still an empty file, or a
 * directory tree that holds nothing but empty directories. Anything with
 * content, or that existed before, is never touched.
 */
export const SANDBOX_PLACEHOLDER_NAMES: readonly string[] = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.production',
  '.env.production.local',
  '.env.test',
  '.env.test.local',
  '.gitmodules',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'bunfig.toml',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'node_modules',
  '.claude',
];

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Names from the list that already exist in `cwd` (taken before the run). */
export function snapshotPlaceholders(cwd: string): Set<string> {
  const present = new Set<string>();
  for (const name of SANDBOX_PLACEHOLDER_NAMES) if (exists(join(cwd, name))) present.add(name);
  return present;
}

function onlyEmptyDirs(dir: string, depth = 0): boolean {
  if (depth > 4) return false;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    const st = lstatSync(join(dir, entry), { throwIfNoEntry: false });
    if (!st || !st.isDirectory() || !onlyEmptyDirs(join(dir, entry), depth + 1)) return false;
  }
  return true;
}

/** Remove what the run left behind; returns the names removed. Never throws. */
export function cleanupSandboxPlaceholders(cwd: string, before: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  for (const name of SANDBOX_PLACEHOLDER_NAMES) {
    if (before.has(name)) continue;
    const path = join(cwd, name);
    try {
      const st = lstatSync(path, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isFile() && st.size === 0) {
        unlinkSync(path);
        removed.push(name);
      } else if (st.isDirectory() && onlyEmptyDirs(path)) {
        rmSync(path, { recursive: true, force: true });
        removed.push(name);
      }
    } catch {
      /* best effort */
    }
  }
  return removed;
}
