import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { withConfigFileLock } from '../../../src/config/profile-store';
import {
  acquireAppRuntimeLock,
  acquireProfileRuntimeLock,
  type AcquiredRuntimeLock,
} from '../../../src/runtime/locks';
import {
  register,
  unregister,
  unregisterSync,
  updateEntry,
  type ProcessEntry,
} from '../../../src/runtime/registry';

// f0.4-lockfix: two profiles sharing ~/.aiducat/registry started at the same
// moment used to kill one of them with "Lock file is already being held"
// (registry lock had no retries). Every registry write path must wait instead.

const repo = resolve(__dirname, '../../..');
const roots: string[] = [];
const held: AcquiredRuntimeLock[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'f04-lockfix-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const l of held.splice(0)) await l.release().catch(() => {});
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function holdRuntimeLocks(root: string, profile: string, appId: string): Promise<void> {
  const paths = resolveAppPaths({ rootDir: root, profile });
  held.push(await acquireProfileRuntimeLock(paths, 'claude'));
  held.push(await acquireAppRuntimeLock(paths, appId, 'claude'));
}

function registerArgs(root: string, profileName: string, appId: string) {
  return {
    appId,
    tenant: 'feishu' as const,
    profileName,
    agentKind: 'claude' as const,
    configPath: join(root, 'config.json'),
    version: '0.4.0',
    registryFile: join(root, 'registry', 'processes.json'),
  };
}

async function readEntries(registryFile: string): Promise<ProcessEntry[]> {
  return (JSON.parse(await readFile(registryFile, 'utf8')) as { entries: ProcessEntry[] }).entries;
}

describe('f0.4-lockfix registry lock waits instead of failing', () => {
  it('8 profiles registering at the same moment all succeed and none is lost', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    const n = 8;
    for (let i = 0; i < n; i++) await holdRuntimeLocks(root, `p${i}`, `cli_${i}`);

    const entries = await Promise.all(
      Array.from({ length: n }, (_, i) => register(registerArgs(root, `p${i}`, `cli_${i}`))),
    );
    expect(new Set((await readEntries(registryFile)).map((e) => e.id))).toEqual(new Set(entries.map((e) => e.id)));

    // running: both bots fill in botName at about the same time
    await Promise.all(entries.map((e, i) => updateEntry(e.id, { botName: `bot${i}` }, registryFile)));
    const after = await readEntries(registryFile);
    expect(after).toHaveLength(n);
    for (const [i, e] of entries.entries()) {
      expect(after.find((x) => x.id === e.id)?.botName).toBe(`bot${i}`);
    }

    // stopping together
    await Promise.all(entries.map((e) => unregister(e.id, registryFile)));
    expect(await readEntries(registryFile)).toEqual([]);
  });

  it('register waits for a registry lock another holder releases shortly', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    await mkdir(dirname(registryFile), { recursive: true });
    await writeFile(registryFile, '{"entries":[]}\n');
    const release = await lockfile.lock(registryFile, { realpath: false, stale: 30_000, update: 10_000 });
    setTimeout(() => void release(), 300);

    await holdRuntimeLocks(root, 'claude', 'cli_a');
    const e = await register(registerArgs(root, 'claude', 'cli_a'));
    expect((await readEntries(registryFile)).map((x) => x.id)).toEqual([e.id]);
  });

  it('takes over a registry lock left behind by a killed process (stale)', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    await mkdir(`${registryFile}.lock`, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(`${registryFile}.lock`, old, old);

    await holdRuntimeLocks(root, 'claude', 'cli_a');
    const e = await register(registerArgs(root, 'claude', 'cli_a'));
    expect((await readEntries(registryFile)).map((x) => x.id)).toEqual([e.id]);
  });

  it('a dead pid entry is pruned even while its profile lock is being re-taken (no fail-closed on restart)', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    await mkdir(dirname(registryFile), { recursive: true });
    const dead: ProcessEntry = {
      id: 'dead',
      pid: 999_999_993,
      appId: 'cli_b',
      tenant: 'feishu',
      profileName: 'xiaohou',
      agentKind: 'claude',
      configPath: join(root, 'config.json'),
      startedAt: new Date().toISOString(),
      version: '0.4.0',
    };
    await writeFile(registryFile, `${JSON.stringify({ entries: [dead] })}\n`);
    // the restarted xiaohou holds its profile lock but has not written the meta yet
    const xPaths = resolveAppPaths({ rootDir: root, profile: 'xiaohou' });
    await mkdir(dirname(xPaths.profileLockFile), { recursive: true });
    await writeFile(xPaths.profileLockFile, '');
    const releaseX = await lockfile.lock(xPaths.profileLockFile, { realpath: false, stale: 30_000, update: 10_000 });
    try {
      await holdRuntimeLocks(root, 'claude', 'cli_a');
      const e = await register(registerArgs(root, 'claude', 'cli_a'));
      expect((await readEntries(registryFile)).map((x) => x.id)).toEqual([e.id]);
    } finally {
      await releaseX();
    }
  });

  it('unregisterSync (exit hook) waits for a lock held by another process', async () => {
    const root = await makeRoot();
    const registryFile = join(root, 'registry', 'processes.json');
    await mkdir(dirname(registryFile), { recursive: true });
    await writeFile(
      registryFile,
      `${JSON.stringify({ entries: [{ id: 'bye', pid: process.pid, appId: 'cli_a', tenant: 'feishu', profileName: 'claude', agentKind: 'claude', configPath: '/x', startedAt: 'x', version: '0.4.0' }] })}\n`,
    );
    const script = [
      `const lf = require(${JSON.stringify(join(repo, 'node_modules/proper-lockfile'))});`,
      `lf.lock(${JSON.stringify(registryFile)}, { realpath: false, stale: 30000, update: 10000 })`,
      `  .then((rel) => { console.log('HELD'); setTimeout(() => rel().then(() => process.exit(0)), 400); });`,
    ].join('\n');
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((ok, fail) => {
      child.stdout.on('data', (d) => String(d).includes('HELD') && ok());
      child.on('exit', (c) => fail(new Error(`child exited early ${c}`)));
    });
    const exited = new Promise((ok) => child.on('exit', ok));

    unregisterSync('bye', registryFile);
    expect(await readEntries(registryFile)).toEqual([]);
    await exited;
  });
});

describe('f0.4-lockfix shared config.json lock', () => {
  it('waits longer than ~1s for the other profile (e.g. a lark-cli import at startup)', async () => {
    const root = await makeRoot();
    const configFile = join(root, 'config.json');
    let releaseFirst!: () => void;
    const first = withConfigFileLock(configFile, () => new Promise<void>((ok) => (releaseFirst = ok)));
    await new Promise((ok) => setTimeout(ok, 50));
    const second = withConfigFileLock(configFile, async () => 'second-ok');
    setTimeout(() => releaseFirst(), 1_800);
    await first;
    await expect(second).resolves.toBe('second-ok');
  });
});

describe('f0.4-lockfix docs', () => {
  it('CHANGELOG f0.4 section records the post-release fix without a new version', async () => {
    const md = await readFile(join(repo, 'CHANGELOG.md'), 'utf8');
    const section = md.slice(md.indexOf('## f0.4 '), md.indexOf('## f0.3+ '));
    expect(section).toContain('### f0.4 之后的修复');
    expect(section).toContain('Lock file is already being held');
    expect(section).toContain('config.json');
  });
});
