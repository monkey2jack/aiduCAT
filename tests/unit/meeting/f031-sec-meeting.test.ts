import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig, MEETING_DEFAULTS, type MeetingConfig } from '../../../src/config/profile-schema';
import { MeetingManager, VC_BOT_EVENTS } from '../../../src/meeting/manager';
import { attachMeetingAgent, type MeetingAgentDeps } from '../../../src/meeting/orchestrator';
import type { VcRequestClient } from '../../../src/meeting/api';

type Handler = (data: unknown) => unknown;

function fakeChannel() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    channel: {
      onRawEvent(eventType: string, handler: Handler) {
        handlers.set(eventType, handler);
        return () => handlers.delete(eventType);
      },
    },
  };
}

function fakeClient(): VcRequestClient {
  return {
    request: vi.fn(async (p: { url: string }) => {
      if (p.url.endsWith('/join')) return { code: 0, data: { meeting: { id: '70001' } } } as never;
      return { code: 0, data: {} } as never;
    }),
  };
}

const cfg = (over: Partial<MeetingConfig> = {}): MeetingConfig => ({ ...MEETING_DEFAULTS, enabled: true, ...over });

describe('f031-sec-M3 meetings: only allowlisted people drive the agent', () => {
  it('f031-sec-M3 auto-join only when the inviter is owner/admin', async () => {
    for (const [inviter, expected] of [['ou_stranger', 0], ['ou_owner', 1], [undefined, 0]] as const) {
      const { channel, handlers } = fakeChannel();
      const m = new MeetingManager({
        client: fakeClient(),
        config: () => cfg({ autoJoinOnInvite: true }),
        channel,
        canAutoJoin: (id?: string) => id === 'ou_owner',
      } as ConstructorParameters<typeof MeetingManager>[0]);
      m.attachPush();
      handlers.get(VC_BOT_EVENTS.invited)?.({
        meeting: { meeting_no: '123456789' },
        ...(inviter ? { operator: { open_id: inviter } } : {}),
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(m.list()).toHaveLength(expected);
    }
  });

  it('f031-sec-M3 auto-join stays off when no inviter check is wired', async () => {
    const { channel, handlers } = fakeChannel();
    const m = new MeetingManager({ client: fakeClient(), config: () => cfg({ autoJoinOnInvite: true }), channel });
    m.attachPush();
    handlers.get(VC_BOT_EVENTS.invited)?.({ meeting: { meeting_no: '123456789' }, operator: { open_id: 'ou_owner' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(m.list()).toHaveLength(0);
  });

  it('f031-sec-M3 in-meeting triggers from non-allowlisted participants are ignored', async () => {
    const profileConfig = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
      access: { allowedUsers: ['ou_friend'] },
    });
    profileConfig.meeting = { ...profileConfig.meeting, enabled: true, trigger: '@bot' };
    const session = Object.assign(new EventEmitter(), {
      meetingId: 'm1',
      sendMessage: vi.fn(async () => {}),
    });
    const interrupt = vi.fn(() => false);
    attachMeetingAgent({
      session,
      channel: { botIdentity: { name: 'bot' } },
      controls: { profileConfig, botOwnerId: 'ou_owner', ownerRefreshState: 'ok' },
      activeRuns: { interrupt },
    } as unknown as MeetingAgentDeps);

    session.emit('chat', { kind: 'chat', from: { id: 'ou_guest', name: 'Guest' }, content: '@bot stop' });
    session.emit('chat', { kind: 'chat', from: { name: 'NoId' }, content: '@bot stop' });
    await new Promise((r) => setTimeout(r, 10));
    expect(interrupt).not.toHaveBeenCalled();
    expect(session.sendMessage).not.toHaveBeenCalled();

    session.emit('chat', { kind: 'chat', from: { id: 'ou_friend', name: 'Friend' }, content: '@bot stop' });
    session.emit('chat', { kind: 'chat', from: { id: 'ou_owner', name: 'Owner' }, content: '@bot stop' });
    await new Promise((r) => setTimeout(r, 10));
    expect(interrupt).toHaveBeenCalledTimes(2);
  });
});
