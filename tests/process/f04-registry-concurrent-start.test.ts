import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'tsup';
import { afterAll, describe, expect, it } from 'vitest';

// f0.4-lockfix: real separate processes, released at the same instant, doing
// what `aiduCAT start --profile X` does on bring-up (profile + app runtime
// locks → register in the shared registry → updateEntry botName), then
// stopping together. Before the fix one of them died with
// "Lock file is already being held" (summer: aiduCAT + aiduCAT-xiaohou).

const repo = resolve(__dirname, '../..');
const work = mkdtempSync(join(tmpdir(), 'f04-lockfix-proc-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const src = (p: string) => JSON.stringify(join(repo, 'src', p));

async function buildChild(): Promise<string> {
  symlinkSync(join(repo, 'node_modules'), join(work, 'node_modules'), 'dir');
  const entry = join(work, 'child.ts');
  writeFileSync(
    entry,
    [
      `import { resolveAppPaths } from ${src('config/app-paths')};`,
      `import { acquireAppRuntimeLock, acquireProfileRuntimeLock } from ${src('runtime/locks')};`,
      `import { register, unregister, updateEntry } from ${src('runtime/registry')};`,
      'const [root, profile, appId, startAt] = process.argv.slice(2);',
      'const registryFile = join(root, "registry", "processes.json");',
      'import { join } from "node:path";',
      'async function main() {',
      '  while (Date.now() < Number(startAt)) { /* start barrier */ }',
      '  const paths = resolveAppPaths({ rootDir: root, profile });',
      '  const locks = [await acquireProfileRuntimeLock(paths, "claude"), await acquireAppRuntimeLock(paths, appId, "claude")];',
      '  const e = await register({ appId, tenant: "feishu", profileName: profile, agentKind: "claude", configPath: join(root, "config.json"), version: "0.4.0", registryFile });',
      '  await updateEntry(e.id, { botName: "bot-" + profile }, registryFile);',
      '  console.log("READY " + e.id);',
      '  process.stdin.once("data", async () => {',
      '    await unregister(e.id, registryFile);',
      '    for (const l of locks.reverse()) await l.release();',
      '    console.log("BYE");',
      '    process.exit(0);',
      '  });',
      '}',
      'main().catch((err) => { console.log("ERR " + (err instanceof Error ? err.message : String(err))); process.exit(1); });',
      '',
    ].join('\n'),
  );
  await build({
    config: false,
    entry: { child: entry },
    outDir: join(work, 'out'),
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    external: [/^(?![A-Za-z]:[\\/])(?![./])/],
    outExtension: () => ({ js: '.mjs' }),
    silent: true,
    dts: false,
    clean: false,
  });
  return join(work, 'out', 'child.mjs');
}

function waitLine(child: ChildProcess, re: RegExp): Promise<string> {
  return new Promise((ok, fail) => {
    let out = '';
    child.stdout?.on('data', (d) => {
      out += String(d);
      const m = out.match(re);
      if (m) ok(m[0]);
      else if (/ERR .*/.test(out)) fail(new Error(out.trim()));
    });
    child.on('exit', (code) => fail(new Error(`exit ${code}: ${out.trim()}`)));
  });
}

describe('f0.4-lockfix two+ aiduCAT processes starting at the same moment', () => {
  it('all register (none exits with "Lock file is already being held"), none is lost, all unregister', async () => {
    const childJs = await buildChild();
    const root = join(work, 'home');
    const profiles = ['claude', 'xiaohou', 'p3', 'p4', 'p5', 'p6'];
    const startAt = Date.now() + 1_500;
    const children = profiles.map((p, i) =>
      spawn(process.execPath, [childJs, root, p, `cli_app${i}`, String(startAt)], { stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    const ids = await Promise.all(children.map((c) => waitLine(c, /READY (\w+)/).then((l) => l.split(' ')[1])));
    expect(new Set(ids).size).toBe(profiles.length);

    const reg = JSON.parse(readFileSync(join(root, 'registry', 'processes.json'), 'utf8')) as {
      entries: { id: string; profileName: string; botName?: string }[];
    };
    expect(new Set(reg.entries.map((e) => e.id))).toEqual(new Set(ids));
    for (const e of reg.entries) expect(e.botName).toBe(`bot-${e.profileName}`);

    const byes = children.map((c) => waitLine(c, /BYE/));
    for (const c of children) c.stdin?.write('stop\n');
    await Promise.all(byes);
    const after = JSON.parse(readFileSync(join(root, 'registry', 'processes.json'), 'utf8')) as { entries: unknown[] };
    expect(after.entries).toEqual([]);
  }, 60_000);
});
