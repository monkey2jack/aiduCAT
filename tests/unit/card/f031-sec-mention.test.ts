import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as sanitize from '../../../src/card/sanitize';
import { renderText } from '../../../src/card/text-renderer';
import * as toolRender from '../../../src/card/tool-render';

const ALL = ['<at id="all"></at>', '<at user_id="all">所有人</at>', "<at open_id='all'>", '<AT USER_ID=all></AT>'];

function textState(content: string) {
  return { blocks: [{ kind: 'text', content }], terminal: 'done', footer: null } as unknown as Parameters<typeof renderText>[0];
}

describe('f031-sec-L5 agent output cannot @everyone or escape a code fence', () => {
  it('f031-sec-L5 @all tags are defused in cards, plain text and markdown/post replies (code included)', () => {
    for (const tag of ALL) {
      const md = `通知 ${tag} 开会\n\`\`\`\n${tag}\n\`\`\``;
      for (const out of [sanitize.sanitizeCardMarkdown(md), sanitize.sanitizePlainText(md), renderText(textState(md))]) {
        expect(out).not.toMatch(/<at[^>]*all/i);
      }
    }
  });

  it('f031-sec-L5 a normal @person mention in markdown replies is kept', () => {
    expect(renderText(textState('好的 <at user_id="ou_abc"></at>'))).toContain('<at user_id="ou_abc"></at>');
  });

  it('f031-sec-L5 fenceBlock uses a fence longer than any backtick run inside', () => {
    const fence = (sanitize as unknown as { fenceBlock?: (t: string) => string }).fenceBlock;
    expect(fence).toBeTypeOf('function');
    const body = 'a\n```\n<at id="all"></at>\n```\nb';
    const out = fence!(body);
    const opener = out.split('\n')[0]!;
    expect(opener.length).toBeGreaterThan(3);
    expect(out.endsWith(opener)).toBe(true);
    expect(out).not.toMatch(/<at[^>]*all/i);
  });

  it('f031-sec-L5 the unsafe tool-output fencing (dead toolBodyMd) is gone; /meeting transcript uses fenceBlock', () => {
    expect((toolRender as Record<string, unknown>).toolBodyMd).toBeUndefined();
    const src = readFileSync(join(__dirname, '../../../src/commands/index.ts'), 'utf8');
    expect(src).toContain('fenceBlock(tail.join');
  });
});
