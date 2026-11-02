import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { buildAgentEnv } from '../../platform/agent-env';
import { isClaudeModelId } from './model-id';
import {
  buildNonOwnerSettings,
  claudeUserConfigDir,
  readUserSettingsEnvNames,
} from './owner-only-settings';
import { cleanupSandboxPlaceholders, snapshotPlaceholders } from './sandbox-placeholders';
import { spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import {
  CLAUDE_DEFAULT_PERMISSION_MODE,
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
} from '../types';
import { translateEvent } from './stream-json';

export interface ClaudeAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
  /** f031-sec-#4: daemon env names the owner explicitly passes to the agent. */
  envPassthrough?: readonly string[];
}

type ClaudeChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

const effortSkipLogged = new Set<string>();

// f031-stab-#15 / f031-fix-#2: shared with the /model card.
export { isClaudeModelId };

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly envPassthrough: readonly string[];
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'claude';
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
      agentId: 'claude',
      agentName: 'Claude Code',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for ClaudeAdapter.run');
    }

    // The prompt and bridge system prompt must NOT go through argv. On Windows,
    // `claude` resolves to a `claude.cmd` shim and cross-spawn routes it through
    // `cmd.exe /d /s /c`, which interprets `<` and `>` as redirection operators
    // — that silently eats the prompt's `<bridge_context>` XML, so claude runs
    // with an empty request and replies with its default greeting instead of a
    // stream-json response. Pass the prompt via stdin and the appended system
    // prompt via a temp file (the same approach the Codex adapter uses) so no
    // special characters ever reach the shell.
    // f03p-infra-#2: a run not started by the owner gets flag settings that
    // blank the owner's settings.json tokens (fail-closed: only an explicit
    // ownerRun === true skips it). Written next to the system prompt file and
    // removed with it; holds key names only, never values.
    const ownerRun = opts.ownerRun === true;
    const nonOwnerSettings = ownerRun
      ? undefined
      : (() => {
          const configDir = claudeUserConfigDir({ ...process.env, ...(opts.envOverrides ?? {}) });
          return JSON.stringify(
            buildNonOwnerSettings({ configDir, settingsEnvNames: readUserSettingsEnvNames(configDir) }),
            null,
            2,
          );
        })();
    const systemPromptFile = writeSystemPromptFile(buildBridgeSystemPrompt(this.botIdentity), nonOwnerSettings);
    // f0.4 之后的修复 (bwrap): the sandbox a non-owner run starts leaves empty
    // placeholder files in cwd; note what was there so exit can tidy up.
    const placeholdersBefore = ownerRun ? undefined : snapshotPlaceholders(opts.cwd);
    const cwdForCleanup = opts.cwd;

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      // aiduCAT: partial messages carry `message_delta.usage` — the only
      // per-API-call token snapshot the CLI emits (assistant events report
      // zeros and `result` reports the whole-turn cumulative sum). Without
      // this flag the panel's context-window readout can't be live or right.
      '--include-partial-messages',
      '--verbose',
      '--permission-mode',
      opts.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE,
      '--append-system-prompt-file',
      systemPromptFile.path,
    ];
    if (systemPromptFile.settingsPath) args.push('--settings', systemPromptFile.settingsPath);
    // f031-sec-L1: belt and braces — a session id is never passed if the CLI
    // could parse it as an option.
    if (opts.sessionId && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts.sessionId)) {
      args.push('--resume', opts.sessionId);
    }
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) {
      // f031-stab-#15: --effort is an Anthropic setting. Behind a gateway a
      // non-Claude model (Gemini/GPT/GLM/Kimi…) does not support it, so only
      // Claude models get it. The model is --model, else the per-run
      // ANTHROPIC_MODEL override, else the CLI default (assumed Claude).
      const effectiveModel = opts.model ?? opts.envOverrides?.ANTHROPIC_MODEL ?? process.env.ANTHROPIC_MODEL;
      if (isClaudeModelId(effectiveModel)) {
        // Claude Code validates low/medium/high/xhigh/max. If ultra was selected (e.g. from codex profile), fallback to max.
        const effort = opts.effort === 'ultra' ? 'max' : opts.effort;
        args.push('--effort', effort);
      } else if (effectiveModel && !effortSkipLogged.has(effectiveModel)) {
        effortSkipLogged.add(effectiveModel);
        log.info('agent', 'effort-skipped-non-claude', { model: effectiveModel, effort: opts.effort });
      }
    }

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      // f0.2: per-run provider overrides (envOverrides) layer last, on top of
      // the Lark channel env — /model provider switches take effect per run.
      // f031-sec-#4: allowlisted env only (no daemon secrets, no bridge config path).
      env: buildAgentEnv({
        agent: 'claude',
        overrides: {
          ...buildLarkChannelEnv(this.larkChannel, { forAgent: true }),
          ...(opts.envOverrides ?? {}),
          // f03p-infra-#2: also in the process env, in case flag settings are ignored.
          ...(ownerRun ? {} : { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' }),
        },
        // f03p-infra-#2: owner-chosen passthrough (SSH agent, …) is the owner's.
        passthrough: ownerRun ? this.envPassthrough : [],
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ClaudeChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    // Listeners MUST be attached synchronously here, before we return.
    // The 'error' and exit-related events can fire in the next tick; if we
    // defer attachment to the async-generator body, those events fire into
    // the void and the generator hangs.
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
        // f031-stab-#15 / f03p-slim-#8: see classifyClaudeStderrLine.
        const level = classifyClaudeStderrLine(line);
        if (level === 'info') log.info('agent', 'stderr', { line });
        else if (level === 'warn') log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn claude: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
      systemPromptFile.cleanup();
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      systemPromptFile.cleanup();
      if (placeholdersBefore) {
        const removed = cleanupSandboxPlaceholders(cwdForCleanup, placeholdersBefore);
        if (removed.length > 0) log.info('agent', 'sandbox-placeholders-cleaned', { count: removed.length });
      }
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
    });
    child.stdin.end(opts.prompt, 'utf8');

    // Default 5s if caller didn't specify — claude often has live
    // subprocesses (lark-cli waiting for OAuth, long Bash, etc.) and the
    // old 500ms was nowhere near enough for them to flush state before the
    // SIGKILL cascade. Callers (channel.ts, /doctor) override per-run with
    // a value derived from preferences.
    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
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
  child: ClaudeChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  // If fork itself failed synchronously, child.pid is undefined. The 'error'
  // event (ENOENT etc.) fires in the next tick, so also check getError().
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn claude: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);
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
      yield* translateEvent(parsed);
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield {
      type: 'error',
      message: `claude runtime error: ${earlyRuntimeError.message}`,
      terminationReason: 'failed',
    };
    return;
  }

  // When the child is killed by a signal, exitCode stays null and signalCode
  // carries the name. Both must be checked or we'll attach an 'exit' listener
  // for an event that already fired and hang forever.
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield {
      type: 'error',
      message: `claude exited with code ${exitCode}${detail}`,
      terminationReason: 'failed',
    };
  } else if (runtimeError) {
    yield {
      type: 'error',
      message: `claude runtime error: ${runtimeError.message}`,
      terminationReason: 'failed',
    };
  }
}

