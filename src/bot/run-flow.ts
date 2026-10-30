import type { AgentCapability } from '../agent/capability';
import { resolveModelArg } from '../agent/models';
import type { AgentEvent } from '../agent/types';
import type { ProfileConfig } from '../config/profile-schema';
import type { AccessDecision } from '../policy/access';
import {
  evaluateRunPolicy,
  type AgentAttachment,
  type RunPolicyAllow,
  type RunPolicyReject,
  type ScopeContext,
} from '../policy/run-policy';
import {
  resolveWorkingDirectory,
  type WorkingDirectoryRejectReason,
  type WorkingDirectoryResolveResult,
} from '../policy/workspace';
import type { RunExecution, RunExecutor } from '../runtime/run-executor';
import { RunRejected, type RunRejectedCode } from '../runtime/errors';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';

export interface StartRunFlowInput {
  scopeId: string;
  scope: ScopeContext;
  prompt: string;
  attachments: AgentAttachment[];
  access: AccessDecision;
  capability: AgentCapability;
  profileConfig: ProfileConfig;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  executor: RunExecutor;
  now: number;
  stopGraceMs?: number;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
  /** f0.2+: declared context window of the selected model (from the 10router
   * combo catalog). Drives the 60% auto-compact env; optional — the per-run
   * env just falls back to the service default when absent. */
  modelWindow?: number;
}

export type RunFlowRejectCode =
  | WorkingDirectoryRejectReason
  | RunPolicyReject['rejectReason']['code']
  | RunRejectedCode;

export type StartRunFlowResult =
  | {
      ok: true;
      execution: RunExecution;
      policy: RunPolicyAllow;
      cwdRealpath: string;
      resumeFrom?: string;
    }
  | {
      ok: false;
      rejectReason: {
        code: RunFlowRejectCode;
        userVisible: string;
      };
      workspace?: WorkingDirectoryResolveResult;
    };

export interface RecordRunSessionEventInput {
  scopeId: string;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  capability: AgentCapability;
  policy: RunPolicyAllow;
  event: AgentEvent;
}

export async function startRunFlow(input: StartRunFlowInput): Promise<StartRunFlowResult> {
  const requestedCwd =
    input.workspaces.cwdFor(input.scopeId) ?? input.profileConfig.workspaces.default ?? '';
  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) {
    return {
      ok: false,
      rejectReason: {
        code: workspace.reason,
        userVisible: workspace.userVisible,
      },
      workspace,
    };
  }

  const policy = evaluateRunPolicy({
    scope: input.scope,
    attachments: input.attachments,
    prompt: input.prompt,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: input.access,
    capability: input.capability,
    profileConfig: input.profileConfig,
    now: input.now,
    codexHome: input.profileConfig.codex?.codexHome,
    inheritCodexHome: input.profileConfig.codex?.inheritCodexHome,
  });
  if (!policy.ok) {
    return {
      ok: false,
      rejectReason: policy.rejectReason,
      workspace,
    };
  }

  let resumeFrom: string | undefined;
  let sessionId: string | undefined;
  let threadId: string | undefined;
  if (input.sessionCatalog) {
    const catalogEntry = input.sessionCatalog.activeFor({
      scopeId: input.scopeId,
      agentId: input.capability.agentId,
      cwdRealpath: workspace.cwdRealpath,
      policyFingerprint: policy.policyFingerprint,
    });
    if (catalogEntry?.agentId === 'claude') {
      sessionId = catalogEntry.sessionId;
      resumeFrom = sessionId;
    } else if (catalogEntry?.agentId === 'codex') {
      threadId = catalogEntry.threadId;
      resumeFrom = threadId;
    }
  }
  if (!resumeFrom && input.capability.agentId === 'claude') {
    resumeFrom = input.sessions.resumeFor(input.scopeId, workspace.cwdRealpath);
    sessionId = resumeFrom;
    const stale = input.sessions.getRaw(input.scopeId);
    if (!resumeFrom && stale?.cwd && stale.cwd !== workspace.cwdRealpath) {
      input.sessions.clear(input.scopeId);
    }
  }

  let execution: RunExecution;
  try {
    execution = await input.executor.submit({
      scopeId: input.scopeId,
      policy,
      sessionId,
      threadId,
      model: resolveModelArg(
        input.profileConfig.agentKind,
        input.profileConfig.preferences.model,
      ),
      // f0.2: non-default provider → per-run credential overrides. `wire`
      // decides which env family the agent CLI reads (claude: ANTHROPIC_*,
      // codex: OPENAI_*). Resolution is async and failure-safe: on key
      // errors we log and fall back to the inherited service env.
      // Must land on `envOverrides` — spreading the map at the top level
      // turned ANTHROPIC_BASE_URL etc. into stray SubmitRunInput keys that
      // nothing read, so --model switched but the endpoint did not.
      envOverrides: await (async () => {
        // f0.2+ 猴哥点单 (2026-10-21): auto-compact follows the MODEL's
        // declared window at a fixed 60% — never a hard-coded token count.
        // A 1M combo compacts at 600k, a 500k model at 300k, so an undersized
        // gateway model can never overflow before compaction fires.
        const base = (await runProviderEnvOverrides(
          input.profileConfig.modelProviders,
          input.profileConfig.preferences.provider,
          input.capability.agentId,
        )) ?? {};
        const win = input.modelWindow;
        const pct = Number(process.env.AIDUCAT_COMPACT_PCT ?? 60);
        if (win && pct > 0 && pct <= 100) {
          base.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(
            Math.round((win * pct) / 100),
          );
        }
        return base;
      })(),
      // aiduCAT: forward the stored reasoning effort (claude forwards as --effort,
      // codex forwards as -c model_reasoning_effort="..."). If claude is set to
      // 'ultra' (supported on codex), automatically coerce to 'max' to avoid CLI warnings.
      effort:
        input.capability.agentId === 'claude'
          ? input.profileConfig.preferences.effort === 'ultra'
            ? 'max'
            : input.profileConfig.preferences.effort
          : input.profileConfig.preferences.effort,
      images:
        input.capability.agentId === 'codex'
          ? policy.attachments
              .filter((attachment) => attachment.kind === 'image' && attachment.decision === 'accepted')
              .map((attachment) => attachment.path)
              .filter((path): path is string => Boolean(path))
          : undefined,
      stopGraceMs: input.stopGraceMs,
      observability: input.observability,
    });
  } catch (err) {
    if (err instanceof RunRejected) {
      return {
        ok: false,
        rejectReason: {
          code: err.code,
          userVisible:
            err.code === 'reconnect-in-progress'
              ? '当前 bot 正在重连，稍后会继续处理新消息。'
              : err.code === 'run-already-active'
                ? '当前会话已有运行在执行，请稍后再试或先停止当前运行。'
              : '当前无法发起运行，请稍后重试。',
        },
        workspace,
      };
    }
    throw err;
  }

  return {
    ok: true,
    execution,
    policy,
    cwdRealpath: workspace.cwdRealpath,
    ...(resumeFrom ? { resumeFrom } : {}),
  };
}

