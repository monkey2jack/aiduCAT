import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// f03p-fix-#7: since 0.3.2 dist/ is split into chunks that a running service
// import()s on demand. Rebuilding while the service runs must not make the
// running process's next lazy import fail (it used to: `clean: true` wiped the
// old chunks). This drives the repo's real tsup.config.ts against a tiny
// fixture project laid out like src/ (cli entry with a lazy chunk + index).

const repo = resolve(__dirname, '../..');
const tsupCli = join(repo, 'node_modules/tsup/dist/cli-default.js');
const work = mkdtempSync(join(tmpdir(), 'f03p-fix7-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function setupProject(): string {
  const dir = join(work, 'proj');
  mkdirSync(join(dir, 'src/cli'), { recursive: true });
  for (const f of ['tsup.config.ts', 'tsconfig.json', 'package.json']) cpSync(join(repo, f), join(dir, f));
  if (existsSync(join(repo, 'tools'))) cpSync(join(repo, 'tools'), join(dir, 'tools'), { recursive: true });
  symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(join(dir, 'src/index.ts'), 'export const lib = 1;\n');
  writeFileSync(
    join(dir, 'src/cli/index.ts'),
    [
      "process.stdin.once('data', async () => {",
      "  try { const m = await import('./lazy.js'); console.log('LAZY:' + m.value); }",
      "  catch (e) { console.log('ERR:' + (e as Error).message); }",
      '  process.exit(0);',
      '});',
      "console.log('READY');",
      '',
    ].join('\n'),
  );
  return dir;
}

function setGen(dir: string, gen: number): void {
  writeFileSync(join(dir, 'src/cli/lazy.ts'), `export const value = 'GEN${gen}';\n`);
}

function build(dir: string): void {
  execFileSync(process.execPath, [tsupCli], { cwd: dir, stdio: 'pipe', env: { ...process.env, NODE_ENV: 'production' } });
}

function startOld(dir: string): Promise<{ trigger: () => Promise<string> }> {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [join(dir, 'dist/cli.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let ready = false;
    child.stdout.on('data', (d) => {
      out += String(d);
      if (!ready && out.includes('READY')) {
        ready = true;
        ok({
          trigger: () =>
            new Promise((done) => {
              child.on('exit', () => done(out + (child.stderr.read()?.toString() ?? '')));
              child.stdin.write('go\n');
            }),
        });
      }
    });
    child.on('error', fail);
    setTimeout(() => !ready && fail(new Error('child not ready: ' + out)), 20_000);
  });
}

const hashed = (dir: string) => readdirSync(join(dir, 'dist')).filter((f) => /-[A-Z0-9]{8}\.js$/.test(f));

describe('f03p-fix-#7 build while the service is running', () => {
  it('a process started from the old build still loads its lazy chunk after a rebuild; new process gets the new code; old generations are pruned', async () => {
    const dir = setupProject();
    setGen(dir, 1);
    build(dir);
    const ino1 = statSync(join(dir, 'dist/cli.js')).ino;
    const old = await startOld(dir);

    setGen(dir, 2);
    build(dir); // rebuild while "the service" (old) is running

    expect(await old.trigger()).toContain('LAZY:GEN1');
    // entry replaced by an atomic rename, never rewritten in place
    expect(statSync(join(dir, 'dist/cli.js')).ino).not.toBe(ino1);
    const fresh = await startOld(dir);
    expect(await fresh.trigger()).toContain('LAZY:GEN2');
    expect(existsSync(join(dir, 'dist/.next'))).toBe(false);
    expect(existsSync(join(dir, 'dist/index.js'))).toBe(true);
    expect(existsSync(join(dir, 'dist/index.d.ts'))).toBe(true);

    // keep the current build + 2 previous; older chunks are deleted
    const gen1 = hashed(dir).filter((f) => f.startsWith('lazy-'));
    for (const g of [3, 4, 5]) {
      setGen(dir, g);
      build(dir);
    }
    const lazies = hashed(dir).filter((f) => f.startsWith('lazy-'));
    expect(lazies).toHaveLength(3);
    expect(lazies.filter((f) => gen1.includes(f))).toHaveLength(0);
  }, 180_000);
});
