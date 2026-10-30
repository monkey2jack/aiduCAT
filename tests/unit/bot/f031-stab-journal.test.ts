import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunJournal } from '../../../src/bot/run-journal';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const tmps: TmpProfile[] = [];
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((t) => t.cleanup()));
});

const msg = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    messageId: id, chatId: 'oc', chatType: 'p2p', senderId: 'ou', content: 'hello', rawContentType: 'text',
    resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: 1, ...extra,
  }) as never;

describe('f031-stab-#5 RunJournal', () => {
  it('f031-stab-#5 file is 0600 and keeps only the slim raw fields a replay needs', async () => {
    const tmp = await createTmpProfile('journal-');
    tmps.push(tmp);
    const path = join(tmp.profile, 'run-journal.json');
    const j = new RunJournal(path);
    await j.takeOver();
    j.queue('s', msg('m1', { raw: { sender: { sender_type: 'user' }, header: { token: 'X'.repeat(500) }, message: { content: '{}' } } }));
    await j.flush();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const body = JSON.parse(await readFile(path, 'utf8'));
    expect(body.queued.s[0].msg.raw).toEqual({ sender: { sender_type: 'user' } });
    expect(JSON.stringify(body)).not.toContain('XXXX');
  });

  it('f031-stab-#5 takeOver hands back the previous state once and starts clean', async () => {
    const tmp = await createTmpProfile('journal-');
    tmps.push(tmp);
    const path = join(tmp.profile, 'run-journal.json');
    const a = new RunJournal(path);
    await a.takeOver();
    a.startRun('s', { runKey: 'k', chatId: 'oc', replyTo: 'm0' });
    a.setCard('s', 'k', 'om_card');
    a.queue('s', msg('m1'));
    await a.close();
    a.endRun('s', 'k'); // late cleanup from a dying run must not erase the hand-over
    await a.flush();
    const b = new RunJournal(path);
    const snap = await b.takeOver();
    expect(snap.inflight).toEqual([['s', expect.objectContaining({ cardMessageId: 'om_card', replyTo: 'm0' })]]);
    expect(snap.queued[0]![1].map((q) => q.msg.messageId)).toEqual(['m1']);
    await b.flush();
    const c = new RunJournal(path);
    expect(await c.takeOver()).toEqual({ inflight: [], queued: [] });
  });

  it('f031-stab-#5 endRun only clears the matching run', async () => {
    const tmp = await createTmpProfile('journal-');
    tmps.push(tmp);
    const path = join(tmp.profile, 'run-journal.json');
    const j = new RunJournal(path);
    await j.takeOver();
    j.startRun('s', { runKey: 'new', chatId: 'oc' });
    j.endRun('s', 'old');
    await j.flush();
    const snap = await new RunJournal(path).takeOver();
    expect(snap.inflight.map(([, e]) => e.runKey)).toEqual(['new']);
  });
});
