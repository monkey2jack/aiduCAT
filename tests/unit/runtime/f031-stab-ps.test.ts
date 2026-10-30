import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAndPrune, type ProcessEntry } from '../../../src/runtime/registry';

// f031-stab-#290 (upstream issue #290, unfixed upstream): `ps` / `/ps` listed
// crashed processes as running because readAndPrune() never looked at the
// pid. It is the first command anyone runs when the bot looks dead, so it
// must not lie. Read path stays read-only (no rewrite); cleanup is still the
// write path's job.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

function entry(overrides: Partial<ProcessEntry>): ProcessEntry {
  return {
    id: 'id',
    pid: process.pid,
    appId: 'cli_test',
    tenant: 'feishu',
    configPath: '/tmp/config.json',
    startedAt: new Date().toISOString(),
    version: '0.3.1',
    profileName: 'claude',
    agentKind: 'claude',
    ...overrides,
  };
}

async function registryWith(entries: ProcessEntry[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'f031-stab-ps-'));
  roots.push(root);
  const file = join(root, 'registry', 'processes.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8');
  return file;
}

describe('f031-stab-#290 ps never lists dead processes', () => {
  it('f031-stab-#290 readAndPrune drops entries whose pid is gone, without rewriting the file', async () => {
    const file = await registryWith([
      entry({ id: 'dead', pid: 999_999_999 }),
      entry({ id: 'self', pid: process.pid }),
    ]);
    const before = await readFile(file, 'utf8');
    expect(readAndPrune(file).map((e) => e.id)).toEqual(['self']);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('f031-stab-#290 a registry with only dead entries reads as empty ("no bot running")', async () => {
    const file = await registryWith([entry({ id: 'dead', pid: 999_999_998 })]);
    expect(readAndPrune(file)).toEqual([]);
  });
});
