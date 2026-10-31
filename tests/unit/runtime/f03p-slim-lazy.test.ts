import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRuntimeAgent } from '../../../src/runtime/agent-runtime';

const app = { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };

/**
 * f03p-slim-#7: the optional modules are loaded only when switched on. The
 * startup path may import them for types only; a value import would pull the
 * module into the main bundle and into memory on every start.
 */
const STARTUP_FILES = [
  'src/bot/channel.ts',
  'src/commands/index.ts',
  'src/cli/commands/start.ts',
  'src/cli/commands/ui.ts',
  'src/runtime/agent-runtime.ts',
  'src/runtime/supervisor.ts',
];
const LAZY = [/\/meeting\//, /\/cot['"]/, /\/agent\/codex\//, /\/codex\//, /\/session\/codex-history['"]/, /\/ui\/server['"]/];

function valueImports(src: string): string[] {
  const out: string[] = [];
  const re = /^import\s+(?!type\b)([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;
  for (const m of src.matchAll(re)) {
    const clause = m[1]!.trim();
    // `import { type A, type B } from` is type-only too.
    const braces = clause.match(/^\{([\s\S]*)\}$/);
    if (braces && braces[1]!.split(',').every((s) => !s.trim() || s.trim().startsWith('type '))) continue;
    out.push(m[2]!);
  }
  for (const m of src.matchAll(/^export\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)) out.push(m[1]!);
  return out;
}

describe('f03p-slim-#7 optional modules are lazy', () => {
  it('f03p-slim-#7 startup files have no value import of meeting / cot / codex / ui server', async () => {
    const offenders: string[] = [];
    for (const f of STARTUP_FILES) {
      const src = await readFile(join(process.cwd(), f), 'utf8');
      for (const spec of valueImports(src)) {
        if (LAZY.some((re) => re.test(spec))) offenders.push(`${f} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('f03p-slim-#7 the cli bundle is code-split so dynamic imports become their own chunks', async () => {
    const cfg = await readFile(join(process.cwd(), 'tsup.config.ts'), 'utf8');
    const cliBlock = cfg.slice(cfg.indexOf("entry: { cli:"), cfg.indexOf("entry: { index:"));
    expect(cliBlock).toMatch(/splitting:\s*true/);
  });

  it('f03p-slim-#5 createRuntimeAgent is async and still builds Claude by default', async () => {
    const agent = await createRuntimeAgent(
      createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
      { profileDir: tmpdir() },
    );
    expect(agent.id).toBe('claude');
  });

  it('f03p-slim-#5 a codex profile with features.codex=false refuses to start: 此功能未开启', async () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app },
      codex: { binaryPath: '/usr/local/bin/codex' },
      features: { codex: false },
    });
    await expect(createRuntimeAgent(profile, { profileDir: tmpdir() })).rejects.toThrow(/此功能未开启/);
  });

  it('f03p-slim-#5 codex on: CodexAdapter is loaded on demand', async () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app },
      codex: { binaryPath: '/usr/local/bin/codex' },
    });
    const agent = await createRuntimeAgent(profile, { profileDir: tmpdir() });
    expect(agent.id).toBe('codex');
  });
});
