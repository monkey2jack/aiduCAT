import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { MediaCache } from '../../../src/media/cache.js';
import { setupStabChannel, stabSdkMock, waitFor, dmMessage, type StabHarness } from '../../helpers/stab-channel-harness.js';

vi.mock('@larksuite/channel', async (orig) => ({
  ...(await orig<typeof import('@larksuite/channel')>()),
  createLarkChannel: (o: unknown) =>
    (globalThis as { __stabSdkMock?: { createLarkChannel(o: unknown): unknown } }).__stabSdkMock!.createLarkChannel(o),
}));

vi.setConfig({ testTimeout: 20_000 });

// f031-fix-#1 (零死角): one attachment failing to download used to be dropped
// silently (log only) — the agent ran without it and Dudu never knew. Now the
// failed attachment stays in the list as rejected/download-failed, and the
// prompt tells the agent which one is missing so it can say so in the answer.

const PNG = Buffer.from('fake-png-bytes');
const cleanups: Array<() => Promise<void>> = [];
const harnesses: StabHarness[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) {
    await h.disconnect();
    await h.tmp.cleanup();
  }
  stabSdkMock.channel = undefined;
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

function flakyChannel(failKey: string) {
  return {
    async downloadResourceToFile(_m: string, fileKey: string, _t: string, dest: string) {
      if (fileKey === failKey) throw new Error('Request failed with status code 500');
      await writeFile(dest, PNG);
      return { contentType: 'image/png', bytesWritten: PNG.length };
    },
  };
}

describe('f031-fix-#1 a failed attachment download is reported, not dropped', () => {
  it('f031-fix-#1 MediaCache keeps the failed item as rejected/download-failed (no path, no crash)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f031-fix-media-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const cache = new MediaCache(flakyChannel('img_bad') as never, root);
    const out = await cache.resolve([
      { messageId: 'om_1', resource: { type: 'image', fileKey: 'img_ok', fileName: 'ok.png' } as never },
      { messageId: 'om_1', resource: { type: 'file', fileKey: 'img_bad', fileName: '报价单.pdf' } as never },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ decision: 'accepted', kind: 'image' });
    expect(out[1]).toMatchObject({
      decision: 'rejected',
      rejectionReason: 'download-failed',
      kind: 'file',
      originalName: '报价单.pdf',
      sourceMessageId: 'om_1',
      absPath: '',
    });
    // only the good file is in the cache, no stray tmp files
    expect((await readdir(root)).filter((f) => f.startsWith('.tmp-'))).toEqual([]);
  });

  it('f031-fix-#1 end to end: the agent still runs, and the prompt names the missing attachment', async () => {
    const events = [{ type: 'text', delta: 'ok' }, { type: 'done', terminationReason: 'normal' }] as AgentEvent[];
    const h = await setupStabChannel({ events, withAppPaths: true });
    harnesses.push(h);
    Object.assign(stabSdkMock.channel as object, flakyChannel('file_bad'));
    await h.handlers.message?.(
      dmMessage('om_att', '帮我看看这两个附件', {
        rawContentType: 'post',
        resources: [
          { type: 'image', fileKey: 'img_good' },
          { type: 'file', fileKey: 'file_bad', fileName: '报价单.pdf' },
        ],
      }),
    );
    await waitFor(() => h.agent.runOptions.length >= 1);
    const prompt = h.agent.runOptions[0]!.prompt;
    expect(prompt).toContain('download-failed');
    expect(prompt).toContain('报价单.pdf');
    expect(prompt).toContain('没下载下来');
    // the good image is still handed over
    expect(prompt).toMatch(/"decision":"accepted"/);
  });
});
