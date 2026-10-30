import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import type { ChatModeCache } from '../bot/chat-mode-cache';
import type { PendingQueue } from '../bot/pending-queue';
import type { ProcessPool } from '../bot/process-pool';
import type { CallbackAuth } from './callback-auth';
import { runCommandHandler, type CommandContext, type Controls } from '../commands';
import { log } from '../core/logger';
import { canUseDm, canUseGroup, senderFactsOf } from '../policy/access';
import type { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { commandSessionCatalogIdentity } from '../bot/session-catalog-identity';
import { lookupMessageThreadId } from '../bot/thread-id';

/** Marker key on a button's value object that flags the cardAction as
 * a callback that should be forwarded back to the agent instead
 * of dispatched to a built-in command handler. The double-underscore
 * sigils make it virtually impossible to collide with normal payload
 * fields the agent might set.
 */
const BRIDGE_CALLBACK_MARKER = '__bridge_cb';
const LEGACY_CLAUDE_CALLBACK_MARKER = '__claude_cb';

export interface CardDispatchDeps {
  channel: LarkChannel;
  evt: CardActionEvent;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: AgentAdapter;
  processPool?: ProcessPool;
  runExecutor?: RunExecutor;
  controls: Controls;
  pending: PendingQueue;
  chatModeCache: ChatModeCache;
  callbackAuth?: CallbackAuth;
  callbackPolicyFingerprint?: string;
  callbackPolicyFingerprintForScope?: (scope: string) => string | undefined;
}

export async function handleCardAction(deps: CardDispatchDeps): Promise<void> {
  const value = deps.evt.action.value;
  log.info('cardAction', 'entry', {
    hasValue: Boolean(value),
    cmd: typeof value === 'object' && value ? (value as Record<string, unknown>).cmd : undefined,
    messageId: deps.evt.messageId,
  });
  if (!value || typeof value !== 'object') return;
  const payload = value as Record<string, unknown>;

  const operatorId = deps.evt.operator.openId;
  const chatId = deps.evt.chatId;

  // CardKit 2.0 form submits drop user-input values from action.value; they
  // arrive on raw.action.form_value. The SDK forwards the raw event when
  // includeRawEvent: true is set on the channel options.
  const raw = (deps.evt as CardActionEvent & { raw?: unknown }).raw as
    | { action?: { form_value?: Record<string, unknown> } }
    | undefined;
  const formValue = raw?.action?.form_value;

  // Resolve the click's session scope. For topic groups we need to know
  // the message's thread_id so the action targets the right topic's
  // session — look up the carrier message (the card lives on it) once.
  // Done before the access check so we know the chat mode (p2p vs group)
  // and can skip the chat allowlist for DMs.
  const { scope, threadId, mode } = await resolveScope(deps);

  const operatorFacts = senderFactsOf({ raw });
  const accessDecision =
    mode === 'p2p'
      ? canUseDm(deps.controls.profileConfig, deps.controls, operatorId, operatorFacts)
      : canUseGroup(deps.controls.profileConfig, deps.controls, chatId, operatorId, operatorFacts);
  if (!accessDecision.ok) {
    log.info('cardAction', 'skip-not-allowed-user', {
      operator: operatorId.slice(-6),
      reason: accessDecision.reason,
    });
    return;
  }

  if (LEGACY_CLAUDE_CALLBACK_MARKER in payload) {
    log.info('cardAction', 'skip-legacy-callback-marker', { scope });
    return;
  }

  const cmd = typeof payload.cmd === 'string' ? payload.cmd : '';
  if (cmd) {
    if (isSignedBridgeCallback(payload) && !verifyBridgeToken(deps, payload, scope, cmd)) {
      return;
    }
    log.info('cardAction', 'cmd', { cmd, scope });

    // aiduCAT clarify: an option button on a clarify card. The button value
    // carries `cmd: 'clarify.answer'` plus the JSON payload in `arg`. Forward
    // the choice as a plain user message into the scope's pending queue so
    // the agent's session resumes with the answer.
    if (cmd === 'clarify.answer') {
      // f0.2: dropdown 獨立 — the chosen option rides form_value.clarify_choice
      // (select inside the clarify form); the question rides payload.arg.
      const chosen =
        typeof formValue?.clarify_choice === 'string' ? formValue.clarify_choice.trim() : '';
      let question = '';
      let answer = '';
      if (chosen) {
        // dropdown path: question rides payload.arg.q
        try {
          const parsed = JSON.parse(typeof payload.arg === 'string' ? payload.arg : '{}') as {
            q?: unknown;
          };
          question = typeof parsed.q === 'string' ? parsed.q : '';
        } catch {
          /* keep empty question */
        }
        answer = chosen;
      } else {
        // legacy button path ({"q","a"} in arg)
        const legacy = parseClarifyAnswer(typeof payload.arg === 'string' ? payload.arg : '');
        if (legacy) {
          question = legacy.question;
          answer = legacy.answer;
        }
      }
      if (!question || !answer) {
        log.warn('cardAction', 'clarify-unparseable', {
          raw: String(payload.arg ?? '').slice(0, 120),
          chosen: chosen.slice(0, 80),
        });
        return;
      }
      forwardToAgent(deps, { clarify: { question, answer } }, formValue, scope, threadId, mode);
      return;
    }

    const msg = makeFakeMsg(deps.evt, threadId);

    // aiduCAT /help dropdown: picking an option fires a `help.run` callback
    // with the command name on action.option (no submit button). Dispatch it
    // as if the user typed the bare slash command — handlers with required
    // args (cd/exit/timeout/…) reply their own usage text on empty args.
    //
    // Crucially this must NOT carry fromCardAction: that flag means "the
    // carrier message is my own form card — recall it in place" (/model,
    // /config, /account). Here the carrier is the help card, a launcher the
    // user may pick from repeatedly; recalling it also breaks replyTo for
    // the follow-up card. Help-picked commands run as plain typed commands.
    let dispatchCmd = cmd;
    let viaHelpCard = false;
    if (cmd === 'help.run') {
      const picked =
        typeof deps.evt.action.option === 'string' ? deps.evt.action.option.trim() : '';
      if (!picked) {
        log.info('cardAction', 'help-run-no-option', { scope });
        return;
      }
      dispatchCmd = picked;
      viaHelpCard = true;
    }

    const ctx: CommandContext = {
      channel: deps.channel,
      msg,
      scope,
      chatMode: mode,
      sessions: deps.sessions,
      sessionCatalog: deps.sessionCatalog,
      sessionCatalogIdentity: await commandSessionCatalogIdentity({
        msg,
        scope,
        mode,
        workspaces: deps.workspaces,
        controls: deps.controls,
        access: accessDecision,
      }),
      workspaces: deps.workspaces,
      activeRuns: deps.activeRuns,
      agent: deps.agent,
      processPool: deps.processPool,
      runExecutor: deps.runExecutor,
      controls: deps.controls,
      formValue,
      // Help-dropdown picks are plain command invocations (see note above):
      // no in-place recall of the carrier help card.
      fromCardAction: !viaHelpCard,
    };

    const [name, ...rest] = dispatchCmd.split('.');
    const sub = rest.join(' ');
    const args = composeArgs(sub, payload);

    try {
      const ok = await runCommandHandler(name ?? '', args, ctx);
      if (!ok) log.warn('cardAction', 'unknown', { cmd });
    } catch (err) {
      log.fail('cardAction', err, { cmd });
    }
    return;
  }

  // Agent-driven callback: the button was rendered by an agent via lark-cli,
  // with `__bridge_cb` set on the value. Forward the click back into the
  // scope's pending queue so the agent resumes its session and sees the click
  // as a follow-up message, with full context of what it sent.
  if (BRIDGE_CALLBACK_MARKER in payload) {
    if (!verifyBridgeToken(deps, payload, scope, 'agent_callback')) return;
    forwardToAgent(deps, payload, formValue, scope, threadId, mode);
    return;
  }

  return;
}

/** Parse the JSON arg the clarify button carries: `{"q":"...","a":"..."}`.
 * Returns null when the shape is broken (nothing to forward). */
function parseClarifyAnswer(arg: string): { question: string; answer: string } | null {
  try {
    const parsed = JSON.parse(arg) as { q?: unknown; a?: unknown };
    if (typeof parsed.q !== 'string' || typeof parsed.a !== 'string') return null;
    if (!parsed.q.trim() || !parsed.a.trim()) return null;
    return { question: parsed.q, answer: parsed.a };
  } catch {
    return null;
  }
}

async function resolveScope(
  deps: CardDispatchDeps,
): Promise<{ scope: string; threadId: string | undefined; mode: 'p2p' | 'group' | 'topic' }> {  const chatId = deps.evt.chatId;
  const mode = await deps.chatModeCache.resolve(deps.channel, chatId);
  if (mode !== 'topic') {
    return { scope: chatId, threadId: undefined, mode };
  }
  // Topic group — need the carrier message's thread_id to compose scope.
  // One API call per click; could cache by messageId if it ever becomes hot.
  const threadId = await lookupMessageThreadId(deps.channel, deps.evt.messageId);
  if (!threadId) {
    // Fall back to plain chatId. Better to land in the chat's "default"
    // scope than fail the click silently.
    return { scope: chatId, threadId: undefined, mode };
  }
  return { scope: `${chatId}:${threadId}`, threadId, mode };
}

function forwardToAgent(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  formValue: Record<string, unknown> | undefined,
  scope: string,
  threadId: string | undefined,
  mode: 'p2p' | 'group' | 'topic',
): void {
  // aiduCAT clarify: render the choice as a readable answer line the agent
  // was promised in the system prompt ("[clarify] <question> => <answer>").
  const clarify = payload.clarify;
  if (
    clarify &&
    typeof clarify === 'object' &&
    'question' in (clarify as Record<string, unknown>) &&
    'answer' in (clarify as Record<string, unknown>)
  ) {
    const { question, answer } = clarify as { question: unknown; answer: unknown };
    if (typeof question === 'string' && typeof answer === 'string') {
      // f0.2: receipt on the SAME card — swap the form for a chosen line so
      // the question can't be answered twice. updateCard targets the message
      // that carries the card (evt.messageId).
      void (async () => {
        try {
          await deps.channel.updateCard(deps.evt.messageId, {
            schema: '2.0',
            config: {},
            body: {
              elements: [
                { tag: 'markdown', content: `⁉️ **TBC**：${question}` },
                { tag: 'markdown', content: `✅ **已选**：${answer}` },
              ],
            },
          });
        } catch (err) {
          log.warn('cardAction', 'clarify-receipt-update-failed', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      forwardContent(deps, `[clarify] ${question} => ${answer}`, scope, threadId, mode);
      return;
    }
  }
  // Strip the marker so the agent only sees the meaningful fields it set.
  const {
    [BRIDGE_CALLBACK_MARKER]: _marker,
    bridge_token: _token,
    ...agentPayload
  } = payload;
  const merged = formValue ? { ...agentPayload, form_value: formValue } : agentPayload;
  forwardContent(
    deps,
    `[card-click] ${JSON.stringify(merged)}`,
    scope,
    threadId,
    mode,
  );
}

function forwardContent(
  deps: CardDispatchDeps,
  content: string,
  scope: string,
  threadId: string | undefined,
  mode: 'p2p' | 'group' | 'topic',
): void {
  log.info('cardAction', 'forward-agent', {
    scope,
    content: content.slice(0, 200),
  });
  const synthetic: NormalizedMessage = {
    messageId: deps.evt.messageId,
    chatId: deps.evt.chatId,
    chatType: mode === 'p2p' ? 'p2p' : 'group',
    threadId,
    senderId: deps.evt.operator.openId,
    senderName: deps.evt.operator.name,
    content,
    rawContentType: 'card_action',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
  deps.pending.push(scope, synthetic);
}

function verifyBridgeToken(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  scope: string,
  action: string,
): boolean {
  const token = typeof payload.bridge_token === 'string' ? payload.bridge_token : '';
  const active = deps.activeRuns.get(scope);
  if (!deps.callbackAuth || !token || !active) {
    log.info('cardAction', 'skip-callback-auth-missing', { scope, action });
    log.warn('callback', 'denied', { scope, action, reason: 'missing-token-or-run' });
    return false;
  }
  const result = deps.callbackAuth.verify(token, {
    runId: active.run.runId,
    scope,
    chatId: deps.evt.chatId,
    operatorOpenId: deps.evt.operator.openId,
    action,
    policyFingerprint:
      deps.callbackPolicyFingerprintForScope?.(scope) ??
      deps.callbackPolicyFingerprint ??
      '',
  });
  if (!result.ok) {
    log.info('cardAction', 'skip-callback-auth-failed', {
      scope,
      action,
      reason: result.reason,
    });
    log.warn('callback', 'denied', { scope, action, reason: result.reason });
    return false;
  }
  return true;
}

function isSignedBridgeCallback(payload: Record<string, unknown>): boolean {
  return BRIDGE_CALLBACK_MARKER in payload || typeof payload.bridge_token === 'string';
}

/** Turn a button payload like {cmd:'ws.use', name:'proj-a'} into the arg
 * string the text-command handler expects: 'use proj-a'. Accepts `arg`
 * (preferred, generic) or `name` (legacy ws cards). */
function composeArgs(sub: string, payload: Record<string, unknown>): string {
  if (!sub) return '';
  const arg =
    (typeof payload.arg === 'string' && payload.arg) ||
    (typeof payload.name === 'string' && payload.name) ||
    '';
  return arg ? `${sub} ${arg}` : sub;
}

function makeFakeMsg(
  evt: CardActionEvent,
  threadId: string | undefined,
): NormalizedMessage {
  return {
    messageId: evt.messageId,
    chatId: evt.chatId,
    chatType: 'p2p',
    threadId,
    senderId: evt.operator.openId,
    senderName: evt.operator.name,
    content: '',
    rawContentType: 'interactive',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}
