import { describe, expect, it } from 'vitest';
import { helpCard } from '../../../src/card/templates.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { configFormCard, configSavedCard, type ConfigFormOpts } from '../../../src/card/config-card.js';
import { hiddenCommandsFor } from '../../../src/commands/index.js';

const app = { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };

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

describe('f03p-slim-#2 /help hides switched-off modules', () => {
  it('f03p-slim-#2 default profile: /meeting is listed', () => {
    const p = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });
    const json = JSON.stringify(helpCard('嘟嘟', hiddenCommandsFor(p)));
    expect(json).toContain('/meeting — ');
    expect(json).toContain('"value":"meeting"');
  });

  it('f03p-slim-#2 meeting off: /meeting gone from text and dropdown, others stay', () => {
    const p = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app }, features: { meeting: false } });
    const json = JSON.stringify(helpCard('嘟嘟', hiddenCommandsFor(p)));
    expect(json).not.toContain('/meeting');
    expect(json).not.toContain('"value":"meeting"');
    expect(json).toContain('/status — ');
    expect(json).toContain('/model — ');
  });
});

describe('f03p-slim-#4/#6 /config card follows the switches', () => {
  it('f03p-slim-#4 cot off: no COT selector on the form, no COT line on the saved card', () => {
    const on = JSON.stringify(configFormCard(base));
    expect(on).toContain('cot_messages');
    const off = JSON.stringify(configFormCard({ ...base, cotAvailable: false }));
    expect(off).not.toContain('cot_messages');
    expect(off).not.toContain('COT 过程消息');
    expect(JSON.stringify(configSavedCard({ ...base, cotAvailable: false }))).not.toContain('COT');
  });
});
