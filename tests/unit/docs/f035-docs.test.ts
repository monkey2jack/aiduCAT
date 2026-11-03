import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import pkg from '../../../package.json';

const read = (f: string) => readFile(new URL(`../../../${f}`, import.meta.url), 'utf8');
const READMES = ['README.md', 'README.zh.md', 'README.en.md'];

describe('f035 version f0.3.5 (package 0.3.5) docs', () => {
  it('f035 package moved past 0.3.5 (now 0.4.2) and no README still carries the f0.3.5 badge', async () => {
    expect(pkg.version).toBe('0.4.2');
    for (const f of READMES) expect(await read(f), f).not.toContain('badge/version-f0.3.5-blue');
  });

  it('f035 (merged into f0.4) the f0.4 section covers TPS, group cards and the 1M alignment', async () => {
    const md = await read('CHANGELOG.md');
    const start = md.indexOf('## f0.4 ');
    const prev = md.indexOf('## f0.3+ ');
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(prev);
    const section = md.slice(start, prev);
    for (const s of ['0.3.5', 'TPS', 'duration_api_ms', '群', '面板', 'showToolCallsInGroups', '1000000', '☤aiduCATing…', '表情']) expect(section).toContain(s);
  });

  it('f035 READMEs say groups get the panel card', async () => {
    for (const f of READMES) expect(await read(f), f).toMatch(/showToolCallsInGroups/);
  });
});
