import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { log } from '../../core/logger';
import { delimiter, join } from 'node:path';

/**
 * f04-group-cmd-model (C): let a non-owner run use Bash on hosts with
 * containerd — WITHOUT loosening containerd.
 *
 * A non-owner run sets CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1, so Claude Code
 * runs every Bash command inside bubblewrap and always masks the container
 * runtime sockets (/run/containerd/containerd.sock, …). bubblewrap ≥ 0.12
 * (CVE fix: symlink-safe destination resolution) must open the socket's
 * parent as a real directory; containerd keeps /run/containerd at 0711, so
 * every Bash call dies with "Can't mkdir parents for
 * /run/containerd/containerd.sock" (anthropics/claude-code#93144). The only
 * published workaround is `chmod a+rx /run/containerd` — loosening
 * containerd's own hardening, which we do not do.
 *
 * Instead, the non-owner Claude process starts in a private mount namespace
 * (unprivileged user namespace, own uid only — no root, no new rights) where
 * each such unreadable runtime directory is covered by an empty tmpfs holding
 * a placeholder for the socket. Inside that view the socket simply is not
 * there (the run can reach containerd even less than before), and bubblewrap
 * can mask the placeholder. The host, other processes and the owner's runs
 * see nothing. Capabilities gained in the namespace are dropped before Claude
 * starts (`setpriv`), and every exec keeps the same pid, so signals from the
 * bridge reach Claude directly.
 */

/** Sockets Claude Code's scrub sandbox always masks (2.1.3xx). */
export const CLAUDE_SANDBOX_RUNTIME_SOCKETS: readonly string[] = [
  '/run/containerd/containerd.sock',
  '/run/podman/podman.sock',
  '/run/buildkit/buildkitd.sock',
];

export interface MaskPlan {
  /** Directories to cover with a tmpfs, each with the socket file name to recreate. */
  dirs: Array<{ dir: string; socket: string }>;
}

export interface MaskProbe {
  exists(path: string): boolean;
  readable(path: string): boolean;
  onPath(binary: string): boolean;
  /**
   * Whether this host lets an unprivileged process create a user + mount
   * namespace. Ubuntu ≥ 23.10 blocks it by default via AppArmor
   * (kernel.apparmor_restrict_unprivileged_userns=1: "write failed
   * /proc/self/uid_map"); then we must NOT wrap, or the whole run would die.
   */
  usernsWorks(): boolean;
}

let usernsCache: boolean | undefined;
function usernsWorksDefault(): boolean {
  if (usernsCache !== undefined) return usernsCache;
  try {
    const r = spawnSync('unshare', ['--user', '--map-current-user', '--mount', '--', 'true'], {
      stdio: 'ignore',
      timeout: 3000,
    });
    usernsCache = r.status === 0;
  } catch {
    usernsCache = false;
  }
  if (!usernsCache) {
    log.warn('agent', 'runtime-dir-mask-unavailable', {
      hint: 'unprivileged user namespaces are blocked here; non-owner Bash may hit claude-code#93144',
    });
  }
  return usernsCache;
}

function onPathDefault(binary: string, pathEnv = process.env.PATH): boolean {
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, binary), constants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

export const defaultMaskProbe: MaskProbe = {
  exists: (p) => existsSync(p),
  readable: (p) => {
    try {
      accessSync(p, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
  onPath: (b) => onPathDefault(b),
  usernsWorks: () => usernsWorksDefault(),
};

/**
 * Which runtime directories need masking on this host. Empty plan = nothing to
 * do (no containerd, or its directory is already listable). Linux only.
 */
export function planRuntimeDirMask(
  platform: NodeJS.Platform = process.platform,
  probe: MaskProbe = defaultMaskProbe,
): MaskPlan {
  if (platform !== 'linux') return { dirs: [] };
  const dirs: MaskPlan['dirs'] = [];
  for (const sock of CLAUDE_SANDBOX_RUNTIME_SOCKETS) {
    const slash = sock.lastIndexOf('/');
    const dir = sock.slice(0, slash);
    const socket = sock.slice(slash + 1);
    if (probe.exists(dir) && !probe.readable(dir)) dirs.push({ dir, socket });
  }
  return { dirs };
}

/** Fixed, quote-free paths only (they come from the constant list above). */
function safePath(p: string): boolean {
  return /^\/[A-Za-z0-9._/-]+$/.test(p);
}

/**
 * Wrap `binary args…` so it starts inside the masked mount namespace. Returns
 * undefined when nothing needs masking, the tools (unshare, setpriv from
 * util-linux) are missing, or the host blocks unprivileged user namespaces
 * (checked once) — the caller then spawns Claude directly, exactly as before.
 */
export function wrapWithRuntimeDirMask(
  binary: string,
  args: readonly string[],
  plan: MaskPlan,
  probe: MaskProbe = defaultMaskProbe,
): { command: string; args: string[] } | undefined {
  if (plan.dirs.length === 0) return undefined;
  if (!probe.onPath('unshare') || !probe.onPath('setpriv')) return undefined;
  if (!probe.usernsWorks()) return undefined;
  const steps: string[] = [];
  for (const { dir, socket } of plan.dirs) {
    if (!safePath(dir) || !/^[A-Za-z0-9._-]+$/.test(socket)) return undefined;
    steps.push(`mount -t tmpfs -o mode=0755,size=64k aiducat-mask ${dir}`);
    steps.push(`: > ${dir}/${socket}`);
  }
  // `set -e`: if any mask step fails, do NOT start Claude half-masked — the
  // run fails (and the user-facing error path handles it).
  const script = `set -e; ${steps.join('; ')}; exec setpriv --inh-caps=-all --ambient-caps=-all -- "$@"`;
  return {
    command: 'unshare',
    args: [
      '--user',
      '--map-current-user',
      '--mount',
      '--propagation',
      'private',
      '--keep-caps',
      '--',
      'sh',
      '-c',
      script,
      'aiducat-mask',
      binary,
      ...args,
    ],
  };
}
