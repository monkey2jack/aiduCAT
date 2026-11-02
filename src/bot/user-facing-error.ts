import { log } from '../core/logger';
import type { AgentEvent } from '../agent/types';
import type { AccessDecision } from '../policy/access';

/**
 * f0.4 之后的修复 (bwrap, 2026-11-02): when the agent process itself fails
 * (could not start, crashed, exited non-zero, spawn error …) the raw English
 * stderr used to land on the card — e.g. in a group, for someone who is not the
 * owner: "⚠️ claude exited with code 1: Claude Code could not start: bubblewrap
 * is required …". Wei: queueing is fine, that kind of reply is not.
 *
 * Who sees what:
 *  - the owner in a private chat ('owner-dm') gets a short reason (one line,
 *    capped) plus a pointer to the log;
 *  - everyone else — any group, any non-owner, doc comments — gets a friendly
 *    fixed notice. The full error only goes to the log (run-executor already
 *    logs it on `run failed`).
 */
export type ErrorAudience = 'owner-dm' | 'public';

export const AGENT_FAILED_PUBLIC_NOTICE = '暂时没法处理这条消息，请稍后再试。原因已记到日志，管理员会去看。';
export const PRE_RUN_FAILED_PUBLIC_NOTICE = '⚠️ 这条消息暂时没能处理，请稍后再发一次。原因已记到日志，管理员会去看。';

const OWNER_REASON_MAX = 160;

export function errorAudienceOf(
  access: Pick<AccessDecision, 'ok' | 'reason'> | undefined,
  chatType: string | undefined,
): ErrorAudience {
  return access?.ok === true && access.reason === 'owner' && chatType === 'p2p' ? 'owner-dm' : 'public';
}

/** Short, single-line reason for the owner (no stack, no multi-line stderr). */
export function briefAgentError(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  if (/bubblewrap is required/i.test(text)) {
    return '本机缺少 bubblewrap（非 owner 轮次的隔离要用它），Claude Code 没能启动';
  }
  const exit = /^(claude|codex|hermes) exited with code (\d+)(?::\s*)?(.*)$/i.exec(text);
  if (exit) {
    const detail = (exit[3] ?? '').trim();
    text = `${exit[1]} 进程异常退出（code ${exit[2]}）${detail ? `：${detail}` : ''}`;
  }
  if (text.length > OWNER_REASON_MAX) text = `${text.slice(0, OWNER_REASON_MAX - 1)}…`;
  return text || '未知错误';
}

export function userFacingAgentError(raw: string, audience: ErrorAudience): string {
  if (audience === 'public') return AGENT_FAILED_PUBLIC_NOTICE;
  return `这轮没跑成：${briefAgentError(raw)}。完整报错在 aiduCAT 日志里。`;
}

/**
 * Rewrites `error` events whose terminationReason is 'failed' for the given
 * audience; every other event passes through untouched. Interrupt/timeout
 * errors are left alone (their card text is already ours).
 */
export async function* presentAgentErrors(
  events: AsyncIterable<AgentEvent>,
  audience: ErrorAudience,
): AsyncGenerator<AgentEvent> {
  for await (const evt of events) {
    if (evt.type === 'error' && evt.terminationReason === 'failed') {
      log.info('run', 'error-shown', { audience, masked: audience === 'public' });
      yield { ...evt, message: userFacingAgentError(evt.message, audience) };
    } else {
      yield evt;
    }
  }
}
