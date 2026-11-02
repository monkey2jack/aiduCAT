import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

// f0.4 之后的修复 (bwrap): a non-owner run keeps its isolation
// (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1), and the empty placeholders Claude
// Code's sandbox drops into cwd are tidied away after the run — only the ones
// that run created and that are still empty.

const dirs: string[] = [];
const savedEnv = { ...process.env };
afterEach(async () => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A fake `claude` that behaves like 2.1.316's sandbox init: empty placeholders in cwd. */
async function setup(opts: { exitCode?: number; stderr?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'f04-bwrap-'));
  dirs.push(dir);
  const cwd = join(dir, 'ws');
  await mkdir(cwd);
  const configDir = join(dir, 'claude-config');
  await mkdir(configDir);
  await writeFile(join(configDir, 'settings.json'), JSON.stringify({ env: { GH_TOKEN: 'x' } }));
  const record = join(dir, 'record.json');
  const bin = join(dir, 'fake-claude.mjs');
  await writeFile(
    bin,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync, mkdirSync } from "node:fs";',
      'process.stdin.resume(); process.stdin.on("end", () => {',
      `  writeFileSync(${JSON.stringify(record)}, JSON.stringify({ scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ?? null }));`,
      '  for (const f of [".env", ".env.local", ".npmrc", "package.json", "yarn.lock", "bunfig.toml"]) { try { writeFileSync(f, "", { flag: "wx" }); } catch {} }',
      '  mkdirSync("node_modules/.bin", { recursive: true });',
      '  mkdirSync(".claude/agents", { recursive: true }); mkdirSync(".claude/commands", { recursive: true });',
      '  writeFileSync("notes.txt", "real work");',
      opts.exitCode
        ? `  process.stderr.write(${JSON.stringify(opts.stderr ?? 'boom')} + "\\n"); setTimeout(() => process.exit(${opts.exitCode}), 0);`
        : '  console.log(JSON.stringify({ type: "result", session_id: "s1" })); setTimeout(() => process.exit(0), 0);',
      '});',
    ].join('\n'),
  );
  await chmod(bin, 0o755);
  process.env.CLAUDE_CONFIG_DIR = configDir;
  return { dir, cwd, bin, record };
}

async function runOnce(bin: string, cwd: string, ownerRun: boolean): Promise<AgentEvent[]> {
  const run = new ClaudeAdapter({ binary: bin }).run({ runId: 'r', prompt: 'hi', cwd, ownerRun } as never);
  const out: AgentEvent[] = [];
  for await (const e of run.events) out.push(e);
  await run.waitForExit(2000);
  await new Promise((r) => setTimeout(r, 30));
  return out;
}

describe('f04-bwrap non-owner runs: isolation kept, sandbox placeholders tidied', () => {
  it('non-owner run: SCRUB stays on; new empty placeholders removed; real files and pre-existing ones kept', async () => {
    const { cwd, bin, record } = await setup();
    await writeFile(join(cwd, 'package.json'), '{"name":"mine"}'); // existed, has content
    await writeFile(join(cwd, '.env'), ''); // existed, empty — not ours to delete
    await mkdir(join(cwd, '.claude'));
    await runOnce(bin, cwd, false);

    expect(JSON.parse(await readFile(record, 'utf8')).scrub).toBe('1');
    const left = (await readdir(cwd)).sort();
    expect(left).toEqual(['.claude', '.env', 'notes.txt', 'package.json']);
    expect(await readFile(join(cwd, 'package.json'), 'utf8')).toBe('{"name":"mine"}');
  });

  it('non-owner run that fails to start still tidies up', async () => {
    const { cwd, bin } = await setup({ exitCode: 1, stderr: 'Claude Code could not start: bubblewrap is required' });
    const events = await runOnce(bin, cwd, false);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(existsSync(join(cwd, 'package.json'))).toBe(false);
    expect(existsSync(join(cwd, 'node_modules'))).toBe(false);
  });

  it('owner run: nothing is touched (no sandbox, no SCRUB)', async () => {
    const { cwd, bin, record } = await setup();
    await runOnce(bin, cwd, true);
    expect(JSON.parse(await readFile(record, 'utf8')).scrub).toBeNull();
    expect(existsSync(join(cwd, 'package.json'))).toBe(true);
    expect(existsSync(join(cwd, 'node_modules/.bin'))).toBe(true);
  });
});
