import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { maskConsoleUrl } from '../../../src/ui/console-url';

describe('f031-sec-M2 console URL never leaves the terminal with its token', () => {
  it('f031-sec-M2 maskConsoleUrl drops the token query', () => {
    expect(maskConsoleUrl('http://127.0.0.1:53219/?token=abcdef0123')).toBe('http://127.0.0.1:53219/');
    expect(maskConsoleUrl('not a url ?token=abc')).not.toContain('abc');
  });

  it('f031-sec-M2 start.ts (daemon stdout → journald) prints only the masked URL', () => {
    const src = readFileSync(join(__dirname, '../../../src/cli/commands/start.ts'), 'utf8');
    expect(src).not.toMatch(/\$\{(uiServer|sidecar)\.url\}/);
    expect(src).toContain('maskConsoleUrl(uiServer.url)');
  });
});
