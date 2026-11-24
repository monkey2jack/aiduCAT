import { join } from 'node:path';
import { ClaudeAdapter } from '../agent/claude/adapter';
import { AgentPreflightError, type AgentAvailability, type LocalAgentId } from '../agent/preflight';
import type { AgentAdapter } from '../agent/types';
import type { AppPaths } from '../config/app-paths';
import { FEATURE_OFF_REPLY, featureEnabled, type AgentKind, type ProfileConfig } from '../config/profile-schema';
import type { AcquiredRuntimeLock } from './locks';

/**
 * Build the agent adapter for a profile, wiring its per-profile lark-channel env
 * (so spawned agent processes see this profile's LARKSUITE_CLI_CONFIG_DIR etc.).
 * Shared by the foreground run path and the supervisor so both produce an
 * identically-configured adapter. Each profile MUST get its own adapter — the
 * adapter stores bot identity on itself (see `setBotIdentity`).
 *
 * f03p-slim-#5/#7: async because the Codex adapter is imported on demand; a
 * codex profile whose `features.codex` is false is refused.
 */
export async function createRuntimeAgent(
  profileConfig: ProfileConfig,
  appPaths: Pick<AppPaths, 'profileDir'> &
    Partial<Pick<AppPaths, 'rootDir' | 'profile' | 'configFile' | 'larkCliConfigDir' | 'larkCliSourceConfigFile'>> & {
      configPath?: string;
    },
): Promise<AgentAdapter> {
  const larkChannelConfigPath = appPaths.configPath ?? appPaths.configFile;
  const larkChannel =
    appPaths.rootDir && appPaths.profile
      ? {
          profile: appPaths.profile,
          rootDir: appPaths.rootDir,
          ...(larkChannelConfigPath ? { configPath: larkChannelConfigPath } : {}),
          ...(appPaths.larkCliConfigDir ? { larkCliConfigDir: appPaths.larkCliConfigDir } : {}),
          ...(appPaths.larkCliSourceConfigFile
            ? { larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile }
            : {}),
        }
      : undefined;
  if (profileConfig.agentKind === 'codex') {
    if (!featureEnabled(profileConfig, 'codex')) {
      throw new Error(`${FEATURE_OFF_REPLY}：codex（profile features.codex=false）`);
    }
    const { CodexAdapter } = await import('../agent/codex/adapter');
    const codex = profileConfig.codex;
    if (!codex?.binaryPath) {
      throw new Error('codex profile requires codex.binaryPath');
    }
    return new CodexAdapter({
      binary: codex.binaryPath,
      profileStateDir: appPaths.profileDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      inheritCodexHome: codex.inheritCodexHome === true,
      ignoreUserConfig: codex.ignoreUserConfig === true,
      ignoreRules: codex.ignoreRules !== false,
      sandbox: profileConfig.sandbox.defaultMode,
      larkChannel,
      envPassthrough: profileConfig.agentEnv?.passthrough ?? [],
    });
  }
  if (profileConfig.agentKind === 'dsh') {
    const { DshAdapter } = await import('../agent/dsh/adapter');
    const { discoverDshLaunch } = await import('../agent/dsh/launch');
    const dsh = profileConfig.dsh;
    // f0.5++: find the install instead of trusting one hand-written launcher.
    // A configured binaryPath that resolves still wins (it is the operator's
    // explicit choice); otherwise probe PATH and the Desktop app.
    const launch = discoverDshLaunch(dsh?.binaryPath);
    return new DshAdapter({
      binary: launch?.command ?? dsh?.binaryPath ?? process.env.LARK_CHANNEL_DSH_BIN ?? 'dsh',
      ...(launch && launch.prefixArgs.length > 0 ? { prefixArgs: launch.prefixArgs } : {}),
      ...(launch && Object.keys(launch.env).length > 0 ? { launchEnv: launch.env } : {}),
      ...(dsh?.profile ? { dshProfile: dsh.profile } : {}),
      ...(dsh?.privatePatch ? { privatePatch: dsh.privatePatch } : {}),
      larkChannel,
      envPassthrough: profileConfig.agentEnv?.passthrough ?? [],
    });
  }
  if (profileConfig.agentKind === 'hermes') {
    if (!featureEnabled(profileConfig, 'hermes')) {
      throw new Error(`${FEATURE_OFF_REPLY}：hermes（profile features.hermes=false）`);
    }
    const { HermesAdapter } = await import('../agent/hermes/adapter');
    const hermes = profileConfig.hermes;
    return new HermesAdapter({
      binary: hermes?.binaryPath ?? process.env.LARK_CHANNEL_HERMES_BIN ?? 'hermes',
      ...(hermes?.profile ? { hermesProfile: hermes.profile } : {}),
      ...(hermes?.outsiderToolsets ? { outsiderToolsets: hermes.outsiderToolsets } : {}),
      larkChannel,
      envPassthrough: profileConfig.agentEnv?.passthrough ?? [],
    });
  }
  if (profileConfig.agentKind === 'pi') {
    const { PiAdapter } = await import('../agent/pi/adapter');
    const { writePiModelsFile, writePiSettings, PI_PROVIDER_ID, PI_DEFAULT_CONTEXT_WINDOW } = await import('../agent/pi/models-file');
    const { cachedCombos, resolveTenRouterConfig } = await import('../bot/tenrouter');
    const pi = profileConfig.pi;
    const agentDir = join(appPaths.profileDir, 'pi-agent');
    // f0.6+: the pi model catalog is the curated 10router combo list (never
    // the raw /v1/models firehose). Written at adapter construction; the
    // combo cache refreshes in the background and the next profile reload
    // rewrites the file. The API key rides `$AIDUCAT_PI_API_KEY` env
    // interpolation — it is resolved per spawn, never persisted to disk.
    let baseUrl = process.env.AIDU_10ROUTER_URL?.trim();
    if (!baseUrl) {
      try {
        const tr = await resolveTenRouterConfig({
          tenRouter: undefined,
          accounts: {},
        } as never);
        baseUrl = tr?.baseUrl;
      } catch {
        baseUrl = undefined;
      }
    }
    // Never overwrite a populated models.json with an empty combo list: on a
    // cold start the combo cache may not be warmed yet, and writing an empty
    // catalog would leave the pi child with NO models at all. Keep the
    // existing file (or a manually provisioned one) until the first real
    // combo fetch lands. Re-run before every pi spawn so a cold-start stale
    // catalog heals itself (2026-11-24: /model GPT-6-Luna "Model not found").
    const refreshCatalog = (): string[] | undefined => {
      const combos = cachedCombos() ?? [];
      if (!baseUrl || combos.length === 0) return undefined;
      const models = combos.map((c) => ({
        id: c.name,
        // gateway-reported window; unknown → 1M (Wei 2026-11-24), never
        // pi's silent 128k default
        contextWindow: c.contextWindow ?? c.gatewayWindow ?? PI_DEFAULT_CONTEXT_WINDOW,
        ...(c.maxOutput ? { maxTokens: Math.min(c.maxOutput, 32000) } : {}),
      }));
      writePiModelsFile(agentDir, {
        baseUrl: `${baseUrl.replace(/\/+$/, '')}/v1`,
        models,
      });
      writePiSettings(agentDir, models);
      return combos.map((c) => c.name);
    };
    refreshCatalog();
    // The default provider key: env AIDU_10ROUTER_API_KEY wins; otherwise the
    // profile's default modelProviders entry (id 'default') if one exists.
    let apiKey = process.env.AIDU_10ROUTER_API_KEY?.trim();
    if (!apiKey) {
      const def = profileConfig.modelProviders?.default;
      if (def) {
        try {
          const { resolveProviderKey } = await import('../bot/model-providers');
          apiKey = await resolveProviderKey(def);
        } catch {
          apiKey = undefined;
        }
      }
    }
    const prefModel = (profileConfig as { preferences?: { model?: string } }).preferences?.model;
    return new PiAdapter({
      binary: pi?.binaryPath ?? process.env.LARK_CHANNEL_PI_BIN ?? 'pi',
      agentDir,
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(prefModel ? { model: prefModel } : {}),
      larkChannel,
      envPassthrough: profileConfig.agentEnv?.passthrough ?? [],
      refreshCatalog,
    });
  }
  if (profileConfig.agentKind === 'opencode' || profileConfig.agentKind === 'openchamber') {
    const { OpencodeAdapter } = await import('../agent/opencode/adapter');
    const opencode = profileConfig.opencode;
    return new OpencodeAdapter({
      binary: opencode?.binaryPath ?? process.env.LARK_CHANNEL_OPENCODE_BIN ?? 'opencode',
      ...(opencode?.serverUrl ? { serverUrl: opencode.serverUrl } : {}),
      ...(opencode?.password ? { password: opencode.password } : {}),
      ...(opencode?.username ? { username: opencode.username } : {}),
      larkChannel,
      envPassthrough: profileConfig.agentEnv?.passthrough ?? [],
    });
  }
  return new ClaudeAdapter({
    larkChannel,
    envPassthrough: profileConfig.agentEnv?.passthrough ?? [],
    // f0.4 之后的修复: extra paths non-owner runs may not read.
    outsiderDenyRead: profileConfig.access.outsiderDenyRead ?? [],
  });
}

