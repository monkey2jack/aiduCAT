import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { legacyDataDirNotice, resolveAppPaths } from '../../../src/config/app-paths.js';
import { clearKeystoreDerivedKeyCache, getSecret, setSecret } from '../../../src/config/keystore.js';
import { runMigrateHome } from '../../../src/cli/commands/migrate-home.js';
import { resolveWorkingDirectory } from '../../../src/policy/workspace.js';

// f03p-infra-#4: data dir ~/.lark-channel → ~/.aiducat.

let home = '';
const saved = { HOME: process.env.HOME, LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'f03p-home-')));
  process.env.HOME = home;
  delete process.env.LARK_CHANNEL_HOME;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  clearKeystoreDerivedKeyCache();
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

async function treeHash(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const st = await lstat(p);
      const key = relative(root, p);
      if (st.isSymbolicLink()) out[key] = `link:${await readlink(p)}`;
      else if (st.isDirectory()) {
        out[key] = `dir:${(st.mode & 0o777).toString(8)}`;
        await walk(p);
      } else out[key] = `${(st.mode & 0o777).toString(8)}:${createHash('sha256').update(await readFile(p)).digest('hex')}`;
    }
  };
  await walk(root);
  return out;
}

async function seedLegacy(root = join(home, '.lark-channel')): Promise<string> {
  const prof = join(root, 'profiles', 'claude');
  await mkdir(join(prof, 'lark-cli', 'lark-channel'), { recursive: true, mode: 0o700 });
  await mkdir(join(prof, 'logs'), { recursive: true });
  await mkdir(join(prof, 'media'), { recursive: true });
  await mkdir(join(root, 'registry', 'locks'), { recursive: true });
  await mkdir(join(`${root}-workspaces`, 'claude', 'default'), { recursive: true });
  const paths = resolveAppPaths({ rootDir: root, profile: 'claude' });
  await setSecret('app-secret', 'PLAINTEXT_SENTINEL_123', paths);
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({
      schemaVersion: 2,
      activeProfile: 'claude',
      profiles: {
        claude: {
          workspaces: { default: join(`${root}-workspaces`, 'claude', 'default') },
          secrets: { providers: { getter: { command: join(root, 'secrets-getter') } } },
        },
      },
    }, null, 2),
    { mode: 0o600 },
  );
  await writeFile(join(root, 'secrets-getter'), `#!/bin/sh\nLARK_CHANNEL_HOME='${root}' exec node x secrets get "$@"\n`, { mode: 0o700 });
  await writeFile(join(prof, 'lark-cli', 'lark-channel', 'config.json'), JSON.stringify({ exec: join(root, 'secrets-getter'), home: root }), { mode: 0o600 });
  await writeFile(join(prof, 'sessions.json'), JSON.stringify({ oc_dm: { sessionId: 's1', cwd: join(`${root}-workspaces`, 'claude', 'default') } }), { mode: 0o600 });
  await writeFile(join(prof, 'run-journal.json'), JSON.stringify({ v: 1, inflight: {}, queued: {} }), { mode: 0o600 });
  await writeFile(join(root, 'registry', 'processes.json'), JSON.stringify({ entries: [] }), { mode: 0o600 });
  await writeFile(join(prof, 'logs', 'bridge-20261031.jsonl'), `{"msg":"read ${root}/config.json"}\n`, { mode: 0o600 });
  await writeFile(join(prof, 'media', 'a.bin'), Buffer.from([0, 1, 2, 255]), { mode: 0o600 });
  await symlink(join(root, 'config.json'), join(root, 'config-link.json'));
  return root;
}

describe('f03p-infra-#4 default data dir', () => {
  it('f03p-infra-#4 fresh machine → ~/.aiducat', () => {
    expect(resolveAppPaths().rootDir).toBe(join(home, '.aiducat'));
    expect(legacyDataDirNotice(resolveAppPaths().rootDir)).toBeUndefined();
  });

  it('f03p-infra-#4 only the old dir exists → keep using it, with a one-line notice', async () => {
    await mkdir(join(home, '.lark-channel'));
    const root = resolveAppPaths().rootDir;
    expect(root).toBe(join(home, '.lark-channel'));
    expect(legacyDataDirNotice(root)).toContain('migrate-home');
  });

  it('f03p-infra-#4 both exist → the new one wins', async () => {
    await mkdir(join(home, '.lark-channel'));
    await mkdir(join(home, '.aiducat'));
    expect(resolveAppPaths().rootDir).toBe(join(home, '.aiducat'));
  });

  it('f03p-infra-#4 LARK_CHANNEL_HOME still wins and never triggers the notice', async () => {
    await mkdir(join(home, '.lark-channel'));
    process.env.LARK_CHANNEL_HOME = join(home, 'custom');
    expect(resolveAppPaths().rootDir).toBe(join(home, 'custom'));
    process.env.LARK_CHANNEL_HOME = join(home, '.lark-channel');
    expect(legacyDataDirNotice(resolveAppPaths().rootDir)).toBeUndefined();
  });

  it('f03p-infra-#4 /cd refuses ~/.aiducat like ~/.lark-channel', async () => {
    await mkdir(join(home, '.aiducat', 'profiles'), { recursive: true });
    const r = await resolveWorkingDirectory(join(home, '.aiducat', 'profiles'));
    expect(r.ok).toBe(false);
  });
});

