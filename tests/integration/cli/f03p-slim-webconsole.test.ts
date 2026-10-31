import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runUi } from '../../../src/cli/commands/ui.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';

const roots: string[] = [];
const savedHome = process.env.LARK_CHANNEL_HOME;

afterEach(async () => {
  process.env.LARK_CHANNEL_HOME = savedHome;
  if (savedHome === undefined) delete process.env.LARK_CHANNEL_HOME;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function home(webConsole: boolean | undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'f03p-slim-ui-'));
  roots.push(root);
  const profile = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_x', secret: '${APP_SECRET}', tenant: 'feishu' } },
    ...(webConsole === undefined ? {} : { features: { webConsole } }),
  });
  await saveRootConfig(createRootConfig('claude', profile), join(root, 'config.json'));
  await writeFile(
    join(root, 'ui.json'),
    JSON.stringify({ url: 'http://127.0.0.1:1/?token=t', token: 't', port: 1, pid: process.pid, startedAt: 'x' }),
  );
  process.env.LARK_CHANNEL_HOME = root;
  return root;
}

describe('f03p-slim-#6 web console switch', () => {
  it('f03p-slim-#6 `aiduCAT ui` says 此功能未开启 when the active profile has webConsole off', async () => {
    await home(false);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runUi({ print: true });
    expect(err.mock.calls.flat().join('\n')).toContain('此功能未开启');
    expect(out).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('f03p-slim-#6 default (on): `aiduCAT ui --print` still prints the URL', async () => {
    await home(undefined);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runUi({ print: true });
    expect(out.mock.calls.flat().join('\n')).toContain('http://127.0.0.1:1/');
  });

  it('f03p-slim-#6 run/start --web-ui checks the switch before taking the host lock', async () => {
    const src = await readFile(join(process.cwd(), 'src/cli/commands/start.ts'), 'utf8');
    const body = src.slice(src.indexOf('async function runSupervisorConsole'));
    const gate = body.indexOf("featureEnabled(runtime.profileConfig, 'webConsole')");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(body.indexOf('acquireHostLock('));
  });
});
