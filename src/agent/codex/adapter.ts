import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import { buildAgentEnv } from '../../platform/agent-env';
import { killProcessTree } from '../../platform/kill-tree';
import { spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { buildCodexArgs } from './argv';
import { CodexJsonlTranslator, type CodexFinishReason } from './jsonl';
import { extractCodexLastUsage } from './history-usage';

export interface CodexAdapterOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  sandbox?: SandboxMode;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
  /** f031-sec-#4: daemon env names the owner explicitly passes to the agent. */
  envPassthrough?: readonly string[];
}

type CodexChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex CLI';

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly codexHome: string | undefined;
  private readonly inheritCodexHome: boolean;
  private readonly ignoreUserConfig: boolean;
  private readonly ignoreRules: boolean;
  private readonly sandbox: SandboxMode;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly envPassthrough: readonly string[];
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: CodexAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.codexHome = opts.codexHome;
    this.inheritCodexHome = opts.inheritCodexHome !== false;
    this.ignoreUserConfig = opts.ignoreUserConfig === true;
    this.ignoreRules = opts.ignoreRules !== false;
    this.sandbox = opts.sandbox ?? 'workspace-write';
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
      agentId: 'codex',
      agentName: 'Codex CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'codex binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for CodexAdapter.run');
    }

    const larkEnv = buildLarkChannelEnv(this.larkChannel, { forAgent: true });
    const args = buildCodexArgs({
      cwd: opts.cwd,
      // f031-sec-#4: Codex shells inherit only core vars + the lark-channel env.
      shellEnv: larkEnv as Record<string, string>,
      sandbox: opts.sandbox ?? this.sandbox,
      threadId: opts.threadId,
      images: opts.images,
      ignoreUserConfig: this.ignoreUserConfig,
      ignoreRules: this.ignoreRules,
      model: opts.model,
      effort: opts.effort,
    });
    const envOverrides: NodeJS.ProcessEnv = {
      ...larkEnv,
      // f0.2: per-run provider overrides layer last so /model switches take
      // effect per run without a service restart.
      ...(opts.envOverrides ?? {}),
    };
    if (this.codexHome) {
      envOverrides.CODEX_HOME = this.codexHome;
    } else if (!this.inheritCodexHome) {
      envOverrides.CODEX_HOME = join(this.profileStateDir, 'codex-home');
    }
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      // f03p-infra-#2: owner passthrough only for the owner's runs.
      env: buildAgentEnv({
        agent: 'codex',
        overrides: envOverrides,
        passthrough: opts.ownerRun === true ? this.envPassthrough : [],
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as CodexChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasThread: Boolean(opts.threadId),
      promptChars: opts.prompt.length,
      images: opts.images?.length ?? 0,
      model: opts.model,
    });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn codex: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let stopReason: CodexFinishReason | undefined;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    child.stdin.end(prefixBridgeSystemPrompt(opts.prompt, this.botIdentity), 'utf8');

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    const codexHomeDir = this.codexHome
      ? this.codexHome
      : (this.inheritCodexHome ? (process.env.CODEX_HOME || join(process.env.HOME || '/data/home', '.codex')) : join(this.profileStateDir, 'codex-home'));

    return {
      runId: opts.runId,
      pid: child.pid,
      events: createEventStream(child, stderrChunks, () => runtimeError, () => stopReason, codexHomeDir),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopReason = 'interrupted';
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              // issue #9 (P2): child.kill() cannot reach past a .cmd shim to
              // the real codex.exe or its grandchilds — same orphan failure
              // mode as the claude adapter.
              void killProcessTree(child.pid, 'stop-grace-expired');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      async forceKillTree() {
        // Works even when the child already exited: the event stream can
        // still be wedged by a grandchild holding the stdout write handle.
        await killProcessTree(child.pid, 'force-kill');
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
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
    };
  }
}

