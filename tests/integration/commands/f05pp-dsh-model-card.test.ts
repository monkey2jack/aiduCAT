import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import {
  tryHandleCommand,
  type CommandContext,
  type Controls,
} from '../../../src/commands/index.js';
import { resetDshProfileModelsCache } from '../../../src/agent/models.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

// f0.5++: /model on a dsh profile lists the models the headless profile DECLARES
// (never the empty 10router combo list), validates picks against that catalog,
// and /new shows the real model name instead of the internal `default` sentinel.

const PROFILE_MODEL = 'Test-Default-Model';
const PATCH_YML = [
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: aidu',
  `    model: ${PROFILE_MODEL}`,
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      aidu:',
  '        apiKeyEnv: AIDU_API_KEY',
  '        api: openai-completions',
  '        baseURL: https://example.invalid/v1',
  '        models:',
  `          - id: ${PROFILE_MODEL}`,
  '          - id: GPT-OSS-20B',
  '          - id: Muse-Ember',
  '',
].join('\n');

const cleanups: Array<() => Promise<void>> = [];
const originalHome = process.env.DSH_HOME;
afterEach(async () => {
  resetDshProfileModelsCache();
  if (originalHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalHome;
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

interface Opts {
  sender?: string;
  formValue?: Record<string, unknown>;
  card?: boolean;
}

async function harness() {
  const tmp = await createTmpProfile('f06-dsh-model-');
  // A fake DSH_HOME whose headless profile declares the catalog above.
  const dshHome = join(tmp.root, 'dsh-home');
  const profileDir = join(dshHome, 'profiles', 'headless');
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, 'cordis.patch.yml'), PATCH_YML, 'utf8');
  process.env.DSH_HOME = dshHome;
  resetDshProfileModelsCache();

  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = createFakeAgent();
  const profileConfig: ProfileConfig = createDefaultProfileConfig({
    agentKind: 'dsh',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'], allowedUsers: ['ou-user'] },
    preferences: { model: 'default' },
  });
  profileConfig.dsh = { binaryPath: 'dsh-launcher.cmd', profile: 'headless' };
  const configPath = join(tmp.root, 'config.json');
  await saveRootConfig(createRootConfig('claude', profileConfig), configPath);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  const ctx = (content: string, o: Opts = {}): CommandContext => ({
    channel: channel as unknown as CommandContext['channel'],
    msg: {
      messageId: `om-${Math.random().toString(36).slice(2)}`,
      chatId: 'oc-dm',
      chatType: 'p2p',
      senderId: o.sender ?? 'ou-admin',
      senderName: 'U',
      content,
      rawContentType: o.card ? 'interactive' : 'text',
      resources: [],
      mentions: [],
      mentionedBot: false,
    } as unknown as NormalizedMessage,
    scope: 'oc-dm',
    chatMode: 'p2p',
    sessions,
    workspaces,
    agent,
    activeRuns: new ActiveRuns(),
    controls,
    ...(o.formValue ? { formValue: o.formValue } : {}),
    ...(o.card ? { fromCardAction: true } : {}),
  });
  const run = (content: string, o: Opts = {}) => tryHandleCommand(ctx(content, o));
  const disk = async () => (await loadRootConfig(configPath))!.profiles.claude!.preferences;
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { channel, run, disk };
}

const lastText = (c: FakeChannel) => JSON.stringify(c.sent.at(-1)?.content ?? {});

describe('f0.5++ dsh /model card', () => {
  it('/model lists the profile catalog, not the empty gateway combos', async () => {
    const h = await harness();
    await expect(h.run('/model')).resolves.toBe(true);
    const card = lastText(h.channel);
    expect(card).toContain(PROFILE_MODEL);
    expect(card).toContain('GPT-OSS-20B');
    expect(card).toContain('Muse-Ember');
    expect(card).toContain('跟随 DSH profile');
    expect(card).not.toContain('暂时取不到模型列表');
  });

  it('submitting a catalog model persists it for the next turn', async () => {
    const h = await harness();
    await h.run('/model submit', { card: true, formValue: { combo: 'GPT-OSS-20B' } });
    expect((await h.disk()).model).toBe('GPT-OSS-20B');
    expect(lastText(h.channel)).toContain('已保存模型');
  });

  it('rejects a model the profile does not declare', async () => {
    const h = await harness();
    await h.run('/model submit', { card: true, formValue: { combo: 'no-such-model' } });
    expect((await h.disk()).model).toBe('default');
    expect(lastText(h.channel)).toContain('不在当前 DSH profile');
  });

  it('rejects an empty pick', async () => {
    const h = await harness();
    await h.run('/model submit', { card: true, formValue: {} });
    expect((await h.disk()).model).toBe('default');
    expect(lastText(h.channel)).toContain('请先选择一个模型');
  });

  it('/new shows the real profile model, never the internal default sentinel', async () => {
    const h = await harness();
    await h.run('/new');
    const text = lastText(h.channel);
    expect(text).toContain(PROFILE_MODEL);
    expect(text).not.toContain('模型 default');
  });

  it('typed /model <catalog id> switches; an id outside the catalog is rejected', async () => {
    const h = await harness();
    // The live 406 incident: a typed id the profile never declared broke the
    // next turn. The typed path must validate against the same catalog.
    await h.run('/model no-such-model');
    expect((await h.disk()).model).toBe('default');
    expect(lastText(h.channel)).toContain('不在当前 DSH profile');
    await h.run('/model GPT-OSS-20B');
    expect((await h.disk()).model).toBe('GPT-OSS-20B');
    expect(lastText(h.channel)).toContain('--patch');
    // After a switch the panel/snapshot must name the OVERRIDE, not the
    // profile's default — otherwise the card lies about what runs next.
    await h.run('/new');
    expect(lastText(h.channel)).toContain('GPT-OSS-20B');
  });

  it('typed /model default restores following the profile', async () => {
    const h = await harness();
    await h.run('/model GPT-OSS-20B');
    await h.run('/model default');
    expect((await h.disk()).model).toBeUndefined();
    expect(lastText(h.channel)).toContain('恢复跟随 DSH profile');
  });
});
