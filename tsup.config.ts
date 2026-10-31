import { defineConfig } from 'tsup';
import { publishDist } from './tools/dist-publish.mjs';

export default defineConfig([
  {
    entry: { cli: 'src/cli/index.ts' },
    // f03p-fix-#7: build into dist/.next, then publish (new chunks first,
    // entry swapped by atomic rename, old chunks kept for KEEP_GENERATIONS
    // builds) so rebuilding while the service runs does not break its next
    // lazy import(). Only the staging folder is cleaned.
    outDir: 'dist/.next',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    clean: true,
    onSuccess: async () => publishDist({ stagingDir: 'dist/.next', outDir: 'dist' }),
    sourcemap: false,
    // f03p-slim-#7: optional modules (meeting, CoT, Codex, web console) are
    // dynamic imports; splitting turns them into chunks loaded on demand.
    splitting: true,
    dts: false,
    // Inline the Vite-built console (src/ui/generated/index.html) as a string.
    esbuildOptions(options) {
      options.loader = { ...options.loader, '.html': 'text' };
    },
  },
  {
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: false,
    splitting: false,
    dts: true,
  },
]);
