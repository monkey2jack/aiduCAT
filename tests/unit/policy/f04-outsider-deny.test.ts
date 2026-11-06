import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNonOwnerSettings, expandOutsiderDenyRead } from '../../../src/agent/claude/owner-only-settings';
import { createDefaultProfileConfig, normalizeProfileConfig } from '../../../src/config/profile-schema';

// f0.4 之后的修复 (Wei 13:52): profile `access.outsiderDenyRead` — extra paths a
// non-owner run may not read (小猴²'s 角色记忆/服务器信息/救火手册 + backups),
// while the group rules file next to them stays readable.

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function fakeHome() {
  const home = await mkdtemp(join(tmpdir(), 'f04-deny-'));
  dirs.push(home);
  const mem = join(home, '.xiaohou', 'memory');
  await mkdir(mem, { recursive: true });
  for (const f of ['服务器信息.md', '服务器信息.md.bak_20261102_0121', '角色记忆.md', '救火手册.md', '群服务机器人守则与业务RAG.md']) {
    await writeFile(join(mem, f), 'x');
  }
  return { home, mem };
}

describe('f04 outsider deny-read', () => {
  it('expands ~/, matches * in the last segment (backups), ignores relative / missing', async () => {
    const { home, mem } = await fakeHome();
    const missingPattern = join(home, 'nope', 'dir', '*.md');
    const absoluteFile = join(home, 'abs-file');
    const out = expandOutsiderDenyRead(
      ['~/.xiaohou/memory/服务器信息.md*', '~/.xiaohou/memory/角色记忆.md', '  ', 'relative/x', missingPattern, absoluteFile],
      home,
    );
    expect(out).toEqual(
      [join(mem, '服务器信息.md'), join(mem, '服务器信息.md.bak_20261102_0121'), join(mem, '角色记忆.md'), resolve(absoluteFile)].sort(),
    );
    expect(out).not.toContain(join(mem, '群服务机器人守则与业务RAG.md'));
    // a regex-looking name is literal, not a pattern
    expect(expandOutsiderDenyRead(['~/.xiaohou/memory/服务器信息.(md)*'], home)).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('accepts absolute Windows drive paths', () => {
    expect(expandOutsiderDenyRead(['C:\\private\\notes.md'])).toContain('C:\\private\\notes.md');
  });

  it('adds Read/Edit/Write deny for each path (and its subtree); rules file untouched', async () => {
    const { home, mem } = await fakeHome();
    const s = buildNonOwnerSettings({
      configDir: join(home, '.claude'),
      settingsEnvNames: [],
      home,
      cwd: join(home, 'ws'),
      outsiderDenyRead: ['~/.xiaohou/memory/服务器信息.md*', `${mem}/救火手册.md`],
    });
    for (const p of [join(mem, '服务器信息.md'), join(mem, '服务器信息.md.bak_20261102_0121'), join(mem, '救火手册.md')]) {
      expect(s.permissions.deny).toEqual(
        expect.arrayContaining([`Read(/${p})`, `Read(/${p}/**)`, `Edit(/${p})`, `Write(/${p})`]),
      );
    }
    expect(s.permissions.deny.some((r) => r.includes('群服务机器人守则'))).toBe(false);
    expect(s.permissions.deny.some((r) => r.includes('角色记忆'))).toBe(false);
  });

  it('no setting = no extra rules (嘟嘟 unchanged)', async () => {
    const { home } = await fakeHome();
    const a = buildNonOwnerSettings({ configDir: join(home, '.claude'), settingsEnvNames: [], home, cwd: join(home, 'ws') });
    const b = buildNonOwnerSettings({
      configDir: join(home, '.claude'),
      settingsEnvNames: [],
      home,
      cwd: join(home, 'ws'),
      outsiderDenyRead: [],
    });
    expect(b).toEqual(a);
    expect(a.permissions.deny.some((r) => r.includes('.xiaohou'))).toBe(false);
  });

  it('config load keeps access.outsiderDenyRead (drops junk / blank / empty list)', () => {
    const base = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    });
    const kept = normalizeProfileConfig({
      ...base,
      access: { ...base.access, outsiderDenyRead: [' ~/.xiaohou/memory/服务器信息.md* ', 7 as never, ''] },
    } as never);
    expect(kept.access.outsiderDenyRead).toEqual(['~/.xiaohou/memory/服务器信息.md*']);
    const empty = normalizeProfileConfig({ ...base, access: { ...base.access, outsiderDenyRead: [] } } as never);
    expect(empty.access).not.toHaveProperty('outsiderDenyRead');
  });

  it('CHANGELOG and README document the setting', async () => {
    const changelog = await readFile(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');
    expect(changelog).toContain('outsiderDenyRead');
    for (const f of ['README.md', 'README.zh.md', 'README.en.md']) {
      const doc = await readFile(new URL(`../../../${f}`, import.meta.url), 'utf8');
      expect(doc).toContain('outsiderDenyRead');
    }
  });
});
