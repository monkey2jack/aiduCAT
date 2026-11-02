import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilityFor, usesSessionId } from '../../../src/agent/capability';
import { buildHermesArgs, outsiderToolsets } from '../../../src/agent/hermes/argv';
import { HermesStreamTranslator } from '../../../src/agent/hermes/jsonl';
import {
  formatHermesSessionKey,
  hermesSessionDisplay,
  parseHermesSessionKey,
  resumeFor,
  withSlot,
} from '../../../src/agent/hermes/session-key';
import { supportedModels } from '../../../src/agent/models';
import { recordRunSessionEvent } from '../../../src/bot/run-flow';
import { briefAgentError } from '../../../src/bot/user-facing-error';
import { createDefaultProfileConfig, normalizeProfileConfig } from '../../../src/config/profile-schema';
import { agentKindFromString } from '../../../src/config/profile-store';
import { buildAgentEnv } from '../../../src/platform/agent-env';
import { createRuntimeAgent } from '../../../src/runtime/agent-runtime';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { readFileSync } from 'node:fs';

const app = { app: { id: 'cli_xxx', secret: '${APP_SECRET}', tenant: 'feishu' as const } };

describe('f0.4+ Hermes argv', () => {
  it('owner: stdin query, stream-json, hidden tool source, --yolo', () => {
    expect(buildHermesArgs({ owner: true })).toEqual([
      'chat', '--query-file', '-', '--format', 'stream-json', '--source', 'tool', '--yolo',
    ]);
  });
  it('outsider: chat-only toolset + --ignore-rules, never --yolo', () => {
    const a = buildHermesArgs({ owner: false });
    expect(a).toEqual(['chat', '--query-file', '-', '--format', 'stream-json', '--source', 'tool', '-t', 'todo', '--ignore-rules']);
  });
  it('profile, resume and model', () => {
    expect(buildHermesArgs({ owner: true, hermesProfile: 'aiducat', resume: 'local-abc', model: 'GLM-5.3-Flash' })).toEqual([
      '--profile', 'aiducat', 'chat', '--query-file', '-', '--format', 'stream-json', '--source', 'tool',
      '--resume', 'local-abc', '-m', 'GLM-5.3-Flash', '--yolo',
    ]);
  });
  it('rejects ids that could be read as options', () => {
    expect(() => buildHermesArgs({ owner: true, resume: '--yolo' })).toThrow();
    expect(() => buildHermesArgs({ owner: true, model: 'a b' })).toThrow();
    expect(() => buildHermesArgs({ owner: true, hermesProfile: '-x' })).toThrow();
  });
  it('outsider toolsets: only todo/web survive', () => {
    expect(outsiderToolsets(['terminal', 'file', 'code_execution'])).toEqual(['todo']);
    expect(outsiderToolsets(['web', 'todo', 'web'])).toEqual(['web', 'todo']);
    expect(outsiderToolsets(undefined)).toEqual(['todo']);
  });
});

describe('f0.4+ Hermes session key', () => {
  it('round-trips both slots with models', () => {
    const k = withSlot(withSlot({}, 'o', 'local-a1', 'cu/claude:x'), 'x', 'local-b2', '');
    const s = formatHermesSessionKey(k)!;
    expect(parseHermesSessionKey(s)).toEqual({
      o: { sessionId: 'local-a1', model: 'cu/claude:x' },
      x: { sessionId: 'local-b2', model: '' },
    });
    expect(resumeFor(parseHermesSessionKey(s), 'o', 'cu/claude:x')).toBe('local-a1');
    expect(resumeFor(parseHermesSessionKey(s), 'o', '')).toBeUndefined();
    expect(hermesSessionDisplay(s)).toBe('local-a1 · 其他人 local-b2');
  });
  it('ignores a Claude UUID or garbage (fresh session)', () => {
    expect(parseHermesSessionKey('6f1c1c1e-1111-2222-3333-444444444444')).toEqual({});
    expect(parseHermesSessionKey('hermes1|o=--yolo@')).toEqual({});
    expect(parseHermesSessionKey(undefined)).toEqual({});
  });
});

