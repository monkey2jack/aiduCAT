import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentRun } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';
import { CLAUDE_USAGE_FIXTURE as F } from '../../helpers/claude-usage-fixture.js';
import { translateEvent } from '../../../src/agent/claude/stream-json.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  pool: ProcessPool;
  agent: FakeAgentAdapter;
  controls: Controls;
  run(content: string): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('/status and /doctor diagnostics', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('shows passive status for active run, queue, stale session, and owner API state', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    h.sessions.set('chat-1', 'sess-old', '/old');
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('chat-1', activeRun);
    const release = await h.pool.acquire();

    await expect(h.run('/status')).resolves.toBe(true);

    release();
    expect(h.agent.runOptions).toHaveLength(1);
    const status = JSON.stringify(lastContent(h.channel));
    // f0.2+ six-line /status layout (猴哥终版 2026-10-21): no cwd/scope rows;
    // session · agent · 🛡 permission · 👤 owner · 🔐 lark-cli · 🏃 run · 🚦 queue.
    expect(status).toContain('`sess-old` ⚠️ 旧 cwd');
    expect(status).toContain('🏃 1');
    expect(status).toContain('🚦 1/1 active, 0 waiting');
    expect(status).toContain('👤 ok owner=present');
    expect(status).toContain('🛡 plan');
    expect(status).not.toContain('bypassPermissions');
  });

  it('runs only self-checks when no cwd is selected', async () => {
    const h = await createHarness({ configuredWorkspace: false, bindWorkspace: false });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(0);
    expect(lastMarkdownOrText(h.channel)).toContain('未设置工作目录');
    expect(lastMarkdownOrText(h.channel)).toContain('self-check');
  });

  it('uses RunExecutor for a sessionless read-only agent echo check', async () => {
    const h = await createHarness({ configuredWorkspace: true });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(1);
    const opts = h.agent.runOptions[0]!;
    await expect(realpath(h.tmp.workspace)).resolves.toBe(opts.cwd);
    expect(opts.sessionId).toBeUndefined();
    expect(opts.threadId).toBeUndefined();
    expect(opts.images).toBeUndefined();
    expect(opts.permissionMode).toBe('plan');
    expect(opts.prompt).toContain('OK');
    const output = lastStreamCardJson(h.channel);
    expect(output).toContain('self-check');
    expect(output).toContain('profile');
    expect(output).toContain('claude');
    expect(output).toContain('workspace check');
    expect(output).toContain('policy check: ok permission=plan');
    expect(output).not.toContain('permission=bypassPermissions');
    expect(output).toContain('agent echo check');
    expect(output).toContain('OK');
  });

  it('uses the profile default workspace when the chat has no bound cwd', async () => {
    const h = await createHarness({
      configuredWorkspace: true,
      bindWorkspace: false,
      defaultWorkspace: true,
    });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(1);
    const opts = h.agent.runOptions[0]!;
    await expect(realpath(h.tmp.workspace)).resolves.toBe(opts.cwd);

    await expect(h.run('/status')).resolves.toBe(true);
    const status = JSON.stringify(lastContent(h.channel));
    // /status (six-line layout) has no cwd row; it must still render without
    // a bound cwd and without the old picker hint.
    expect(status).toContain('**Session**');
    expect(status).toContain('🚦 0/1 active, 0 waiting');
    expect(status).not.toContain('工作目录已选择');
  });

  it('fast-fails the agent echo check when the process pool is full', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    const release = await h.pool.acquire();

    await expect(h.run('/doctor')).resolves.toBe(true);

    release();
    expect(h.agent.runOptions).toHaveLength(0);
    expect(lastMarkdownOrText(h.channel)).toContain('pool-full');
  });
});

