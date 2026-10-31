import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import {
  createDefaultProfileConfig,
  type ProfileConfig,
  type ProfileFeatures,
} from '../../../src/config/profile-schema.js';
import { getEffectiveCotMessages } from '../../../src/config/schema.js';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('f03p-slim feature switches in commands', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
  });

  it('f03p-slim-#3 meeting off: /meeting answers 此功能未开启 (even for the owner)', async () => {
    const h = await harness({ meeting: false });
    await expect(h.run('/meeting join 123456789', 'ou-owner')).resolves.toBe(true);
    expect(lastText(h.channel)).toContain('此功能未开启');
  });

  it('f03p-slim-#3 meeting on (default): /meeting keeps its old reply', async () => {
    const h = await harness({});
    await expect(h.run('/meeting', 'ou-owner')).resolves.toBe(true);
    expect(lastText(h.channel)).not.toContain('此功能未开启');
  });

  it('f03p-slim-#2 /help card hides /meeting when meeting is off', async () => {
    const h = await harness({ meeting: false });
    await expect(h.run('/help', 'ou-owner')).resolves.toBe(true);
    const json = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(json).toContain('/status — ');
    expect(json).not.toContain('/meeting');
  });

  it('f03p-slim-#4 cot off: /config has no COT selector and the effective mode is off', async () => {
    const h = await harness({ cot: false }, { cotMessages: 'detailed' });
    await expect(h.run('/config', 'ou-owner')).resolves.toBe(true);
    const json = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(json).not.toContain('cot_messages');
    expect(getEffectiveCotMessages(h.controls.cfg, h.controls.profileConfig)).toBe('off');
    const on = await harness({}, { cotMessages: 'detailed' });
    expect(getEffectiveCotMessages(on.controls.cfg, on.controls.profileConfig)).toBe('detailed');
  });

  it('f03p-slim-#6 webConsole off: /config never shows the Web 控制台 line', async () => {
    const h = await harness({ webConsole: false });
    const token = 'f'.repeat(64);
    await writeFile(
      join(h.root, 'ui.json'),
      JSON.stringify({ url: `http://127.0.0.1:53219/?token=${token}`, token, port: 53219, pid: process.pid, startedAt: 'x' }),
    );
    await expect(h.run('/config', 'ou-owner')).resolves.toBe(true);
    expect(JSON.stringify(h.channel.sent.at(-1)?.content)).not.toContain('Web 控制台');
  });
});

async function harness(features: Partial<ProfileFeatures>, preferences: ProfileConfig['preferences'] = {}) {
  const tmp = await createTmpProfile('f03p-slim-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const ws = await realpath(tmp.workspace);
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'], allowedUsers: ['ou-allowed'] },
    preferences,
    features,
  });
  profileConfig.workspaces.default = ws;
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
  workspaces.setCwd('chat-1', ws);
  const run = (content: string, senderId: string) =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: {
        messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
        chatId: 'chat-1',
        chatType: 'p2p',
        senderId,
        senderName: 'User',
        content,
        resources: [],
        mentions: [],
        mentionedBot: false,
      } as unknown as NormalizedMessage,
      scope: 'chat-1',
      chatMode: 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      controls,
    });
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { root: tmp.root, channel, controls, run };
}

function lastText(channel: FakeChannel): string {
  return JSON.stringify(channel.sent.at(-1)?.content ?? '');
}
