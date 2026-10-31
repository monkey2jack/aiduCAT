import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { dmMessage, setupStabChannel, stabSdkMock, waitFor, type StabHarness } from '../../helpers/stab-channel-harness.js';

vi.mock('@larksuite/channel', async (orig) => ({
  ...(await orig<typeof import('@larksuite/channel')>()),
  createLarkChannel: (o: unknown) =>
    (globalThis as { __stabSdkMock?: { createLarkChannel(o: unknown): unknown } }).__stabSdkMock!.createLarkChannel(o),
}));

const harnesses: StabHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.disconnect();
    await h.tmp.cleanup();
  }
  stabSdkMock.channel = undefined;
});

const doneOnly = [{ type: 'text', delta: 'ok' }, { type: 'done', terminationReason: 'normal' }] as AgentEvent[];

describe('f03p-infra-#2 IM runs tell the adapter whether the owner started them', () => {
  it('f03p-infra-#2 the owner\'s DM run is ownerRun=true (嘟嘟/猴哥 unchanged)', async () => {
    const h = await setupStabChannel({ events: doneOnly, botOwnerId: 'ou_user' });
    harnesses.push(h);
    await h.handlers.message?.(dmMessage('om_1', 'hi'));
    await waitFor(() => h.agent.runOptions.length >= 1);
    expect(h.agent.runOptions[0]!.ownerRun).toBe(true);
  });

  it('f03p-infra-#2 an allowlisted non-owner\'s DM run is ownerRun=false', async () => {
    const h = await setupStabChannel({ events: doneOnly, botOwnerId: 'ou_someone_else' });
    harnesses.push(h);
    await h.handlers.message?.(dmMessage('om_2', 'hi'));
    await waitFor(() => h.agent.runOptions.length >= 1);
    expect(h.agent.runOptions[0]!.ownerRun).toBe(false);
  });
});
