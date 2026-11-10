import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';

// f04 C (Wei 11:52): a non-owner run gets the settings that let it work
// (sandboxed Bash, read/write inside cwd) on top of the f03p isolation; the
// owner's run is spawned exactly as before (no --settings, no sandbox).

const dirs: string[] = [];
const savedEnv = { ...process.env };
afterEach(async () => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'f04-tools-'));
  dirs.push(dir);
  const cwd = join(dir, 'ws');
  await mkdir(cwd);
  const configDir = join(dir, 'claude-config');
  await mkdir(configDir);
  await writeFile(join(configDir, 'settings.json'), JSON.stringify({ env: { AIDU_X_TOKEN: 'v' } }));
  const record = join(dir, 'record.json');
  const bin = join(dir, 'fake-claude.mjs');
  await writeFile(
    bin,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync, readFileSync } from "node:fs";',
      'const argv = process.argv.slice(2);',
      'const i = argv.indexOf("--settings");',
      'const settings = i >= 0 ? JSON.parse(readFileSync(argv[i + 1], "utf8")) : null;',
      // f0.5 之后 (steer): stdin stays open — answer on the first stream-json line.
      'process.stdin.once("data", () => {',
      `  writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, settings }));`,
      '  console.log(JSON.stringify({ type: "result", session_id: "s1" })); setTimeout(() => process.exit(0), 0);',
      '});',
    ].join('\n'),
  );
  await chmod(bin, 0o755);
  process.env.CLAUDE_CONFIG_DIR = configDir;
  return { cwd, bin, record };
}

async function runOnce(bin: string, cwd: string, ownerRun: boolean, outsiderDenyRead?: string[]) {
  const run = new ClaudeAdapter({ binary: bin, outsiderDenyRead }).run({ runId: 'r', prompt: 'hi', cwd, ownerRun } as never);
  for await (const _e of run.events) { /* drain */ }
  await run.waitForExit(2000);
}

describe('f04 C non-owner tools', () => {
  it('non-owner: allow rules scoped to cwd, sandboxed Bash, secrets denied, scrub kept', async () => {
    const { cwd, bin, record } = await setup();
    await runOnce(bin, cwd, false);
    const { settings } = JSON.parse(await readFile(record, 'utf8'));
    expect(settings.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
    expect(settings.env.AIDU_X_TOKEN).toBe('');
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(['Bash', `Edit(/${cwd}/**)`, `Write(/${cwd}/**)`]));
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        `Read(/${resolve(join(cwd, '.claude', 'settings.json'))})`,
        `Edit(/${resolve(join(cwd, 'CLAUDE.md'))})`,
        'Read(//proc/**)',
      ]),
    );
    expect(settings.sandbox).toEqual({ enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false });
    // Wei 12:43: sandboxed Bash reaches the internet like a normal agent.
    expect(settings.permissions.allow).toContain('WebFetch(domain:*)');
  });

  it('profile outsiderDenyRead reaches the non-owner settings; owner still gets none', async () => {
    const { cwd, bin, record } = await setup();
    const secret = join(cwd, '..', 'secret-notes.md');
    await writeFile(secret, 'x');
    await runOnce(bin, cwd, false, [secret]);
    const { settings } = JSON.parse(await readFile(record, 'utf8'));
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        `Read(/${resolve(secret)})`,
        `Read(/${resolve(secret)}/**)`,
      ]),
    );
    await runOnce(bin, cwd, true, [secret]);
    const owner = JSON.parse(await readFile(record, 'utf8'));
    expect(owner.settings).toBeNull();
  });

  it('owner: no --settings at all (unchanged)', async () => {
    const { cwd, bin, record } = await setup();
    await runOnce(bin, cwd, true);
    const { argv, settings } = JSON.parse(await readFile(record, 'utf8'));
    expect(settings).toBeNull();
    expect(argv).not.toContain('--settings');
  });
});
