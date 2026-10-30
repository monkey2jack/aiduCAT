import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkingDirectory } from '../../../src/policy/workspace';

const linux = process.platform === 'linux';
let home = '';
let savedHome: string | undefined;

describe('f031-sec-L2 /cd refuses credential and system directories (subtrees too)', () => {
  beforeEach(async () => {
    savedHome = process.env.HOME;
    home = await mkdtemp(join(tmpdir(), 'f031-sec-home-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    process.env.HOME = savedHome;
    await rm(home, { recursive: true, force: true });
  });

  it('f031-sec-L2 credential dirs under $HOME are rejected, normal project dirs are not', async () => {
    const sensitive = ['.ssh', '.ssh/keys', '.lark-channel', '.lark-channel/claude/lark-cli', '.claude', '.claude/projects', '.codex', '.aws', '.gnupg', '.config/gh', '.kube', '.docker'];
    for (const rel of sensitive) {
      await mkdir(join(home, rel), { recursive: true });
      const r = await resolveWorkingDirectory(join(home, rel));
      expect(r.ok, rel).toBe(false);
      if (!r.ok) expect(r.reason).toBe('sensitive-dir');
    }
    await mkdir(join(home, 'code', 'app'), { recursive: true });
    expect((await resolveWorkingDirectory(join(home, 'code', 'app'))).ok).toBe(true);
    // a project that merely contains ".ssh" in its name is fine
    await mkdir(join(home, 'code', 'my.ssh-tool'), { recursive: true });
    expect((await resolveWorkingDirectory(join(home, 'code', 'my.ssh-tool'))).ok).toBe(true);
  });

  it.runIf(linux)('f031-sec-L2 /etc, /proc, /sys, /root and /boot subtrees are rejected', async () => {
    const etcChild = (await readdir('/etc', { withFileTypes: true })).find((d) => d.isDirectory());
    const candidates = ['/etc', etcChild ? `/etc/${etcChild.name}` : '/etc', '/proc/self', '/sys/kernel', '/root', '/boot', '/dev'];
    for (const dir of candidates) {
      const exists = await stat(dir).then((s) => s.isDirectory()).catch(() => false);
      if (!exists) continue;
      const r = await resolveWorkingDirectory(dir);
      expect(r.ok, dir).toBe(false);
    }
  });
});