describe('f03p-infra-#4 aiduCAT migrate-home', () => {
  it('f03p-infra-#4 --dry-run writes nothing and lists what would change', async () => {
    const old = await seedLegacy();
    const before = await treeHash(old);
    const lines: string[] = [];
    const report = await runMigrateHome({ dryRun: true, out: (l) => lines.push(l) });
    expect(report.dryRun).toBe(true);
    expect(report.from).toBe(old);
    expect(report.to).toBe(join(home, '.aiducat'));
    await expect(stat(join(home, '.aiducat'))).rejects.toThrow();
    expect(await treeHash(old)).toEqual(before);
    expect(report.rewrites.map((r) => r.path).sort()).toEqual(
      ['config.json', 'profiles/claude/lark-cli/lark-channel/config.json', 'secrets-getter'].sort(),
    );
    expect(lines.join('\n')).toContain('secrets.enc');
    expect(lines.join('\n')).not.toContain('PLAINTEXT_SENTINEL');
  });

  it('f03p-infra-#4 copies everything, rewrites paths, keeps modes, secrets still decrypt, old dir untouched', async () => {
    const old = await seedLegacy();
    const before = await treeHash(old);
    const report = await runMigrateHome({ out: () => undefined });
    const neu = join(home, '.aiducat');
    expect(report.verified).toBe(true);
    expect(await treeHash(old)).toEqual(before); // never deleted, never modified
    const cfg = JSON.parse(await readFile(join(neu, 'config.json'), 'utf8'));
    expect(cfg.profiles.claude.secrets.providers.getter.command).toBe(join(neu, 'secrets-getter'));
    // the workspaces tree is NOT moved: same cwd → Claude sessions resume as before
    expect(cfg.profiles.claude.workspaces.default).toBe(join(`${old}-workspaces`, 'claude', 'default'));
    expect(await readFile(join(neu, 'secrets-getter'), 'utf8')).toContain(`LARK_CHANNEL_HOME='${neu}'`);
    expect((await stat(join(neu, 'secrets-getter'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(neu, 'config.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(neu)).mode & 0o777).toBe(0o700);
    // logs/media copied byte for byte, never rewritten
    expect(await readFile(join(neu, 'profiles/claude/logs/bridge-20261031.jsonl'), 'utf8')).toContain(old);
    expect([...(await readFile(join(neu, 'profiles/claude/media/a.bin')))]).toEqual([0, 1, 2, 255]);
    for (const f of ['profiles/claude/secrets.enc', 'profiles/claude/.keystore.key', 'profiles/claude/.keystore.salt', 'registry/processes.json', 'profiles/claude/run-journal.json', 'profiles/claude/sessions.json']) {
      expect((await readFile(join(neu, f))).equals(await readFile(join(old, f))), f).toBe(true);
    }
    expect(await readlink(join(neu, 'config-link.json'))).toBe(join(neu, 'config.json'));
    clearKeystoreDerivedKeyCache();
    expect(await getSecret('app-secret', resolveAppPaths({ rootDir: neu, profile: 'claude' }))).toBe('PLAINTEXT_SENTINEL_123');
    // ~/.aiducat-workspaces → the old workspaces tree (no copy)
    expect(await readlink(join(home, '.aiducat-workspaces'))).toBe(`${old}-workspaces`);
    // and the app now resolves to the new dir by default
    expect(resolveAppPaths().rootDir).toBe(neu);
  });

  it('f03p-infra-#4 refuses when the target already has content', async () => {
    await seedLegacy();
    await mkdir(join(home, '.aiducat'));
    await writeFile(join(home, '.aiducat', 'x'), '1');
    await expect(runMigrateHome({ out: () => undefined })).rejects.toThrow(/已存在/);
  });

  it('f03p-infra-#4 refuses while a bridge process from the old dir is alive', async () => {
    const old = await seedLegacy();
    await writeFile(
      join(old, 'registry', 'processes.json'),
      JSON.stringify({ entries: [{ id: 'a1', pid: process.ppid, appId: 'cli', tenant: 'feishu', profileName: 'claude', agentKind: 'claude', configPath: join(old, 'config.json'), startedAt: 'x', version: '0.3.1' }] }),
    );
    await expect(runMigrateHome({ out: () => undefined })).rejects.toThrow(/停/);
    await expect(stat(join(home, '.aiducat'))).rejects.toThrow();
  });

  it('f03p-infra-#4 LARK_CHANNEL_HOME pointing at a custom old dir is the source', async () => {
    const custom = await seedLegacy(join(home, 'bridge-data'));
    process.env.LARK_CHANNEL_HOME = custom;
    const lines: string[] = [];
    const report = await runMigrateHome({ dryRun: true, out: (l) => lines.push(l) });
    expect(report.from).toBe(custom);
    expect(lines.join('\n')).toContain('LARK_CHANNEL_HOME');
  });

  it('f03p-infra-#4 points out a systemd unit that still pins the old dir', async () => {
    const old = await seedLegacy();
    const unitDir = join(home, '.config', 'systemd', 'user');
    await mkdir(unitDir, { recursive: true });
    await writeFile(join(unitDir, 'aiduCAT.service'), `[Service]\nEnvironment="LARK_CHANNEL_HOME=${old}"\n`);
    await chmod(join(unitDir, 'aiduCAT.service'), 0o644);
    const lines: string[] = [];
    await runMigrateHome({ dryRun: true, out: (l) => lines.push(l) });
    expect(lines.join('\n')).toContain('aiduCAT.service');
  });
});