export function recordRunSessionEvent(input: RecordRunSessionEventInput): void {
  if (input.event.type !== 'system') return;
  if (input.capability.agentId === 'claude' && input.event.sessionId) {
    const cwdRealpath = input.event.cwd ?? input.policy.cwdRealpath;
    input.sessions.set(input.scopeId, input.event.sessionId, cwdRealpath);
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: 'claude',
      cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      sessionId: input.event.sessionId,
    });
    return;
  }
  if (input.capability.agentId === 'codex' && input.event.threadId) {
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: 'codex',
      cwdRealpath: input.policy.cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      threadId: input.event.threadId,
    });
  }
}

/**
 * f0.2: env overrides for a non-default /model provider.
 *
 * `wire` picks the env family the agent CLI reads — claude consumes
 * ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY (+ ANTHROPIC_MODEL harmless), codex
 * consumes OPENAI_BASE_URL/OPENAI_API_KEY. Key resolution mirrors
 * model-providers.resolveProviderKey; a failure logs and returns no override
 * so the run continues on the service env instead of erroring.
 */
export async function runProviderEnvOverrides(
  providers: ProfileConfig['modelProviders'],
  providerId: string | undefined,
  agentId: 'claude' | 'codex' | string,
): Promise<Record<string, string> | undefined> {
  if (!providerId || providerId === 'default') return undefined;
  const def = providers?.[providerId];
  if (!def) return undefined;
  const { resolveProviderKey } = await import('./model-providers');
  const key = await resolveProviderKey(def);
  if (!key) {
    console.warn(
      JSON.stringify({ area: 'provider', msg: 'key-unresolved-fallback-default', provider: providerId }),
    );
    return undefined;
  }
  const base: Record<string, string> = {
    ...(def.contextWindow ? {} : {}),
  };
  if (def.wire === 'anthropic') {
    base.ANTHROPIC_BASE_URL = def.baseUrl;
    base.ANTHROPIC_API_KEY = key;
    if (def.contextWindow) base.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(def.contextWindow);
  } else {
    base.OPENAI_BASE_URL = def.baseUrl;
    base.OPENAI_API_KEY = key;
    if (def.contextWindow) base.CODEX_CONTEXT_WINDOW = String(def.contextWindow);
  }
  if (def.env && typeof def.env === 'object') {
    for (const [k, v] of Object.entries(def.env)) {
      if (/^[A-Z_][A-Z0-9_]*$/.test(k) && typeof v === 'string') base[k] = v;
    }
  }
  void agentId;
  return base;
}
