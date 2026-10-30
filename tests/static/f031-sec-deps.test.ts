import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('f031-sec-M5 vulnerable transitive deps are pinned to fixed versions', () => {
  it('f031-sec-M5 pnpm.overrides lift protobufjs/ws/follow-redirects/qs/@protobufjs/utf8 past the advisories', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    expect(pkg.pnpm?.overrides).toMatchObject({
      protobufjs: '^7.6.5',
      ws: '^8.21.0',
      'follow-redirects': '^1.16.1',
      qs: '^6.16.1',
      '@protobufjs/utf8': '^1.1.1',
    });
    const lock = readFileSync(join(__dirname, '../../pnpm-lock.yaml'), 'utf8');
    expect(lock).toMatch(/^overrides:\n(?:  .+\n)*  protobufjs: \^7\.6\.5/m);
  });
});
