import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { Supervisor } from '../../../src/runtime/supervisor';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).flatMap((r) => [r, `${r}-workspaces`].map((d) => rm(d, { recursive: true, force: true }))));
});

async function make(prefs: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'f03p-sup-'));
  roots.push(root);
  const configPath = join(root, 'config.json');
  await mkdir(join(root, 'profiles', 'claude'), { recursive: true });
  const cfg = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'cli_a', secret: '${S}', tenant: 'feishu' } } });
  cfg.preferences = { ...cfg.preferences, ...prefs } as never;
  await saveRootConfig(createRootConfig('claude', cfg), configPath);
  const calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const startChannelFn: any = async () => ({
    channel: { botIdentity: { name: 'bot' } },
    drain: async (ms: number) => {
      calls.push(`drain:${ms}`);
      return { drained: true, remaining: 0 };
    },
    disconnect: async () => {
      calls.push('disconnect');
    },
  });
  const sup = new Supervisor({ configPath, rootDir: root, runPreflight: false, startChannelFn });
  await sup.startProfile('claude');
  return { sup, calls };
}

describe('f03p-infra-#5 supervisor shutdown', () => {
  it('f03p-infra-#5 graceful: drain with the profile\'s cap, then disconnect', async () => {
    const { sup, calls } = await make({ shutdownDrainMinutes: 2 });
    await sup.shutdown({ graceful: true });
    expect(calls).toEqual([`drain:${2 * 60_000}`, 'disconnect']);
  });

  it('f03p-infra-#5 shutdownDrainMinutes: 0 → straight to disconnect (old behaviour)', async () => {
    const { sup, calls } = await make({ shutdownDrainMinutes: 0 });
    await sup.shutdown({ graceful: true });
    expect(calls).toEqual(['disconnect']);
  });

  it('f03p-infra-#5 non-graceful shutdown (/exit, console stop) does not drain', async () => {
    const { sup, calls } = await make({});
    await sup.shutdown();
    expect(calls).toEqual(['disconnect']);
  });
});
