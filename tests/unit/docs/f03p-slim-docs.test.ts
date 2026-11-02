import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import pkg from '../../../package.json';

const read = (f: string) => readFile(new URL(`../../../${f}`, import.meta.url), 'utf8');
const READMES = ['README.md', 'README.zh.md', 'README.en.md'];

describe('f03p-slim-#9 version f0.3+ (package 0.3.2) docs', () => {
  it('f03p-slim-#9 package moved past 0.3.2 (now 0.4.1) and no README still carries the f0.3+ / f0.3.1 badge', async () => {
    expect(pkg.version).toBe('0.4.1');
    for (const f of READMES) {
      const md = await read(f);
      // shields.io: `+` must be URL-encoded inside the badge path
      expect(md, f).not.toContain('badge/version-f0.3%2B-blue');
      expect(md, f).not.toContain('badge/version-f0.3.1-blue');
    }
  });

  it('f03p-slim-#9 READMEs document the features switches', async () => {
    for (const f of READMES) {
      const md = await read(f);
      expect(md, f).toContain('"features"');
      for (const k of ['meeting', 'webConsole', 'codex', 'cot']) expect(md, f).toContain(`"${k}"`);
      expect(md, f).toContain('此功能未开启');
    }
  });

  it('f03p-slim-#9 CHANGELOG has an f0.3+ section (Y and X, by-design notes)', async () => {
    const md = await read('CHANGELOG.md');
    const start = md.indexOf('## f0.3+ ');
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(md.indexOf('## f0.3.1 '));
    const section = md.slice(start, md.indexOf('## f0.3.1 '));
    for (const s of ['features', '此功能未开启', 'unrecognized_model', '0.3.2']) expect(section).toContain(s);
    for (const x of ['优雅重启', '自动续跑', '~/.aiducat', 'owner', '0700', '/cd']) expect(section).toContain(x);
    expect(section).toContain('keystore');
    expect(section).toContain('aiduCAT ui');
    expect(section).toContain('设计如此');
  });

  it('f03p-slim-#10 the old wrong-tag note now says it was fixed on 2026-10-31', async () => {
    const md = await read('CHANGELOG.md');
    expect(md).toContain('已于 2026-10-31 修正');
    expect(md).not.toContain('待维护者决定');
  });
});
