import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import pkg from '../../../package.json';

const read = (f: string) => readFile(new URL(`../../../${f}`, import.meta.url), 'utf8');
const READMES = ['README.md', 'README.zh.md', 'README.en.md'];

describe('f036 version f0.3.6 (merged into f0.4, now package 0.4.2) docs', () => {
  it('f036 package moved past 0.3.6 (now 0.5.0) and no README still carries the f0.3.6 badge', async () => {
    expect(pkg.version).toBe('0.5.0');
    for (const f of READMES) expect(await read(f), f).not.toContain('badge/version-f0.3.6-blue');
  });

  it('f036 (merged into f0.4) the f0.4 section covers the TPS move and the two-stage card', async () => {
    const md = await read('CHANGELOG.md');
    const start = md.indexOf('## f0.4 ');
    const prev = md.indexOf('## f0.3+ ');
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(prev);
    const section = md.slice(start, prev);
    for (const s of ['0.3.6', 'tok/s', '/status', '☤aiduCATing…', '面板', '纯正文', '降级']) expect(section).toContain(s);
  });

  it('f036 READMEs describe the one-line placeholder and TPS only in /status', async () => {
    for (const f of READMES) {
      const md = await read(f);
      expect(md, f).toContain('/status');
      // f0.4+ (Wei 2026-11-04): the placeholder is a one-line panel with the agent icon
      expect(md, f).toMatch(/一行面板|one-line panel/);
      expect(md, f).not.toContain('☤aiduCATing…');
    }
  });
});
