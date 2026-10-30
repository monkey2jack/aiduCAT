import { describe, expect, it } from 'vitest';
import { buildCodexArgs } from '../../../src/agent/codex/argv';
import { buildLarkChannelEnv } from '../../../src/agent/lark-channel-env';
import { sanitizeCardMarkdown, sanitizePlainText } from '../../../src/card/sanitize';
import { renderText } from '../../../src/card/text-renderer';
import { createDefaultProfileConfig, normalizeProfileConfig } from '../../../src/config/profile-schema';
import { getShowToolCalls } from '../../../src/config/schema';

const FAKE_SK = 'sk-' + 'ant-api03-' + 'A'.repeat(30);

describe('f031-sec-#4 secrets do not reach chat or the agent env', () => {
  it('f031-sec-#4 card markdown and plain text mask credential shapes', () => {
    const md = `here\n\`\`\`\nANTHROPIC_API_KEY=${FAKE_SK}\n{"app_secret":"abcdefgh12345678"}\nAuthorization: Bearer abc.def.ghijklmnop\n\`\`\``;
    const card = sanitizeCardMarkdown(md);
    expect(card).not.toContain(FAKE_SK);
    expect(card).not.toContain('abcdefgh12345678');
    expect(card).not.toContain('ghijklmnop');
    expect(sanitizePlainText(`key ${FAKE_SK}`)).not.toContain(FAKE_SK);
    // ordinary prose survives
    expect(sanitizeCardMarkdown('max_tokens: 4096, token budget ok')).toBe('max_tokens: 4096, token budget ok');
  });

  it('f031-sec-#4 markdown-mode replies are masked too', () => {
    const text = renderText({
      blocks: [{ kind: 'text', content: `password=${'p'.repeat(16)}` }],
      terminal: 'done',
      footer: null,
    } as unknown as Parameters<typeof renderText>[0]);
    expect(text).not.toContain('p'.repeat(16));
  });

  it('f031-sec-#4 group chats hide tool calls by default; p2p unchanged', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
    });
    const getter = getShowToolCalls as (c: unknown, chatType?: string) => boolean;
    expect(getter(cfg, 'p2p')).toBe(true);
    expect(getter(cfg, 'group')).toBe(false);
    expect(getter({ ...cfg, preferences: { ...cfg.preferences, showToolCallsInGroups: true } }, 'group')).toBe(true);
  });

  it('f031-sec-#4 the agent never gets the bridge config.json path', () => {
    const build = buildLarkChannelEnv as (c: unknown, o?: unknown) => NodeJS.ProcessEnv;
    const env = build({ profile: 'p', rootDir: '/r', configPath: '/r/config.json' }, { forAgent: true });
    expect(env.LARK_CHANNEL_CONFIG).toBeUndefined();
    const withProjection = build(
      { profile: 'p', rootDir: '/r', larkCliSourceConfigFile: '/r/p/lark-cli-source/config.json' },
      { forAgent: true },
    );
    expect(withProjection.LARK_CHANNEL_CONFIG).toBe('/r/p/lark-cli-source/config.json');
  });

  it('f031-sec-#4 codex shells inherit core env only, plus the lark-channel vars', () => {
    const args = buildCodexArgs({
      cwd: '/repo',
      sandbox: 'workspace-write',
      shellEnv: { LARK_CHANNEL: '1', LARK_CHANNEL_HOME: '/r' },
    } as Parameters<typeof buildCodexArgs>[0]);
    expect(args).toContain('shell_environment_policy.inherit="core"');
    expect(args).not.toContain('shell_environment_policy.inherit="all"');
    expect(args).toContain('shell_environment_policy.set={LARK_CHANNEL="1",LARK_CHANNEL_HOME="/r"}');
  });

  it('f031-sec-#4 profile agentEnv.passthrough survives normalization', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
      agentEnv: { passthrough: ['AIDU_10ROUTER_URL', 'bad name'] },
    }) as { agentEnv?: unknown };
    expect(cfg.agentEnv).toEqual({ passthrough: ['AIDU_10ROUTER_URL'] });
  });
});
