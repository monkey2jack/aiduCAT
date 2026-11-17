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
import { buildDshArgs, isDshPermissionPreset, DSH_UNATTENDED_APPROVAL } from './argv';
import { DshStreamTranslator, type DshFinal } from './jsonl';

/**
 * DSH (DeepSeek Harness) adapter — aiduCAT's fourth agent.
 *
 * One Feishu turn = one `dsh --profile <p> headless --json -` client: the
 * task rides on stdin, run events stream back as NDJSON on stdout, and the
 * process exits when the turn ends (no background daemon to manage, unlike
 * Hermes). Sessions resume via `--session-id <id>`.
 *
 * The headless profile's model routing lives in DSH's own config
 * (`agent-default-model` in cordis.patch.yml), so /model on a dsh profile
 * intentionally offers only "follow DSH config".
 */
export interface DshAdapterOptions {
  /** Absolute path to the `dsh.cmd` launcher (Windows) or `dsh` binary. */
  binary: string;
  /** DSH profile under $DSH_HOME/profiles. */
  dshProfile?: string;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
  envPassthrough?: readonly string[];
}

type DshChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh';
  readonly displayName = 'DeepSeek Harness';

  private readonly binary: string;
  private readonly dshProfile: string | undefined;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly envPassthrough: readonly string[];
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: DshAdapterOptions) {
    this.binary = opts.binary;
    this.dshProfile = opts.dshProfile;
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
      agentId: 'dsh',
      agentName: 'DeepSeek Harness',
      command: this.binary,
      binaryPath: this.binary,
      // Electron-as-node cold start is slow (asset unzip on first run).
      timeoutMs: 30_000,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'dsh binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for DshAdapter.run');
    const model = opts.model ?? '';
    if (model && model !== 'default') {
      // /model is pinned to "follow DSH config" for this adapter; a stored
      // non-default value (left over after switching agent kinds) is ignored
      // rather than rejected, matching how a missing flag behaves.
      log.info('agent', 'dsh-model-ignored', { model, note: 'headless profile routes via its own config' });
    }
    const larkEnv = buildLarkChannelEnv(this.larkChannel, { forAgent: true });
    const env = buildAgentEnv({
      agent: 'dsh',
      overrides: {
        ...larkEnv,
        ...(process.env.DSH_HOME ? { DSH_HOME: process.env.DSH_HOME } : {}),
        // The aidu provider route in the DSH profile reads this by name;
        // buildAgentEnv does not forward it on its own.
        ...(process.env.AIDU_API_KEY ? { AIDU_API_KEY: process.env.AIDU_API_KEY } : {}),
        ...dshSafeOverrides(opts.envOverrides),
      },
      passthrough: opts.ownerRun === true ? this.envPassthrough : [],
    });
    const prompt = prefixBridgeSystemPrompt(opts.prompt, this.botIdentity);
    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    // aiduCAT's access mode IS a DSH preset name — both are the same three
    // levels (read-only / workspace-write / danger-full-access). An
    // unrecognised value is dropped so the turn keeps the profile default
    // rather than aborting on a preset DSH does not know.
    const permissionMode = isDshPermissionPreset(opts.sandbox) ? opts.sandbox : undefined;
    const args = buildDshArgs({
      ...(this.dshProfile ? { profile: this.dshProfile } : {}),
      ...(opts.sessionId ? { resume: opts.sessionId } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      // Headless has no live approval channel, so an unattended bridged turn
      // must never park waiting for one.
      approvalPolicy: DSH_UNATTENDED_APPROVAL,
    });
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as DshChild;
    log.info('agent', 'spawn', {
      agent: 'dsh',
      pid: child.pid ?? null,
      cwd: opts.cwd,
      profile: this.dshProfile ?? 'headless',
      resume: Boolean(opts.sessionId),
      // Audit trail: the exact access level this bridged turn ran under.
      permissionMode: permissionMode ?? 'profile-default',
      approvalPolicy: DSH_UNATTENDED_APPROVAL,
      ownerRun: opts.ownerRun === true,
      promptChars: opts.prompt.length,
    });
    child.on('error', (err) => log.warn('agent', 'spawn-error', { agent: 'dsh', message: err.message }));
    child.on('exit', (code, signal) => log.info('agent', 'exit', { agent: 'dsh', pid: child.pid ?? null, code, signal }));

    let stopped = false;

    const events = (async function* (): AsyncGenerator<AgentEvent> {
      if (!child.pid) {
        const message = await onceError(child);
        yield {
          type: 'error',
          message: `failed to spawn dsh: ${message ?? 'spawn returned no pid'}`,
          terminationReason: 'failed',
        };
        return;
      }
      // Prompt on stdin ("-" reads it there).
      child.stdin.end(prompt, 'utf8');

      const translator = new DshStreamTranslator();
      const stderr = collectStderr(child);
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      let final: DshFinal | undefined;
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
      const sessionId = final?.sessionId ?? translator.currentSessionId();
      if (stopped) {
        if (sessionId) yield { type: 'system', sessionId };
        yield { type: 'done', terminationReason: 'interrupted' };
        return;
      }
      if (sessionId) yield { type: 'system', sessionId };

      // A completed run requires BOTH conditions. The headless runner exits 0
      // only on a completed turn, and `final.reason` is null when the last turn
      // never closed — trusting either one alone would report an aborted run as
      // a success (DeepSeek Harness 0.2.2-rc.3, dsh-headless README, exit mapping).
      // The exit code alone is not enough either: a turn that fails in-turn still
      // ends with a (often empty) `final` and no `error` event.
      const completed = exitCode === 0 && final?.reasonKind === 'completed';
      if (!completed) {
        const detail =
          final?.errorMessage ?? translator.errorFromStream() ?? stderr.text().trim().slice(0, 500);
        const code = final?.errorCode;
        yield {
          type: 'error',
          message: detail
            ? `dsh ${code ? `${code}: ` : ''}${detail}`
            : `dsh exited with code ${exitCode ?? 'null'}`,
          terminationReason: 'failed',
        };
        return;
      }
      // The streamed blocks on the card already carry the answer, unless the
      // projection capped one or they do not reconstruct the terminal text
      // exactly — in which case the lossless terminal answer is authoritative.
      if (final && translator.needsTerminalText(final.text)) {
        yield { type: 'final_text', content: final.text };
      }
      yield { type: 'done', terminationReason: 'normal' };
    })();

    return {
      runId: opts.runId,
      events,
      async stop() {
        stopped = true;
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop', { agent: 'dsh', pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        const exited = await new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, stopGraceMs);
          child.once('exit', onExit);
        });
        if (!exited) {
          // The launcher is a .cmd that starts Electron, so the direct child is
          // the shell — killing only it would orphan the real agent process,
          // which keeps holding the workspace. taskkill /T takes the tree.
          log.warn('agent', 'stop-force-kill', { agent: 'dsh', pid: child.pid ?? null });
          await killProcessTree(child.pid, 'stop-grace-expired');
        }
      },
      async forceKillTree() {
        if (child.exitCode === null && child.signalCode === null) {
          await killProcessTree(child.pid, 'force-kill');
        }
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
    };
  }
}

