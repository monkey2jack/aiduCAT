import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { killProcessTree } from '../../src/platform/kill-tree.js';

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('killProcessTree', () => {
  it.skipIf(process.platform !== 'win32')('kills a live Windows process tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiduCAT-kill-tree-'));
    cleanup.push(dir);
    const childPath = join(dir, 'child.mjs');
    const parentPath = join(dir, 'parent.mjs');
    const marker = join(dir, 'child.pid');
    await writeFile(childPath, [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
      'setInterval(() => {}, 60_000);',
    ].join('\n'));
    await writeFile(parentPath, [
      'import { spawn } from "node:child_process";',
      `const child = spawn(process.execPath, [${JSON.stringify(childPath)}], { stdio: "ignore" });`,
      'child.unref();',
      'setInterval(() => {}, 60_000);',
    ].join('\n'));
    await chmod(childPath, 0o755);
    await chmod(parentPath, 0o755);
    const parent = spawn(process.execPath, [parentPath], { stdio: 'ignore', windowsHide: true });
    let childPid = '';
    for (let i = 0; i < 100 && !childPid; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      childPid = await readFile(marker, 'utf8').catch(() => '');
    }
    expect(Number(childPid)).toBeGreaterThan(0);
    await killProcessTree(parent.pid, 'test');
    await expect(execFileAsync('tasklist.exe', ['/FI', `PID eq ${parent.pid}`, '/FO', 'CSV', '/NH'])).resolves.toMatchObject({ stdout: expect.not.stringContaining(String(parent.pid)) });
    await expect(execFileAsync('tasklist.exe', ['/FI', `PID eq ${Number(childPid)}`, '/FO', 'CSV', '/NH'])).resolves.toMatchObject({ stdout: expect.not.stringContaining(childPid) });
  }, 20_000);
});
