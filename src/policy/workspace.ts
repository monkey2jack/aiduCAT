import { realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type WorkingDirectoryRejectReason =
  | 'empty-requested-cwd'
  | 'path-inaccessible'
  | 'not-directory'
  | 'filesystem-root'
  | 'home-root'
  | 'user-root'
  | 'system-root'
  | 'temp-root'
  | 'broad-user-folder'
  | 'volume-root'
  | 'sensitive-dir';

export type WorkingDirectoryResolveResult =
  | { ok: true; requestedCwd: string; cwdRealpath: string }
  | {
      ok: false;
      reason: WorkingDirectoryRejectReason;
      requestedCwd: string;
      userVisible: string;
    };

export async function resolveWorkingDirectory(
  requestedCwd: string,
): Promise<WorkingDirectoryResolveResult> {
  const trimmed = requestedCwd.trim();
  if (!trimmed) {
    return reject('empty-requested-cwd', requestedCwd, '未指定工作目录。');
  }

  let resolved: string;
  try {
    resolved = await realpath(trimmed);
  } catch {
    return reject('path-inaccessible', requestedCwd, `工作目录不存在或不可访问：${requestedCwd}`);
  }

  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isDirectory()) {
    return reject('not-directory', requestedCwd, `路径不是目录：${resolved}`);
  }

  const tempRealpath = await realpath(tmpdir()).catch(() => resolve(tmpdir()));
  const homeRealpath = await realpath(homedir()).catch(() => resolve(homedir()));
  const broad = classifyHighRiskWorkingDirectory(resolved, requestedCwd, tempRealpath, homeRealpath);
  if (broad) return broad;

  return {
    ok: true,
    requestedCwd,
    cwdRealpath: resolved,
  };
}

function reject(
  reason: WorkingDirectoryRejectReason,
  requestedCwd: string,
  userVisible: string,
): WorkingDirectoryResolveResult {
  return { ok: false, reason, requestedCwd, userVisible };
}

function classifyHighRiskWorkingDirectory(
  real: string,
  requestedCwd: string,
  tempRealpath: string,
  homeRealpath: string,
): WorkingDirectoryResolveResult | undefined {
  if (real === dirname(real)) {
    return reject('filesystem-root', requestedCwd, '不能把文件系统根目录设为工作目录。');
  }

  const home = homeRealpath;
  if (real === home) {
    return reject('home-root', requestedCwd, '不能把 Home 根目录设为工作目录，请选择更具体的子目录。');
  }
  if (real === dirname(home)) {
    return reject('user-root', requestedCwd, '不能把用户目录根设为工作目录，请选择更具体的子目录。');
  }

  if (dirname(real) === home && new Set(['Desktop', 'Downloads']).has(basename(real))) {
    return reject('broad-user-folder', requestedCwd, '这个目录范围过大，请选择更具体的子目录。');
  }

  const temp = resolve(tmpdir());
  if (real === temp || real === tempRealpath || real === '/tmp' || real === '/private/tmp') {
    return reject('temp-root', requestedCwd, '不能把临时目录根设为工作目录，请选择更具体的子目录。');
  }

  const systemRoots = new Set([
    '/Applications',
    '/bin',
    '/etc',
    '/Library',
    '/private',
    '/sbin',
    '/System',
    '/usr',
    '/var',
  ]);
  if (systemRoots.has(real)) {
    return reject('system-root', requestedCwd, '不能把系统目录设为工作目录。');
  }

  if (real === '/Volumes' || dirname(real) === '/Volumes') {
    return reject('volume-root', requestedCwd, '不能把磁盘卷根目录设为工作目录，请选择更具体的子目录。');
  }

  if (sensitiveRoots(home).some((root) => isWithin(real, root))) {
    return reject('sensitive-dir', requestedCwd, '这是凭据或系统目录（含子目录），不能设为工作目录。');
  }

  return undefined;
}

/**
 * f031-sec-L2: directories that hold credentials or system state. Their whole
 * subtree is off-limits as a cwd (the old list only matched exact roots, so
 * `/etc/ssh` or `~/.ssh` were accepted).
 */
const HOME_SENSITIVE = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.netrc',
  '.lark-channel', '.lark-cli', '.claude', '.codex',
  join('.config', 'gh'), join('.config', 'gcloud'), join('.config', 'lark-cli'),
  join('Library', 'Keychains'),
];
const SYSTEM_SENSITIVE = ['/etc', '/proc', '/sys', '/dev', '/boot', '/private/etc', '/private/var/root'];

function sensitiveRoots(home: string): string[] {
  const roots = HOME_SENSITIVE.map((rel) => join(home, rel));
  for (const env of ['LARK_CHANNEL_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    const v = process.env[env]?.trim();
    if (v && isAbsolute(v)) roots.push(resolve(v));
  }
  if (process.platform !== 'win32') {
    roots.push(...SYSTEM_SENSITIVE);
    // root's home, unless this process *is* running with it as $HOME
    if (!isWithin(home, '/root')) roots.push('/root');
  }
  return roots;
}

function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`);
}
