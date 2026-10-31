import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tightenDataDirPermissions } from '../../../src/config/data-dir-perms';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function mode(p: string): Promise<number> {
  return (await stat(p)).mode & 0o777;
}

async function seed(): Promise<{ base: string; root: string; outside: string }> {
  const base = await mkdtemp(join(tmpdir(), 'f03p-perms-'));
  roots.push(base);
  const root = join(base, '.aiducat');
  const outside = join(base, 'outside.txt');
  await mkdir(join(root, 'profiles', 'claude', 'media'), { recursive: true });
  await mkdir(join(root, 'registry', 'locks', 'profile'), { recursive: true });
  await writeFile(join(root, 'config.json'), '{}');
  await writeFile(join(root, 'profiles', 'claude', 'secrets.enc'), '{}');
  await writeFile(join(root, 'profiles', 'claude', '.keystore.key'), 'k');
  await writeFile(join(root, 'profiles', 'claude', 'media', 'a.png'), 'x');
  await writeFile(join(root, 'registry', 'processes.json'), '[]');
  await writeFile(join(root, 'secrets-getter'), '#!/bin/sh\n');
  await writeFile(outside, 'not ours');
  await chmod(outside, 0o644);
  await symlink(outside, join(root, 'link-out'));
  for (const d of [root, join(root, 'profiles'), join(root, 'profiles', 'claude'), join(root, 'profiles', 'claude', 'media'), join(root, 'registry'), join(root, 'registry', 'locks'), join(root, 'registry', 'locks', 'profile')]) {
    await chmod(d, 0o775);
  }
  for (const f of ['config.json', 'profiles/claude/secrets.enc', 'profiles/claude/.keystore.key', 'profiles/claude/media/a.png', 'registry/processes.json']) {
    await chmod(join(root, f), 0o664);
  }
  await chmod(join(root, 'secrets-getter'), 0o755);
  return { base, root, outside };
}

describe.skipIf(process.platform === 'win32')('f03p-infra-#1 data dir permissions are tightened on start', () => {
  it('f03p-infra-#1 dirs → 0700, files → 0600, scripts keep owner-exec (0700), symlink targets untouched', async () => {
    const { root, outside } = await seed();
    const r = await tightenDataDirPermissions(root);
    expect(r.failed).toBe(0);
    expect(r.changed).toBeGreaterThan(0);
    for (const d of ['', 'profiles', 'profiles/claude', 'profiles/claude/media', 'registry', 'registry/locks', 'registry/locks/profile']) {
      expect(await mode(join(root, d)), d).toBe(0o700);
    }
    for (const f of ['config.json', 'profiles/claude/secrets.enc', 'profiles/claude/.keystore.key', 'profiles/claude/media/a.png', 'registry/processes.json']) {
      expect(await mode(join(root, f)), f).toBe(0o600);
    }
    expect(await mode(join(root, 'secrets-getter'))).toBe(0o700);
    expect(await mode(outside)).toBe(0o644);
    expect(await readFile(join(root, 'config.json'), 'utf8')).toBe('{}');
  });

  it('f03p-infra-#1 idempotent: a second pass changes nothing', async () => {
    const { root } = await seed();
    await tightenDataDirPermissions(root);
    const again = await tightenDataDirPermissions(root);
    expect(again).toMatchObject({ changed: 0, failed: 0 });
  });

  it('f03p-infra-#1 never throws: missing root → zero work', async () => {
    const base = await mkdtemp(join(tmpdir(), 'f03p-perms-'));
    roots.push(base);
    await expect(tightenDataDirPermissions(join(base, 'nope'))).resolves.toMatchObject({ changed: 0, failed: 0 });
  });

  it('f03p-infra-#1 refuses to walk $HOME or a top-level dir (LARK_CHANNEL_HOME=~ by mistake)', async () => {
    const { homedir } = await import('node:os');
    await expect(tightenDataDirPermissions(homedir())).resolves.toMatchObject({ changed: 0, scanned: 0 });
    await expect(tightenDataDirPermissions('/')).resolves.toMatchObject({ changed: 0, scanned: 0 });
    await expect(tightenDataDirPermissions('/tmp')).resolves.toMatchObject({ changed: 0, scanned: 0 });
  });

  it('f03p-infra-#1 both start modes call it without awaiting it before going online', async () => {
    const src = await readFile(new URL('../../../src/cli/commands/start.ts', import.meta.url), 'utf8');
    expect(src.match(/scheduleDataDirTightening\(/g)?.length).toBeGreaterThanOrEqual(3); // definition + 2 call sites
  });
});
