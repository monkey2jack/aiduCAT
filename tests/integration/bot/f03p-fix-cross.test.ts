import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { runMigrateHome } from '../../../src/cli/commands/migrate-home.js';
import { resolveAppPaths } from '../../../src/config/app-paths.js';
import { clearKeystoreDerivedKeyCache, getSecret, setSecret } from '../../../src/config/keystore.js';
import { createDefaultProfileConfig, featureEnabled } from '../../../src/config/profile-schema.js';
import { createRootConfig, loadRootConfig, runtimeProfileConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { Supervisor } from '../../../src/runtime/supervisor.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { dmMessage, settle, setupStabChannel, stabSdkMock, waitFor, type StabHarness } from '../../helpers/stab-channel-harness.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

vi.mock('@larksuite/channel', async (orig) => ({
  ...(await orig<typeof import('@larksuite/channel')>()),
  createLarkChannel: (o: unknown) =>
    (globalThis as { __stabSdkMock?: { createLarkChannel(o: unknown): unknown } }).__stabSdkMock!.createLarkChannel(o),
}));
vi.setConfig({ testTimeout: 20_000 });

// f03p-fix: X (graceful restart / auto-continue / migrate-home) × Y (feature
// switches + lazy loading). 嘟嘟's production profile turns all four off.
const ALL_OFF = { meeting: false, webConsole: false, codex: false, cot: false };

const harnesses: StabHarness[] = [];
const tmps: TmpProfile[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) await h.disconnect().catch(() => undefined);
  await Promise.all(tmps.splice(0).map((t) => t.cleanup()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  stabSdkMock.channel = undefined;
});

const doneOnly = [{ type: 'text', delta: 'ok' }, { type: 'done', terminationReason: 'normal' }] as AgentEvent[];

const allOffPatch = (c: Record<string, unknown>) => ({
  ...c,
  // CoT preference ON and meeting ON in config — the switches must still win.
  preferences: { ...(c.preferences as object), cotMessages: 'detailed' },
  meeting: { ...(c.meeting as object), enabled: true },
  features: { ...(c.features as object), ...ALL_OFF },
});

const fakeFeishuFetch = async (input: unknown): Promise<Response> =>
  String(input).includes('tenant_access_token')
    ? new Response(JSON.stringify({ code: 0, tenant_access_token: 't-fake', expire: 7200 }), { status: 200 })
    : new Response('{}', { status: 500 });

describe('f03p-fix cross effects: features all off × graceful restart / auto-continue / migrate-home', () => {
  it('f03p-fix-#1 features all off: graceful drain still waits for the round, journals what arrives, no meeting manager', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let paused = false;
    const h = await setupStabChannel({
      withAppPaths: true,
      events: [doneOnly, doneOnly],
      configPatch: allOffPatch,
      onUpdate: async () => {
        if (!paused) {
          paused = true;
          await gate;
        }
      },
    });
    harnesses.push(h);
    expect(h.controls.meeting).toBeUndefined();
    await h.handlers.message?.(dmMessage('om_a', 'first'));
    await waitFor(() => paused);
    let done: { drained: boolean; remaining: number } | undefined;
    const draining = h.drain(10_000).then((r) => {
      done = r;
    });
    await settle(50);
    await h.handlers.message?.(dmMessage('om_b', 'DURING_DRAIN_SENTINEL'));
    await settle(400);
    expect(done).toBeUndefined();
    expect(h.agent.runOptions).toHaveLength(1);
    release();
    await draining;
    expect(done).toEqual({ drained: true, remaining: 0 });
    await h.disconnect();
    harnesses.splice(harnesses.indexOf(h), 1);
    const journal = JSON.parse(await readFile(join(h.tmp.profile, 'run-journal.json'), 'utf8'));
    expect(journal.inflight).toEqual({});
    expect(JSON.stringify(journal.queued)).toContain('DURING_DRAIN_SENTINEL');
    await h.tmp.cleanup();
  });

  it('f03p-fix-#2 features.cot=false (pref detailed): auto-continue after restart still works, new card answers, no message_cot', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFeishuFetch as typeof fetch);
    const tmp = await createTmpProfile('f03p-fix-resume-');
    tmps.push(tmp);
    const cwd = await realpath(tmp.workspace);
    await writeFile(join(tmp.profile, 'sessions.json'), JSON.stringify({ oc_dm: { sessionId: 'sess-prev', cwd, updatedAt: Date.now() } }));
    const resumeMsg = { ...dmMessage('om_orig', ''), createTime: Date.now() - 60_000 };
    await writeFile(
      join(tmp.profile, 'run-journal.json'),
      JSON.stringify({
        v: 1,
        inflight: { oc_dm: { runKey: 'k-old', chatId: 'oc_dm', replyTo: 'om_orig', cardMessageId: 'om_card_old', startedAt: Date.now() - 90_000, resumeMsg } },
        queued: {},
        closedAt: Date.now() - 5_000,
      }),
    );
    const agent = new FakeAgentAdapter({ id: 'claude', displayName: 'Claude', events: doneOnly as never });
    const h = await setupStabChannel({ tmp, withAppPaths: true, agent, configPatch: allOffPatch });
    harnesses.push(h);
    await waitFor(() => agent.runOptions.length >= 1);
    const old = JSON.stringify(h.updateCardCalls.filter((c) => c.messageId === 'om_card_old').map((c) => c.card));
    expect(old).toContain('服务重启后自动继续');
    expect(agent.runOptions[0]!.prompt).toContain('服务重启，接着刚才的继续');
    expect(agent.runOptions[0]!.sessionId).toBe('sess-prev');
    // the continued round renders a normal card to the end
    await waitFor(() => JSON.stringify(h.updates.at(-1) ?? '').includes('ok'));
    const last = JSON.stringify(h.updates.at(-1));
    expect(Buffer.byteLength(last)).toBeLessThan(30_000);
    await settle(300);
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('message_cot'))).toBe(false);
    expect(h.sent.some((s) => String(s.content.text ?? '').includes('请重发'))).toBe(false);
    expect(agent.runOptions).toHaveLength(1);
  });

  it('f03p-fix-#3 supervisor with features all off: graceful shutdown drains then disconnects (async createRuntimeAgent path)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f03p-fix-sup-'));
    dirs.push(root, `${root}-workspaces`);
    const configPath = join(root, 'config.json');
    await mkdir(join(root, 'profiles', 'claude'), { recursive: true });
    const cfg = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'cli_a', secret: '${S}', tenant: 'feishu' } } });
    cfg.preferences = { ...cfg.preferences, shutdownDrainMinutes: 3 } as never;
    (cfg as unknown as { features: unknown }).features = ALL_OFF;
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
    await sup.shutdown({ graceful: true });
    expect(calls).toEqual([`drain:${3 * 60_000}`, 'disconnect']);
  });

  it('f03p-fix-#4 migrate-home keeps the features block (and workspaces.roots / shutdownDrainMinutes); secrets decrypt at the new place', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'f03p-fix-home-')));
    dirs.push(home);
    clearKeystoreDerivedKeyCache();
    const from = join(home, '.lark-channel');
    const to = join(home, '.aiducat');
    await mkdir(join(from, 'profiles', 'claude'), { recursive: true, mode: 0o700 });
    await mkdir(join(from, 'registry'), { recursive: true, mode: 0o700 });
    await setSecret('app-secret', 'FIX_SENTINEL_42', resolveAppPaths({ rootDir: from, profile: 'claude' }));
    const cfg = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'cli_a', secret: '${S}', tenant: 'feishu' } } });
    (cfg as unknown as { features: unknown }).features = ALL_OFF;
    cfg.workspaces = { default: join(from, 'ws'), roots: ['~/proj'] };
    cfg.preferences = { ...cfg.preferences, shutdownDrainMinutes: 10 } as never;
    await saveRootConfig(createRootConfig('claude', cfg), join(from, 'config.json'));
    const before = await readFile(join(from, 'config.json'), 'utf8');

    const out: string[] = [];
    await runMigrateHome({ from, to, dryRun: true, out: (l) => out.push(l) });
    await expect(readFile(join(to, 'config.json'), 'utf8')).rejects.toThrow();
    await runMigrateHome({ from, to, out: (l) => out.push(l) });

    const root = await loadRootConfig(join(to, 'config.json'));
    const prof = runtimeProfileConfig(root!, 'claude');
    for (const k of ['meeting', 'webConsole', 'codex', 'cot'] as const) expect(featureEnabled(prof, k)).toBe(false);
    expect(prof.workspaces.roots).toEqual(['~/proj']);
    expect(prof.workspaces.default).toBe(join(to, 'ws'));
    expect(prof.preferences.shutdownDrainMinutes).toBe(10);
    clearKeystoreDerivedKeyCache();
    expect(await getSecret('app-secret', resolveAppPaths({ rootDir: to, profile: 'claude' }))).toBe('FIX_SENTINEL_42');
    expect(await readFile(join(from, 'config.json'), 'utf8')).toBe(before);
    expect(out.join('\n')).not.toContain('FIX_SENTINEL_42');
  });
});
