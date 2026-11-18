import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverDshLaunch,
  dshSearchSummary,
  isLaunchSpecUsable,
  resolveDshCommand,
} from '../../../src/agent/dsh/launch.js';

// f0.5++: DSH is found by probing, not by trusting one hand-written launcher.
// These tests pin the precedence order and the failure mode, because a wrong
// answer here means `agent-binary-not-found` on a fresh machine.

const cleanups: Array<() => void> = [];
const saved = { PATH: process.env.PATH, LARK_CHANNEL_DSH_BIN: process.env.LARK_CHANNEL_DSH_BIN };
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  process.env.PATH = saved.PATH;
  if (saved.LARK_CHANNEL_DSH_BIN === undefined) delete process.env.LARK_CHANNEL_DSH_BIN;
  else process.env.LARK_CHANNEL_DSH_BIN = saved.LARK_CHANNEL_DSH_BIN;
});

const dshName = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';

async function tmpBin(name = dshName): Promise<{ dir: string; file: string }> {
  const dir = await import('node:fs/promises').then((fs) => fs.mkdtemp(join(tmpdir(), 'dsh-launch-')));
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, '@echo off\r\n', 'utf8');
  cleanups.push(() => void rm(dir, { recursive: true, force: true }));
  return { dir, file };
}

describe('resolveDshCommand', () => {
  it('accepts an absolute path that exists and rejects one that does not', async () => {
    const { file } = await tmpBin();
    expect(resolveDshCommand(file)).toBe(file);
    expect(resolveDshCommand(join(tmpdir(), 'no-such-dsh-xyz'))).toBeUndefined();
  });

  it('finds a command on PATH', async () => {
    const { dir } = await tmpBin();
    process.env.PATH = `${dir}${process.platform === 'win32' ? ';' : ':'}${saved.PATH ?? ''}`;
    // Windows resolves extensions case-insensitively (PATHEXT gives `.CMD`).
    expect(resolveDshCommand('dsh')?.toLowerCase()).toBe(join(dir, dshName).toLowerCase());
  });

  it('returns undefined for an empty command', () => {
    expect(resolveDshCommand('   ')).toBeUndefined();
  });
});

describe('discoverDshLaunch', () => {
  it('lets an explicit dsh.binaryPath win over everything else', async () => {
    const configured = await tmpBin('custom-launcher.cmd');
    const onPath = await tmpBin();
    process.env.PATH = `${onPath.dir}${process.platform === 'win32' ? ';' : ':'}${saved.PATH ?? ''}`;
    process.env.LARK_CHANNEL_DSH_BIN = onPath.file;

    const launch = discoverDshLaunch(configured.file);
    expect(launch).toMatchObject({ command: configured.file, source: 'config', prefixArgs: [] });
  });

  it('falls back to LARK_CHANNEL_DSH_BIN when the configured path is stale', async () => {
    const env = await tmpBin('env-dsh.cmd');
    process.env.LARK_CHANNEL_DSH_BIN = env.file;
    const launch = discoverDshLaunch(join(tmpdir(), 'gone-dsh'));
    expect(launch).toMatchObject({ command: env.file, source: 'env' });
  });

  it('falls back to PATH when nothing is configured', async () => {
    const onPath = await tmpBin();
    process.env.PATH = `${onPath.dir}${process.platform === 'win32' ? ';' : ':'}${saved.PATH ?? ''}`;
    delete process.env.LARK_CHANNEL_DSH_BIN;
    const launch = discoverDshLaunch(undefined);
    expect(launch?.source).toBe('path');
    expect(launch?.command.toLowerCase()).toBe(join(onPath.dir, dshName).toLowerCase());
  });

  it('returns undefined (not a bogus path) when DSH is nowhere', () => {
    delete process.env.LARK_CHANNEL_DSH_BIN;
    process.env.PATH = join(tmpdir(), 'empty-path-for-dsh');
    // The Desktop install is a real directory on a developer machine, so this
    // assertion only holds where it is absent.
    const launch = discoverDshLaunch(join(tmpdir(), 'definitely-missing-dsh-binary'));
    if (launch) {
      expect(launch.source).toBe('desktop-app');
      expect(launch.env.ELECTRON_RUN_AS_NODE).toBe('1');
      expect(launch.prefixArgs).toHaveLength(2);
    } else {
      expect(launch).toBeUndefined();
    }
  });

  it('explains where it looked, for the not-found diagnostic', () => {
    const summary = dshSearchSummary();
    expect(summary).toContain('PATH');
    expect(summary).toContain('binaryPath');
  });
});

describe('isLaunchSpecUsable', () => {
  it('flags a launch whose CLI entry vanished', async () => {
    const { file } = await tmpBin();
    expect(isLaunchSpecUsable({ command: file, prefixArgs: [], env: {}, source: 'config', detail: '' })).toBe(true);
    expect(
      isLaunchSpecUsable({
        command: file,
        prefixArgs: ['--expose-internals', join(tmpdir(), 'missing-cli.js')],
        env: {},
        source: 'desktop-app',
        detail: '',
      }),
    ).toBe(false);
  });
});