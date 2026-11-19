import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedMessage } from "@larksuite/channel";
import { ActiveRuns } from "../../../src/bot/active-runs.js";
import {
  tryHandleCommand,
  type CommandContext,
  type Controls,
} from "../../../src/commands/index.js";
import { createDefaultProfileConfig, type ProfileConfig } from "../../../src/config/profile-schema.js";
import { createRootConfig, loadRootConfig, saveRootConfig } from "../../../src/config/profile-store.js";
import { SessionStore } from "../../../src/session/store.js";
import { WorkspaceStore } from "../../../src/workspace/store.js";
import { createFakeAgent } from "../../helpers/fake-agent.js";
import { createFakeChannel, type FakeChannel } from "../../helpers/fake-channel.js";
import { createTmpProfile } from "../../helpers/tmp-profile.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

interface Opts {
  sender?: string;
  formValue?: Record<string, unknown>;
  card?: boolean;
}

async function harness() {
  const tmp = await createTmpProfile("oc-model-");
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, "sessions.json"));
  const workspaces = new WorkspaceStore(join(tmp.profile, "workspaces.json"));
  const agent = createFakeAgent();
  const profileConfig: ProfileConfig = createDefaultProfileConfig({
    agentKind: "openchamber",
    accounts: { app: { id: "app-id", secret: "secret", tenant: "feishu" } },
    access: { admins: ["ou-admin"], allowedUsers: ["ou-user"] },
    preferences: { model: "default" },
  });
  profileConfig.opencode = { binaryPath: "opencode.exe" };
  const configPath = join(tmp.root, "config.json");
  await saveRootConfig(createRootConfig("openchamber", profileConfig), configPath);
  const controls = {
    profile: "openchamber",
    profileConfig,
    botOwnerId: "ou-owner",
    ownerRefreshState: "ok",
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath,
    cfg: profileConfig,
    processId: "proc-1",
  } satisfies Controls;
  const ctx = (content: string, o: Opts = {}): CommandContext => ({
    channel: channel as unknown as CommandContext["channel"],
    msg: {
      messageId: "om-12345",
      chatId: "oc-dm",
      chatType: "p2p",
      senderId: o.sender ?? "ou-admin",
      senderName: "U",
      content,
      rawContentType: o.card ? "interactive" : "text",
      resources: [],
      mentions: [],
      mentionedBot: false,
    } as unknown as NormalizedMessage,
    scope: "oc-dm",
    chatMode: "p2p",
    sessions,
    workspaces,
    agent,
    activeRuns: new ActiveRuns(),
    controls,
    ...(o.formValue ? { formValue: o.formValue } : {}),
    ...(o.card ? { fromCardAction: true } : {}),
  });
  const run = (content: string, o: Opts = {}) => tryHandleCommand(ctx(content, o));
  const disk = async () => (await loadRootConfig(configPath))!.profiles.openchamber!.preferences;
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { channel, run, disk };
}

const lastText = (c: FakeChannel) => JSON.stringify(c.sent.at(-1)?.content ?? {});

describe("openchamber /model card", () => {
  it("/model lists OpenCode free models and does not say 暂时取不到模型列表", async () => {
    const h = await harness();
    await expect(h.run("/model")).resolves.toBe(true);
    const card = lastText(h.channel);
    expect(card).toContain("Hunyuan 4 Flash · Free");
    expect(card).toContain("DeepSeek V4.1 Flash · Free");
    expect(card).toContain("opencode/hy4-flash-free");
    expect(card).not.toContain("暂时取不到模型列表");
  });

  it("submitting model and effort persists them", async () => {
    const h = await harness();
    await h.run("/model submit", {
      card: true,
      formValue: { combo: "opencode/hy4-flash-free", effort: "high" },
    });
    const prefs = await h.disk();
    expect(prefs.model).toBe("opencode/hy4-flash-free");
    expect(prefs.effort).toBe("high");
  });

  it("/new displays active model name, not internal default sentinel", async () => {
    const h = await harness();
    await h.run("/new");
    const text = lastText(h.channel);
    expect(text).toContain("hy4-flash-free");
    expect(text).not.toContain("模型 default");
  });
});
