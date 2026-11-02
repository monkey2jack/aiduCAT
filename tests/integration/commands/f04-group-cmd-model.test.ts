import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import {
  runCommandHandler,
  tryHandleCommand,
  type CommandContext,
  type Controls,
} from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { effectiveModelPrefs } from '../../../src/config/chat-model.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

// f04-group-cmd-model, command layer: /model per chat (B) and the group
// slash gate on typed commands + card buttons (A).

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

interface Opts {
  chat?: 'p2p' | 'group';
  chatId?: string;
  sender?: string;
  formValue?: Record<string, unknown>;
  card?: boolean;
}

async function harness() {
  const tmp = await createTmpProfile('f04-gcm-cmd-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = createFakeAgent();
  const ws = await realpath(tmp.workspace);
  const profileConfig: ProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'], allowedChats: ['oc-g1', 'oc-g2'], allowedUsers: ['ou-user'] },
    preferences: { model: 'default-m', effort: 'high' },
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
  const ctx = (content: string, o: Opts = {}): CommandContext => {
    const chat = o.chat ?? 'group';
    const chatId = o.chatId ?? (chat === 'group' ? 'oc-g1' : 'oc-dm');
    return {
      channel: channel as unknown as CommandContext['channel'],
      msg: {
        messageId: `om-${Math.random().toString(36).slice(2)}`,
        chatId,
        // card clicks arrive with a synthetic p2p msg (dispatcher makeFakeMsg)
        chatType: o.card ? 'p2p' : chat,
        senderId: o.sender ?? 'ou-admin',
        senderName: 'U',
        content,
        rawContentType: o.card ? 'interactive' : 'text',
        resources: [],
        mentions: [],
        mentionedBot: chat === 'group' && !o.card,
      } as unknown as NormalizedMessage,
      scope: chatId,
      chatMode: chat,
      sessions,
      workspaces,
      agent,
      activeRuns: new ActiveRuns(),
      controls,
      ...(o.formValue ? { formValue: o.formValue } : {}),
      ...(o.card ? { fromCardAction: true } : {}),
    };
  };
  const run = (content: string, o: Opts = {}) => tryHandleCommand(ctx(content, o));
  const click = (name: string, args: string, o: Opts = {}) => runCommandHandler(name, args, ctx('', { ...o, card: true }));
  const disk = async () => (await loadRootConfig(configPath))!.profiles.claude!.preferences;
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { channel, controls, run, click, disk };
}

const lastText = (c: FakeChannel) => JSON.stringify(c.sent.at(-1)?.content ?? {});

describe('f04 B: /model per chat', () => {
  it('group /model changes only that group; DM /model changes the default but never a group that set its own', async () => {
    const h = await harness();
    await h.run('/model group-m');
    expect(lastText(h.channel)).toContain('只改本群');
    let prefs = await h.disk();
    expect(prefs.model).toBe('default-m');
    expect(prefs.chatModels).toEqual({ 'oc-g1': { model: 'group-m', effort: 'high' } });
    // hot: in-memory profile already has it
    expect(effectiveModelPrefs(h.controls.profileConfig, 'oc-g1')).toMatchObject({ model: 'group-m', source: 'chat' });
    // an unset group follows the default
    expect(effectiveModelPrefs(h.controls.profileConfig, 'oc-g2')).toMatchObject({ model: 'default-m', source: 'default' });

    await h.run('/model new-default', { chat: 'p2p' });
    prefs = await h.disk();
    expect(prefs.model).toBe('new-default');
    expect(prefs.chatModels).toEqual({ 'oc-g1': { model: 'group-m', effort: 'high' } });
    expect(effectiveModelPrefs(h.controls.profileConfig, 'oc-g1').model).toBe('group-m');
    // the unset group moves with the default, live
    expect(effectiveModelPrefs(h.controls.profileConfig, 'oc-g2').model).toBe('new-default');
  });

  it('card submit in a group writes the group entry; 「恢复跟随默认」 button clears it; /status shows the source', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = await harness();
    await h.click('model', 'submit', { formValue: { effort: 'low' } });
    let prefs = await h.disk();
    expect(prefs.effort).toBe('high');
    expect(prefs.chatModels?.['oc-g1']).toEqual({ model: 'default-m', effort: 'low' });

    // the /model card in a group with its own model offers the reset button
    await h.run('/model');
    const card = lastText(h.channel);
    expect(card).toContain('只改本群');
    expect(card).toContain('model.reset');

    await h.run('/status');
    expect(lastText(h.channel)).toContain('本群设置');

    await h.click('model', 'reset');
    prefs = await h.disk();
    expect(prefs.chatModels).toBeUndefined();
    await h.run('/status');
    expect(lastText(h.channel)).toContain('跟随默认');
    await h.run('/model');
    expect(lastText(h.channel)).not.toContain('model.reset');

    await h.run('/model reset');
    expect(lastText(h.channel)).toContain('本来就跟随默认');
  });

  it('/remove group drops that group’s model; load/save keeps every valid entry', async () => {
    const h = await harness();
    await h.run('/model g1-m', { chatId: 'oc-g1' });
    await h.run('/model g2-m', { chatId: 'oc-g2' });
    // an unrelated preferences save (DM /model) keeps both
    await h.run('/model d2', { chat: 'p2p' });
    expect(Object.keys((await h.disk()).chatModels ?? {}).sort()).toEqual(['oc-g1', 'oc-g2']);
    await h.run('/remove group', { chatId: 'oc-g1' });
    expect((await h.disk()).chatModels).toEqual({ 'oc-g2': { model: 'g2-m', effort: 'high' } });
    expect(effectiveModelPrefs(h.controls.profileConfig, 'oc-g1').source).toBe('default');
  });

  it('/model stays admin-only in a group; /new shows the group’s model', async () => {
    const h = await harness();
    await h.run('/model g-m');
    await h.run('/new');
    expect(lastText(h.channel)).toContain('g-m');
    expect(lastText(h.channel)).toContain('本群设置');
    await h.run('/model hijack', { sender: 'ou-user' });
    expect((await h.disk()).chatModels?.['oc-g1']?.model).toBe('g-m');
  });
});

describe('f04 A: command layer', () => {
  it('typed: a group non-admin is swallowed (registered or unknown); admin and DM unchanged', async () => {
    const h = await harness();
    expect(await h.run('/help', { sender: 'ou-user' })).toBe(true);
    expect(await h.run('/xxx', { sender: 'ou-user' })).toBe(true); // handled = never forwarded
    expect(h.channel.sent).toHaveLength(0);
    expect(await h.run('/xxx', { sender: 'ou-admin' })).toBe(false); // admin: falls through to the agent
    expect(await h.run('/xxx', { chat: 'p2p', sender: 'ou-user' })).toBe(false);
    expect(await h.run('/help', { chat: 'p2p', sender: 'ou-user' })).toBe(true);
    expect(h.channel.sent.length).toBeGreaterThan(0);
  });

  it('card buttons in a group: a non-admin click does nothing; admin works; DM card unchanged', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = await harness();
    await h.click('model', 'submit', { sender: 'ou-user', formValue: { effort: 'low' } });
    expect((await h.disk()).chatModels).toBeUndefined();
    await h.click('status', '', { sender: 'ou-user' });
    expect(h.channel.sent).toHaveLength(0);
    await h.click('status', '', { sender: 'ou-admin' });
    expect(h.channel.sent.length).toBeGreaterThan(0);
    const before = h.channel.sent.length;
    await h.click('status', '', { chat: 'p2p', sender: 'ou-user' });
    expect(h.channel.sent.length).toBeGreaterThan(before);
  });
});
