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

const IMAGE_RE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"\n]*")?\s*\)/g;
const IMG_TAG_RE = /<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)["']?[^>]*>/gi;
const BR_RE = /<br\s*\/?>/gi;
// A tag must start with a letter (or `/letter`), so `1 < 2 > 0` survives.
const TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g;

export const TRUNCATION_NOTE = '\n\n…（已截断，全文见下方纯文本消息）';

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
  return splitCode(md)
    .map((seg) => {
      // Images are converted everywhere, code included: it is unclear whether
      // Feishu's img_key check skips code, and an image is never load-bearing there.
      let t = seg.text.replace(IMAGE_RE, (_m, alt: string, url: string) =>
        imageToText(alt, url, withLinks),
      );
      if (seg.code) return t;
      t = t.replace(IMG_TAG_RE, (_m, url: string) => imageToText('', url, withLinks));
      t = t.replace(BR_RE, '\n');
      t = t.replace(TAG_RE, '');
      return t;
    })
    .join('');
}

/** Same cleaning for the plain-text fallback message: images become `alt (url)`. */
export function sanitizePlainText(md: string): string {
  const t = md
    .replace(IMAGE_RE, (_m, alt: string, url: string) =>
      isHttp(url) ? `${alt.trim() || '图片'} (${url})` : alt.trim() || '图片',
    )
    .replace(IMG_TAG_RE, (_m, url: string) => (isHttp(url) ? `图片 (${url})` : '图片'))
    .replace(BR_RE, '\n');
  return splitCode(t)
    .map((seg) => (seg.code ? seg.text : seg.text.replace(TAG_RE, '')))
    .join('');
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
