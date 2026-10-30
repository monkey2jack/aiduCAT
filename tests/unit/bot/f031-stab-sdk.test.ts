import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// f031-stab-#1: @larksuite/channel 0.6.0 → 0.7.1.
//  - 0.6.1 closes the old WS when a handshake fails (forceReconnect used to hang)
//  - 0.7.1 retries a reply whose trigger message was withdrawn (230011)
// 0.7.1 still fires throttled patches from a bare setTimeout, so the f0.3.1
// pnpm patch is redone on top of 0.7.1 (behaviour covered by
// sdk-card-stream-patch.test.ts).

const require = createRequire(import.meta.url);

function sdkDir(): string {
  // the package's "exports" hides package.json; walk up from the entry.
  let dir = dirname(require.resolve('@larksuite/channel'));
  while (!dir.endsWith('channel')) dir = dirname(dir);
  return dir;
}

describe('f031-stab-#1 @larksuite/channel upgrade', () => {
  it('f031-stab-#1 runs on @larksuite/channel 0.7.1', () => {
    const pkg = JSON.parse(readFileSync(join(sdkDir(), 'package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe('0.7.1');
  });

  it('f031-stab-#1 the throttle-failure patch is applied to both ESM and CJS builds', () => {
    for (const file of ['dist/index.mjs', 'dist/index.cjs']) {
      const src = readFileSync(join(sdkDir(), file), 'utf8');
      expect(src.match(/aiduCAT patch/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(src).toContain('this.doFire().catch(');
    }
  });

  it('f031-stab-#1 0.7.1 knows the withdrawn-trigger reply error (230011)', () => {
    const src = readFileSync(join(sdkDir(), 'dist/index.mjs'), 'utf8');
    expect(src).toContain('230011');
  });
});
