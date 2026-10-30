import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// f031-stab-#296 (upstream issue #296, unfixed upstream): `/invite group`
// saved the chat to config.json and acked, yet later group messages kept being
// rejected as `denied-chat` until a restart. Root cause: every reconnect
// (keepalive force-reconnect, /account) built a NEW Controls object for the new
// channel while the old listener — still delivering events until its socket
// really closed, or for good if its disconnect failed — kept the old one. An
// /invite handled on one listener updated only its own object; the other one
// kept deciding with the stale allowlist. All Controls of a profile must read
// one live config.

vi.mock('../../../src/runtime/agent-runtime', async (orig) => {
  const real = await orig<typeof import('../../../src/runtime/agent-runtime')>();
  return {
    ...real,
    checkRuntimeAgentAvailability: async () => ({ ok: true }),
  };
});

const { createDefaultProfileConfig } = await import('../../../src/config/profile-schema');
const { createRootConfig, saveRootConfig, loadRootConfig } = await import('../../../src/config/profile-store');
const { Supervisor } = await import('../../../src/runtime/supervisor');
const configOps = await import('../../../src/config/config-ops');
const { canUseGroup } = await import('../../../src/policy/access');

const roots: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const controlsSeen: any[] = [];
let sup: InstanceType<typeof Supervisor>;
let configPath: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stubStartChannel: any = async (deps: any) => {
  controlsSeen.push(deps.controls);
  return { channel: { botIdentity: { name: 'bot' } }, disconnect: async () => {} };
};

beforeEach(async () => {
  controlsSeen.length = 0;
  const root = await mkdtemp(join(tmpdir(), 'f031-stab-invite-'));
  roots.push(root);
  configPath = join(root, 'config.json');
  await mkdir(join(root, 'profiles', 'claude'), { recursive: true });
  await saveRootConfig(
    createRootConfig(
      'claude',
      createDefaultProfileConfig({
        agentKind: 'claude',
        accounts: { app: { id: 'cli_a', secret: '${APP_SECRET}', tenant: 'feishu' } },
        // f031 merge: since f031-sec-#3 the sender must be allowlisted too, so the
        // member is an allowed user — only the group allowlist is under test here.
        access: { allowedUsers: ['ou_member'] },
      }),
    ),
    configPath,
  );
  sup = new Supervisor({ configPath, rootDir: root, runPreflight: false, startChannelFn: stubStartChannel });
  await sup.startProfile('claude');
});

afterEach(async () => {
  await sup.shutdown();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const allowed = (c: { profileConfig: Parameters<typeof canUseGroup>[0] }) =>
  canUseGroup(c.profileConfig, c as never, 'oc_group', 'ou_member').ok;

describe('f031-stab-#296 /invite group takes effect on every live listener', () => {
  it('f031-stab-#296 invite saved via the NEW channel is seen by the old listener', async () => {
    const [before] = controlsSeen;
    await before.restart();
    const after = controlsSeen.at(-1);
    expect(after).toBeDefined();
    await configOps.saveAccessConfig(after, (a) => ({ ...a, allowedChats: [...a.allowedChats, 'oc_group'] }));
    expect(allowed(after)).toBe(true);
    expect(allowed(before)).toBe(true);
  });

  it('f031-stab-#296 invite saved via the OLD listener is seen by the new channel, and /remove too', async () => {
    const [before] = controlsSeen;
    await before.restart();
    const after = controlsSeen.at(-1);
    await configOps.saveAccessConfig(before, (a) => ({ ...a, allowedChats: [...a.allowedChats, 'oc_group'] }));
    expect(allowed(after)).toBe(true);
    await configOps.saveAccessConfig(after, (a) => ({
      ...a,
      allowedChats: a.allowedChats.filter((c) => c !== 'oc_group'),
    }));
    expect(allowed(before)).toBe(false);
    expect(allowed(after)).toBe(false);
    const disk = await loadRootConfig(configPath);
    expect(disk?.profiles.claude?.access.allowedChats).toEqual([]);
  });
});
