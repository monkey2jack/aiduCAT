import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DATA_DIR_NAME, LEGACY_DATA_DIR_NAME } from '../../config/app-paths';
import { clearKeystoreDerivedKeyCache, getSecret, listSecretIds } from '../../config/keystore';
import { isAlive } from '../../runtime/registry';

/**
 * f03p-infra-#4: `aiduCAT migrate-home [--dry-run]` — copy the data dir from
 * the old `~/.lark-channel` (or $LARK_CHANNEL_HOME) to `~/.aiducat`.
 *
 *  - copies everything (config.json, secrets.enc, .keystore.key/.salt,
 *    profiles/, registry/, run-journal, logs, media) keeping modes and mtimes;
 *  - rewrites absolute paths that point INTO the old dir in the small text
 *    files that hold them (config.json, lark-cli configs, secrets-getter…);
 *    logs and media are copied byte for byte, never rewritten;
 *  - the `<old>-workspaces` tree is NOT copied: `~/.aiducat-workspaces` becomes
 *    a symlink to it, so every chat keeps the same cwd and Claude sessions
 *    resume exactly as before;
 *  - verifies (byte-equal copies, expected rewrites, JSON parses, keystore
 *    decrypts at the new place) in a temp dir, then renames it into place;
 *  - never deletes or modifies the old dir. Refuses while a bridge from the
 *    old dir is alive, or when the target already has content.
 */

export interface MigrateHomeOptions {
  dryRun?: boolean;
  from?: string;
  to?: string;
  out?: (line: string) => void;
}

export interface MigrateHomeReport {
  dryRun: boolean;
  from: string;
  to: string;
  files: number;
  dirs: number;
  symlinks: number;
  bytes: number;
  rewrites: Array<{ path: string; replacements: number }>;
  workspacesLink?: { link: string; target: string };
  hints: string[];
  verified: boolean;
}

const MAX_REWRITE_BYTES = 2 * 1024 * 1024;
const NEVER_REWRITE_DIRS = new Set(['logs', 'media']);
const NEVER_REWRITE_FILES = new Set(['secrets.enc', '.keystore.key', '.keystore.salt']);
const KEY_FILES = ['config.json', 'secrets.enc', '.keystore.key', '.keystore.salt', 'run-journal.json', 'processes.json'];

interface Entry {
  rel: string;
  kind: 'dir' | 'file' | 'symlink';
  mode: number;
  size: number;
  atime: Date;
  mtime: Date;
  linkTarget?: string;
}

