import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import pkg from '../../../package.json';

const read = (f: string) => readFile(new URL(`../../../${f}`, import.meta.url), 'utf8');
const READMES = ['README.md', 'README.zh.md', 'README.en.md'];

describe('f036 version f0.3.6 (package 0.3.6) docs', () => {
  it('f036 package 0.3.6 and every README carries the f0.3.6 badge', async () => {
    expect(pkg.version).toBe('0.3.6');
    for (const f of READMES) expect(await read(f), f).toContain('badge/version-f0.3.6-blue');
  });

  it('f036 CHANGELOG has an f0.3.6 section above f0.3.5 covering the TPS move and the two-stage card', async () => {
    const md = await read('CHANGELOG.md');
    const start = md.indexOf('## f0.3.6 ');
    const prev = md.indexOf('## f0.3.5 ');
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(prev);
    const section = md.slice(start, prev);
    for (const s of ['0.3.6', 'tok/s', '/status', '☤aiduCATing…', '面板', '纯正文', '降级']) expect(section).toContain(s);
  });

  it('f036 READMEs describe the one-line placeholder and TPS only in /status', async () => {
    for (const f of READMES) {
      const md = await read(f);
      expect(md, f).toContain('/status');
      expect(md, f).toMatch(/没有面板|no panel/);
    }
  });
});
