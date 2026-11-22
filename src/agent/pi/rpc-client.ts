import type { Writable } from 'node:stream';
import { log } from '../../core/logger';

/**
 * f0.6+ (pi): minimal JSONL client for pi's `--mode rpc` long-lived child.
 *
 * Protocol facts (docs/rpc.md, probed live on summer 2026-11-23):
 *  - one JSON object per line, LF-terminated; stdout carries `response`
 *    records (correlated by the command's `id`) and session events.
 *  - Node's readline is NOT safe here: it also splits on U+2028/U+2029,
 *    which are legal inside JSON strings. Split on LF only.
 *  - a `prompt` response only means accepted/queued/handled; completion is
 *    signalled by `agent_settled`, never by the response.
 *  - stderr is diagnostics only — never parsed as protocol data.
 */

export interface RpcResponse {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export type RpcEvent = Record<string, unknown> & { type: string };
export type RpcRecord = RpcResponse | RpcEvent;

interface Pending {
  resolve: (r: RpcResponse) => void;
  timer: NodeJS.Timeout;
}

export class PiRpcClient {
  private buffer = '';
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(e: RpcEvent) => void>();
  private closed = false;

  constructor(private readonly stdin: Writable) {
    stdin.on('error', () => {
      this.closed = true;
      this.failAll(new Error('pi stdin closed'));
    });
    stdin.on('close', () => {
      this.closed = true;
      this.failAll(new Error('pi stdin closed'));
    });
  }

  get isClosed(): boolean {
    return this.closed || this.stdin.destroyed || this.stdin.writableEnded;
  }

  /** Feed raw stdout bytes; returns nothing, emits via onEvent/response. */
  feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let rec: RpcRecord;
      try {
        rec = JSON.parse(line) as RpcRecord;
      } catch {
        log.warn('agent', 'pi-rpc-parse-skip', { excerpt: line.slice(0, 120) });
        continue;
      }
      if (rec.type === 'response') {
        const res = rec as RpcResponse;
        const p = res.id ? this.pending.get(res.id) : undefined;
        if (p) {
          this.pending.delete(res.id!);
          clearTimeout(p.timer);
          p.resolve(res);
        }
        continue;
      }
      for (const fn of this.listeners) {
        try {
          fn(rec as RpcEvent);
        } catch (err) {
          log.warn('agent', 'pi-rpc-listener-error', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  onEvent(fn: (e: RpcEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Send a command without waiting for its response (steer, abort, …). */
  send(cmd: Record<string, unknown>): boolean {
    if (this.isClosed) return false;
    try {
      this.stdin.write(JSON.stringify(cmd) + '\n', 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** Send a command and await its correlated response. */
  request(cmd: Record<string, unknown>, timeoutMs = 15_000): Promise<RpcResponse> {
    if (this.isClosed) {
      return Promise.resolve({
        type: 'response',
        command: String(cmd.type ?? ''),
        success: false,
        error: 'pi process is not writable',
      });
    }
    const id = `rq${++this.seq}`;
    return new Promise<RpcResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          id,
          type: 'response',
          command: String(cmd.type ?? ''),
          success: false,
          error: `pi rpc timeout after ${timeoutMs}ms`,
        });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      if (!this.send({ ...cmd, id })) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({
          id,
          type: 'response',
          command: String(cmd.type ?? ''),
          success: false,
          error: 'pi stdin write failed',
        });
      }
    });
  }

  /** Mark the client dead and reject every outstanding request. */
  failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({
        id,
        type: 'response',
        command: 'unknown',
        success: false,
        error: err.message,
      });
    }
    this.pending.clear();
  }
}