describe('f031-#8 /status shows the real context and window', () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  beforeEach(async () => {
    // isolate from any real ~/.claude/settings.json on the test host
    process.env.CLAUDE_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'f031-claude-cfg-'));
  });
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    await rm(process.env.CLAUDE_CONFIG_DIR!, { recursive: true, force: true });
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  });

  it('f031-#8 no aiduCAT window → the CLI\'s own settings.json window/compact (嘟嘟 production: 900k / 600k)', async () => {
    await writeFile(
      join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'),
      JSON.stringify({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '900000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000', ANTHROPIC_API_KEY: 'fake' } }),
    );
    const h = await createHarness({ configuredWorkspace: true });
    h.sessions.set('chat-1', 'sess-1', h.tmp.workspace);
    feed(h, [F.mainAssistant(F.calls[1]!)]);
    await h.run('/status');
    const status = JSON.stringify(lastContent(h.channel));
    // real: 4387 input + 544304 cache_read = 548691 (old /status showed 4.4k/1M)
    expect(status).toContain('⏳ 548.7k/900k (61%)');
    expect(status).toContain('🗜️ 67%');
    expect(status).not.toContain('fake');
  });

  function feed(h: Harness, raws: unknown[]): void {
    for (const raw of raws) {
      for (const e of translateEvent(raw)) {
        if (e.type === 'usage') h.sessions.recordUsage('chat-1', e);
        if (e.type === 'system') h.sessions.recordModel('chat-1', e.model);
      }
    }
  }

  it('f031-#8 context = input + cache_read + cache_creation over the provider window, 🗜️ from the same source', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    h.controls.profileConfig.modelProviders = {
      gw: { label: 'gw', baseUrl: 'https://gw.invalid/v1', apiKey: 'x', wire: 'anthropic', contextWindow: 1_000_000 },
    };
    h.controls.profileConfig.preferences.provider = 'gw';
    h.sessions.set('chat-1', 'sess-1', h.tmp.workspace);
    feed(h, [F.mainAssistant(F.calls[1]!), F.sidechainAssistant(F.subagentCall), F.result()]);
    await h.run('/status');
    const status = JSON.stringify(lastContent(h.channel));
    const c = F.calls[1]!;
    const used = c.input_tokens + c.cache_read_input_tokens + c.cache_creation_input_tokens;
    const k = (used / 1000).toFixed(1).replace(/\.0$/, '');
    expect(status).toContain(`⏳ ${k}k/1M (${Math.round(used / 10_000)}%)`);
    expect(status).toContain('🗜️ 60%');
  });

  it('f031-#8 unknown window is shown as unknown, not a made-up 1M', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    h.sessions.set('chat-1', 'sess-1', h.tmp.workspace);
    feed(h, [F.mainAssistant(F.calls[1]!)]);
    await h.run('/status');
    const status = JSON.stringify(lastContent(h.channel));
    expect(status).not.toContain('/1M');
    expect(status).not.toContain('🗜️');
    expect(status).toMatch(/⏳ \d+(\.\d)?k\/— \(—%\)/);
  });

  it('f031-func-#2 🚩 = first timestamp of the Claude transcript, else the stored start', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    h.sessions.set('chat-1', 'sess-1', h.tmp.workspace);
    feed(h, [F.mainAssistant(F.calls[1]!)]);
    const fmt = (ms: number): string =>
      new Date(ms).toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
    // no transcript yet → stored stats start (fallback)
    await h.run('/status');
    const storedStart = h.sessions.getRaw('chat-1')!.stats!.startedAt;
    expect(JSON.stringify(lastContent(h.channel))).toContain(`🚩 ${fmt(storedStart)}`);
    // transcript under any project dir: first line without timestamp is skipped
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-some-other-cwd');
    await mkdir(dir, { recursive: true });
    const first = Date.parse('2026-10-28T10:15:00.000Z');
    await writeFile(
      join(dir, 'sess-1.jsonl'),
      [
        JSON.stringify({ type: 'summary', summary: 'x' }),
        JSON.stringify({ type: 'user', timestamp: '2026-10-28T10:15:00.000Z' }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-10-30T13:09:00.000Z' }),
      ].join('\n') + '\n',
    );
    await h.run('/status');
    expect(JSON.stringify(lastContent(h.channel))).toContain(`🚩 ${fmt(first)}`);
  });

  it('f031-#12 model line falls back to the model the CLI reported', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    h.sessions.set('chat-1', 'sess-1', h.tmp.workspace);
    feed(h, [{ type: 'system', subtype: 'init', session_id: 'sess-1', model: F.model }]);
    await h.run('/status');
    expect(JSON.stringify(lastContent(h.channel))).toContain(F.model);
  });
});

async function createHarness(options: {
  configuredWorkspace: boolean;
  bindWorkspace?: boolean;
  defaultWorkspace?: boolean;
}): Promise<Harness> {
  const tmp = await createTmpProfile('doctor-status-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 1);
  const agent = new FakeAgentAdapter({
    events: [[{ type: 'text', delta: 'OK' }, { type: 'done', terminationReason: 'normal' }]],
  });
  const profileConfig = appConfig(options.configuredWorkspace ? tmp.workspace : undefined);
  if (options.defaultWorkspace) {
    profileConfig.workspaces.default = tmp.workspace;
  }
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  if (options.bindWorkspace !== false) {
    workspaces.setCwd('chat-1', tmp.workspace);
  }
  const executor = new RunExecutor({
    agent,
    pool,
    activeRuns,
    createRunId: () => 'doctor-run-1',
    now: () => 1_700_000_000_000,
    postDoneExitGraceMs: 10,
  });

  const run = (content: string): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content),
      scope: 'chat-1',
      chatMode: 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      processPool: pool,
      runExecutor: executor,
      controls,
    });

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, sessions, workspaces, activeRuns, pool, agent, controls, run };
}

function appConfig(defaultWorkspace: string | undefined): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
  });
  if (defaultWorkspace) config.workspaces.default = defaultWorkspace;
  return config;
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastMarkdownOrText(channel: FakeChannel): string {
  const content = lastContent(channel);
  const value = content.markdown ?? content.text;
  expect(value).toBeTypeOf('string');
  return value as string;
}

function lastStreamCardJson(channel: FakeChannel): string {
  const stream = channel.streams.at(-1);
  expect(stream).toBeDefined();
  const initial = (stream?.input as { card?: { initial?: unknown } } | undefined)?.card?.initial;
  return JSON.stringify(stream?.cardUpdates.at(-1) ?? initial);
}

function jsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
