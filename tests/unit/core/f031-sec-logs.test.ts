import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureLogger, closeLogger, flushLogger, log } from '../../../src/core/logger.js';
import { MediaCache } from '../../../src/media/cache.js';
import { writeFileAtomic } from '../../../src/platform/atomic-write.js';

const FAKE_SK = 'sk-' + 'proj-' + 'Q'.repeat(28);
const posix = process.platform !== 'win32';
let root = '';

describe('f031-sec-M4 / L8 private log + cache files, credential shapes masked', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'f031-sec-logs-'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeLogger();
    await rm(root, { recursive: true, force: true });
  });

  it.runIf(posix)('f031-sec-M4 logs dir is 0700 and log files 0600 (also tightens an existing 0755 dir)', async () => {
    const logsDir = join(root, 'profile', 'logs');
    await mkdir(logsDir, { recursive: true, mode: 0o755 });
    await chmod(logsDir, 0o755);
    configureLogger({ logsDir });
    log.warn('t', 'perm', { a: 1 });
    await flushLogger();
    expect((await stat(logsDir)).mode & 0o777).toBe(0o700);
    const [file] = await readdir(logsDir);
    expect((await stat(join(logsDir, file!))).mode & 0o777).toBe(0o600);
  });

  it('f031-sec-M4 log lines mask api_key / apiKey / password / sk-… shapes', async () => {
    const logsDir = join(root, 'logs');
    configureLogger({ logsDir });
    log.warn('agent', 'stderr', {
      line: `boom ANTHROPIC_API_KEY=${'k'.repeat(24)} api_key: ${'v'.repeat(20)} key ${FAKE_SK}`,
      apiKey: 'plain-api-key-value-123',
      api_key: 'snake-api-key-value-456',
      password: 'hunter2hunter2',
      nested: { providerApiKey: 'nested-key-value-789' },
    });
    await flushLogger();
    const [file] = await readdir(logsDir);
    const text = await readFile(join(logsDir, file!), 'utf8');
    for (const secret of ['k'.repeat(24), 'v'.repeat(20), FAKE_SK, 'plain-api-key-value-123', 'snake-api-key-value-456', 'hunter2hunter2', 'nested-key-value-789']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('boom');
  });

  it.runIf(posix)('f031-sec-M4 the data root created by an atomic config write is 0700', async () => {
    const home = join(root, 'fresh-home');
    await writeFileAtomic(join(home, 'config.json'), '{}\n', { mode: 0o600 });
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it.runIf(posix)('f031-sec-L8 media cache dir is 0700', async () => {
    const dir = join(root, 'media');
    const cache = new MediaCache({} as never, dir);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await cache.resolve([{ resource: { fileKey: 'fk', type: 'image' } } as never]).catch(() => []);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
});
