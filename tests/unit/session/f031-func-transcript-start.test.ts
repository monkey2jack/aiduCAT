import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transcriptStartedAt } from '../../../src/session/history.js';

describe('f031-func-#2 transcriptStartedAt', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'f031-func-tx-'));
    process.env.CLAUDE_CONFIG_DIR = dir;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  });

  it('f031-func-#2 reads the first timestamped line, prefers the cwd project dir', async () => {
    const cwd = '/data/home/work';
    const p = join(dir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    await mkdir(p, { recursive: true });
    await writeFile(join(p, 'abc-1.jsonl'), '{"type":"x"}\nnot json\n{"timestamp":"2026-10-28T10:15:00Z"}\n');
    expect(await transcriptStartedAt('abc-1', cwd)).toBe(Date.parse('2026-10-28T10:15:00Z'));
  });

  it('f031-func-#2 missing transcript / unsafe id → undefined', async () => {
    expect(await transcriptStartedAt('nope')).toBeUndefined();
    expect(await transcriptStartedAt('../../etc/passwd')).toBeUndefined();
    expect(await transcriptStartedAt(undefined)).toBeUndefined();
  });
});
