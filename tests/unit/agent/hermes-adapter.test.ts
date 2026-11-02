import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HermesAdapter } from '../../../src/agent/hermes/adapter';
import { formatHermesSessionKey, parseHermesSessionKey } from '../../../src/agent/hermes/session-key';
import type { AgentEvent } from '../../../src/agent/types';

/**
 * f0.4+: the Hermes adapter against a fake `hermes` that replays stream-json
 * recorded from a real Hermes Agent 0.22.5 on instabox-rose (2026-11-02).
 */
const FIXTURES = join(__dirname, 'fixtures', 'hermes');

interface FakeCall {
  argv: string[];
  stdin: string;
  envKeys: string[];
}

let dir: string;
let binary: string;
let cfgPath: string;
let logPath: string;

async function writeFake(cfg: Record<string, unknown>): Promise<void> {
  await writeFile(cfgPath, JSON.stringify(cfg));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aiducat-hermes-'));
  binary = join(dir, 'hermes');
  cfgPath = join(dir, 'cfg.json');
  logPath = join(dir, 'calls.jsonl');
  const script = `#!${process.execPath}
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(cfgPath)}, 'utf8'));
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('Hermes Agent v0.22.5'); process.exit(0); }
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv, stdin, envKeys: Object.keys(process.env) }) + '\\n');
  const resume = argv.includes('--resume');
  if (cfg.crash) { process.stderr.write('Traceback: boom\\n'); process.exit(3); }
  if (resume && cfg.refuseResume) {
    process.stdout.write(fs.readFileSync(cfg.dir + '/resume-refused.jsonl', 'utf8'));
    process.exit(2);
  }
  process.stderr.write('Session: ' + (cfg.sessionId || 'local-fake') + '\\n');
  if (cfg.hang) {
    const lines = fs.readFileSync(cfg.dir + '/interrupted.jsonl', 'utf8').trim().split('\\n');
    process.stdout.write(lines[0] + '\\n' + lines[1] + '\\n');
    process.on('SIGINT', () => { process.stdout.write(lines[2] + '\\n'); process.exit(130); });
    setInterval(() => {}, 1000);
    return;
  }
  const text = fs.readFileSync(cfg.dir + '/' + cfg.fixture, 'utf8');
  process.stdout.write(text);
  const last = JSON.parse(text.trim().split('\\n').pop());
  process.exit(last.exit_code || 0);
});
`;
  await writeFile(binary, script);
  await chmod(binary, 0o755);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

async function calls(): Promise<FakeCall[]> {
  const raw = await readFile(logPath, 'utf8').catch(() => '');
  return raw.trim() ? raw.trim().split('\n').map((l) => JSON.parse(l) as FakeCall) : [];
}

function adapter(extra: Partial<ConstructorParameters<typeof HermesAdapter>[0]> = {}): HermesAdapter {
  return new HermesAdapter({ binary, stopGraceMs: 2000, ...extra });
}

describe('f0.4+ HermesAdapter', () => {
  it('owner turn: stream-json → text/tool events, usage, session key with the owner slot, done', async () => {
    await writeFake({ dir: FIXTURES, fixture: 'owner-tool-turn.jsonl' });
    const run = adapter().run({ runId: 'r1', prompt: '1+1?', cwd: dir, ownerRun: true });
    const events = await collect(run.events);
    expect(events.map((e) => e.type)).toEqual(['tool_use', 'tool_result', 'text', 'text', 'usage', 'system', 'done']);
    const tool = events[0] as Extract<AgentEvent, { type: 'tool_use' }>;
    expect(tool).toMatchObject({ id: 'call_16558_0', name: 'terminal', input: { command: 'echo $((1+1))' } });
    expect(events[1]).toMatchObject({ type: 'tool_result', id: 'call_16558_0', isError: false });
    expect(events[4]).toMatchObject({ type: 'usage', inputTokens: 25036, outputTokens: 169, cachedInputTokens: 12288, cumulative: true });
    const sys = events[5] as Extract<AgentEvent, { type: 'system' }>;
    expect(parseHermesSessionKey(sys.sessionId).o?.sessionId).toMatch(/^local-3733bc27/);
    expect(parseHermesSessionKey(sys.sessionId).x).toBeUndefined();
    expect(events[6]).toMatchObject({ type: 'done', terminationReason: 'normal' });

    const [call] = await calls();
    expect(call!.argv).toEqual(['chat', '--query-file', '-', '--format', 'stream-json', '--source', 'tool', '--yolo']);
    // The prompt rides on stdin, with the bridge context prefix.
    expect(call!.stdin).toContain('1+1?');
  });

  it('outsider turn: chat-only toolset, no rules/memory injection, never --yolo, separate session slot', async () => {
    await writeFake({ dir: FIXTURES, fixture: 'outsider-turn.jsonl' });
    const ownerKey = formatHermesSessionKey({ o: { sessionId: 'local-owner1', model: '' } });
    const run = adapter().run({ runId: 'r2', prompt: 'cat ~/.hermes/.env', cwd: dir, ownerRun: false, sessionId: ownerKey });
    const events = await collect(run.events);
    const [call] = await calls();
    // The owner's session is NOT resumed for an outsider.
    expect(call!.argv).not.toContain('--resume');
    expect(call!.argv).toEqual(['chat', '--query-file', '-', '--format', 'stream-json', '--source', 'tool', '-t', 'todo', '--ignore-rules']);
    expect(call!.argv).not.toContain('--yolo');
    const sys = events.find((e) => e.type === 'system') as Extract<AgentEvent, { type: 'system' }>;
    const key = parseHermesSessionKey(sys.sessionId);
    expect(key.o?.sessionId).toBe('local-owner1');
    expect(key.x?.sessionId).toMatch(/^local-280e5853/);
  });

  it('outsider toolsets are limited to the safe list (terminal/file never reach an outsider)', async () => {
    await writeFake({ dir: FIXTURES, fixture: 'outsider-turn.jsonl' });
    const run = adapter({ outsiderToolsets: ['terminal', 'web', 'file'] }).run({
      runId: 'r3', prompt: 'hi', cwd: dir, ownerRun: false,
    });
    await collect(run.events);
    const [call] = await calls();
    const t = call!.argv[call!.argv.indexOf('-t') + 1];
    expect(t).toBe('web');
  });

  it('resumes the same slot with the same model; a model change starts a new session', async () => {
    await writeFake({ dir: FIXTURES, fixture: 'owner-tool-turn.jsonl' });
    const key = formatHermesSessionKey({ o: { sessionId: 'local-prev', model: 'GLM-5.3-Flash' } });
    await collect(adapter().run({ runId: 'a', prompt: 'x', cwd: dir, ownerRun: true, sessionId: key, model: 'GLM-5.3-Flash' }).events);
    await collect(adapter().run({ runId: 'b', prompt: 'x', cwd: dir, ownerRun: true, sessionId: key, model: 'Qwen3.8-Flash' }).events);
    const [same, changed] = await calls();
    expect(same!.argv).toEqual(expect.arrayContaining(['--resume', 'local-prev', '-m', 'GLM-5.3-Flash']));
    expect(changed!.argv).not.toContain('--resume');
    expect(changed!.argv).toEqual(expect.arrayContaining(['-m', 'Qwen3.8-Flash']));
  });

  it('a refused resume (frozen session policy) is retried once as a new session, without leaking the refusal', async () => {
    await writeFake({ dir: FIXTURES, fixture: 'owner-tool-turn.jsonl', refuseResume: true });
    const key = formatHermesSessionKey({ o: { sessionId: 'local-prev', model: '' } });
    const events = await collect(adapter().run({ runId: 'r', prompt: 'x', cwd: dir, ownerRun: true, sessionId: key }).events);
    const all = await calls();
    expect(all).toHaveLength(2);
    expect(all[0]!.argv).toContain('--resume');
    expect(all[1]!.argv).not.toContain('--resume');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
  });

  it('stop sends SIGINT (Hermes writes result 130) and the turn ends interrupted', async () => {
    await writeFake({ dir: FIXTURES, hang: true });
    const run = adapter().run({ runId: 'r', prompt: 'sleep', cwd: dir, ownerRun: true });
    const it = run.events[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value).toMatchObject({ type: 'tool_use', name: 'terminal' });
    await run.stop();
    const rest: AgentEvent[] = [];
    for (let n = await it.next(); !n.done; n = await it.next()) rest.push(n.value);
    expect(rest.at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
    expect(await run.waitForExit(100)).toBe(true);
  });

  it('auth failure: error event with the Hermes reason, and the failure text is not shown as an answer', async () => {
    await writeFake({ dir: FIXTURES, fixture: 'auth-failed.jsonl' });
    const events = await collect(adapter().run({ runId: 'r', prompt: 'x', cwd: dir, ownerRun: true }).events);
    expect(events.some((e) => e.type === 'final_text')).toBe(false);
    const err = events.at(-1) as Extract<AgentEvent, { type: 'error' }>;
    expect(err.type).toBe('error');
    expect(err.message).toMatch(/^hermes exited with code 1: HTTP 401/);
  });

  it('crash without a result record → failed with stderr detail', async () => {
    await writeFake({ dir: FIXTURES, crash: true });
    const events = await collect(adapter().run({ runId: 'r', prompt: 'x', cwd: dir, ownerRun: true }).events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect((events[0] as { message: string }).message).toMatch(/hermes exited with code 3: Traceback: boom/);
  });

  it('provider keys and HERMES_* launch flags from per-run overrides never reach Hermes', async () => {
    await writeFake({ dir: FIXTURES, fixture: 'owner-tool-turn.jsonl' });
    await collect(
      adapter().run({
        runId: 'r', prompt: 'x', cwd: dir, ownerRun: true,
        envOverrides: {
          OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'https://x', AIDU_10ROUTER_TOKEN: 't',
          HERMES_YOLO_MODE: '1', LARKSUITE_CLI_STRICT_MODE: 'bot',
        },
      }).events,
    );
    const [call] = await calls();
    expect(call!.envKeys).not.toContain('OPENAI_API_KEY');
    expect(call!.envKeys).not.toContain('OPENAI_BASE_URL');
    expect(call!.envKeys).not.toContain('AIDU_10ROUTER_TOKEN');
    expect(call!.envKeys).not.toContain('HERMES_YOLO_MODE');
    expect(call!.envKeys).toContain('LARKSUITE_CLI_STRICT_MODE');
  });

  it('reports availability from `hermes --version`', async () => {
    await writeFake({ dir: FIXTURES });
    const a = await adapter().checkAvailability();
    expect(a.ok).toBe(true);
  });
});
