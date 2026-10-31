// f03p-fix-#7: publish a staged tsup build into dist/ without breaking a
// running service. Since 0.3.2 dist/ has hash-named chunks the service
// import()s on demand; deleting them (tsup `clean`) under a running process
// made its next lazy import fail. Here:
//   1. tsup writes into <outDir>/.next (only that folder is cleaned);
//   2. new chunks are moved in first (hash names: an existing name means the
//      same content), then the entries are swapped in with an atomic rename;
//   3. chunks of the current build and of the previous KEEP-1 builds stay,
//      older ones are deleted, so dist/ does not grow without bound.
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

export const KEEP_GENERATIONS = 3;
const HASHED = /-[A-Z0-9]{8}\.js$/;
const MANIFEST = '.generations.json';

function atomicPut(src, dest) {
  try {
    renameSync(src, dest);
  } catch {
    const tmp = `${dest}.tmp-${process.pid}`;
    copyFileSync(src, tmp);
    renameSync(tmp, dest);
  }
}

export function publishDist({ stagingDir, outDir, keep = KEEP_GENERATIONS }) {
  const files = readdirSync(stagingDir);
  const entries = files.filter((f) => !HASHED.test(f));
  const chunks = files.filter((f) => HASHED.test(f));
  for (const f of chunks) atomicPut(join(stagingDir, f), join(outDir, f));
  for (const f of entries) atomicPut(join(stagingDir, f), join(outDir, f));
  rmSync(stagingDir, { recursive: true, force: true });

  const manifestPath = join(outDir, MANIFEST);
  let generations = [];
  try {
    generations = JSON.parse(readFileSync(manifestPath, 'utf8')).generations ?? [];
  } catch {
    // first build with this scheme: whatever chunks are already there count
    // as one previous generation (a running process may still need them)
    const existing = existsSync(outDir) ? readdirSync(outDir).filter((f) => HASHED.test(f) && !chunks.includes(f)) : [];
    if (existing.length) generations = [existing];
  }
  generations = [chunks, ...generations].slice(0, keep);
  const live = new Set(generations.flat());
  for (const f of readdirSync(outDir)) {
    if (HASHED.test(f) && !live.has(f)) unlinkSync(join(outDir, f));
  }
  const tmp = `${manifestPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ generations }, null, 2) + '\n');
  renameSync(tmp, manifestPath);
}
