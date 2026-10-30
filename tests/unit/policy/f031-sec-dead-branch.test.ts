import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('f031-sec-L6 no hard-coded comment access bypass is left behind', () => {
  it("f031-sec-L6 'comment-mention' (the old always-ok comment access) is gone from src", () => {
    const hits = walk(join(__dirname, '../../../src')).filter((f) =>
      readFileSync(f, 'utf8').includes('comment-mention'),
    );
    expect(hits).toEqual([]);
  });
});
