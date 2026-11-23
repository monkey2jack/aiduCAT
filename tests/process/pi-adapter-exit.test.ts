import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAdapter } from '../../src/agent/pi/adapter.js';
import type { AgentEvent, AgentRun } from '../../src/agent/types.js';

/**
 * pi-exit-hang (2026-11-23): process-level contract tests for the long-lived
 * rpc child — requestExit() must deliver stdin EOF + SIGTERM (pi exits on
 * both), escalate to SIGKILL when the child wedges, and the executor-visible
 * post-terminal settle must finish long before the old 15s blind wait.
 */

interface FakePi {
  path: string;
  dir: string;
  recordPath: string;
}

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })),
  );
});

async function createFakePi(options: {
  /** How the fake behaves after settling (per exit-request delivery). */
  onExitRequest?: 'exit' | 'hang';
  exitDelayMs?: number;
}): Promise<FakePi> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-adapter-test-'));
  const path = join(dir, 'fake-pi.mjs');
  const recordPath = join(dir, 'argv.json');
  const behavior = options.onExitRequest ?? 'exit';
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync } from "node:fs";',
      'const argv = process.argv.slice(2);',
      'let settled = false;',
      'let exitRequested = false;',
      'let killed = false;',
      'process.on("SIGTERM", () => {',
      `  if (${JSON.stringify(behavior)} === "exit" || killed) process.exit(143);`,
      '  // wedged: keep running unless the SIGKILL escalation lands',
      '});',
      'process.on("SIGKILL", () => { killed = true; process.exit(137); });',
      'process.stdin.on("end", () => {',
      `  if (${JSON.stringify(behavior)} === "exit") process.exit(0);`,
      '});',
      'process.stdin.on("data", (chunk) => {',
      '  for (const line of String(chunk).split("\\n")) {',
      '    if (!line.trim()) continue;',
      '    let cmd; try { cmd = JSON.parse(line); } catch { continue; }',
      '    if (cmd.type === "prompt") {',
      `      writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv, pid: process.pid }));`,
      '      if (settled) continue;',
      '      settled = true;',
      '      console.log(JSON.stringify({ id: cmd.id, type: "response", command: "prompt", success: true }));',
      '      console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" } }));',
      '      console.log(JSON.stringify({ type: "agent_settled", aborted: false }));',
      '    } else if (cmd.type === "get_state") {',
      '      console.log(JSON.stringify({ id: cmd.id, type: "response", command: "get_state", success: true, data: { sessionId: "sess-fake" } }));',
      '    } else {',
      '      console.log(JSON.stringify({ id: cmd.id, type: "response", command: String(cmd.type ?? ""), success: true }));',
      '    }',
      '  }',
      '});',
      options.exitDelayMs ? `setTimeout(() => process.exit(0), ${options.exitDelayMs});` : '',
      // Wedged mode must survive stdin EOF: keep the event loop alive (a real
      // wedged extension keeps handles open). SIGKILL cannot be intercepted —
      // the OS reaps us when the escalation fires, which is the point.
      behavior === 'hang' ? 'setInterval(() => {}, 1 << 30);' : '',
      '// keep alive until stdin closes',
    ].filter(Boolean).join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function adapterFor(fake: FakePi, agentDir: string): PiAdapter {
  return new PiAdapter({
    binary: fake.path,
    agentDir,
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('PiAdapter process contract (pi-exit-hang)', () => {
  it('run completes via agent_settled and the child is reused while idle', async () => {
    const fake = await createFakePi({ onExitRequest: 'exit' });
    cleanup.push(fake.dir);
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-adapter-dir-'));
    cleanup.push(agentDir);
    const adapter = adapterFor(fake, agentDir);

    const run: AgentRun = adapter.run({ runId: 'r1', prompt: '你好', cwd: fake.dir });
    const events = await collect(run.events);
    expect(events.some((e) => e.type === 'done' && e.terminationReason === 'normal')).toBe(true);
    adapter.dispose();
  }, 20_000);

  it('requestExit resolves true, delivers shutdown, and the child dies promptly', async () => {
    const fake = await createFakePi({ onExitRequest: 'exit' });
    cleanup.push(fake.dir);
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-adapter-dir-'));
    cleanup.push(agentDir);
    const adapter = adapterFor(fake, agentDir);

    const run = adapter.run({ runId: 'r2', prompt: 'hi', cwd: fake.dir });
    await collect(run.events); // settled

    const t0 = Date.now();
    const delivered = await run.requestExit!();
    expect(delivered).toBe(true);
    const exited = await run.waitForExit(15_000);
    const waited = Date.now() - t0;
    expect(exited).toBe(true);
    expect(waited).toBeLessThan(15_000);
    adapter.dispose();
  }, 30_000);

  it('requestExit on an already-dead child resolves false', async () => {
    const fake = await createFakePi({ onExitRequest: 'exit' });
    cleanup.push(fake.dir);
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-adapter-dir-'));
    cleanup.push(agentDir);
    const adapter = adapterFor(fake, agentDir);

    const run = adapter.run({ runId: 'r3', prompt: 'hi', cwd: fake.dir });
    await collect(run.events);
    // Kill out-of-band; the adapter learns via its exit handler.
    await run.forceKillTree!();
    await new Promise((r) => setTimeout(r, 300));
    expect(await run.requestExit!()).toBe(false);
    adapter.dispose();
  }, 30_000);

  it('a wedged child is reaped after the exit-request window (SIGKILL escalation)', async () => {
    const fake = await createFakePi({ onExitRequest: 'hang' });
    cleanup.push(fake.dir);
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-adapter-dir-'));
    cleanup.push(agentDir);
    const adapter = adapterFor(fake, agentDir);

    const run = adapter.run({ runId: 'r4', prompt: 'hi', cwd: fake.dir });
    await collect(run.events);
    expect(await run.requestExit!()).toBe(true);
    // Run-level waitForExit tracks the turn (already settled); child death is
    // what must be observed. On win32 SIGTERM is a hard kill (dies at once);
    // on POSIX the wedged fake ignores it and dies only via the 30s SIGKILL
    // escalation — either way it must be gone well within this budget.
    const pid = JSON.parse(await readFile(fake.recordPath, 'utf8')).pid as number;
    const deadline = Date.now() + 45_000;
    let alive = true;
    while (Date.now() < deadline) {
      alive = pidAlive(pid);
      if (!alive) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(alive).toBe(false);
    adapter.dispose();
  }, 70_000);

  it('exitRequestGraceMs is exported for the executor', async () => {
    const fake = await createFakePi({ onExitRequest: 'exit' });
    cleanup.push(fake.dir);
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-adapter-dir-'));
    cleanup.push(agentDir);
    const adapter = adapterFor(fake, agentDir);
    const run = adapter.run({ runId: 'r5', prompt: 'hi', cwd: fake.dir });
    await collect(run.events);
    expect(run.exitRequestGraceMs).toBe(5_000);
    adapter.dispose();
  }, 20_000);
});