export async function checkRuntimeAgentAvailability(agent: AgentAdapter): Promise<AgentAvailability> {
  if (agent.checkAvailability) return agent.checkAvailability();
  const ok = await agent.isAvailable();
  if (ok) return { ok: true };
  // The binary named in the diagnostic must match the reported agent id, or a
  // DSH profile with a missing launcher is misdiagnosed as `claude`.
  const agentId: LocalAgentId =
    agent.id === 'codex' || agent.id === 'hermes' || agent.id === 'dsh' || agent.id === 'opencode' || agent.id === 'openchamber' || agent.id === 'pi' ? agent.id : 'claude';
  const diagnostic = {
    code: 'agent-binary-not-found' as const,
    agentId,
    agentName: agent.displayName,
    command: agentId,
  };
  return { ok: false, diagnostic, error: new AgentPreflightError(diagnostic) };
}

/** Guard: reconnect/restart must not switch a profile's agent kind mid-flight. */
export function assertReconnectAgentKindUnchanged(
  current: AgentKind | undefined,
  next: AgentKind | undefined,
): void {
  const currentKind = current ?? 'claude';
  const nextKind = next ?? 'claude';
  if (nextKind !== currentKind) {
    throw new Error(
      `agent kind cannot change during reconnect (${currentKind} -> ${nextKind}); stop/start is required`,
    );
  }
}

/** Release a set of runtime locks, swallowing individual failures. */
export async function releaseRuntimeLocks(locks: AcquiredRuntimeLock[]): Promise<void> {
  for (const lock of locks) {
    await lock.release().catch(() => undefined);
  }
}
