import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFile(new URL(`../../../${f}`, import.meta.url), 'utf8');
const READMES = ['README.md', 'README.zh.md', 'README.en.md'];

// f03p-fix: after merging X (f03p/infra) and Y (f03p/slim) the docs describe X for real.
describe('f03p-fix docs', () => {
  it('f03p-fix-#5 CHANGELOG f0.3+ has no X placeholder left and names every X knob', async () => {
    const md = await read('CHANGELOG.md');
    const section = md.slice(md.indexOf('## f0.3+ '), md.indexOf('## f0.3.1 '));
    expect(section).not.toContain('占位');
    for (const s of ['workspaces.roots', 'shutdownDrainMinutes', 'migrate-home', '--dry-run', 'KillMode=mixed', 'TimeoutStopSec=660', '~/.aiducat', 'owner', '接着刚才的继续']) {
      expect(section, s).toContain(s);
    }
  });

  it('f03p-fix-#6 every README documents migrate-home, workspaces.roots, the drain and the unit settings', async () => {
    for (const f of READMES) {
      const md = await read(f);
      for (const s of ['migrate-home --dry-run', '"roots"', 'shutdownDrainMinutes', 'KillMode=mixed', 'TimeoutStopSec=660', '~/.aiducat/config.json']) {
        expect(md, `${f} ${s}`).toContain(s);
      }
      expect(md, f).not.toContain('暂未改名');
      expect(md, f).not.toContain('keep the upstream names for now');
    }
    expect(await read('README.zh.md')).toBe(await read('README.md'));
  });
});
