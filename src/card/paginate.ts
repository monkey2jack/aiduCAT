/**
 * f03p-fix-#8: split a long (already card-sanitized) answer into pages that
 * each fit one card. Production 10:14: a 17,451-char answer was cut at the
 * card budget and re-sent whole as plain text — unformatted and duplicated.
 *
 * Pages are cut between blocks (paragraph / fenced code / table), never inside
 * one, unless a single block is larger than a page: then a code fence is split
 * between lines (each part closed and reopened with the same fence + language)
 * and a table between rows (header + separator repeated on every part); an
 * oversized paragraph is split between lines, then sentences, then characters.
 * Sizes are measured as JSON-escaped UTF-8 bytes, which is what the card costs.
 */

/** Bytes this text costs inside card JSON (escapes included, quotes excluded). */
export function jsonBytes(s: string): number {
  return Buffer.byteLength(JSON.stringify(s), 'utf8') - 2;
}

interface Unit {
  kind: 'fence' | 'table' | 'para';
  lines: string[];
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function parse(md: string): Unit[] {
  const lines = md.split('\n');
  const units: Unit[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const block = [line];
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        block.push(l);
        i++;
        if (l.trim().startsWith(marker[0]!.repeat(marker.length)) && l.trim().replace(/[`~]/g, '') === '') break;
      }
      units.push({ kind: 'fence', lines: block });
      continue;
    }
    if (line.trimStart().startsWith('|')) {
      const block: string[] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith('|')) block.push(lines[i++]!);
      units.push({ kind: 'table', lines: block });
      continue;
    }
    const block: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !FENCE_RE.test(lines[i]!) && !lines[i]!.trimStart().startsWith('|')) {
      block.push(lines[i++]!);
    }
    units.push({ kind: 'para', lines: block });
  }
  return units;
}

const text = (u: Unit) => u.lines.join('\n');
const SEP = '\n\n';

/** Split one over-long line at sentence ends, then characters, until each piece fits. */
function splitLong(s: string, room: number): string[] {
  if (jsonBytes(s) <= room) return [s];
  const out: string[] = [];
  let cur = '';
  let curBytes = 0; // JSON escaping is per character, so sizes add up
  const push = (piece: string, b: number) => {
    if (cur && curBytes + b > room) {
      out.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += piece;
    curBytes += b;
  };
  for (const p of s.split(/(?<=[。！？!?；;.])/u)) {
    const b = jsonBytes(p);
    if (b <= room) push(p, b);
    else for (const ch of p) push(ch, jsonBytes(ch));
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Split an oversized unit into parts; the first part fits `firstRoom`, the
 * others `room`. Returns [] for the first part when nothing useful fits there.
 */
function splitUnit(u: Unit, firstRoom: number, room: number): string[] {
  let head: string[] = [];
  let tail: string[] = [];
  let body = u.lines;
  if (u.kind === 'fence') {
    const open = u.lines[0]!;
    const marker = FENCE_RE.exec(open)![1]!;
    const last = u.lines.at(-1)!;
    const closed = u.lines.length > 1 && last.trim().replace(/[`~]/g, '') === '' && last.trim().length >= marker.length;
    head = [open];
    tail = [marker];
    body = u.lines.slice(1, closed ? -1 : undefined);
  } else if (u.kind === 'table' && u.lines.length > 2 && TABLE_SEP_RE.test(u.lines[1]!)) {
    head = u.lines.slice(0, 2);
    body = u.lines.slice(2);
  }
  const frame = jsonBytes([...head, ...tail].join('\n')) + 2;
  const parts: string[] = [];
  let cur: string[] = [];
  let curBytes = 0;
  let limit = firstRoom - frame;
  const flush = () => {
    parts.push([...head, ...cur, ...tail].join('\n'));
    cur = [];
    curBytes = 0;
    limit = room - frame;
  };
  for (const raw of body) {
    for (const line of u.kind === 'para' ? splitLong(raw, room - frame) : [raw]) {
      const b = jsonBytes(line) + 2;
      if (cur.length && curBytes + b > limit) flush();
      else if (!cur.length && b > limit && limit < room - frame) {
        parts.push(''); // nothing fits in the first room — start on a fresh page
        limit = room - frame;
      }
      cur.push(line);
      curBytes += b;
    }
  }
  if (cur.length || !parts.length) flush();
  return parts;
}

/**
 * Pages of `md`: the first fits `firstBudget`, the rest `budget` (JSON bytes,
 * page separators included; callers reserve room for their own notes).
 * Concatenating the pages gives back every block once, in order.
 */
export function paginateMarkdown(md: string, firstBudget: number, budget: number): string[] {
  const pages: string[] = [];
  let cur: string[] = [];
  let used = 0;
  let room = firstBudget;
  const close = () => {
    pages.push(cur.join(SEP));
    cur = [];
    used = 0;
    room = budget;
  };
  for (const u of parse(md)) {
    const t = text(u);
    const b = jsonBytes(t) + (cur.length ? 4 : 0);
    if (used + b <= room) {
      cur.push(t);
      used += b;
      continue;
    }
    if (jsonBytes(t) <= budget) {
      // whole block fits a fresh page: never cut it
      if (cur.length) close();
      cur.push(t);
      used = jsonBytes(t);
      continue;
    }
    // block bigger than a page: fill what is left here, continue on new pages
    const left = room - used - (cur.length ? 4 : 0);
    // a sliver at the bottom of a page is not worth starting a block in
    const parts = splitUnit(u, left < 1_500 ? 0 : left, budget);
    parts.forEach((p, i) => {
      if (i > 0 || !p) {
        if (cur.length) close();
      }
      if (!p) return;
      cur.push(p);
      used += jsonBytes(p) + (cur.length > 1 ? 4 : 0);
    });
  }
  if (cur.length || !pages.length) close();
  return pages.filter((p, i) => p.trim() || i === 0);
}
