/**
 * Keep the whole card when a clarify question is answered (Wei 2026-11-25:
 * 「选完之后之前的信息全部收起不见，只留选项」).
 *
 * The card-action callback carries no card content, so the receipt used to
 * replace the whole answer card with two lines. Now the run remembers the
 * final card of every run that ended on a [CLARIFY] form; on answer the
 * dispatcher swaps only the form for the receipt and keeps everything else.
 *
 * Persisted next to sessions.json so a restart between asking and answering
 * still finds it. Small: last 30 cards, 14 days.
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { log } from '../core/logger';

const MAX_ENTRIES = 30;
const TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface Entry {
  at: number;
  card: object;
}

export class ClarifyCardStore {
  private data: Record<string, Entry> | undefined;

  constructor(private readonly file: string) {}

  private load(): Record<string, Entry> {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Entry>;
    } catch {
      this.data = {};
    }
    return this.data;
  }

  private save(): void {
    const data = this.load();
    const now = Date.now();
    const keep = Object.entries(data)
      .filter(([, e]) => e && typeof e.at === 'number' && now - e.at < TTL_MS)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_ENTRIES);
    this.data = Object.fromEntries(keep);
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      renameSync(tmp, this.file);
      chmodSync(this.file, 0o600);
    } catch (err) {
      log.warn('cardAction', 'clarify-store-save-failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  remember(messageId: string, card: object): void {
    if (!messageId) return;
    this.load()[messageId] = { at: Date.now(), card };
    this.save();
  }

  take(messageId: string): object | undefined {
    const data = this.load();
    const entry = data[messageId];
    if (!entry) return undefined;
    delete data[messageId];
    this.save();
    return entry.card;
  }
}

const stores = new Map<string, ClarifyCardStore>();

/** One store per profile, kept beside that profile's sessions.json. */
export function clarifyCardsFor(sessionsFile: string): ClarifyCardStore {
  const file = `${sessionsFile}.clarify-cards.json`;
  let s = stores.get(file);
  if (!s) {
    s = new ClarifyCardStore(file);
    stores.set(file, s);
  }
  return s;
}

/** The two receipt lines that replace the form. */
export function clarifyReceiptElements(question: string, answer: string): object[] {
  return [
    { tag: 'markdown', content: `⁉️ **TBC**：${question}` },
    { tag: 'markdown', content: `✅ **已选**：${answer}` },
  ];
}

function isForm(el: unknown): boolean {
  const e = el as { tag?: unknown; name?: unknown } | null;
  return !!e && e.tag === 'form' && e.name === 'clarify_form';
}

function isTbcLine(el: unknown): boolean {
  const e = el as { tag?: unknown; content?: unknown } | null;
  return !!e && e.tag === 'markdown' && typeof e.content === 'string' && e.content.startsWith('⁉️ **TBC**');
}

/**
 * The stored card with its clarify form (and the TBC prompt line above it)
 * replaced by the receipt. Undefined when the card holds no clarify form.
 */
export function answeredClarifyCard(card: object, question: string, answer: string): object | undefined {
  const copy = JSON.parse(JSON.stringify(card)) as object;
  let done = false;
  const walk = (node: unknown): void => {
    if (done || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const i = node.findIndex(isForm);
      if (i >= 0) {
        const start = i > 0 && isTbcLine(node[i - 1]) ? i - 1 : i;
        node.splice(start, i - start + 1, ...clarifyReceiptElements(question, answer));
        done = true;
        return;
      }
      for (const child of node) walk(child);
      return;
    }
    for (const v of Object.values(node as Record<string, unknown>)) walk(v);
  };
  walk(copy);
  return done ? copy : undefined;
}
