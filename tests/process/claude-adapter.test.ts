import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

describe('ClaudeAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh run with stream-json, verbose, permission mode, and bridge prompt args', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-fresh' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-fresh',
      prompt: 'hello',
      cwd: fake.dir,
      permissionMode: 'acceptEdits',
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 'sess-fresh', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(await realpath(fake.dir));
    expect(record.env.LARK_CHANNEL).toBe('1');
    // The prompt goes via stdin, and the bridge system prompt via a temp file,
    // so neither ever touches argv (which cmd.exe would mangle on Windows).
    expect(record.stdin).toBe(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } })}\n`,
    );
    expect(record.argv.slice(0, 11)).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--replay-user-messages',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--append-system-prompt-file',
    ]);
    expect(record.argv).not.toContain('hello');
    expect(record.systemPrompt).toContain('aiduCAT 运行约定');
    expect(record.systemPrompt).toContain('__bridge_cb');
    expect(record.systemPrompt).toContain('LARK_CHANNEL_PROFILE');
    expect(record.systemPrompt).toContain('LARKSUITE_CLI_CONFIG_DIR');
    expect(record.systemPrompt).not.toContain('lark-cli config bind --source lark-channel');
    expect(record.systemPrompt).not.toContain('__claude_cb');
    expect(record.argv).not.toContain('--resume');
    expect(record.argv).not.toContain('--model');
  });

  it('prod 2026-11-08: an empty result (queued task-notification) does not end the turn when claude goes on', async () => {
    const fake = await createFakeClaude({
      lines: [
        { type: 'result', session_id: 'sess-n' },
        { type: 'assistant', message: { model: 'gemini', content: [{ type: 'text', text: 'real answer' }] } },
        { type: 'result', session_id: 'sess-n' },
      ],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-notify',
      prompt: 'hello',
      cwd: fake.dir,
      permissionMode: 'acceptEdits',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'real answer' },
      { type: 'done', sessionId: 'sess-n', terminationReason: 'normal' },
    ]);
  });

  it('f0.5 之后 steer: a message written mid-turn is taken in and the same turn goes on', async () => {
    const fake = await createInteractiveFake('mid');
    cleanup.push(fake.dir);
    const run = new ClaudeAdapter({ binary: fake.path }).run({ runId: 'run-steer', prompt: 'first', cwd: fake.dir });
    const seen: AgentEvent[] = [];
    for await (const evt of run.events) {
      seen.push(evt);
      if (evt.type === 'tool_use') expect(run.steer?.('second')).toBe(true);
    }
    expect(seen).toEqual([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 1' } },
      { type: 'tool_result', id: 't1', output: 'ok', isError: false },
      { type: 'steer' },
      { type: 'text', delta: 'got: second' },
      { type: 'done', sessionId: 's-mid', terminationReason: 'normal' },
    ]);
    expect(run.steer?.('too late')).toBe(false);
  });

  it('f0.5 之后 steer: a message that misses the turn becomes the next turn in the same process (no early done)', async () => {
    const fake = await createInteractiveFake('late');
    cleanup.push(fake.dir);
    const run = new ClaudeAdapter({ binary: fake.path }).run({ runId: 'run-late', prompt: 'first', cwd: fake.dir });
    const seen: AgentEvent[] = [];
    for await (const evt of run.events) {
      seen.push(evt);
      if (evt.type === 'text' && evt.delta === 'answer 1') expect(run.steer?.('second')).toBe(true);
    }
    expect(seen).toEqual([
      { type: 'text', delta: 'answer 1' },
      { type: 'steer' },
      { type: 'text', delta: 'answer 2' },
      { type: 'done', sessionId: 's-late', terminationReason: 'normal' },
    ]);
  });

  it('f0.5 之后 steer: with nothing written, stdin closes at the result and the run ends as before', async () => {
    const fake = await createInteractiveFake('late');
    cleanup.push(fake.dir);
    const run = new ClaudeAdapter({ binary: fake.path }).run({ runId: 'run-plain', prompt: 'first', cwd: fake.dir });
    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'answer 1' },
      { type: 'done', sessionId: 's-late', terminationReason: 'normal' },
    ]);
    expect(await run.waitForExit(2000)).toBe(true);
  });

  it('injects the active bridge profile env into spawned runs', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-profile' }],
    });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const larkCliConfigDir = join(rootDir, 'profiles', 'codex-dev', 'lark-cli');
    const larkCliSourceConfigFile = join(rootDir, 'profiles', 'codex-dev', 'lark-cli-source', 'config.json');

    const run = new ClaudeAdapter({
      binary: fake.path,
      larkChannel: {
        profile: 'codex-dev',
        rootDir,
        configPath,
        larkCliConfigDir,
        larkCliSourceConfigFile,
      },
    }).run({
      runId: 'run-profile-env',
      prompt: 'profile',
      cwd: fake.dir,
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);

    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'codex-dev',
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
    });
  });

  it('f031-sec-#4 spawns with an allowlisted env: no daemon secrets, no bridge config.json', async () => {
    const fake = await createFakeClaude({ lines: [{ type: 'result', session_id: 'sess-env' }] });
    cleanup.push(fake.dir);
    const saved = { ...process.env };
    process.env.GH_TOKEN = 'ghp_fake_daemon_secret';
    process.env.AIDU_10ROUTER_TOKEN = 'fake-router-token';
    process.env.OPENAI_API_KEY = 'fake-openai';
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example';
    process.env.MY_PASSTHROUGH = 'kept';
    try {
      const rootDir = join(fake.dir, 'channel-home');
      const run = new ClaudeAdapter({
        binary: fake.path,
        larkChannel: { profile: 'claude', rootDir, configPath: join(rootDir, 'config.json') },
        envPassthrough: ['MY_PASSTHROUGH'],
      } as ConstructorParameters<typeof ClaudeAdapter>[0]).run({
        runId: 'run-env',
        prompt: 'env',
        cwd: fake.dir,
        // f03p-infra-#2: passthrough is for the owner's runs.
        ownerRun: true,
      });
      await collect(run.events);
      const record = await readRecord(fake.recordPath);
      expect(record.env.GH_TOKEN).toBeUndefined();
      expect(record.env.AIDU_10ROUTER_TOKEN).toBeUndefined();
      expect(record.env.OPENAI_API_KEY).toBeUndefined();
      expect(record.env.LARK_CHANNEL_CONFIG).toBeUndefined();
      expect(record.env.ANTHROPIC_BASE_URL).toBe('https://gw.example');
      expect(record.env.MY_PASSTHROUGH).toBe('kept');
      expect(record.env.PATH).toBe(process.env.PATH);
      expect(record.env.LARK_CHANNEL).toBe('1');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('passes resume and model after the base CLI contract', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-resumed' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd: fake.dir,
      sessionId: 'sess-old',
      model: 'sonnet',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 'sess-resumed', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(record.argv.slice(-4)).toEqual(['--resume', 'sess-old', '--model', 'sonnet']);
    // f031-sec-#1: no policy → fail closed (the CLI's own prompting mode), never bypass.
    expect(record.argv[9]).toBe('default');
  });

  it('includes stderr when the process exits non-zero', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'before failure' }] } }],
      stderr: 'boom\n',
      exitCode: 42,
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure' },
      {
        type: 'error',
        message: 'claude exited with code 42: boom',
        terminationReason: 'failed',
      },
    ]);
  });

  it('surfaces spawn errors as stream error events', async () => {
    let run: ReturnType<ClaudeAdapter['run']>;
    if (process.platform === 'win32') {
      const fake = await createFakeClaude({
        lines: [],
        stderr: 'missing command\n',
        exitCode: 1,
      });
      cleanup.push(fake.dir);
      run = new ClaudeAdapter({ binary: fake.path }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: fake.dir,
      });
    } else {
      const missing = join(tmpdir(), `missing-claude-${Date.now()}`);
      run = new ClaudeAdapter({ binary: missing }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: tmpdir(),
      });
    }

    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn claude|spawn returned no pid|claude exited with code/,
    );
  });

  it('waits for post-done process exit before stop fallback is needed', async () => {
    const fake = await createFakeClaude({
      // A turn with output: its done is not held (see hold-empty-done.ts).
      lines: [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
        { type: 'result', session_id: 'sess-tail' },
      ],
      exitDelayMs: 150,
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-tail',
      prompt: 'tail',
      cwd: fake.dir,
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ done: false, value: { type: 'text', delta: 'ok' } });
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', sessionId: 'sess-tail', terminationReason: 'normal' },
    });
    expect(await run.waitForExit(10)).toBe(false);
    expect(await run.waitForExit(1_000)).toBe(true);
    await iterator.return?.();
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new ClaudeAdapter({ binary: 'unused' }).run({ runId: 'run-no-cwd', prompt: 'hi' }),
    ).toThrow(/cwd is required/);
  });

  it('finishes after the CLI exits even if a descendant holds stdout open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-exit-holder-'));
    cleanup.push(dir);
    const bin = join(dir, 'fake-claude.mjs');
    await writeFile(bin, [
      '#!/usr/bin/env node',
      'import { spawn } from "node:child_process";',
      'console.log(JSON.stringify({ type: "system", subtype: "init" }));',
      'const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 6500)"], { stdio: ["ignore", "inherit", "ignore"] });',
      'holder.unref();',
      'setTimeout(() => process.exit(1), 150);',
    ].join('\n'));
    await chmod(bin, 0o755);
    const run = new ClaudeAdapter({ binary: bin }).run({ runId: 'exit-holder', prompt: 'hello', cwd: dir });
    const events = collect(run.events);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        events,
        new Promise<'timed-out'>((resolve) => { timeout = setTimeout(() => resolve('timed-out'), 4000); }),
      ]);
      expect(result).not.toBe('timed-out');
      if (result !== 'timed-out') expect(result.some((event) => event.type === 'error')).toBe(true);
    } finally {
      if (timeout) clearTimeout(timeout);
      await events;
    }
  }, 12_000);

  it('reports an error when the CLI exits successfully without a result', async () => {
    const fake = await createFakeClaude({ lines: [{ type: 'system', subtype: 'init' }] });
    cleanup.push(fake.dir);
    const run = new ClaudeAdapter({ binary: fake.path }).run({ runId: 'no-result', prompt: 'hello', cwd: fake.dir });
    expect(await collect(run.events)).toContainEqual({
      type: 'error', message: 'claude exited without a result event', terminationReason: 'failed',
    });
  });

  it('keeps buffered answer events when the consumer is slow after CLI exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-buffered-exit-'));
    cleanup.push(dir);
    const bin = join(dir, 'fake-claude.mjs');
    await writeFile(bin, [
      '#!/usr/bin/env node',
      'import { spawn } from "node:child_process";',
      'const out = (event) => console.log(JSON.stringify(event));',
      'out({ type: "system", subtype: "init", session_id: "slow" });',
      'out({ type: "assistant", message: { content: [{ type: "text", text: "complete answer" }] } });',
      'out({ type: "result", session_id: "slow" });',
      'const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 6500)"], { stdio: ["ignore", "inherit", "ignore"] });',
      'holder.unref();',
      'setTimeout(() => process.exit(0), 150);',
    ].join('\n'));
    await chmod(bin, 0o755);
    const run = new ClaudeAdapter({ binary: bin }).run({ runId: 'slow-consumer', prompt: 'hello', cwd: dir });
    const iterator = run.events[Symbol.asyncIterator]();
    const first = await iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 2600));
    const out: AgentEvent[] = first.done ? [] : [first.value];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      out.push(next.value);
    }
    expect(out).toContainEqual({ type: 'text', delta: 'complete answer' });
    expect(out.some((event) => event.type === 'done')).toBe(true);
  }, 12_000);
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeClaude(options: {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-adapter-test-'));
  const path = join(dir, 'fake-claude.mjs');
  const recordPath = join(dir, 'argv.json');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync, readFileSync } from "node:fs";',
      'const argv = process.argv.slice(2);',
      'const spIdx = argv.indexOf("--append-system-prompt-file");',
      'const systemPrompt = spIdx !== -1 ? readFileSync(argv[spIdx + 1], "utf8") : null;',
      'let stdin = "";',
      'let started = false;',
      // f0.5 之后 (steer): stdin stays open — answer on the first stream-json line.
      'process.stdin.on("data", (c) => { stdin += c; if (started || !stdin.includes("\\n")) return; started = true; go(); });',
      'function go() {',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '    argv,',
      '    stdin,',
      '    systemPrompt,',
      '    cwd: process.cwd(),',
      '    env: { ...process.env },',
      '  }));',
      `  const lines = ${JSON.stringify(options.lines)};`,
      '  for (const line of lines) console.log(JSON.stringify(line));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `  setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
      '}',
    ].filter(Boolean).join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

