import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { normalizeSessionPreview } from './preview';

export interface SessionSummary {
  sessionId: string;
  mtime: number;
  preview: string;
  lineCount: number;
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function claudeProjectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', encodeCwd(cwd));
}

/** f031-func-#2: Claude config root ($CLAUDE_CONFIG_DIR or ~/.claude). */
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
}

/**
 * f031-func-#2: when the Claude session really started — the first
 * `timestamp` in its transcript (<config>/projects/<cwd>/<session>.jsonl;
 * any project dir if the cwd one has no such file). Only the first 50 lines
 * are scanned and only the timestamp field is kept. undefined when there is
 * no transcript, no timestamp, or the id isn't a plain session id.
 */
export async function transcriptStartedAt(
  sessionId: string | undefined,
  cwd?: string,
): Promise<number | undefined> {
  if (!sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return undefined;
  const root = join(claudeConfigDir(), 'projects');
  const file = `${sessionId}.jsonl`;
  const candidates: string[] = [];
  if (cwd) candidates.push(join(root, encodeCwd(cwd), file));
  try {
    for (const d of await readdir(root)) candidates.push(join(root, d, file));
  } catch {
    /* no projects dir */
  }
  for (const path of candidates) {
    const ts = await firstTimestamp(path);
    if (ts !== undefined) return ts;
  }
  return undefined;
}

async function firstTimestamp(path: string): Promise<number | undefined> {
  let stream: ReturnType<typeof createReadStream>;
  try {
    await stat(path);
    stream = createReadStream(path, { encoding: 'utf8' });
  } catch {
    return undefined;
  }
  const rl = createInterface({ input: stream });
  let n = 0;
  try {
    for await (const line of rl) {
      if (++n > 50) break;
      if (!line.includes('"timestamp"')) continue;
      try {
        const ts = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
        const ms = typeof ts === 'string' ? Date.parse(ts) : typeof ts === 'number' ? ts : NaN;
        if (Number.isFinite(ms) && ms > 0) return ms;
      } catch {
        /* malformed line */
      }
    }
  } catch {
    return undefined;
  } finally {
    rl.close();
    stream.destroy();
  }
  return undefined;
}

/** Return the most recent `limit` jsonl sessions for the given cwd, newest first. */
export async function listRecentSessions(cwd: string, limit = 5): Promise<SessionSummary[]> {
  const dir = claudeProjectDir(cwd);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const jsonls = files.filter((f) => f.endsWith('.jsonl'));
  const withStats = await Promise.all(
    jsonls.map(async (f) => {
      const path = join(dir, f);
      try {
        const st = await stat(path);
        return { file: f, path, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  const sorted = withStats
    .filter((x): x is { file: string; path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  return Promise.all(
    sorted.map(async (entry) => {
      const sessionId = entry.file.replace(/\.jsonl$/, '');
      const { preview, lineCount } = await summarize(entry.path);
      return { sessionId, mtime: entry.mtime, preview, lineCount };
    }),
  );
}

async function summarize(path: string): Promise<{ preview: string; lineCount: number }> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream });
  let preview = '';
  let lineCount = 0;
  try {
    for await (const line of rl) {
      lineCount++;
      if (!preview && line.includes('"type":"user"')) {
        try {
          const obj = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
          if (obj.type === 'user' && obj.message) {
            const text = extractUserText(obj.message.content);
            if (text) preview = normalizeSessionPreview(text);
          }
        } catch {
          /* malformed line */
        }
      }
      // reading the whole file is fine — sessions are usually under 10k lines
      if (lineCount > 20_000) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { preview: preview || '(空会话)', lineCount };
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        return (block as { text: string }).text.trim();
      }
    }
  }
  return '';
}

/** Format a relative time like "3 小时前", "昨天", "3 天前". */
export function formatRelTime(mtime: number): string {
  const diffMs = Date.now() - mtime;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '昨天';
  if (day < 30) return `${day} 天前`;
  const mo = Math.floor(day / 30);
  return `${mo} 个月前`;
}
