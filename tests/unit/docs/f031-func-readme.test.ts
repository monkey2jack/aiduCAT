import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { REGISTERED_COMMANDS } from '../../../src/commands/index.js';
import pkg from '../../../package.json';

const read = (f: string) => readFile(new URL(`../../../${f}`, import.meta.url), 'utf8');
const READMES = ['README.md', 'README.zh.md', 'README.en.md'];

describe('f031-func-#5 READMEs + CHANGELOG match the code', () => {
  it('f031-func-#5 all three READMEs carry the current badge (f0.5, package 0.5.0)', async () => {
    expect(pkg.version).toBe('0.5.0');
    for (const f of READMES) {
      const md = await read(f);
      expect(md, f).toContain('badge/version-f0.5-blue');
      expect(md, f).not.toMatch(/badge\/version-f0\.(1|2)/);
    }
  });

  it('f031-func-#5 every registered slash command is in each README command table', async () => {
    for (const f of READMES) {
      const md = await read(f);
      for (const cmd of REGISTERED_COMMANDS) expect(md, `${f} ${cmd}`).toMatch(new RegExp(`\\| \`${cmd}[\` ]`));
    }
  });

  it('f031-func-#5 quick start uses pnpm + the real entry, not `npm run dev -- run`', async () => {
    for (const f of READMES) {
      const md = await read(f);
      expect(md, f).toContain('pnpm install --frozen-lockfile');
      expect(md, f).toContain('node bin/lark-channel-bridge.mjs run');
      expect(md, f).not.toContain('npm run dev -- run');
      expect(md, f).not.toContain('npm install && npm run build');
      // stale card anatomy (removed two-line header) must be gone
      expect(md, f).not.toContain('💭Reasoning...');
    }
  });

  it('f031-func-#5 README.zh.md is the same document as README.md', async () => {
    expect(await read('README.zh.md')).toBe(await read('README.md'));
  });

  it('f031-func-#5 CHANGELOG.md exists and covers f0.1 → f0.4+', async () => {
    const md = await read('CHANGELOG.md');
    for (const v of ['f0.4+', 'f0.4', 'f0.3+', 'f0.3.1', 'f0.3', 'f0.2++', 'f0.2+', 'f0.2', 'f0.1+', 'f0.1']) {
      expect(md).toContain(`## ${v} `);
    }
  });
});
