import { describe, expect, it } from 'vitest';
import { HELP_COMMANDS, helpCard } from '../../../src/card/templates.js';
import { REGISTERED_COMMANDS } from '../../../src/commands/index.js';

describe('f031-func-#4 /help lists every registered command', () => {
  it('f031-func-#4 HELP_COMMANDS == command registry (no missing, no stale)', () => {
    const help = HELP_COMMANDS.map((c) => `/${c.cmd}`).sort();
    expect(help).toEqual([...REGISTERED_COMMANDS].sort());
  });

  it('f031-func-#4 help card text and dropdown carry every command', () => {
    const json = JSON.stringify(helpCard('嘟嘟'));
    for (const cmd of REGISTERED_COMMANDS) {
      expect(json).toContain(`${cmd} — `);
      expect(json).toContain(`"value":"${cmd.slice(1)}"`);
    }
    for (const must of ['/doc', '/invite', '/remove', '/meeting', '/reset']) {
      expect(REGISTERED_COMMANDS).toContain(must);
    }
  });
});
