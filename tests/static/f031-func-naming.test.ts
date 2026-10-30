import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// f031-func-#7: user-facing hints/help/usage must name the real command
// (`aiduCAT …`), not the upstream `lark-channel-bridge …`, which isn't on
// PATH after installing aiduCAT. Data dir (~/.lark-channel), service name,
// bin file path and protocol `source` fields are deliberately untouched.

const ROOT = new URL('../../', import.meta.url).pathname;
const SUBCOMMAND = /lark-channel-bridge (ps|kill|stop|restart|ui|secrets|run|start)\b/;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'generated' || e.name === 'node_modules') continue;
      out.push(...(await walk(p)));
    } else if (/\.(ts|tsx|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('f031-func-#7 no upstream command name in user-facing text', () => {
  it('f031-func-#7 hints say `aiduCAT <sub>`, never `lark-channel-bridge <sub>`', async () => {
    const files = [...(await walk(join(ROOT, 'src'))), ...(await walk(join(ROOT, 'web')))];
    const hits: string[] = [];
    for (const f of files) {
      const lines = (await readFile(f, 'utf8')).split('\n');
      lines.forEach((l, i) => {
        if (SUBCOMMAND.test(l)) hits.push(`${f.slice(ROOT.length)}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('f031-func-#7 CLI program name, console title and agent prompt say aiduCAT', async () => {
    const cli = await readFile(join(ROOT, 'src/cli/index.ts'), 'utf8');
    expect(cli).toContain(".name('aiduCAT')");
    const html = await readFile(join(ROOT, 'web/index.html'), 'utf8');
    expect(html).toContain('<title>aiduCAT 控制台</title>');
    const prompt = await readFile(join(ROOT, 'src/agent/bridge-system-prompt.ts'), 'utf8');
    expect(prompt).not.toContain('lark-channel-bridge');
  });
});