export async function runMigrateHome(opts: MigrateHomeOptions = {}): Promise<MigrateHomeReport> {
  const out = opts.out ?? ((line: string) => console.log(line));
  const home = homedir();
  const to = resolve(opts.to ?? join(home, DATA_DIR_NAME));
  const envHome = process.env.LARK_CHANNEL_HOME?.trim();
  const from = resolve(
    opts.from ?? (envHome && resolve(envHome) !== to ? envHome : join(home, LEGACY_DATA_DIR_NAME)),
  );
  const dryRun = opts.dryRun === true;

  // ---- preconditions -------------------------------------------------------
  const fromInfo = await stat(from).catch(() => undefined);
  if (!fromInfo?.isDirectory()) throw new Error(`旧数据目录不存在：${from}`);
  if (from === to || isWithin(to, from) || isWithin(from, to)) {
    throw new Error(`源和目标不能相同或互相包含：${from} → ${to}`);
  }
  if (existsSync(to)) {
    const inside = await readdir(to).catch(() => ['?']);
    if (inside.length > 0) throw new Error(`目标目录已存在且不为空：${to}（不会覆盖；确认后自己移走再试）`);
  }
  const live = liveBridges(from);
  if (live.length > 0) {
    throw new Error(
      `旧目录的 aiduCAT 还在运行（pid ${live.join(', ')}）。请先停服务（例如 \`systemctl --user stop aiduCAT\`）再迁移。`,
    );
  }

  // ---- plan ------------------------------------------------------------------
  const entries = await walk(from);
  const fromReal = await realpathOr(from);
  const roots = [...new Set([from, fromReal])];
  const rewrites: MigrateHomeReport['rewrites'] = [];
  const planned = new Map<string, Buffer>();
  for (const e of entries) {
    if (e.kind !== 'file' || !rewritable(e)) continue;
    const buf = await readFile(join(from, e.rel));
    if (!roots.some((r) => buf.includes(r))) continue;
    const text = buf.toString('utf8');
    if (Buffer.from(text, 'utf8').compare(buf) !== 0) continue; // not UTF-8 text
    const { next, count } = rewritePaths(text, roots, to);
    if (count === 0) continue;
    rewrites.push({ path: e.rel.split(sep).join('/'), replacements: count });
    planned.set(e.rel, Buffer.from(next, 'utf8'));
  }
  const files = entries.filter((e) => e.kind === 'file');
  const report: MigrateHomeReport = {
    dryRun,
    from,
    to,
    files: files.length,
    dirs: entries.filter((e) => e.kind === 'dir').length,
    symlinks: entries.filter((e) => e.kind === 'symlink').length,
    bytes: files.reduce((n, e) => n + e.size, 0),
    rewrites,
    hints: [],
    verified: false,
  };
  const oldWs = `${from}-workspaces`;
  const newWs = `${to}-workspaces`;
  if (existsSync(oldWs) && !existsSync(newWs)) report.workspacesLink = { link: newWs, target: oldWs };
  report.hints.push(...deploymentHints(from, to));

  out(`${dryRun ? '【演练，不写任何东西】' : '【迁移】'}${from} → ${to}`);
  out(`  ${report.dirs} 个目录、${report.files} 个文件（${formatBytes(report.bytes)}）、${report.symlinks} 个符号链接，全部复制，保留权限和时间`);
  const present = KEY_FILES.filter((k) => files.some((e) => e.rel.split(sep).pop() === k));
  out(`  关键文件：${present.join('、') || '（无）'}；profiles/ ${hasDir(entries, 'profiles') ? '✓' : '—'}；registry/ ${hasDir(entries, 'registry') ? '✓' : '—'}`);
  if (rewrites.length) {
    out(`  改写路径（旧目录 → 新目录）：`);
    for (const r of rewrites) out(`    - ${r.path}（${r.replacements} 处）`);
  } else out('  没有需要改写路径的文件');
  if (report.workspacesLink) out(`  工作目录不搬：${newWs} → 链到 ${oldWs}（会话 cwd 不变，Claude 照常续接）`);
  for (const h of report.hints) out(`  ⚠️ ${h}`);
  out(`  旧目录 ${from} 不删、不改。`);
  if (dryRun) return report;

  // ---- copy into a temp sibling, verify, then rename into place -------------
  await mkdir(dirname(to), { recursive: true });
  const staging = `${to}.migrating-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const e of entries) {
      const src = join(from, e.rel);
      const dst = join(staging, e.rel);
      if (e.kind === 'dir') {
        await mkdir(dst, { recursive: true, mode: 0o700 });
      } else if (e.kind === 'symlink') {
        const target = e.linkTarget ?? '';
        const retarget = roots.map((r) => (isAbsolute(target) && isWithin(target, r) ? join(to, relative(r, target)) : undefined)).find(Boolean);
        await symlink(retarget ?? target, dst);
      } else {
        const body = planned.get(e.rel);
        if (body) await writeFile(dst, body, { mode: e.mode });
        else await copyFile(src, dst);
        await chmod(dst, e.mode);
        await utimes(dst, e.atime, e.mtime);
      }
    }
    for (const e of [...entries].reverse()) {
      if (e.kind !== 'dir') continue;
      await chmod(join(staging, e.rel), e.mode).catch(() => undefined);
    }
    await chmod(staging, 0o700);

    await verify({ from, staging, entries, planned, roots });
    await rename(staging, to);
    await chmod(to, 0o700);
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  if (report.workspacesLink) {
    await symlink(report.workspacesLink.target, report.workspacesLink.link).catch((err: unknown) => {
      report.hints.push(`没能建立 ${newWs} 链接：${err instanceof Error ? err.message : String(err)}`);
    });
  }
  report.verified = true;
  out('✓ 校验通过：文件逐字节一致（改写的除外）、JSON 可解析、密钥库在新位置能解密。');
  out(`下一步：确认 unit / 环境变量里没有写死旧目录 → 启动服务 → 看日志 → 嘟嘟实测。旧目录 ${from} 先留着，观察一周后再决定删不删。`);
  return report;
}

async function verify(input: {
  from: string;
  staging: string;
  entries: Entry[];
  planned: Map<string, Buffer>;
  roots: string[];
}): Promise<void> {
  const problems: string[] = [];
  for (const e of input.entries) {
    const dst = join(input.staging, e.rel);
    if (e.kind === 'dir') {
      if (!(await lstat(dst).catch(() => undefined))?.isDirectory()) problems.push(`缺目录 ${e.rel}`);
      continue;
    }
    if (e.kind === 'symlink') {
      if (!(await lstat(dst).catch(() => undefined))?.isSymbolicLink()) problems.push(`缺链接 ${e.rel}`);
      continue;
    }
    const got = await readFile(dst).catch(() => undefined);
    if (!got) {
      problems.push(`缺文件 ${e.rel}`);
      continue;
    }
    const want = input.planned.get(e.rel) ?? (await readFile(join(input.from, e.rel)));
    if (sha256(got) !== sha256(want)) problems.push(`内容不一致 ${e.rel}`);
    if (((await stat(dst)).mode & 0o777) !== e.mode) problems.push(`权限不一致 ${e.rel}`);
    if (input.planned.has(e.rel)) {
      if (e.rel.endsWith('.json')) {
        try {
          JSON.parse(got.toString('utf8'));
        } catch {
          problems.push(`改写后 JSON 解析失败 ${e.rel}`);
        }
      }
      const { count } = rewritePaths(got.toString('utf8'), input.roots, '');
      if (count > 0) problems.push(`改写后仍含旧路径 ${e.rel}`);
    }
  }
  // Keystores: every profile with a secrets.enc must still decrypt at the new place.
  for (const e of input.entries) {
    if (e.kind !== 'file' || e.rel.split(sep).pop() !== 'secrets.enc') continue;
    const dir = join(input.staging, dirname(e.rel));
    const paths = {
      secretsFile: join(dir, 'secrets.enc'),
      keystoreSaltFile: join(dir, '.keystore.salt'),
      keystoreKeyFile: join(dir, '.keystore.key'),
    };
    clearKeystoreDerivedKeyCache();
    const ids = await listSecretIds(paths).catch(() => [] as string[]);
    let ok = 0;
    for (const id of ids) {
      if ((await getSecret(id, paths).catch(() => undefined)) !== undefined) ok++;
    }
    if (ids.length > 0 && ok === 0) problems.push(`密钥库在新位置一项都解不开 ${e.rel}`);
  }
  clearKeystoreDerivedKeyCache();
  if (problems.length) throw new Error(`校验失败，已放弃（旧目录没动）：\n  ${problems.join('\n  ')}`);
}

function rewritable(e: Entry): boolean {
  const parts = e.rel.split(sep);
  if (parts.some((p) => NEVER_REWRITE_DIRS.has(p))) return false;
  if (NEVER_REWRITE_FILES.has(parts[parts.length - 1] ?? '')) return false;
  return e.size <= MAX_REWRITE_BYTES;
}

/** Replace `<root>` only where it is the whole path or a path prefix (`<root>/…`). */
export function rewritePaths(text: string, roots: readonly string[], to: string): { next: string; count: number } {
  let count = 0;
  let next = text;
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`${escapeRegExp(root)}(?=$|[/"'\\s\`,;:)\\]}])`, 'g');
    next = next.replace(re, () => {
      count++;
      return to;
    });
  }
  return { next, count };
}

async function walk(root: string): Promise<Entry[]> {
  const out: Entry[] = [];
  const visit = async (rel: string): Promise<void> => {
    for (const name of (await readdir(join(root, rel))).sort()) {
      const r = rel ? join(rel, name) : name;
      const st = await lstat(join(root, r));
      const base = { rel: r, mode: st.mode & 0o777, size: st.size, atime: st.atime, mtime: st.mtime };
      if (st.isSymbolicLink()) out.push({ ...base, kind: 'symlink', linkTarget: await readlink(join(root, r)) });
      else if (st.isDirectory()) {
        out.push({ ...base, kind: 'dir' });
        await visit(r);
      } else if (st.isFile()) out.push({ ...base, kind: 'file' });
    }
  };
  await visit('');
  return out;
}

function liveBridges(from: string): number[] {
  try {
    const raw = JSON.parse(readFileSync(join(from, 'registry', 'processes.json'), 'utf8')) as {
      entries?: Array<{ pid?: unknown }>;
    };
    return (raw.entries ?? [])
      .map((e) => e.pid)
      .filter((pid): pid is number => typeof pid === 'number' && pid !== process.pid && isAlive(pid));
  } catch {
    return [];
  }
}

function deploymentHints(from: string, to: string): string[] {
  const hints: string[] = [];
  if (process.env.LARK_CHANNEL_HOME?.trim() && resolve(process.env.LARK_CHANNEL_HOME) === from) {
    hints.push(`当前环境设置了 LARK_CHANNEL_HOME=${from}：迁移后要从 unit / 环境里删掉它（或改成 ${to}），否则还会用旧目录。`);
  }
  const unitDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user');
  try {
    for (const name of readdirSync(unitDir)) {
      if (!name.endsWith('.service')) continue;
      const body = readFileSync(join(unitDir, name), 'utf8');
      if (body.includes(from)) hints.push(`${join(unitDir, name)} 里写死了旧目录 ${from}：改成 ${to} 后 \`systemctl --user daemon-reload\`。`);
    }
  } catch {
    /* no user units */
  }
  return hints;
}

function hasDir(entries: Entry[], name: string): boolean {
  return entries.some((e) => e.kind === 'dir' && e.rel === name);
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function realpathOr(p: string): Promise<string> {
  return realpath(p).catch(() => p);
}

function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
