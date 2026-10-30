/**
 * f031-stab-#6 (upstream PR #148 idea / issue #147, hand-ported): gateway
 * models (GLM / Kimi / DeepSeek …) sometimes leak their reasoning into the
 * plain text stream, either as `<think>…</think>` or as reasoning followed by
 * a dangling `</think>`. Strip it so only the answer reaches the card.
 *
 * Pure function over the whole (accumulated) text, so streaming needs no
 * filter state: the reducer keeps the raw text and re-derives the visible
 * part on every delta. Only the part before the first ``` fence is touched —
 * leaks happen at the start of a turn, and code samples may legitimately
 * contain these tags.
 */
const TAG = '(?:think|thinking|redacted_thinking)';
const BLOCK_RE = new RegExp(`<(${TAG})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, 'gi');
const OPEN_RE = new RegExp(`<${TAG}\\b[^>]*>`, 'i');
const CLOSE_RE = new RegExp(`</${TAG}\\s*>`, 'gi');
const TAG_PREFIXES = ['<think>', '</think>', '<thinking>', '</thinking>', '<redacted_thinking>', '</redacted_thinking>'];

export function stripLeakedThinking(text: string): string {
  if (!text || !text.includes('<')) return text;
  const fence = text.indexOf('```');
  let head = fence === -1 ? text : text.slice(0, fence);
  let tail = fence === -1 ? '' : text.slice(fence);
  const before = head;

  head = head.replace(BLOCK_RE, '');
  // Reasoning with only a closing tag: everything up to the LAST close is thought.
  let lastClose = -1;
  let closeLen = 0;
  for (const m of head.matchAll(CLOSE_RE)) {
    lastClose = m.index ?? -1;
    closeLen = m[0].length;
  }
  if (lastClose !== -1) head = head.slice(lastClose + closeLen);
  // Still inside an unclosed thinking block: hide from the open tag on.
  const open = OPEN_RE.exec(head);
  if (open) {
    head = head.slice(0, open.index);
    tail = '';
  }
  // A tag split across deltas ("<thi" | "nk>") must not flash on the card.
  if (!tail) head = trimPartialTag(head);
  if (head !== before) head = head.replace(/^\s+/, '');
  return head + tail;
}

function trimPartialTag(s: string): string {
  const lt = s.lastIndexOf('<');
  if (lt === -1 || s.length - lt < 2) return s;
  const suffix = s.slice(lt).toLowerCase();
  return TAG_PREFIXES.some((t) => t.startsWith(suffix) && t !== suffix) ? s.slice(0, lt) : s;
}