async function* createEventStream(
  child: CodexChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  getStopReason: () => CodexFinishReason | undefined,
  codexHomeDir?: string,
): AsyncGenerator<AgentEvent> {
  const translator = new CodexJsonlTranslator();
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn codex: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let lastUsageFetchAt = 0;
  let threadId: string | undefined;
  let lastKnownUsage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | undefined;
  // issue #9 (P0): stdout EOF is not a reliable end-of-stream — same failure
  // mode as the claude adapter. When the child exits, give any final lines 2s
  // to flush, then destroy stdout so readline ends regardless of who still
  // holds the write handle (a grandchild can keep it open indefinitely).
  const EXIT_FLUSH_GRACE_MS = 2_000;
  const closeStdoutAfterExit = (sawStdout: boolean): void => {
    setTimeout(() => {
      if (!child.stdout.readableEnded) {
        log.info('agent', 'stdout-force-close-after-exit', {
          pid: child.pid ?? null,
          sawStdout,
          graceMs: EXIT_FLUSH_GRACE_MS,
        });
        child.stdout.destroy();
      }
    }, EXIT_FLUSH_GRACE_MS).unref();
  };
  child.once('exit', () => closeStdoutAfterExit(sawStdout));
  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const parsedType =
        typeof parsed === 'object' && parsed !== null ? (parsed as { type?: string }).type : undefined;

      // aiduCAT: `thread.started` carries this run's thread_id — pin the exact
      // rollout file so concurrent group/p2p runs read their own usage only.
      if (parsedType === 'thread.started' && typeof parsed === 'object' && parsed !== null) {
        const maybeThread = (parsed as { thread_id?: unknown }).thread_id;
        if (typeof maybeThread === 'string' && maybeThread) threadId = maybeThread;
      }

      // aiduCAT: refresh the true per-turn context fill on every completed item
      // (throttled to 15s) so the header tracks live usage on any Codex version
      // and any exit path — regardless of which terminal event the CLI emits.
      if (codexHomeDir && parsedType === 'item.completed') {
        const nowMs = Date.now();
        if (!lastUsageFetchAt || nowMs - lastUsageFetchAt > 15_000) {
          lastUsageFetchAt = nowMs;
          const lastUsage = await extractCodexLastUsage(codexHomeDir, threadId);
          if (lastUsage) {
            lastKnownUsage = lastUsage;
            yield {
              type: 'usage',
              inputTokens: lastUsage.inputTokens,
              outputTokens: lastUsage.outputTokens,
              cachedInputTokens: lastUsage.cachedInputTokens,
            };
          }
        }
      }

      if (codexHomeDir && parsedType === 'turn.completed' && lastKnownUsage) {
        log.info('agent', 'codex-last-usage', { ...lastKnownUsage });
      }

      yield* translator.translate(parsed);
    }
  } finally {
    rl.close();
    // aiduCAT: final guaranteed refresh — run-state keeps whichever usage
    // snapshot arrives last before/carrying the terminal event.
    if (codexHomeDir) {
      const lastUsage = await extractCodexLastUsage(codexHomeDir, threadId);
      if (lastUsage) {
        lastKnownUsage = lastUsage;
        yield {
          type: 'usage',
          inputTokens: lastUsage.inputTokens,
          outputTokens: lastUsage.outputTokens,
          cachedInputTokens: lastUsage.cachedInputTokens,
        };
      }
    }
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield* translator.fail(`codex runtime error: ${earlyRuntimeError.message}`);
    return;
  }

  const exitCode = await waitForExitCode(child);
  const stopReason = getStopReason();
  if (stopReason) {
    yield* translator.finish(stopReason);
    return;
  }

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    if (!translator.terminalEmitted()) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
      yield* translator.fail(`codex exited with code ${exitCode}${detail}`);
    }
    return;
  }
  if (runtimeError && !translator.terminalEmitted()) {
    yield* translator.fail(`codex runtime error: ${runtimeError.message}`);
    return;
  }

  yield* translator.finish();
}

async function waitForExitCode(child: CodexChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
