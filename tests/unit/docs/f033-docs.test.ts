import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import pkg from '../../../package.json';

const read = (f: string) => readFile(new URL(`../../../${f}`, import.meta.url), 'utf8');
const READMES = ['README.md', 'README.zh.md', 'README.en.md'];

describe('f033 version f0.3.3 (package 0.3.3) docs', () => {
  it('f033 package 0.3.3 and every README carries the f0.3.3 badge', async () => {
    expect(pkg.version).toBe('0.3.3');
    for (const f of READMES) {
      const md = await read(f);
      expect(md, f).toContain('badge/version-f0.3.3-blue');
      expect(md, f).not.toContain('badge/version-f0.3%2B-blue');
    }
  });

  it('f033 CHANGELOG has an f0.3.3 section above f0.3+ covering aiduPARK, no "下一版" left', async () => {
    const md = await read('CHANGELOG.md');
    const start = md.indexOf('## f0.3.3 ');
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(md.indexOf('## f0.3+ '));
    const section = md.slice(start, md.indexOf('## f0.3+ '));
    for (const s of ['0.3.3', 'aiduPARK', 'monkey', 'aidupark']) expect(section).toContain(s);
    expect(md).not.toContain('## 下一版');
  });

  it('f033 released versions f0.3+ and f0.3.1 are no longer headed 未发布', async () => {
    const md = await read('CHANGELOG.md');
    for (const v of ['f0.3+', 'f0.3.1']) {
      const line = md.split('\n').find((l) => l.startsWith(`## ${v} `));
      expect(line, v).toBeDefined();
      expect(line, v).not.toContain('未发布');
    }
    expect(md).toContain('## f0.3+ — 2026-10-31（`8d6b4d1`，package 0.3.2）');
    expect(md).toContain('## f0.3.1 — 2026-10-31（`bd79bcb`，package 0.3.1）');
  });
});
