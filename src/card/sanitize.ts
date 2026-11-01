/**
 * f0.3.1 #2: make agent markdown safe for a Feishu card.
 *
 * Feishu rejects a card whose markdown embeds an image by URL (it wants an
 * `img_key`: 230099/200570) and any card over 30KB (230025). One rejected
 * patch used to freeze the whole streaming card on "Thinking…", so the answer
 * is cleaned before it reaches the card:
 *   - `![alt](http…)` → `[🖼 alt](http…)` (a plain link); non-http → `🖼 alt`
 *   - `<img src=…>`   → the same link; every other HTML tag is dropped
 *     (outside code spans / fences, where `<div>` is just text)
 *   - byte-capped truncation with a visible note (`truncateUtf8`)
 */
import { redactSecretShapes } from '../core/secret-shapes';

const IMAGE_RE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"\n]*")?\s*\)/g;
const IMG_TAG_RE = /<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)["']?[^>]*>/gi;
const BR_RE = /<br\s*\/?>/gi;
// A tag must start with a letter (or `/letter`), so `1 < 2 > 0` survives.
const TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g;

// f031-sec-L5: `<at id="all">` / `<at user_id="all">` would ping the whole group.
const AT_ALL_RE = /<at\b[^>]*?\b(?:user_id|open_id|id)\s*=\s*["']?all["']?[^>]*>(?:[\s\S]*?<\/at>)?/gi;

// f0.3.5: a person mention survives the card's tag stripping, rewritten to
// the card markdown form `<at id=ou_…></at>` (groups now get cards too).
const AT_PERSON_RE = /<at\b[^>]*?\b(?:user_id|open_id|id)\s*=\s*["']?(ou_[A-Za-z0-9_-]+)["']?[^>]*>(?:[^<]*<\/at>)?/gi;
const AT_SLOT = '\u0000AT';

/** Replace every @all tag with inert text (code included). Person mentions stay. */
export function defuseMentionAll(text: string): string {
  return text.replace(AT_ALL_RE, '@所有人');
}

/**
 * f031-sec-L5: fence untrusted text so it cannot close the block early — the
 * fence is one backtick longer than the longest backtick run inside.
 */
export function fenceBlock(text: string, lang = ''): string {
  const body = defuseMentionAll(text);
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${body}\n${fence}`;
}

/** f03p-fix-#8: a long answer continues on the next card (no plain-text copy). */
export const TRUNCATION_NOTE = '\n\n…（未完，见下一张卡）';

function isHttp(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function imageToText(alt: string, url: string, withLink: boolean): string {
  const label = alt.trim() || '图片';
  return withLink && isHttp(url) ? `[🖼 ${label}](${url})` : `🖼 ${label}`;
}

/** Split markdown into code (fences / inline spans) and prose segments. */
function splitCode(md: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  const re = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g;
  let last = 0;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    if (m.index > last) out.push({ code: false, text: md.slice(last, m.index) });
    out.push({ code: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < md.length) out.push({ code: false, text: md.slice(last) });
  return out;
}

/**
 * Clean agent markdown for a card. `withLinks: false` (strict / plain modes)
 * drops image URLs entirely and keeps only the alt text.
 */
export function sanitizeCardMarkdown(md: string, opts: { withLinks?: boolean } = {}): string {
  const withLinks = opts.withLinks ?? true;
  // f031-sec-#4: credential-shaped strings never reach a card (code included).
  return redactSecretShapes(splitCode(defuseMentionAll(md))
    .map((seg) => {
      // Images are converted everywhere, code included: it is unclear whether
      // Feishu's img_key check skips code, and an image is never load-bearing there.
      let t = seg.text.replace(IMAGE_RE, (_m, alt: string, url: string) =>
        imageToText(alt, url, withLinks),
      );
      if (seg.code) return t;
      t = t.replace(IMG_TAG_RE, (_m, url: string) => imageToText('', url, withLinks));
      t = t.replace(BR_RE, '\n');
      const mentions: string[] = [];
      t = t.replace(/\u0000/g, '').replace(AT_PERSON_RE, (_m, id: string) => {
        mentions.push(`<at id=${id}></at>`);
        return `${AT_SLOT}${mentions.length - 1}\u0000`;
      });
      t = t.replace(TAG_RE, '');
      if (mentions.length > 0) {
        t = t.replace(/\u0000AT(\d+)\u0000/g, (_m, i: string) => mentions[Number(i)] ?? '');
      }
      return t;
    })
    .join(''));
}

/** Same cleaning for the plain-text fallback message: images become `alt (url)`. */
export function sanitizePlainText(md: string): string {
  const t = defuseMentionAll(md)
    .replace(IMAGE_RE, (_m, alt: string, url: string) =>
      isHttp(url) ? `${alt.trim() || '图片'} (${url})` : alt.trim() || '图片',
    )
    .replace(IMG_TAG_RE, (_m, url: string) => (isHttp(url) ? `图片 (${url})` : '图片'))
    .replace(BR_RE, '\n');
  return redactSecretShapes(
    splitCode(t)
      .map((seg) => (seg.code ? seg.text : seg.text.replace(TAG_RE, '')))
      .join(''),
  );
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Cut `s` to at most `maxBytes` UTF-8 bytes (note included) without splitting
 * a character, close a dangling code fence, and append the truncation note.
 * Returns `s` unchanged when it already fits.
 */
export function truncateUtf8(s: string, maxBytes: number, note = TRUNCATION_NOTE): string {
  if (utf8Bytes(s) <= maxBytes) return s;
  const room = Math.max(0, maxBytes - utf8Bytes(note) - 8);
  let cut = Buffer.from(s, 'utf8').subarray(0, room).toString('utf8').replace(/\uFFFD+$/, '');
  if (((cut.match(/```/g) ?? []).length) % 2 === 1) cut += '\n```';
  return cut + note;
}
