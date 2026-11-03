import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import pkg from '../../../package.json';

const read = (f: string) => readFile(new URL(`../../../${f}`, import.meta.url), 'utf8');
const READMES = ['README.md', 'README.zh.md', 'README.en.md'];

// f0.4 (Wei 2026-11-02): 0.3.3–0.3.6 were never tagged; they ship together as one release.
describe('f04 version f0.4 docs (f0.4+ / package 0.4.2 on top since 2026-11-02)', () => {
  it('f04 package 0.4.2 and every README carries the f0.4+ badge', async () => {
    expect(pkg.version).toBe('0.4.2');
    for (const f of READMES) {
      const md = await read(f);
      expect(md, f).toContain('badge/version-f0.4%2B%2B-blue');
      expect(md, f).not.toContain('badge/version-f0.4-blue');
      expect(md, f).not.toMatch(/badge\/version-f0\.3/);
    }
  });

  it('f04 CHANGELOG: f0.4+ on top, then one f0.4 section right above f0.3+, with no separate 0.3.3–0.3.6 sections', async () => {
    const md = await read('CHANGELOG.md');
    const headers = md.split('\n').filter((l) => l.startsWith('## '));
    expect(headers[0]).toBe('## f0.4++ — 2026-11-04（package 0.4.2）');
    expect(headers[1]).toBe('## f0.4+ — 2026-11-02（package 0.4.1）');
    expect(headers[2]).toBe('## f0.4 — 2026-11-02（package 0.4.0）');
    expect(headers[3]).toMatch(/^## f0\.3\+ — 2026-10-31/);
    for (const v of ['f0.3.3', 'f0.3.4', 'f0.3.5', 'f0.3.6']) expect(md).not.toContain(`## ${v} `);
    expect(md).not.toContain('tag 未打');
    expect(md).not.toContain('未发布');
  });

  it('f04 the f0.4 section names every merged change', async () => {
    const md = await read('CHANGELOG.md');
    const section = md.slice(md.indexOf('## f0.4 '), md.indexOf('## f0.3+ '));
    for (const s of [
      'aiduPARK', // logo rule
      '/api/combos', '预热', // combos only + background refresh + prewarm
      'atMs', 'sinceMsgMs', // ms latency logs
      'settings.json', '1M', // window follows settings.json
      '有效生成时间', '/status', // TPS
      '群聊', 'showToolCallsInGroups', '真 @', // group cards
      '☤aiduCATing…', '表情', '面板', // placeholder card, no reaction, panel on first output
      '各自一张卡', '撤回', // queued cards, recalled placeholders
      '--profile claude', '--profile xiaohou', // two-profile setup
    ]) expect(section, s).toContain(s);
  });

  it('f04 READMEs: f0.4+ changelog summary, then f0.4, then f0.3+', async () => {
    for (const f of READMES) {
      const md = await read(f);
      const h = f === 'README.en.md' ? '## Changelog (f0.4++)' : '## 更新日志（f0.4++）';
      const i = md.indexOf(h);
      expect(i, f).toBeGreaterThan(0);
      const j = md.indexOf('### f0.4\n', i);
      expect(j, f).toBeGreaterThan(i);
      expect(md.indexOf('### f0.3+', j), f).toBeGreaterThan(j);
    }
  });
});
