import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import { Supervisor } from '../../../src/runtime/supervisor';
import { listAllProfiles } from '../../../src/runtime/profile-discovery';

const roots: string[] = [];
const started: string[] = [];
const disconnected: string[] = [];
let root: string;
let sup: Supervisor;

function app(id: string) {
  return { id, secret: '${APP_SECRET}', tenant: 'feishu' as const };
}

// Stub startChannel — no network, records lifecycle, returns a minimal bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stubStartChannel: any = async (deps: any) => {
  started.push(deps.appPaths.profile);
  return {
    channel: { botIdentity: { name: `bot-${deps.appPaths.profile}` } },
    disconnect: async () => {
      disconnected.push(deps.appPaths.profile);
    },
  };
};

beforeEach(async () => {
  started.length = 0;
  disconnected.length = 0;
  root = await mkdtemp(join(tmpdir(), 'bridge-sup-'));
  roots.push(root);
  const configPath = join(root, 'config.json');

  // claude (cli_a), work (cli_b), dup (cli_b — same app as work).
  await mkdir(join(root, 'profiles', 'claude'), { recursive: true });
  await saveRootConfig(
    createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: app('cli_a') } })),
    configPath,
  );
  const rc = (await loadRootConfig(configPath))!;
  for (const [name, id] of [['work', 'cli_b'], ['dup', 'cli_b']] as const) {
    await mkdir(join(root, 'profiles', name), { recursive: true });
    rc.profiles[name] = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: app(id) } });
  }
  await saveRootConfig(rc, configPath);

  sup = new Supervisor({ configPath, rootDir: root, runPreflight: false, startChannelFn: stubStartChannel });
});

afterEach(async () => {
  await sup.shutdown();
  // f031 merge: app paths put the default workspace in a sibling `<root>-workspaces` dir; remove it too.
  await Promise.all(
    roots.splice(0).flatMap((r) => [r, `${r}-workspaces`].map((d) => rm(d, { recursive: true, force: true }))),
  );
});

describe('Supervisor', () => {
  it('starts a profile in-process and lists it online', async () => {
    await sup.startProfile('claude');
    expect(sup.isOnline('claude')).toBe(true);
    expect(started).toContain('claude');
    const list = sup.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ profile: 'claude', online: true, pid: process.pid, botName: 'bot-claude' });
  });

  it('hosts multiple profiles at once', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('work');
    expect(sup.list().map((s) => s.profile).sort()).toEqual(['claude', 'work']);
  });

  it('stops one profile without affecting others or the process', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('work');
    await sup.stopProfile('claude');
    expect(sup.isOnline('claude')).toBe(false);
    expect(disconnected).toContain('claude');
    expect(sup.isOnline('work')).toBe(true); // supervisor + other profile still up
  });

  it('refuses to bring up two profiles sharing one app id', async () => {
    await sup.startProfile('work'); // cli_b
    await expect(sup.startProfile('dup')).rejects.toThrow(/已被 profile/);
    expect(sup.isOnline('dup')).toBe(false);
  });

  it('startProfile is idempotent', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('claude');
    expect(started.filter((p) => p === 'claude')).toHaveLength(1);
  });
});

describe('Supervisor auto-start flag (#5)', () => {
  it('stopProfile sets autoStart=false; startProfile clears it', async () => {
    await sup.startProfile('claude');
    const loaded1 = (await loadRootConfig(join(root, 'config.json')))!;
    expect(loaded1.profiles['claude']?.autoStart).not.toBe(false);

    await sup.stopProfile('claude');
    const loaded2 = (await loadRootConfig(join(root, 'config.json')))!;
    expect(loaded2.profiles['claude']?.autoStart).toBe(false);

    await sup.startProfile('claude');
    const loaded3 = (await loadRootConfig(join(root, 'config.json')))!;
    expect(loaded3.profiles['claude']?.autoStart).not.toBe(false);
  });

  it('stopProfile on a profile that was never started does not throw', async () => {
    await expect(sup.stopProfile('work')).resolves.not.toThrow();
  });

  it('a fresh supervisor skips autoStart=false profiles but still boots the rest', async () => {
    // User stops 'claude' on purpose; 'work' stays auto-start.
    await sup.startProfile('claude');
    await sup.stopProfile('claude');

    const profiles = await listAllProfiles(root);
    expect(profiles.find((p) => p.name === 'claude')?.autoStart).toBe(false);
    expect(profiles.find((p) => p.name === 'work')?.autoStart).toBe(true);

    // Same loop the daemon runs at boot: start every autoStart profile, each
    // isolated. The fixture's `dup`/`work` share one app id, so one of them
    // fails the app-id dedupe; the loop must carry on (mirrors start.ts).
    const fresh = new Supervisor({
      configPath: join(root, 'config.json'),
      rootDir: root,
      runPreflight: false,
      startChannelFn: stubStartChannel,
    });
    for (const p of profiles.filter((p) => p.autoStart)) {
      await fresh.startProfile(p.name).catch(() => undefined);
    }

    // `claude` was stopped on purpose -> stays offline.
    expect(fresh.isOnline('claude')).toBe(false);
    // Exactly one of the two explicit-autoStart profiles with this app id is up.
    expect(fresh.isOnline('work') !== fresh.isOnline('dup')).toBe(true);
    await fresh.shutdown();
  });
});