/**
 * Persist the appended system prompt to a throwaway temp file so it can be
 * passed via `--append-system-prompt-file` instead of argv. Returns the path
 * plus an idempotent, best-effort cleanup that removes the temp directory.
 */
function writeSystemPromptFile(
  content: string,
  settings?: string,
): { path: string; settingsPath?: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lark-claude-'));
  const path = join(dir, 'append-system-prompt.md');
  writeFileSync(path, content, 'utf8');
  let settingsPath: string | undefined;
  if (settings !== undefined) {
    settingsPath = join(dir, 'non-owner-settings.json');
    writeFileSync(settingsPath, settings, { encoding: 'utf8', mode: 0o600 });
  }
  return {
    path,
    ...(settingsPath ? { settingsPath } : {}),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort: the OS will reclaim the temp dir eventually
      }
    },
  };
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}

/**
 * f031-stab-#15 / f03p-slim-#8: Claude Code writes
 * `[claude-code:unrecognized_model] {"model":…}` once per *claude process* for
 * a gateway model id (e.g. Gemini-3.8-Flash via 10router). Each run is a new
 * process, so the bridge used to log it on every run. It is documented,
 * harmless behavior (the request still goes out with our id), so keep one
 * info line per model per bridge process and drop the repeats. Silencing it
 * at the source would need a `modelOverrides` entry that makes Claude Code
 * treat the gateway model as a Claude model (effort/thinking/window), which
 * f031-stab-#15 deliberately avoids for non-Claude models.
 */
export type ClaudeStderrLevel = 'info' | 'warn' | 'skip';

export function createClaudeStderrClassifier(): (line: string) => ClaudeStderrLevel {
  const seenModels = new Set<string>();
  return (line) => {
    if (!line.trim()) return 'skip';
    if (!line.includes('[claude-code:unrecognized_model]')) return 'warn';
    const json = line.slice(line.indexOf(']') + 1).trim();
    let model: string | undefined;
    try {
      const parsed = JSON.parse(json) as { model?: unknown };
      if (typeof parsed.model === 'string') model = parsed.model;
    } catch {
      // unexpected shape: still informational, just not deduplicated
    }
    if (model === undefined) return 'info';
    if (seenModels.has(model)) return 'skip';
    seenModels.add(model);
    return 'info';
  };
}

/** Shared by every ClaudeAdapter run in this bridge process. */
export const classifyClaudeStderrLine = createClaudeStderrClassifier();
