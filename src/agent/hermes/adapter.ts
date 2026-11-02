import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { buildAgentEnv } from '../../platform/agent-env';
import { spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type { AgentAdapter, AgentBotIdentity, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { buildHermesArgs, outsiderToolsets } from './argv';
import { HermesStreamTranslator } from './jsonl';
import {
  formatHermesSessionKey,
  parseHermesSessionKey,
  resumeFor,
  withSlot,
  type HermesSlotName,
} from './session-key';

/**
 * f0.4+: Hermes Agent (NousResearch/hermes-agent) as aiduCAT's third agent.
 *
 * Every Feishu turn starts one `hermes chat … --format stream-json` client and
 * it exits when the turn ends. Since Hermes 0.22 that client hands the turn to
 * a local Hermes background process it starts on demand (`gateway run
 * --idle-exit`, gone after `gateway.unmanaged_idle_exit_seconds`, 600 s by
 * default). Two consequences the adapter has to respect:
 *  - stopping the client does NOT stop the turn: Hermes "detaches" and lets
 *    accepted work finish in the background. /stop ends the card (SIGINT →
 *    `result` exit 130); Hermes may still finish that turn on its own.
 *  - a session's launch flags are frozen; see session-key.ts.
 */
export interface HermesAdapterOptions {
  binary: string;
  /** `hermes --profile <name>`; unset = Hermes's sticky default profile. */
  hermesProfile?: string;
  /** Toolsets for outsider turns (filtered to the safe list). */
  outsiderToolsets?: readonly string[];
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
  envPassthrough?: readonly string[];
}

type HermesChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class HermesAdapter implements AgentAdapter {
  readonly id = 'hermes';
  readonly displayName = 'Hermes Agent';

  private readonly binary: string;
  private readonly hermesProfile: string | undefined;
  private readonly outsiderToolsets: readonly string[];
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly envPassthrough: readonly string[];
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: HermesAdapterOptions) {
    this.binary = opts.binary;
    this.hermesProfile = opts.hermesProfile;
    this.outsiderToolsets = outsiderToolsets(opts.outsiderToolsets);
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
      agentId: 'hermes',
      agentName: 'Hermes Agent',
      command: this.binary,
      binaryPath: this.binary,
      // Hermes is a Python app: its --version is slower to answer than a Node CLI.
      timeoutMs: 20_000,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'hermes binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for HermesAdapter.run');
    const owner = opts.ownerRun === true;
    const slot: HermesSlotName = owner ? 'o' : 'x';
    const model = opts.model ?? '';
    const key = parseHermesSessionKey(opts.sessionId);
    const larkEnv = buildLarkChannelEnv(this.larkChannel, { forAgent: true });
    const env = buildAgentEnv({
      agent: 'hermes',
      overrides: {
        ...larkEnv,
        ...(process.env.HERMES_HOME ? { HERMES_HOME: process.env.HERMES_HOME } : {}),
        ...hermesSafeOverrides(opts.envOverrides),
      },
      passthrough: owner ? this.envPassthrough : [],
    });
    const prompt = prefixBridgeSystemPrompt(opts.prompt, this.botIdentity);
    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    let current: HermesChild | undefined;
    let stopped = false;

    const spawnTurn = (resume: string | undefined): HermesChild => {
      const args = buildHermesArgs({
        ...(resume ? { resume } : {}),
        ...(model ? { model } : {}),
        owner,
        outsiderToolsets: this.outsiderToolsets,
        ...(this.hermesProfile ? { hermesProfile: this.hermesProfile } : {}),
      });
      const child = spawnProcess(this.binary, args, {
        cwd: opts.cwd!,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as HermesChild;
      log.info('agent', 'spawn', {
        agent: 'hermes',
        pid: child.pid ?? null,
        cwd: opts.cwd,
        resume: Boolean(resume),
        owner,
        promptChars: opts.prompt.length,
        model: opts.model,
        ...(owner ? {} : { toolsets: this.outsiderToolsets.join(',') }),
      });
      child.on('error', (err) => log.warn('agent', 'spawn-error', { agent: 'hermes', message: err.message }));
      child.on('exit', (code, signal) => {
        log.info('agent', 'exit', { agent: 'hermes', pid: child.pid ?? null, code, signal });
      });
      child.stdin.on('error', (err) => log.warn('agent', 'stdin-error', { message: err.message }));
      child.stdin.end(prompt, 'utf8');
      current = child;
      return child;
    };

    const events = runTurns({
      spawnTurn,
      firstResume: resumeFor(key, slot, model),
      isStopped: () => stopped,
      onResult: (sessionId) =>
        sessionId ? formatHermesSessionKey(withSlot(key, slot, sessionId, model)) : opts.sessionId,
    });

    return {
      runId: opts.runId,
      events,
      async stop() {
        stopped = true;
        const child = current;
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        // SIGINT = Ctrl-C: Hermes writes its `result` (exit 130) and detaches.
        log.info('agent', 'stop-sigint', { agent: 'hermes', pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGINT');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', { agent: 'hermes', pid: child.pid ?? null, graceMs: stopGraceMs });
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
        const child = current;
        if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
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

interface RunTurnsInput {
  spawnTurn(resume: string | undefined): HermesChild;
  firstResume: string | undefined;
  isStopped(): boolean;
  /** Returns the aiduCAT session key to record for the Hermes session id. */
  onResult(hermesSessionId: string | undefined): string | undefined;
}

async function* runTurns(input: RunTurnsInput): AsyncGenerator<AgentEvent> {
  let resume = input.firstResume;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (input.isStopped()) {
      yield { type: 'done', terminationReason: 'interrupted' };
      return;
    }
    const child = input.spawnTurn(resume);
    const translator = new HermesStreamTranslator();
    const buffered: AgentEvent[] = [];
    const stderr = collectStderr(child);
    if (!child.pid) {
      const err = await spawnError(child);
      yield {
        type: 'error',
        message: `failed to spawn hermes: ${err ?? 'spawn returned no pid'}`,
        terminationReason: 'failed',
      };
      return;
    }
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
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
        const out = translator.translate(parsed);
        // A refused resume produces only init + result; hold events until we
        // know whether this attempt is real.
        if (resume && attempt === 0 && buffered.length === 0 && out.length === 0) continue;
        for (const e of out) yield e;
        buffered.push(...out);
      }
    } finally {
      rl.close();
    }
    const exitCode = await waitForExit(child);
    if (resume && attempt === 0 && buffered.length === 0 && translator.resumeRefused() && !input.isStopped()) {
      log.warn('agent', 'hermes-resume-refused-new-session', {
        reason: (translator.getResult()?.error ?? '').slice(0, 200),
      });
      resume = undefined;
      continue;
    }
    const result = translator.getResult();
    const hermesSessionId = result?.sessionId || stderr.sessionId();
    if (!result) {
      // No terminal record: killed, crashed, or failed before the protocol started.
      const sessionKey = input.onResult(hermesSessionId);
      if (input.isStopped()) {
        if (sessionKey) yield { type: 'system', sessionId: sessionKey };
        yield { type: 'done', ...(sessionKey ? { sessionId: sessionKey } : {}), terminationReason: 'interrupted' };
        return;
      }
      const detail = stderr.text().trim().slice(0, 500);
      yield {
        type: 'error',
        message: `hermes exited with code ${exitCode ?? 'null'}${detail ? `: ${detail}` : ''}`,
        terminationReason: 'failed',
      };
      return;
    }
    const sessionKey = input.onResult(hermesSessionId);
    yield* translator.finishEvents({ sessionKey, stopped: input.isStopped() });
    return;
  }
}

function collectStderr(child: HermesChild): { text(): string; sessionId(): string | undefined } {
  let all = '';
  let buf = '';
  let sid: string | undefined;
  child.stderr.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8');
    if (all.length < 64_000) all += s;
    buf += s;
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      const m = /^(?:Session|session_id):\s*(\S+)$/.exec(line);
      if (m && !sid) sid = m[1];
      else if (line && !m) log.warn('agent', 'stderr', { agent: 'hermes', line: line.slice(0, 500) });
      nl = buf.indexOf('\n');
    }
  });
  return { text: () => all, sessionId: () => sid };
}

function spawnError(child: HermesChild): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 50);
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve(err.message);
    });
  });
}

function waitForExit(child: HermesChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

/**
 * Per-run overrides from aiduCAT (lark-cli identity, /model provider env).
 *  - HERMES_*: Hermes reads some of them as launch flags — never from here.
 *  - provider endpoints/keys (/model extra providers): Hermes talks to the
 *    model service configured in its own profile, so they are not used, and a
 *    key is never put into the environment Hermes hands to its tools.
 */
function hermesSafeOverrides(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    if (/^HERMES_/i.test(k) || /^(OPENAI|ANTHROPIC|CODEX|CLAUDE)_/i.test(k) || /(KEY|TOKEN|SECRET|PASS)/i.test(k)) {
      dropped.push(k);
      continue;
    }
    out[k] = v;
  }
  if (dropped.length > 0) log.info('agent', 'hermes-env-dropped', { names: dropped.join(',') });
  return out;
}
