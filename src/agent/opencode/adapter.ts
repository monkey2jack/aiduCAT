import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { buildAgentEnv } from '../../platform/agent-env';
import { spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { killProcessTree } from '../../platform/kill-tree';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type { AgentAdapter, AgentBotIdentity, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { buildOpencodeArgs } from './argv';
import { OpencodeStreamTranslator, type OpencodeFinal } from './jsonl';

export interface OpencodeAdapterOptions {
  binary: string;
  serverUrl?: string;
  password?: string;
  username?: string;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
  envPassthrough?: readonly string[];
}

type OpencodeChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class OpencodeAdapter implements AgentAdapter {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode';

  private readonly binary: string;
  private readonly serverUrl: string | undefined;
  private readonly password: string | undefined;
  private readonly username: string | undefined;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly envPassthrough: readonly string[];
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: OpencodeAdapterOptions) {
    this.binary = opts.binary;
    this.serverUrl = opts.serverUrl;
    this.password = opts.password;
    this.username = opts.username;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
    this.envPassthrough = opts.envPassthrough ?? [];
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'opencode',
      agentName: 'OpenCode',
      command: this.binary,
      binaryPath: this.binary,
      timeoutMs: 15_000,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'opencode binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for OpencodeAdapter.run');

    const larkEnv = buildLarkChannelEnv(this.larkChannel, { forAgent: true });
    const env = buildAgentEnv({
      agent: 'opencode' as any,
      overrides: {
        ...larkEnv,
        ...(this.password ? { OPENCODE_SERVER_PASSWORD: this.password } : {}),
        ...(process.env.AIDU_API_KEY ? { AIDU_API_KEY: process.env.AIDU_API_KEY } : {}),
        ...(opts.envOverrides ?? {}),
      },
      passthrough: this.envPassthrough,
    });

    const prompt = prefixBridgeSystemPrompt(opts.prompt, this.botIdentity);
    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    const args = buildOpencodeArgs({
      sessionId: opts.sessionId,
      model: opts.model,
      effort: opts.effort,
      attach: this.serverUrl,
      password: this.password,
      username: this.username,
      thinking: true,
    });

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as OpencodeChild;

    const stderr = collectStderr(child);
    let stopped = false;

    // Send prompt to stdin and close stdin
    child.stdin.end(prompt, 'utf8');

    const events = (async function* (): AsyncGenerator<AgentEvent, void, void> {
      const earlyError = await onceError(child);
      if (earlyError) {
        yield {
          type: 'error',
          message: 'failed to spawn opencode: ' + earlyError,
          terminationReason: 'failed',
        };
        return;
      }

      const translator = new OpencodeStreamTranslator();
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      let final: OpencodeFinal | undefined;

      try {
        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (stopped) break;
          for (const e of translator.translate(parsed)) yield e;
          const f = translator.consumeFinal(parsed);
          if (f) {
            final = f;
            break;
          }
        }
      } finally {
        rl.close();
      }

      const exitCode = await waitForExit(child);
      if (stopped) {
        const sid = final?.sessionId ?? translator.currentSessionId();
        if (sid) yield { type: 'system', sessionId: sid };
        yield { type: 'done', terminationReason: 'interrupted' };
        return;
      }

      if (!final) {
        const streamErr = translator.errorFromStream();
        const detail = (streamErr || stderr.text()).trim().slice(0, 500);
        yield {
          type: 'error',
          message: 'opencode exited with code ' + String(exitCode ?? 'null') + (detail ? ': ' + detail : ''),
          terminationReason: 'failed',
        };
        return;
      }

      if (final.sessionId) yield { type: 'system', sessionId: final.sessionId };
      if (final.reasonKind === 'error' || final.errorMessage) {
        yield {
          type: 'error',
          message: final.errorMessage ?? 'opencode run failed',
          terminationReason: 'failed',
        };
        return;
      }

      yield { type: 'done', sessionId: final.sessionId, terminationReason: 'normal' };
    })();

    return {
      runId: opts.runId,
      events,
      async stop() {
        stopped = true;
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop', { agent: 'opencode', pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', { agent: 'opencode', pid: child.pid ?? null });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
      async forceKillTree(): Promise<void> {
        if (child.pid) {
          await killProcessTree(child.pid, 'opencode-force-kill');
        }
      },
    };
  }
}

function collectStderr(child: OpencodeChild): { text(): string } {
  let all = '';
  child.stderr.on('data', (chunk: Buffer) => {
    if (all.length < 64_000) all += chunk.toString('utf8');
  });
  return { text: () => all };
}

function onceError(child: OpencodeChild): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 50);
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve(err.message);
    });
  });
}

function waitForExit(child: OpencodeChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}
