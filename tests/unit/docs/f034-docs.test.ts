import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import pkg from '../../../package.json';

const read = (f: string) => readFile(new URL(`../../../${f}`, import.meta.url), 'utf8');
const READMES = ['README.md', 'README.zh.md', 'README.en.md'];

describe('f034 version f0.3.4 (package 0.3.4) docs', () => {
  it('f034 package moved past 0.3.4 (now 0.3.6) and no README still carries the f0.3.4 badge', async () => {
    expect(pkg.version).toBe('0.3.6');
    for (const f of READMES) expect(await read(f), f).not.toContain('badge/version-f0.3.4-blue');
  });

  it('f034 CHANGELOG has an f0.3.4 section above f0.3.3 covering the latency fixes', async () => {
    const md = await read('CHANGELOG.md');
    const start = md.indexOf('## f0.3.4 ');
    const prev = md.indexOf('## f0.3.3 ');
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(prev);
    const section = md.slice(start, prev);
    for (const s of ['0.3.4', '/v1/models', 'combo', '表情', 'Thinking', 'settings.json', 'sinceMsgMs']) expect(section).toContain(s);
  });

  it('f034 READMEs no longer say the window comes from 10router /v1/models', async () => {
    for (const f of READMES) {
      const md = await read(f);
      expect(md, f).not.toMatch(/窗口来自 10router `\/v1\/models`|window comes from 10router `\/v1\/models`/);
    }
  });
});