describe('f0.4+ Hermes stream-json translator (recorded samples)', () => {
  const lines = (f: string) =>
    readFileSync(join(__dirname, 'fixtures', 'hermes', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  it('owner tool turn', () => {
    const t = new HermesStreamTranslator();
    const ev = lines('owner-tool-turn.jsonl').flatMap((l) => t.translate(l));
    expect(ev.map((e) => e.type)).toEqual(['tool_use', 'tool_result', 'text', 'text']);
    const fin = t.finishEvents({ sessionKey: 'hermes1|o=local-x@', stopped: false });
    expect(fin.map((e) => e.type)).toEqual(['usage', 'system', 'done']);
  });
  it('replay_gap / no deltas → final_text from result', () => {
    const t = new HermesStreamTranslator();
    t.translate({ type: 'result', session_id: 'local-q', exit_code: 0, text: '全文', replay_gap: true, tokens: {} });
    expect(t.finishEvents({ stopped: false })[0]).toEqual({ type: 'final_text', content: '全文' });
  });
  it('resume refusal is recognised', () => {
    const t = new HermesStreamTranslator();
    lines('resume-refused.jsonl').forEach((l) => t.translate(l));
    expect(t.resumeRefused()).toBe(true);
  });
  it('interrupted result → done interrupted', () => {
    const t = new HermesStreamTranslator();
    lines('interrupted.jsonl').forEach((l) => t.translate(l));
    expect(t.finishEvents({ stopped: false }).at(-1)).toEqual({ type: 'done', terminationReason: 'interrupted' });
  });
  it('tool_result without tool_call_id pairs with the oldest open call of that name', () => {
    const t = new HermesStreamTranslator();
    const a = t.translate({ type: 'tool_use', name: 'terminal', input: {} })[0] as { id: string };
    const r = t.translate({ type: 'tool_result', name: 'terminal', output: 'ok', is_error: true })[0] as { id: string; isError: boolean };
    expect(r.id).toBe(a.id);
    expect(r.isError).toBe(true);
  });
});

describe('f0.4+ Hermes profile wiring', () => {
  it('agentKind hermes is accepted; a missing hermes block defaults to `hermes` on PATH', () => {
    expect(agentKindFromString('hermes')).toBe('hermes');
    const p = createDefaultProfileConfig({ agentKind: 'hermes', accounts: app });
    expect(p.hermes).toEqual({ binaryPath: 'hermes' });
    expect(p.features?.hermes).toBe(true);
    const n = normalizeProfileConfig({
      ...JSON.parse(JSON.stringify(p)),
      hermes: { binaryPath: '/opt/hermes', profile: 'aiducat', outsiderToolsets: ['web', 'BAD TOOL'] },
    });
    expect(n.hermes).toEqual({ binaryPath: '/opt/hermes', profile: 'aiducat', outsiderToolsets: ['web'] });
  });
  it('capability + session handling', () => {
    const p = createDefaultProfileConfig({ agentKind: 'hermes', accounts: app });
    const cap = capabilityFor(p);
    expect(cap.agentId).toBe('hermes');
    expect(cap.promptInjection).toBe('stdin-prefix');
    expect(usesSessionId('hermes')).toBe(true);
    expect(usesSessionId('claude')).toBe(true);
    expect(usesSessionId('codex')).toBe(false);
    expect(capabilityFor(createDefaultProfileConfig({ agentKind: 'claude', accounts: app })).agentId).toBe('claude');
  });
  it('model picker: only the Hermes default is fixed', () => {
    expect(supportedModels('hermes').map((m) => m.value)).toEqual(['default']);
  });
  it('createRuntimeAgent builds the Hermes adapter; features.hermes=false refuses', async () => {
    const p = createDefaultProfileConfig({ agentKind: 'hermes', accounts: app });
    const agent = await createRuntimeAgent(p, { profileDir: tmpdir() });
    expect(agent.id).toBe('hermes');
    expect(agent.displayName).toBe('Hermes Agent');
    const off = createDefaultProfileConfig({ agentKind: 'hermes', accounts: app, features: { hermes: false } });
    await expect(createRuntimeAgent(off, { profileDir: tmpdir() })).rejects.toThrow(/此功能未开启/);
  });
  it('agent env: no provider/HERMES_* names pass from the daemon', () => {
    const env = buildAgentEnv({
      agent: 'hermes',
      base: { PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'k', HERMES_YOLO_MODE: '1', AIDU_10ROUTER_TOKEN: 't' },
    });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH']);
  });
  it('owner-facing error line names hermes', () => {
    expect(briefAgentError('hermes exited with code 1: HTTP 401')).toBe('hermes 进程异常退出（code 1）：HTTP 401');
  });
  it('a Hermes turn records its session key in the session store and the catalog', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiducat-hermes-sess-'));
    try {
      const sessions = new SessionStore(join(dir, 'sessions.json'));
      const catalog = new SessionCatalog(join(dir, 'catalog.json'));
      const p = createDefaultProfileConfig({ agentKind: 'hermes', accounts: app });
      const policy = { ok: true, cwdRealpath: dir, policyFingerprint: 'fp' } as never;
      recordRunSessionEvent({
        scopeId: 's1',
        sessions,
        sessionCatalog: catalog,
        capability: capabilityFor(p),
        policy,
        event: { type: 'system', sessionId: 'hermes1|o=local-zz@' },
      });
      expect(sessions.resumeFor('s1', dir)).toBe('hermes1|o=local-zz@');
      expect(
        catalog.activeFor({ scopeId: 's1', agentId: 'hermes', cwdRealpath: dir, policyFingerprint: 'fp' })?.sessionId,
      ).toBe('hermes1|o=local-zz@');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
