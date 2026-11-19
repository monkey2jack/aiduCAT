import type { AccessMode } from "../config/permissions";
import type { ProfileConfig } from "../config/profile-schema";
import { BRIDGE_SYSTEM_PROMPT } from "./bridge-system-prompt";

export type AgentCapabilityId = "claude" | "codex" | "hermes" | "dsh" | "opencode" | "openchamber";
export type AgentSessionKind = "claude-session" | "codex-thread" | "hermes-session" | "dsh-session" | "opencode-session";
export type PromptInjectionMode = "append-system-prompt" | "stdin-prefix";

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  callback: {
    marker: "__bridge_cb";
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

export function claudeCapability(profile?: Pick<ProfileConfig, "permissions">): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? "workspace";
  return {
    agentId: "claude",
    sessionKind: "claude-session",
    promptInjection: "append-system-prompt",
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    callback: {
      marker: "__bridge_cb",
      legacyMarkers: ["__claude_cb"],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function codexCapability(profile: Pick<ProfileConfig, "permissions">): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: "codex",
    sessionKind: "codex-thread",
    promptInjection: "stdin-prefix",
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: "__bridge_cb",
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

/**
 * f0.4+: Hermes Agent. Sessions are resumed by id like Claude Code"s
 * (`hermes chat --resume <id>`), the bridge prompt rides on stdin like Codex.
 */
export function hermesCapability(profile: Pick<ProfileConfig, "permissions">): AgentCapability {
  return {
    agentId: "hermes",
    sessionKind: "hermes-session",
    promptInjection: "stdin-prefix",
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: "__bridge_cb",
      legacyMarkers: [],
    },
    permissions: {
      maxAccess: profile.permissions.maxAccess,
    },
  };
}

/**
 * DSH (DeepSeek Harness). One headless process per turn, resumed by session
 * id like Claude Code / Hermes; the bridge prompt rides on stdin (`-`).
 */
export function dshCapability(profile: Pick<ProfileConfig, "permissions">): AgentCapability {
  return {
    agentId: "dsh",
    sessionKind: "dsh-session",
    promptInjection: "stdin-prefix",
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: "__bridge_cb",
      legacyMarkers: [],
    },
    permissions: {
      maxAccess: profile.permissions.maxAccess,
    },
  };
}

/**
 * OpenCode / OpenChamber Agent. One headless process per turn, resumed by session
 * id via `-s <sessionId>`; the prompt is fed through stdin.
 */
export function opencodeCapability(profile: Pick<ProfileConfig, "permissions">): AgentCapability {
  return {
    agentId: "opencode",
    sessionKind: "opencode-session",
    promptInjection: "stdin-prefix",
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    callback: {
      marker: "__bridge_cb",
      legacyMarkers: [],
    },
    permissions: {
      maxAccess: profile.permissions.maxAccess,
    },
  };
}

/** f0.4+: the capability for a profile"s agent kind. */
export function capabilityFor(
  profile: Pick<ProfileConfig, "permissions" | "agentKind">,
): AgentCapability {
  if (profile.agentKind === "codex") return codexCapability(profile);
  if (profile.agentKind === "hermes") return hermesCapability(profile);
  if (profile.agentKind === "dsh") return dshCapability(profile);
  if (profile.agentKind === "opencode" || profile.agentKind === "openchamber") return opencodeCapability(profile);
  return claudeCapability(profile);
}

/**
 * f0.4+: agents whose conversation is resumed by a session id (not a Codex
 * thread). f0.5++: DSH (DeepSeek Harness) adopts a persisted Session through
 * `--session-id`, so it belongs here — this function is the single source of
 * truth every session save/resume path consults.
 */
export function usesSessionId(agentId: string | undefined): boolean {
  return (
    agentId === "claude" ||
    agentId === "hermes" ||
    agentId === "dsh" ||
    agentId === "opencode" ||
    agentId === "openchamber"
  );
}
