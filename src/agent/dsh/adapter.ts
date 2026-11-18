import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { readDshProfileModels, resolveDshProfileName } from '../models';
import { syncModelRoutingFromDesktop } from './profile-sync';
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
  /**
   * argv prepended before DSH's own arguments. The Desktop install needs
   * `--expose-internals <cli.js>`; an npm `dsh` needs nothing.
   */
  prefixArgs?: readonly string[];
  /** Extra environment this launch shape needs (`ELECTRON_RUN_AS_NODE=1`). */
  launchEnv?: Readonly<Record<string, string>>;
  /** DSH profile under $DSH_HOME/profiles. */
  dshProfile?: string;
  /**
   * f0.5++: absolute path to a static patch overlay carried by **p2p turns
   * only** — the private monkey's extra tools (e.g. the aiduMEI memory MCP the
   * desktop profile carries). Group/topic and non-IM turns never receive it.
   * A missing or unreadable file soft-fails: the turn runs without the overlay.
   */
  privatePatch?: string;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
  envPassthrough?: readonly string[];
}

type DshChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh';
  readonly displayName = 'DeepSeek Harness';

  private readonly binary: string;
  private readonly prefixArgs: readonly string[];
  private readonly launchEnv: Readonly<Record<string, string>>;
  private readonly dshProfile: string | undefined;
  private readonly privatePatch: string | undefined;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly envPassthrough: readonly string[];
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: DshAdapterOptions) {
    this.binary = opts.binary;
    this.prefixArgs = opts.prefixArgs ?? [];
    this.launchEnv = opts.launchEnv ?? {};
    this.dshProfile = resolveDshProfileName(opts.dshProfile);
    this.privatePatch = opts.privatePatch;
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
      args: [...this.prefixArgs, '--version'],
      ...(Object.keys(this.launchEnv).length > 0 ? { env: { ...this.launchEnv } } : {}),
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
    // Follow the desktop GUI's model settings for this turn. Cheap when the
    // source is unchanged (one stat), and soft-failing: a bad source leaves the
    // previous routing in place rather than making the turn unrunnable.
    const synced = syncModelRoutingFromDesktop(this.dshProfile);
    if (synced.status === 'written') {
      log.info('agent', 'dsh-profile-synced', { from: 'desktop', target: synced.target });
    } else if (
      synced.status === 'source-invalid' ||
      synced.status === 'source-missing' ||
      synced.status === 'target-unsafe' ||
      synced.status === 'target-missing' ||
      synced.status === 'target-unmanaged' ||
      synced.status === 'write-failed'
    ) {
      // Not fatal: the run profile stays as it is and the turn still starts.
      log.warn('agent', 'dsh-profile-sync-skipped', { reason: synced.status, source: synced.source });
    }
    const model = opts.model ?? '';
    // DSH has no `--model`; a non-default pick rides in as a `--patch` overlay
    // that replaces the profile's `agent-default-model` row.
    const modelPatch = model && model !== 'default' ? writeDshModelPatch(model, this.dshProfile) : undefined;
    // f0.5++ 真假猴王 fix: the private overlay rides on **p2p turns only** —
    // the DM monkey carries the desktop profile's tool set; groups stay clean.
    const turnPatch = resolveTurnPatch({
      modelPatch,
      privatePatchPath: this.privatePatch,
      isPrivate: opts.chatType === 'p2p',
      turnPatchDir: process.env.DSH_HOME?.trim()
        ? join(process.env.DSH_HOME.trim(), 'aiducat-turn-patches')
        : undefined,
    });
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
      ...(turnPatch.patch ? { patch: turnPatch.patch } : {}),
      ...(opts.sessionId ? { resume: opts.sessionId } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      // Headless has no live approval channel, so an unattended bridged turn
      // must never park waiting for one.
      approvalPolicy: DSH_UNATTENDED_APPROVAL,
    });
    const child = spawnProcess(this.binary, [...this.prefixArgs, ...args], {
      cwd: opts.cwd,
      env: { ...env, ...this.launchEnv },
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
      model: modelPatch ? model : 'profile-default',
      privatePatch: turnPatch.privateApplied,
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
 * Compose this turn's single `--patch` overlay (f0.5++ 真假猴王 fix).
 *
 * The private patch (`dsh.privatePatch`) rides on **p2p turns only** — the
 * owner's DM monkey carries the desktop profile's tool set (e.g. the aiduMEI
 * memory MCP), while group/topic and non-IM runs stay clean of it. `--patch`
 * is a single launcher flag, so when a /model overlay also applies the two
 * documents are merged into one stable file (model rows first, private
 * directives after — the same shape the desktop profile's own patch uses).
 *
 * Soft-fail: a missing or unreadable private file downgrades the turn to the
 * model patch (or none) instead of failing the chat.
 */
export function resolveTurnPatch(input: {
  modelPatch: string | undefined;
  privatePatchPath: string | undefined;
  isPrivate: boolean;
  /** Directory for merged overlays; a merge need is skipped when unset. */
  turnPatchDir?: string;
}): { patch: string | undefined; privateApplied: boolean } {
  if (!input.isPrivate || !input.privatePatchPath) {
    return { patch: input.modelPatch, privateApplied: false };
  }
  let privateContent: string;
  try {
    privateContent = readFileSync(input.privatePatchPath, 'utf8');
  } catch (err) {
    log.warn('agent', 'dsh-private-patch-skipped', {
      path: input.privatePatchPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return { patch: input.modelPatch, privateApplied: false };
  }
  if (!input.modelPatch) return { patch: input.privatePatchPath, privateApplied: true };
  if (!input.turnPatchDir) {
    log.warn('agent', 'dsh-private-patch-merge-skipped', { reason: 'DSH_HOME is unset' });
    return { patch: input.modelPatch, privateApplied: false };
  }
  try {
    const modelContent = readFileSync(input.modelPatch, 'utf8');
    const safe = basename(input.modelPatch).replace(/\.yml$/i, '');
    mkdirSync(input.turnPatchDir, { recursive: true });
    const file = join(input.turnPatchDir, `${safe}.with-private.yml`);
    const glue = modelContent.endsWith('\n') || privateContent.startsWith('\n') ? '' : '\n';
    writeFileSync(file, `${modelContent}${glue}${privateContent}`, 'utf8');
    return { patch: file, privateApplied: true };
  } catch (err) {
    log.warn('agent', 'dsh-private-patch-merge-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { patch: input.modelPatch, privateApplied: false };
  }
}

/**
 * Write the `--patch` overlay that switches this turn's DSH model.
 *
 * DSH has no `--model` flag: the model is the profile's `agent-default-model`
 * row, and a patch REPLACES that row's whole config — so the provider must be
 * restated from the profile, not just the model id. The overlay is written once
 * per model id (filenames are derived from it) so a long-lived deployment does
 * not accumulate files.
 *
 * Returns undefined when the switch cannot be expressed, in which case the turn
 * runs on the profile default rather than failing: a config that hides its
 * provider must not break chatting.
 */
function writeDshModelPatch(model: string, configuredProfile: string | undefined): string | undefined {
  const { provider } = readDshProfileModels(configuredProfile);
  if (!provider) {
    log.warn('agent', 'dsh-model-patch-skipped', { model, reason: 'profile declares no provider' });
    return undefined;
  }
  const home = process.env.DSH_HOME?.trim();
  if (!home) {
    log.warn('agent', 'dsh-model-patch-skipped', { model, reason: 'DSH_HOME is unset' });
    return undefined;
  }
  const dir = join(home, 'aiducat-model-patches');
  const safe = model.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  const file = join(dir, `${safe}.yml`);
  // Quote both scalars: a quoted value is always a YAML string, so a model id
  // that looks like a number or boolean can never be re-typed.
  const body = [
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    `    provider: "${provider.replace(/"/g, '\\"')}"`,
    `    model: "${model.replace(/"/g, '\\"')}"`,
    '',
  ].join('\n');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, body, 'utf8');
    return file;
  } catch (err) {
    log.warn('agent', 'dsh-model-patch-failed', {
      model,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
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
