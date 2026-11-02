import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import pkg from '../../../package.json';

const read = (f: string) => readFile(new URL(`../../../${f}`, import.meta.url), 'utf8');

// f0.4+ (Wei 2026-11-02): Hermes Agent is the third agent; READMEs explain how
// to use it and compare gateway style (Hermes gateway + aiduPOP) with bridge style.
describe('f0.4+ Hermes docs (package 0.4.1)', () => {
  it('package 0.4.1', () => {
    expect(pkg.version).toBe('0.4.1');
  });

  it('zh READMEs: three agents per profile, setup, tested behaviour, gateway vs bridge, model gateway note', async () => {
    for (const f of ['README.md', 'README.zh.md']) {
      const md = await read(f);
      for (const s of [
        'Claude Code / Codex CLI / Hermes Agent',
        'badge/agent-Claude%20Code%20%7C%20Codex%20%7C%20Hermes-orange',
        '## Hermes Agent 接入（f0.4+）',
        'profile create hermes --agent hermes',
        'outsiderToolsets',
        'LARK_CHANNEL_HERMES_BIN',
        '600 秒',
        '/stop 只停卡片',
        '没有思考段',
        '--ignore-rules',
        '网关式',
        'bridge 式',
        'aiduPOP 继续维护',
        '不经过任何 agent 网关',
        '模型网关',
        '"hermes": false',
      ]) expect(md, `${f} ${s}`).toContain(s);
    }
  });

  it('en README carries the same Hermes section', async () => {
    const md = await read('README.en.md');
    for (const s of [
      'Claude Code / Codex CLI / Hermes Agent',
      'badge/agent-Claude%20Code%20%7C%20Codex%20%7C%20Hermes-orange',
      '## Hermes Agent (f0.4+)',
      'profile create hermes --agent hermes',
      'outsiderToolsets',
      '600 idle seconds',
      '/stop stops the card only',
      'No thinking section',
      '--ignore-rules',
      'Gateway style',
      'Bridge style',
      'aiduPOP stays maintained',
      'no agent gateway',
      'model gateway',
      '"hermes": false',
    ]) expect(md, s).toContain(s);
  });

  it('CHANGELOG f0.4+ section: Hermes highlight first, post-f0.4 fixes merged in', async () => {
    const md = await read('CHANGELOG.md');
    const section = md.slice(md.indexOf('\n## f0.4+ '), md.indexOf('\n## f0.4 '));
    const highlight = section.indexOf('### 亮点：Hermes Agent');
    const fixes = section.indexOf('### 并入 f0.4 之后的修复');
    expect(highlight).toBeGreaterThan(0);
    expect(fixes).toBeGreaterThan(highlight);
    for (const s of ['--agent hermes', '--yolo', '-t todo --ignore-rules', '/stop', '--source tool', 'chatAllowAllUsers', 'outsiderDenyRead', 'bubblewrap']) {
      expect(section, s).toContain(s);
    }
    // the fixes moved, not copied
    const f04 = md.slice(md.indexOf('\n## f0.4 '), md.indexOf('\n## f0.3+ '));
    expect(f04).not.toContain('之后的修复');
  });
});
