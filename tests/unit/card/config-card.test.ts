import { describe, expect, it } from 'vitest';
import { configFormCard, configSavedCard, type ConfigFormOpts } from '../../../src/card/config-card';

/** Pull the `message_reply` select out of the generated form. */
function replySelect(opts: ConfigFormOpts): { initial_option: string; values: string[] } {
  const json = JSON.stringify(configFormCard(opts));
  const card = JSON.parse(json) as {
    body: { elements: { elements?: { tag: string; name?: string; initial_option?: string; options?: { value: string }[] }[] }[] };
  };
  const all = card.body.elements.flatMap((el) => el.elements ?? []);
  const select = all.find((el) => el.name === 'message_reply');
  if (!select) throw new Error('message_reply select not found');
  return {
    initial_option: select.initial_option ?? '',
    values: (select.options ?? []).map((o) => o.value),
  };
}

const base: ConfigFormOpts = {
  agentKind: 'claude',
  mode: 'personal',
  model: 'default',
  messageReply: 'markdown',
  showToolCalls: false,
  cotMessages: 'off',
  maxConcurrentRuns: 1,
  runIdleTimeoutMinutes: 0,
  requireMentionInGroup: false,
  larkCliIdentity: 'bot-only',
  allowedUsers: [],
  allowedChats: [],
  admins: [],
  knownChats: [],
};

describe('configFormCard console URL', () => {
  it('f031-sec-M2 says the console is running without leaking its token', () => {
    const url = 'http://127.0.0.1:53219/?token=abc123';
    const card = configFormCard({ ...base, consoleUrl: url });
    expect(JSON.stringify(card)).not.toContain('abc123');
    expect(JSON.stringify(card)).toContain('http://127.0.0.1:53219/');
    expect(JSON.stringify(card)).toContain('aiduCAT ui');
    expect(JSON.stringify(card)).toContain('Web 控制台');
  });

  it('omits the console section when no console is running', () => {
    const card = configFormCard(base);
    expect(JSON.stringify(card)).not.toContain('Web 控制台');
  });
});

describe('configFormCard reply-mode picker', () => {
  it('offers all three reply modes including 交互卡片 (card)', () => {
    const sel = replySelect(base);
    expect(sel.values).toEqual(expect.arrayContaining(['text', 'markdown', 'card']));
  });

  it('shows card as the initial option when the profile is set to card', () => {
    // Regression: the picker used to rewrite a `card` config to `markdown`,
    // so saving the form silently downgraded the profile and cards stopped.
    expect(replySelect({ ...base, messageReply: 'card' }).initial_option).toBe('card');
  });

  it('labels a card config as 交互卡片 in the saved-summary card', () => {
    expect(JSON.stringify(configSavedCard({ ...base, messageReply: 'card' }))).toContain('交互卡片');
  });
});