function collectStderr(child: DshChild): { text(): string } {
  let all = '';
  child.stderr.on('data', (chunk: Buffer) => {
    if (all.length < 64_000) all += chunk.toString('utf8');
  });
  return { text: () => all };
}

function onceError(child: DshChild): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 50);
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve(err.message);
    });
  });
}

function waitForExit(child: DshChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

/**
 * Per-run overrides from aiduCAT (/model provider env, lark-cli identity).
 * DSH reads model routing from its own profile config, so vendor-prefixed
 * variables (ANTHROPIC, OPENAI, CODEX, CLAUDE, DEEPSEEK) and any variable
 * whose name contains KEY, TOKEN, SECRET or PASS are dropped here - a /model
 * provider switch must never leak keys into the DSH environment.
 */
function dshSafeOverrides(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    // AIDU_API_KEY is the deliberate exception: the DSH profile's aidu
    // provider route (apiKeyEnv) reads it by name, so it must survive.
    if (k === 'AIDU_API_KEY') {
      out[k] = v;
      continue;
    }
    if (/^DSH_/i.test(k) || /^(OPENAI|ANTHROPIC|CODEX|CLAUDE|DEEPSEEK)_/i.test(k) || /(KEY|TOKEN|SECRET|PASS)/i.test(k)) {
      dropped.push(k);
      continue;
    }
    out[k] = v;
  }
  if (dropped.length > 0) log.info('agent', 'dsh-env-dropped', { names: dropped.join(',') });
  return out;
}
