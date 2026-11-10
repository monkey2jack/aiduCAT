import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

// f03p-infra-#2: tokens in ~/.claude/settings.json `env` reach only runs the
// owner started. Key names below are the real summer settings.json keys
// (values are fake sentinels — the test asserts no value ever leaves the file).
const SETTINGS_ENV = {
  AIDU_10ROUTER_TOKEN: 'SENTINEL_router',
  AIDU_10R_TOKYO_KEY: 'SENTINEL_tokyo',
  ANTHROPIC_API_KEY: 'SENTINEL_anthropic',
  ANTHROPIC_BASE_URL: 'https://gw.example',
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000',
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
  CLOUDFLARE_ACCOUNT_ID: 'SENTINEL_cfacct',
  CLOUDFLARE_API_TOKEN: 'SENTINEL_cf',
  DISABLE_AUTOUPDATER: '1',
  GH_TOKEN: 'SENTINEL_gh',
  GITHUB_TOKEN: 'SENTINEL_github',
};

const dirs: string[] = [];
const savedEnv = { ...process.env };
afterEach(async () => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(): Promise<{ dir: string; bin: string; record: string; configDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'f03p-owner-'));
  dirs.push(dir);
  const configDir = join(dir, 'claude-config');
  await mkdir(configDir);
  await writeFile(join(configDir, 'settings.json'), JSON.stringify({ env: SETTINGS_ENV, hooks: {} }));
  const record = join(dir, 'record.json');
  const bin = join(dir, 'fake-claude.mjs');
  await writeFile(
    bin,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync, readFileSync } from "node:fs";',
      'const argv = process.argv.slice(2);',
      'const i = argv.indexOf("--settings");',
      'const settings = i !== -1 ? readFileSync(argv[i + 1], "utf8") : null;',
      // f0.5 之后 (steer): stdin stays open — answer on the first stream-json line.
      'process.stdin.once("data", () => {',
      `  writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, settings, env: { ...process.env } }));`,
      '  console.log(JSON.stringify({ type: "result", session_id: "s1" }));',
      '  setTimeout(() => process.exit(0), 0);',
      '});',
    ].join('\n'),
  );
  await chmod(bin, 0o755);
  process.env.CLAUDE_CONFIG_DIR = configDir;
  return { dir, bin, record, configDir };
}

async function runOnce(bin: string, cwd: string, extra: Record<string, unknown>): Promise<void> {
  const run = new ClaudeAdapter({ binary: bin, envPassthrough: ['SSH_AUTH_SOCK'] }).run({
    runId: 'r',
    prompt: 'hi',
    cwd,
    sessionId: 'sess-1',
    ...extra,
  } as never);
  const out: AgentEvent[] = [];
  for await (const e of run.events) out.push(e);
}

describe('f03p-infra-#2 settings.json tokens are owner-only', () => {
  it('f03p-infra-#2 owner run: argv and env exactly as before (no --settings, passthrough kept)', async () => {
    const { dir, bin, record } = await setup();
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    await runOnce(bin, dir, { ownerRun: true });
    const rec = JSON.parse(await readFile(record, 'utf8'));
    expect(rec.argv).not.toContain('--settings');
    expect(rec.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    expect(rec.env.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
    expect(rec.argv.slice(-2)).toEqual(['--resume', 'sess-1']);
  });

  it('f03p-infra-#2 non-owner run: --settings blanks the tokens, scrubs subprocess env, denies reading the settings file', async () => {
    const { dir, bin, record, configDir } = await setup();
    await runOnce(bin, dir, { ownerRun: false });
    const rec = JSON.parse(await readFile(record, 'utf8'));
    const i = rec.argv.indexOf('--settings');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(rec.argv.indexOf('--resume'));
    const settings = JSON.parse(rec.settings);
    expect(settings.env).toEqual({
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      GH_ENTERPRISE_TOKEN: '',
      GITHUB_ENTERPRISE_TOKEN: '',
      AIDU_10ROUTER_TOKEN: '',
      AIDU_10R_TOKYO_KEY: '',
      CLOUDFLARE_ACCOUNT_ID: '',
      CLOUDFLARE_API_TOKEN: '',
    });
    // Claude's own gateway credentials stay (it could not answer otherwise);
    // the scrub keeps them out of Bash/hooks/MCP.
    expect(settings.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(settings.env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    expect(settings.env).not.toHaveProperty('DISABLE_AUTOUPDATER');
    expect(settings.permissions.deny).toContain(`Read(/${join(configDir, 'settings.json')})`);
    expect(settings.permissions.deny).toContain(`Edit(/${join(configDir, 'settings.json')})`);
    expect(rec.settings).not.toContain('SENTINEL');
    expect(rec.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
  });

  it('f03p-infra-#2 fail-closed: a run that does not say it is the owner\'s is treated as non-owner', async () => {
    const { dir, bin, record } = await setup();
    await runOnce(bin, dir, {});
    const rec = JSON.parse(await readFile(record, 'utf8'));
    expect(rec.argv).toContain('--settings');
  });

  it('f03p-infra-#2 non-owner run: owner passthrough (SSH agent etc.) is not handed over', async () => {
    const { dir, bin, record } = await setup();
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    await runOnce(bin, dir, { ownerRun: false });
    const rec = JSON.parse(await readFile(record, 'utf8'));
    expect(rec.env.SSH_AUTH_SOCK).toBeUndefined();
  });

  it('f03p-infra-#2 the temp settings file is gone after the run', async () => {
    const { dir, bin, record } = await setup();
    await runOnce(bin, dir, { ownerRun: false });
    const rec = JSON.parse(await readFile(record, 'utf8'));
    const path = rec.argv[rec.argv.indexOf('--settings') + 1];
    await new Promise((r) => setTimeout(r, 100));
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });
});
