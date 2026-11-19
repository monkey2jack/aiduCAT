import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../../src/session/store';

const dirs: string[] = [];
const stores: SessionStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.flush()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function createStore(): Promise<{ s: SessionStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'continuity-test-'));
  dirs.push(dir);
  const path = join(dir, 'sessions.json');
  const s = new SessionStore(path);
  stores.push(s);
  return { s, path };
}

describe('session continuity (Issue #11)', () => {
  it('clear() records previousSession pointer with sessionId, cwd, and timestamp', async () => {
    const { s } = await createStore();
    s.set('chat-1', 'sess-1', '/repo/project');

    expect(s.getPreviousSession('chat-1')).toBeUndefined();

    s.clear('chat-1');

    const prev = s.getPreviousSession('chat-1');
    expect(prev).toBeDefined();
    expect(prev?.sessionId).toBe('sess-1');
    expect(prev?.cwd).toBe('/repo/project');
    expect(prev?.clearedAt).toBeGreaterThan(0);

    // active session is gone
    expect(s.resumeFor('chat-1', '/repo/project')).toBeUndefined();
  });

  it('previousSession pointer survives bot restart (SessionStore.load)', async () => {
    const { s, path } = await createStore();
    s.set('chat-1', 'sess-1', '/repo/project');
    s.clear('chat-1');
    await s.flush();

    const reloaded = new SessionStore(path);
    stores.push(reloaded);
    await reloaded.load();

    const prev = reloaded.getPreviousSession('chat-1');
    expect(prev).toBeDefined();
    expect(prev?.sessionId).toBe('sess-1');
    expect(prev?.cwd).toBe('/repo/project');
  });

  it('multiple consecutive clear() calls preserve the original previousSession', async () => {
    const { s } = await createStore();
    s.set('chat-1', 'sess-1', '/repo/project');
    s.clear('chat-1');

    // Second clear without setting a new session
    s.clear('chat-1');
    const prev = s.getPreviousSession('chat-1');
    expect(prev?.sessionId).toBe('sess-1');
    expect(prev?.cwd).toBe('/repo/project');
  });

  it('consumePreviousSession() returns pointer and deletes it', async () => {
    const { s } = await createStore();
    s.set('chat-1', 'sess-1', '/repo/project');
    s.clear('chat-1');

    const consumed = s.consumePreviousSession('chat-1');
    expect(consumed?.sessionId).toBe('sess-1');

    // After consumption, subsequent calls return undefined
    expect(s.getPreviousSession('chat-1')).toBeUndefined();
    expect(s.consumePreviousSession('chat-1')).toBeUndefined();
  });

  it('setting a new session preserves previousSession until consumed', async () => {
    const { s } = await createStore();
    s.set('chat-1', 'sess-1', '/repo/project');
    s.clear('chat-1');

    // New session starts
    s.set('chat-1', 'sess-2', '/repo/project');
    expect(s.resumeFor('chat-1', '/repo/project')).toBe('sess-2');

    // previousSession pointer is still available for the first turn to consume
    expect(s.getPreviousSession('chat-1')?.sessionId).toBe('sess-1');

    // After consumption
    s.consumePreviousSession('chat-1');
    expect(s.getPreviousSession('chat-1')).toBeUndefined();
    expect(s.resumeFor('chat-1', '/repo/project')).toBe('sess-2');
  });

  it('setPreviousSession() explicitly records pointer (e.g. OpenCode)', async () => {
    const { s } = await createStore();
    s.set('chat-1', 'sess-opencode', '/repo/chats');
    s.setPreviousSession('chat-1', 'sess-opencode', '/repo/chats');

    expect(s.getPreviousSession('chat-1')?.sessionId).toBe('sess-opencode');
  });
});
