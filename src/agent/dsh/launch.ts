/**
 * f0.5++: where is DSH, and how do we start it?
 *
 * DSH ships as a Desktop application (Electron) and, optionally, as an npm
 * `dsh` command. Only the npm form is on PATH; the Desktop form has to be
 * launched as `DeepSeek Harness.exe --expose-internals <cli.js>` with
 * `ELECTRON_RUN_AS_NODE=1`, which is why a hand-written `dsh-launcher.cmd`
 * existed on the first deployment. A hand-written launcher is a single point of
 * failure — it hard-codes one install path, so a DSH upgrade, a different
 * machine, or a different OS account breaks it with `agent-binary-not-found`.
 *
 * This module resolves a launch spec by probing, in order:
 *   1. the operator's explicit choice (`dsh.binaryPath` / LARK_CHANNEL_DSH_BIN)
 *   2. `dsh` on PATH (npm / Homebrew installs)
 *   3. the Desktop application's bundled CLI
 *
 * Everything here is DSH-only: cc/codex/hermes keep their own resolution.
 */

import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export type DshLaunchSource = 'config' | 'env' | 'path' | 'desktop-app';

export interface DshLaunchSpec {
  /** Executable to spawn. */
  command: string;
  /** argv prepended before DSH's own arguments. */
  prefixArgs: string[];
  /** Extra environment this launch shape needs. */
  env: Record<string, string>;
  /** How it was found — surfaced by /doctor. */
  source: DshLaunchSource;
  /** One-line explanation for logs and /doctor. */
  detail: string;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * `app.asar` is a FILE, not a directory: only Electron's patched fs can see the
 * paths inside it, so a plain Node process (`existsSync('...app.asar\\...')`)
 * always says "missing". Discovery therefore checks the archive itself and
 * treats anything below it as present — Electron resolves the real entry when
 * it starts, and a wrong guess surfaces as a version-check failure, not a
 * silently broken install.
 */
function asarAwareExists(path: string): boolean {
  const marker = path.toLowerCase().indexOf('.asar');
  if (marker === -1) return isFile(path);
  const archive = path.slice(0, marker + '.asar'.length);
  return isFile(archive);
}

/**
 * Resolve a command to an absolute path: an absolute path is taken as-is,
 * anything else is searched on PATH honouring PATHEXT (Windows).
 */
export function resolveDshCommand(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  if (isAbsolute(trimmed)) return isFile(trimmed) ? trimmed : undefined;

  const exts = (process.env.PATHEXT ?? '')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  const names = [trimmed, ...exts.map((ext) => `${trimmed}${ext}`)];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

interface DesktopInstall {
  exe: string;
  cli: string;
}

/** Candidate Desktop-app installations for this platform. */
function desktopInstalls(): DesktopInstall[] {
  const cliFrom = (resources: string): string =>
    join(
      resources,
      'app.asar',
      'dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh-desktop-host',
      'lib',
      'cli.js',
    );

  const out: DesktopInstall[] = [];
  if (process.platform === 'win32') {
    const roots = new Set<string>();
    const fromLocalAppData = process.env.LOCALAPPDATA?.trim();
    if (fromLocalAppData) roots.add(join(fromLocalAppData, 'Programs', 'DeepSeek Harness'));
    // A service account (LocalSystem) has its own LOCALAPPDATA under
    // ...\config\systemprofile, so an install made by the real user would be
    // invisible. USERPROFILE is the reliable anchor when it is set.
    const fromUserProfile = process.env.USERPROFILE?.trim();
    if (fromUserProfile) {
      roots.add(join(fromUserProfile, 'AppData', 'Local', 'Programs', 'DeepSeek Harness'));
    }
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]) {
      if (base) roots.add(join(base, 'Programs', 'DeepSeek Harness'));
    }
    for (const root of roots) {
      out.push({ exe: join(root, 'DeepSeek Harness.exe'), cli: cliFrom(join(root, 'resources')) });
    }
  } else if (process.platform === 'darwin') {
    const contents = '/Applications/DeepSeek Harness.app/Contents';
    out.push({
      exe: join(contents, 'MacOS', 'DeepSeek Harness'),
      cli: cliFrom(join(contents, 'Resources')),
    });
  } else {
    for (const root of ['/opt/DeepSeek Harness', '/usr/lib/deepseek-harness']) {
      out.push({ exe: join(root, 'deepseek-harness'), cli: cliFrom(join(root, 'resources')) });
    }
  }
  return out;
}

/**
 * Find how to start DSH on this machine, or `undefined` when it is not
 * installed anywhere we know about.
 *
 * `configured` is the operator's `dsh.binaryPath`; when it resolves it always
 * wins, so a custom launcher (or a deliberately pinned build) is respected.
 */
export function discoverDshLaunch(configured?: string): DshLaunchSpec | undefined {
  const fromConfig = configured?.trim() ? resolveDshCommand(configured) : undefined;
  if (fromConfig) {
    return {
      command: fromConfig,
      prefixArgs: [],
      env: {},
      source: 'config',
      detail: 'profile dsh.binaryPath',
    };
  }

  const fromEnv = process.env.LARK_CHANNEL_DSH_BIN
    ? resolveDshCommand(process.env.LARK_CHANNEL_DSH_BIN)
    : undefined;
  if (fromEnv) {
    return {
      command: fromEnv,
      prefixArgs: [],
      env: {},
      source: 'env',
      detail: 'LARK_CHANNEL_DSH_BIN',
    };
  }

  const onPath = resolveDshCommand('dsh');
  if (onPath) {
    return { command: onPath, prefixArgs: [], env: {}, source: 'path', detail: 'dsh on PATH' };
  }

  for (const install of desktopInstalls()) {
    if (!isFile(install.exe) || !asarAwareExists(install.cli)) continue;
    return {
      command: install.exe,
      prefixArgs: ['--expose-internals', install.cli],
      // Without this the app boots its GUI instead of running the CLI.
      env: { ELECTRON_RUN_AS_NODE: '1' },
      source: 'desktop-app',
      detail: 'DeepSeek Harness desktop install',
    };
  }

  return undefined;
}

/** Where DSH would be looked for — used in the "not found" diagnostic. */
export function dshSearchSummary(): string {
  const places = ['dsh.binaryPath / LARK_CHANNEL_DSH_BIN', 'dsh on PATH'];
  for (const install of desktopInstalls()) places.push(install.exe);
  return places.join(' | ');
}

/** Test seam / doctor helper: is this launch spec still usable? */
export function isLaunchSpecUsable(spec: DshLaunchSpec): boolean {
  if (!existsSync(spec.command)) return false;
  // A `--expose-internals <cli.js>` entry usually lives inside app.asar, which
  // plain fs cannot stat; asarAwareExists handles both shapes.
  return spec.prefixArgs.every((arg) => !arg.endsWith('.js') || asarAwareExists(arg));
}