/**
 * f0.5 之后 (steer): a fake claude that reads stream-json user lines, echoes
 * each (isReplay, like --replay-user-messages) and answers like CC 2.1.319:
 * `mid` — the second line is taken in after the tool call, same turn;
 * `late` — the turn ends first, the second line becomes the next turn.
 */
async function createInteractiveFake(kind: 'mid' | 'late'): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-steer-test-'));
  const path = join(dir, 'fake-claude.mjs');
  const src = [
    '#!/usr/bin/env node',
    'import { createInterface } from "node:readline";',
    `const kind = ${JSON.stringify(kind)};`,
    'const out = (o) => console.log(JSON.stringify(o));',
    'const lines = [];',
    'let wake;',
    'const next = () => new Promise((r) => { if (lines.length) r(lines.shift()); else wake = r; });',
    'const rl = createInterface({ input: process.stdin });',
    'rl.on("line", (l) => { if (wake) { const w = wake; wake = undefined; w(l); } else lines.push(l); });',
    'rl.on("close", () => { if (wake) wake(null); else lines.push(null); });',
    'const echo = (l) => { const m = JSON.parse(l); out({ type: "user", isReplay: true, message: m.message }); return m.message.content[0].text; };',
    'const sid = "s-" + kind;',
    '(async () => {',
    '  echo(await next());',
    '  if (kind === "mid") {',
    '    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 1" } }] } });',
    '    const l2 = await Promise.race([next(), new Promise((r) => setTimeout(() => r(undefined), 3000))]);',
    '    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });',
    '    if (l2) { const t = echo(l2); out({ type: "assistant", message: { content: [{ type: "text", text: "got: " + t }] } }); }',
    '    out({ type: "result", session_id: sid });',
    '  } else {',
    '    out({ type: "assistant", message: { content: [{ type: "text", text: "answer 1" }] } });',
    '    await new Promise((r) => setTimeout(r, 200));',
    '    out({ type: "result", session_id: sid });',
    '    const l2 = await next();',
    '    if (l2) { echo(l2); out({ type: "assistant", message: { content: [{ type: "text", text: "answer 2" }] } }); out({ type: "result", session_id: sid }); }',
    '  }',
    '  const rest = await next();',
    '  process.exit(rest === null ? 0 : 3);',
    '})();',
  ].join('\n');
  await writeFile(path, src, 'utf8');
  await chmod(path, 0o755);
  return { path, dir, recordPath: join(dir, 'unused.json') };
}

async function readRecord(path: string): Promise<{
  argv: string[];
  stdin: string;
  systemPrompt: string | null;
  cwd: string;
  env: Record<string, string | undefined>;
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    stdin: string;
    systemPrompt: string | null;
    cwd: string;
    env: {
      LARK_CHANNEL?: string;
      LARK_CHANNEL_PROFILE?: string;
      LARK_CHANNEL_HOME?: string;
      LARK_CHANNEL_CONFIG?: string;
      LARKSUITE_CLI_CONFIG_DIR?: string;
    };
  };
}
