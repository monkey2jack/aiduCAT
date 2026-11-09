import type {
  LarkChannel,
  LarkChannelOptions,
  NormalizedMessage,
} from '@larksuite/channel';
import { createLarkChannel } from '@larksuite/channel';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { capabilityFor } from '../agent/capability';
import { modelLabel, normalizeModelSelection, resolveModelArg } from '../agent/models';
import {
  buildAgentPrompt,
  untrustedText,
  type BridgePromptInteractiveCard,
  type BridgePromptMention,
  type BridgePromptQuotedMessage,
  type BridgePromptTopicMessage,
} from '../agent/prompt';
import type { AgentAdapter, AgentEvent } from '../agent/types';
import { handleCardAction } from '../card/dispatcher';
import { CallbackAuth } from '../card/callback-auth';
import { CallbackNonceStore } from '../card/callback-store';
import { renderCard, renderCardWithInfo } from '../card/run-renderer';
import { deliverAfterCardFailure, larkErrorCode, sendContinuationCards } from './card-degrade';
import {
  finalizeIfRunning,
  initialState,
  markEmptyRun,
  markIdleTimeout,
  finalAnswerOnlyState,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { renderText } from '../card/text-renderer';
import { tryHandleCommand, type Controls } from '../commands';
import {
  GROUP_SLASH_ADMIN_ONLY_REPLY,
  groupSlashDenied,
  isSlashMessage,
  slashName,
} from '../policy/group-commands';
import type { AppConfig } from '../config/schema';
import {
  getAgentStopGraceMs,
  getEffectiveCotMessages,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRunIdleTimeoutMs,
  getRunToolTimeoutMs,
  getShowToolCalls,
} from '../config/schema';
import type { KeystorePaths } from '../config/keystore';
import { featureEnabled } from '../config/profile-schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { log, reportMetric, withTrace } from '../core/logger';
import { DOWNLOAD_FAILED, MediaCache, type LocalAttachment } from '../media/cache';
import {
  toPolicyAttachment,
  toPromptAttachment,
} from '../media/attachment';
import {
  canRunAdminCommand,
  canUseDm,
  canUseGroup,
  noteOwnerTenant,
  requireMentionForChat,
  senderFactsOf,
} from '../policy/access';
import {
  errorAudienceOf,
  presentAgentErrors,
  PRE_RUN_FAILED_PUBLIC_NOTICE,
  type ErrorAudience,
} from './user-facing-error';
// f03p-slim-#3/#7: meeting modules are imported only when the feature is on
// and meeting.enabled is set.
import type { MeetingManager } from '../meeting/manager';
import type { VcRequestClient } from '../meeting/api';
import type { ScopeContext } from '../policy/run-policy';
import { createOwnerRefreshController } from '../policy/owner';
import { RunExecutor } from '../runtime/run-executor';
import { RunWatchdog, type RunTimeouts } from './run-watchdog';
import { RunJournal, type JournalSnapshot } from './run-journal';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import { TurnTpsMeter } from '../session/turn-tps';
import { EarlyCard, EarlyCards, earlySendOpts } from './early-card';
import type { WorkspaceStore } from '../workspace/store';
import { ActiveRuns, type RunHandle } from './active-runs';
import { ChatModeCache, type ChatMode } from './chat-mode-cache';
import { handleCommentMention } from './comments';
import { recordRunSessionEvent, startRunFlow } from './run-flow';
import { commandSessionCatalogIdentity } from './session-catalog-identity';
import { startKeepalive } from './keepalive';
import { PendingQueue } from './pending-queue';
import { ProcessPool } from './process-pool';
import { fetchQuotedContext, fetchTopicContext, type QuotedContext } from './quote';
import { lookupMessageThreadId } from './thread-id';
import { addWorkingReaction, removeReaction } from './reaction';
import { fetchKnownChats } from './lark-info';
import { contextWindowForModel, resolveModelWindow } from './context-window';
import { profileForChat } from '../config/chat-model';
import { prewarmCombos } from './tenrouter';
import type { AppPaths } from '../config/app-paths';
// f03p-slim-#7: the CoT module is loaded only when a run actually uses CoT.
import type { CotClient } from './cot';

const DEBOUNCE_MS = 600;
const STREAM_TERMINAL_GRACE_MS = 3000;
const REACTION_CLEANUP_GRACE_MS = 1000;

const BRIDGE_AGENT_INSTRUCTIONS = [
  '你在 bridge 进程中运行，普通 lark-cli 会继承 LARK_CHANNEL=1 并进入 bridge-bound 模式。',
  '不要 unset LARK_CHANNEL / LARK_CHANNEL_HOME / LARK_CHANNEL_PROFILE / LARKSUITE_CLI_CONFIG_DIR，也不要用 env -u LARK_CHANNEL 绕回本机普通配置。',
  'Codex bridge 只有在 full 权限下才使用 danger-full-access（对齐 Claude bridge 的 bypassPermissions），那时 lark-cli 能像用户本机终端一样访问 keychain；workspace / read-only 权限下可能做不到，如实告诉用户即可。',
  '如果提示 lark-channel context detected but not bound，停止当前操作并请用户重启 bridge 或运行 bridge doctor/preflight；不要改用普通 profile，不要自行 bind，也不要直接读取 config.json 里的账号或密钥。',
  '🚨 铁律：你就是运行在 aiduCAT 桥接进程里的 agent。绝对禁止执行 systemctl restart/stop aiduCAT、kill 本进程、pkill node、reboot、shutdown 等任何会终止自己所在服务的操作（包括以\"健康验证\"\"测试\"为理由）。restart 这个服务 = 杀死你自己并掐断用户正在跑的任务。健康检查只允许只读命令（systemctl status / is-active / 读日志）。确需重启时，先向用户说明并等用户本人执行。',
];

// Lark SDK logs API errors at error level even when the caller catches them.
// These specific codes are EXPECTED in our flow (wiki-node lookup that
// usually misses, fileComment.get that we deliberately let fall back to
// .list) and the surrounding noise is already covered by our own logs.
const SUPPRESSED_API_ERROR_CODES = new Set([
  131005, // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307, // drive.fileComment.get "not exist" — fall back to .list
  1069302, // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);

const SUPPRESSED_ENDPOINT_API_ERRORS = [
  {
    code: 99991672,
    urlPart: '/open-apis/wiki/v2/spaces/get_node',
  },
];

function codeFromObj(m: unknown): number | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const top = (m as { code?: unknown }).code;
  if (typeof top === 'number') return top;
  const nested = (m as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof nested === 'number' ? nested : undefined;
}

function urlFromObj(m: unknown): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const configUrl = (m as { config?: { url?: unknown } })?.config?.url;
  if (typeof configUrl === 'string') return configUrl;
  const requestPath = (m as { request?: { path?: unknown } })?.request?.path;
  return typeof requestPath === 'string' ? requestPath : undefined;
}

function isSuppressedSdkMessage(msg: unknown): boolean {
  if (Array.isArray(msg)) return msg.some(isSuppressedSdkMessage);
  const code = codeFromObj(msg);
  if (code === undefined) return false;
  if (SUPPRESSED_API_ERROR_CODES.has(code)) return true;
  const url = urlFromObj(msg);
  return SUPPRESSED_ENDPOINT_API_ERRORS.some(
    (rule) => code === rule.code && url?.includes(rule.urlPart),
  );
}

export function shouldSuppressSdkErrorLog(args: unknown[]): boolean {
  return args.some(isSuppressedSdkMessage);
}

function buildQuietLogger(): {
  error: (...m: unknown[]) => void;
  warn: (...m: unknown[]) => void;
  info: (...m: unknown[]) => void;
  debug: (...m: unknown[]) => void;
  trace: (...m: unknown[]) => void;
} {
  return {
    error: (...args: unknown[]) => {
      if (shouldSuppressSdkErrorLog(args)) return;
      log.warn('sdk', 'error', { args: stringifyArgs(args) });
    },
    warn: (...args: unknown[]) => log.warn('sdk', 'warn', { args: stringifyArgs(args) }),
    info: (...args: unknown[]) => log.info('sdk', 'info', { args: stringifyArgs(args) }),
    debug: () => {},
    trace: () => {},
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export interface DrainResult {
  /** true = every round that was running has finished */
  drained: boolean;
  /** rounds still running when the drain gave up (timeout or abort) */
  remaining: number;
}

export interface BridgeChannel {
  channel: LarkChannel;
  disconnect(): Promise<void>;
  /**
   * f03p-infra-#5: graceful shutdown, step 1 — stop starting rounds (new
   * messages are still accepted, journalled, and replayed by the next
   * process) and wait up to `timeoutMs` for the rounds in flight to end.
   * Call disconnect() afterwards. Optional so test doubles may omit it.
   */
  drain?(timeoutMs: number, signal?: AbortSignal): Promise<DrainResult>;
}

export interface StartChannelDeps {
  cfg: AppConfig;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  controls: Controls;
  appPaths?: KeystorePaths & Pick<AppPaths, 'mediaDir'>;
}

export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { cfg, agent, sessions, sessionCatalog, workspaces, controls } = deps;
  const activeRuns = new ActiveRuns();
  // ChatModeCache stays per-bridge-instance — invalidated on restart along
  // with everything else. Topic-mode chats only need one chat.get() call ever.
  const chatModeCache = new ChatModeCache();
  // Concurrency cap — reads `preferences.maxConcurrentRuns` on each acquire,
  // so /config bumps take effect for the next run.
  const pool = new ProcessPool(() => getMaxConcurrentRuns(controls.cfg));
  const executor = new RunExecutor({ agent, pool, activeRuns });

  // Resolve the App Secret to plaintext. The config field can be a literal
  // string, a "${VAR}" template, or a {source, id} SecretRef referencing
  // the encrypted keystore / env / file / exec provider. Re-resolved on
  // every startChannel so /account change picks up new secrets.
  const appSecret = await resolveAppSecret(cfg, deps.appPaths);
  const callbackNonceStore = deps.appPaths?.mediaDir
    ? new CallbackNonceStore(join(dirname(deps.appPaths.mediaDir), 'callback-nonces.json'))
    : undefined;
  await callbackNonceStore?.load();
  const callbackAuth = callbackNonceStore
    ? new CallbackAuth({
        keys: [{ version: 1, secret: appSecret }],
        nonceStore: callbackNonceStore,
      })
    : undefined;
  const activePolicyFingerprints = new Map<string, string>();
  // Per-scope record of the model used on the last run, so a `/config` model
  // switch can inject a one-time "model changed" note into the next (resumed)
  // prompt. In-memory only: on restart the first run re-seeds silently.
  const lastRunModelByScope = new Map<string, string>();
  // f03p-slim-#4/#7: built on first CoT use (never when CoT is off).
  let cotClientPromise: Promise<CotClient> | undefined;
  const cotClient = (): Promise<CotClient> =>
    (cotClientPromise ??= import('./cot').then(
      ({ CotClient: Client }) =>
        new Client({ tenant: cfg.accounts.app.tenant, appId: cfg.accounts.app.id, appSecret }),
    ));
  const threadModeOverrideWarnedChats = new Set<string>();
  const logThreadModeOverride: LogThreadModeOverride = ({ chatId, resolvedMode, threadId }) => {
    const fields = { chatId, cachedMode: resolvedMode, threadId };
    if (threadModeOverrideWarnedChats.has(chatId)) {
      log.info('chat', 'mode-overridden-by-thread', fields);
      return;
    }
    threadModeOverrideWarnedChats.add(chatId);
    log.warn('chat', 'mode-overridden-by-thread', fields);
  };

  const opts: LarkChannelOptions = {
    appId: cfg.accounts.app.id,
    appSecret,
    domain:
      cfg.accounts.app.tenant === 'lark'
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn',
    source: 'lark-channel-bridge',
    logger: buildQuietLogger(),
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
      // Two bridged bots in the same group can @ each other forever. Drop the
      // 5th bot @-mention within an hour per chat; any human message resets it.
      botLoopGuard: { enabled: true, maxBotMentions: 5, windowMs: 3_600_000, scope: 'chat', onTrip: 'drop' },
    },
    // Disable per-chat serialization so we can implement our own
    // debounce + run-chain policy (see pending-queue + runChain below).
    safety: {
      chatQueue: { enabled: false },
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    outbound: {
      // f0.3.1 #5: 飞书「更新应用发送的消息卡片」单条消息限频 5 QPS（50/s 是
      // 整个应用的总量），超了返回 230020，整卡 patch 就失败。250ms = 每卡
      // ≤4 次/秒，留余量。streamThrottleChars 必须关掉：SDK 在累计字符数
      // ≥ 阈值时立即发（默认 50），而整卡 JSON 每次都远超 50，等于没有节流。
      streamThrottleMs: 250,
      streamThrottleChars: Number.MAX_SAFE_INTEGER,
    },
    // SDK 1.65.0-alpha.3+ knobs.
    wsConfig: {
      // f031-stab-#2 (upstream #252): liveness watchdog — no inbound frame
      // within N s after our ping ⇒ presumed dead ⇒ reconnect. 3s tripped on
      // a single late pong, and every reconnect killed in-flight runs. 20s
      // still catches a half-dead socket well before the 15s keepalive ×3.
      pingTimeout: 20,
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks.
    handshakeTimeoutMs: 8_000,
    // f031-stab-#1: since @larksuite/channel 0.6.1 forceReconnect waits on
    // connectTimeoutMs (default 15s) instead of the handshake timeout; pin it
    // to 8s so reconnects behave as before the upgrade.
    connectTimeoutMs: 8_000,
    // Per-request REST timeout — without a cap a slow API can hang the
    // event-handling thread.
    httpTimeoutMs: 30_000,
    // Route WS + REST through HTTPS_PROXY / HTTP_PROXY when set (no-op otherwise).
    respectProxyEnv: true,
  };

  const channel = createLarkChannel(opts);
  // f0.3.4: warm the 10router combo cache in the background so the first
  // /model open (and any combo-declared window) never waits on 10router.
  void prewarmCombos(cfg);
  const media = new MediaCache(channel, deps.appPaths?.mediaDir);

  // Pending → run handoff: while a run is active on a chat, block its pending
  // queue so messages keep accumulating without flushing. When the run ends,
  // unblock arms a fresh quiet-window timer. Net effect: at most one run per
  // chat in flight, and everything sent during a run merges into the next
  // batch (only flushed once 600ms of silence has passed *after* the run).
  // f031-stab-#5: queued messages + in-flight runs mirrored on disk (0600,
  // next to sessions.json) so a restart can close orphan cards and re-queue.
  const journal = new RunJournal(
    deps.appPaths?.mediaDir ? join(dirname(deps.appPaths.mediaDir), RUN_JOURNAL_FILE) : undefined,
  );
  const leftover = await journal.takeOver();
  // f03p-infra-#5: rounds between flush and their end (pre-run steps
  // included), so a graceful shutdown knows when it may stop.
  let inflightBatches = 0;
  const inflightWaiters = new Set<() => void>();
  let draining = false;
  const drainNoticed = new Set<string>();
  /** f03p-infra-#6: message ids of the synthetic "接着刚才的继续" messages. */
  const autoResumeIds = new Set<string>();
  const noteQueuedWhileDraining = (scope: string, msg: NormalizedMessage): void => {
    if (!draining || drainNoticed.has(scope)) return;
    drainNoticed.add(scope);
    const opts = msg.threadId ? { replyTo: msg.messageId, replyInThread: true } : undefined;
    void channel
      .send(msg.chatId, { text: DRAIN_QUEUED_NOTICE }, opts)
      .catch((err: unknown) => log.warn('shutdown', 'drain-notice-failed', { scope, err: String(err) }));
  };
  // f0.3.5: card-mode Claude profiles show「☤aiduCATing…」the moment a
  // message is accepted (see early-card.ts) instead of a reaction.
  const earlyCards = new EarlyCards((scope, msg) => {
    if (!usesEarlyCard(controls)) return undefined;
    log.info('outbound', 'early-card-open', { scope, ...latencyFields(msg.createTime) });
    return new EarlyCard(
      channel as unknown as ConstructorParameters<typeof EarlyCard>[0],
      msg.chatId,
      renderCard(initialState, {
        agentKind: controls.profileConfig.agentKind,
        model: profileForChat(
          controls.profileConfig,
          msg.chatType === 'p2p' ? undefined : msg.chatId,
        ).preferences.model,
      }),
      earlySendOpts(msg),
      scope,
    );
  });
  const pending = new PendingQueue(DEBOUNCE_MS, (scope, batch) => {
    // f0.3.5: taken synchronously, so a message arriving after this flush
    // gets its own card for the next batch.
    const earlyCard = earlyCards.take(scope);
    const firstMsg = batch[0];
    if (!firstMsg) {
      earlyCard?.discard('empty-batch');
      return;
    }
    // f0.2+ /status: count every incoming user message batch as one user turn.
    sessions.recordMessage(scope, 'user');
    pending.block(scope);
    const lastMsg = batch[batch.length - 1]!;
    const runKey = randomUUID();
    // f03p-infra-#6: this batch carries the automatic post-restart continuation.
    const autoResume = batch.some((m) => autoResumeIds.delete(m.messageId));
    journal.dequeue(scope, batch.map((m) => m.messageId));
    journal.startRun(scope, {
      runKey,
      chatId: firstMsg.chatId,
      replyTo: lastMsg.messageId,
      ...(firstMsg.threadId ? { replyInThread: true } : {}),
      resumeMsg: lastMsg,
      ...(autoResume ? { autoResumed: true } : {}),
    });
    inflightBatches++;
    let terminal: string | undefined;
    void withTrace({ chatId: firstMsg.chatId }, async () => {
      log.info('flush', 'start', {
        scope,
        ...latencyFields(lastMsg.createTime),
        batchSize: batch.length,
        chatId: firstMsg.chatId,
        threadId: firstMsg.threadId,
        msgId: firstMsg.messageId,
      });
      // f0.3.4: the "收到了" reaction goes on the moment the batch flushes —
      // before chat-mode lookup, attachments, pool acquire and agent spawn
      // (it used to land ~2s after acquire). Fire-and-forget: a failed
      // reaction never touches the run.
      // f0.3.5: card-mode Claude has the「☤aiduCATing…」card instead (opened
      // at intake, or at run start for a replayed batch) — no reaction.
      const workingReaction = usesEarlyCard(controls)
        ? NO_REACTION
        : startWorkingReaction(channel, lastMsg.messageId, lastMsg.createTime);
      try {
        const resolvedMode = await chatModeCache.resolve(channel, firstMsg.chatId);
        // Feishu/Lark converted topic groups may still resolve as `group` from
        // the chat info API/cache, while message events already carry threadId.
        // Treat threadId as authoritative for IM messages so scope and replies
        // stay isolated per topic.
        const mode = firstMsg.threadId ? 'topic' : resolvedMode;
        if (firstMsg.threadId && resolvedMode !== 'topic') {
          chatModeCache.invalidate(firstMsg.chatId);
          logThreadModeOverride({
            chatId: firstMsg.chatId,
            resolvedMode,
            threadId: firstMsg.threadId,
          });
        }
        await runAgentBatch({
          channel,
          executor,
          sessions,
          sessionCatalog,
          workspaces,
          media,
          batch,
          controls,
          cotClient,
          callbackAuth,
          activePolicyFingerprints,
          lastRunModelByScope,
          scope,
          mode,
          workingReaction,
          ...(earlyCard ? { earlyCard } : {}),
          onCardOpened: (messageId) => journal.setCard(scope, runKey, messageId),
          onTerminal: (t) => {
            terminal = t;
          },
        });
        if (autoResume && !draining && (terminal === undefined || terminal === 'error' || terminal === 'idle_timeout')) {
          await notifyAutoResumeFailed(channel, lastMsg);
        }
      } catch (err) {
        log.fail('flush', err);
        if (autoResume && !(err instanceof PreRunError) && !draining) {
          await notifyAutoResumeFailed(channel, lastMsg);
        }
        // f031-stab-#16: a pre-run step failed before anything reached the
        // user — say so instead of staying silent.
        if (err instanceof PreRunError) {
          await sendPreRunFailure(channel, lastMsg, err, controls.botOwnerId).catch((sendErr) =>
            log.warn('flush', 'pre-run-notice-failed', { err: String(sendErr) }),
          );
        }
      } finally {
        // f03p-infra-#5/#6: a round that ended as "interrupted" while we drain
        // was killed by the stop itself (e.g. systemd signalled the whole
        // cgroup) — keep it in the journal so the next start continues it.
        // Unless someone stopped it on purpose (/stop, /cd, /new …).
        const stoppedOnPurpose = activeRuns.consumeStoppedOnPurpose(scope);
        if (!(draining && terminal === 'interrupted' && !stoppedOnPurpose)) journal.endRun(scope, runKey);
        // f0.3.4: idempotent — covers rounds that ended before the run took
        // over the reaction (pre-run failure, policy reject, empty prompt).
        workingReaction.release();
        // f0.3.5: the round ended without using its placeholder card.
        earlyCard?.discard('not-used');
        pending.unblock(scope);
        log.info('flush', 'end');
        inflightBatches--;
        if (inflightBatches === 0) for (const wake of [...inflightWaiters]) wake();
      }
    });
  }, {
    onPush: (scope, msg) => {
      journal.queue(scope, msg);
      noteQueuedWhileDraining(scope, msg);
      if (!draining) earlyCards.ensure(scope, msg);
    },
    onDrop: (scope, msgs) => {
      journal.dequeue(scope, msgs.map((m) => m.messageId));
      earlyCards.take(scope)?.discard('dropped');
    },
  });

  // Counter for stdout reconnect escalation; reset on `reconnected`.
  let consecutiveReconnects = 0;

  channel.on({
    message: async (msg) => {
      await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, () =>
        intakeMessage({
          channel,
          agent,
          sessions,
          sessionCatalog,
          workspaces,
          activeRuns,
          pending,
          msg,
          controls,
          chatModeCache,
          logThreadModeOverride,
          executor,
          pool,
        }),
      ).catch((err) => log.fail('intake', err));
    },
    reject: (evt) => {
      log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      await withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
        await handleCardAction({
          channel,
          evt,
          sessions,
          sessionCatalog,
          workspaces,
          activeRuns,
          agent,
          processPool: pool,
          runExecutor: executor,
          controls,
          pending,
          chatModeCache,
          callbackAuth,
          callbackPolicyFingerprintForScope: (scope) => activePolicyFingerprints.get(scope),
        });
      }).catch((err) => log.fail('cardAction', err));
    },
    comment: async (evt) => {
      await withTrace({ chatId: 'comment' }, async () => {
        await handleCommentMention({
          channel,
          evt,
          agent,
          sessions,
          sessionCatalog,
          workspaces,
          activeRuns,
          executor,
          controls,
        }).catch((err) => log.fail('comment', err));
      }).catch((err) => log.fail('comment', err));
    },
    reconnecting: () => {
      consecutiveReconnects++;
      log.warn('ws', 'reconnecting', { consecutive: consecutiveReconnects });
      reportMetric('ws_reconnect', 1, { kind: 'ws' });
      // Stdout escalation — surface jitter that's hidden in the file log.
      if (consecutiveReconnects === 3) {
        console.error('⚠️ 已连续重连 3 次,网络可能不稳。');
      } else if (consecutiveReconnects === 10) {
        console.error('❌ 已连续重连 10 次,建议在飞书发 /reconnect 或重启 bot。');
      }
    },
    reconnected: () => {
      if (consecutiveReconnects > 1) {
        log.info('ws', 'recovered', { afterAttempts: consecutiveReconnects });
      } else {
        log.info('ws', 'reconnected');
      }
      consecutiveReconnects = 0;
    },
    // Classify common WS errors into the `network` phase so /doctor and grep
    // can find them without scanning generic `ws.fail` entries.
    error: (err) => {
      const msg = err?.message ?? String(err);
      if (/ENOTFOUND|getaddrinfo/.test(msg)) {
        log.fail('network', err, { kind: 'dns', code: err.code });
      } else if (/handshake|did not complete/.test(msg)) {
        log.fail('network', err, { kind: 'handshake-timeout', code: err.code });
      } else if (/timeout/i.test(msg)) {
        log.fail('network', err, { kind: 'timeout', code: err.code });
      } else {
        log.fail('ws', err, { code: err.code });
      }
    },
  });

  // In-meeting agent. Created before connect() so the `vc.bot.*` handlers are
  // installed on the event dispatcher before any push can arrive; sessions are
  // only created later (on /meeting join or an invite), so the late-bound
  // botOpenId getter is resolved by then.
  const meetingConfig = () => controls.profileConfig.meeting;
  let meetingManager: MeetingManager | undefined;
  if (featureEnabled(controls.profileConfig, 'meeting') && meetingConfig().enabled) {
    const [{ MeetingManager: Manager }, { attachMeetingAgent, summarizeEndedMeeting }] = await Promise.all([
      import('../meeting/manager'),
      import('../meeting/orchestrator'),
    ]);
    meetingManager = new Manager({
      client: channel.rawClient as unknown as VcRequestClient,
      config: meetingConfig,
      botOpenId: () => channel.botIdentity?.openId,
      channel,
      // f031-sec-M3: only an owner/admin invite pulls the bot into a meeting.
      canAutoJoin: (inviterId) =>
        Boolean(inviterId) && canRunAdminCommand(controls.profileConfig, controls, inviterId!).ok,
      // Meeting over: optionally summarize to IM (config-gated inside).
      onEnded: (session) =>
        void summarizeEndedMeeting({
          session,
          channel,
          controls,
          executor,
          activeRuns,
          sessions,
          ...(sessionCatalog ? { sessionCatalog } : {}),
          workspaces,
        }).catch((err) => log.warn('meeting', 'summary-failed', { err: String(err) })),
      onSession: (session) =>
        attachMeetingAgent({
          session,
          channel,
          controls,
          executor,
          activeRuns,
          sessions,
          ...(sessionCatalog ? { sessionCatalog } : {}),
          workspaces,
        }),
    });
    meetingManager.attachPush();
    controls.meeting = meetingManager;
  }

  await channel.connect();
  const ownerRefresh = createOwnerRefreshController({
    controls,
    source: channel,
    appId: cfg.accounts.app.id,
  });
  await ownerRefresh.start();
  const knownChatsRefresh = startKnownChatsRefreshTimer(channel, controls);

  const identity = channel.botIdentity;
  // Late-bind the bot's own IM identity into the agent adapter so the system
  // prompt can state "this open_id is you" with the real value. Covers both
  // initial start and credential-swap reconnects (both go through here).
  if (identity?.openId) {
    agent.setBotIdentity?.({
      openId: identity.openId,
      ...(identity.name ? { name: identity.name } : {}),
    });
  }
  log.info('ws', 'connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    agent: `${agent.displayName} (${agent.id})`,
    appId: cfg.accounts.app.id,
    procId: controls.processId,
  });
  console.log('正在监听消息。按 Ctrl+C 退出。\n');

  // App-level keepalive: 15s probe + wake-up detection + HTTP reachability.
  // Defense-in-depth — the SDK's pingTimeout watchdog handles half-dead WS,
  // this catches anything that the SDK misses (silent state stuck, etc.).
  const probeDomain =
    cfg.accounts.app.tenant === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
  const keepalive = startKeepalive({
    channel,
    domain: probeDomain,
    forceReconnect: () => controls.restart(),
  });

  // f031-stab-#5: settle what the previous process left behind.
  await recoverAfterRestart({
    channel,
    pending,
    journal,
    snapshot: leftover,
    // f03p-infra-#6: only a Claude scope with a recorded session can be resumed.
    canResume: (scope) => agent.id === 'claude' && Boolean(sessions.getRaw(scope)?.sessionId),
    autoResumeIds,
  });

  return {
    channel,
    drain: async (timeoutMs: number, signal?: AbortSignal): Promise<DrainResult> => {
      draining = true;
      pending.freeze();
      // f0.3.5: queued batches are replayed by the next process (which opens
      // its own card); don't leave「☤aiduCATing…」placeholders behind.
      earlyCards.discardAll('draining');
      const startedAt = Date.now();
      log.info('shutdown', 'drain-start', { inflight: inflightBatches, timeoutMs });
      if (inflightBatches > 0 && !signal?.aborted) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer);
            inflightWaiters.delete(check);
            signal?.removeEventListener('abort', done);
            resolve();
          };
          const check = (): void => {
            if (inflightBatches === 0) done();
          };
          const timer = setTimeout(done, Math.max(0, timeoutMs));
          inflightWaiters.add(check);
          signal?.addEventListener('abort', done, { once: true });
        });
      }
      const remaining = inflightBatches;
      log.info('shutdown', 'drain-end', { drained: remaining === 0, remaining, waitedMs: Date.now() - startedAt });
      return { drained: remaining === 0, remaining };
    },
    disconnect: async () => {
      activeRuns.pauseNewRuns('bridge-disconnect');
      ownerRefresh.stop();
      knownChatsRefresh.stop();
      keepalive.stop();
      // Stop meeting timers but stay in the meetings: /reconnect tears the
      // channel down and rebuilds it, and auto-leaving every meeting on a
      // reconnect would be surprising.
      meetingManager?.dispose();
      controls.meeting = undefined;
      // f031-stab-#5: freeze the journal first — what is queued / in flight
      // right now is exactly what the next start must recover.
      await journal.close();
      pending.cancelAll();
      earlyCards.discardAll('disconnect');
      const [disconnectResult, stopAllResult, ...flushResults] = await Promise.allSettled([
        channel.disconnect(),
        activeRuns.stopAll(),
        sessions.flush(),
        sessionCatalog?.flush(),
        callbackNonceStore?.flush(),
        workspaces.flush(),
      ]);
      if (stopAllResult.status === 'rejected') {
        log.fail('disconnect', stopAllResult.reason, { step: 'stopAll' });
      }
      for (const [idx, result] of flushResults.entries()) {
        if (result.status === 'rejected') {
          log.fail('disconnect', result.reason, { step: `flush-${idx}` });
        }
      }
      if (disconnectResult.status === 'rejected') {
        throw disconnectResult.reason;
      }
    },
  };
}

/** f031-stab-#5 */
const RUN_JOURNAL_FILE = 'run-journal.json';
/** Re-queue messages only if the restart was quick; older ones get a notice. */
const REPLAY_MAX_AGE_MS = 10 * 60_000;
export const RESTART_INTERRUPTED_MESSAGE = '服务重启，这一轮被中断了，请重发一次。';
/** f03p-infra-#5: once per chat for messages that arrive while the service drains. */
export const DRAIN_QUEUED_NOTICE = '⏳ 服务正在重启，这条消息已记下，重启后会自动接着处理。';

/** f03p-infra-#6 */
const RESUME_MAX_AGE_MS = 10 * 60_000;
export const AUTO_RESUME_PROMPT = '（服务重启，接着刚才的继续）';
export const AUTO_RESUME_CARD_MESSAGE = '🔄 服务重启后自动继续（见下一张卡片）';
export const AUTO_RESUME_FAILED_MESSAGE = '⚠️ 服务重启后自动继续没成功，请重发一次。';

async function notifyAutoResumeFailed(channel: LarkChannel, msg: NormalizedMessage): Promise<void> {
  const opts = msg.threadId ? { replyTo: msg.messageId, replyInThread: true } : { replyTo: msg.messageId };
  await channel
    .send(msg.chatId, { text: AUTO_RESUME_FAILED_MESSAGE }, opts)
    .catch((err: unknown) => log.warn('journal', 'auto-resume-failed-notice-failed', { err: String(err) }));
}

async function recoverAfterRestart(input: {
  channel: LarkChannel;
  pending: PendingQueue;
  journal: RunJournal;
  snapshot: JournalSnapshot;
  canResume?: (scope: string) => boolean;
  autoResumeIds?: Set<string>;
}): Promise<void> {
  const { channel, pending, snapshot } = input;
  if (snapshot.inflight.length === 0 && snapshot.queued.length === 0) return;
  log.warn('journal', 'recover', {
    inflight: snapshot.inflight.length,
    queuedScopes: snapshot.queued.length,
  });
  const notify = async (chatId: string, text: string, replyTo?: string, replyInThread?: boolean): Promise<void> => {
    try {
      await channel.send(chatId, { text }, replyTo ? { replyTo, ...(replyInThread ? { replyInThread } : {}) } : undefined);
    } catch (err) {
      log.warn('journal', 'notify-failed', { chatId, err: err instanceof Error ? err.message : String(err) });
    }
  };
  const downSince = snapshot.closedAt ?? snapshot.savedAt;
  for (const [scope, e] of snapshot.inflight) {
    // f03p-infra-#6: continue once, by itself, when the restart was quick,
    // the round was not already a continuation, and its session can resume.
    const interruptedAt = downSince ?? e.startedAt;
    const resumable =
      e.resumeMsg !== undefined &&
      e.autoResumed !== true &&
      Date.now() - interruptedAt <= RESUME_MAX_AGE_MS &&
      input.canResume?.(scope) === true &&
      input.autoResumeIds !== undefined;
    if (resumable) {
      if (e.cardMessageId) {
        try {
          const state: RunState = { ...initialState, terminal: 'interrupted', footer: null, errorMsg: AUTO_RESUME_CARD_MESSAGE };
          await channel.updateCard(e.cardMessageId, renderCard(state));
        } catch (err) {
          log.warn('journal', 'orphan-card-close-failed', { scope, err: err instanceof Error ? err.message : String(err) });
        }
      }
      const msg: NormalizedMessage = { ...e.resumeMsg!, content: AUTO_RESUME_PROMPT, createTime: Date.now() };
      input.autoResumeIds!.add(msg.messageId);
      pending.push(scope, msg);
      log.info('journal', 'auto-resume', { scope, card: Boolean(e.cardMessageId), downMs: Date.now() - interruptedAt });
      continue;
    }
    let closed = false;
    if (e.cardMessageId) {
      try {
        const state: RunState = { ...initialState, terminal: 'error', footer: null, errorMsg: RESTART_INTERRUPTED_MESSAGE };
        await channel.updateCard(e.cardMessageId, renderCard(state));
        closed = true;
      } catch (err) {
        log.warn('journal', 'orphan-card-close-failed', { scope, err: err instanceof Error ? err.message : String(err) });
      }
    }
    if (!closed) await notify(e.chatId, `⚠️ ${RESTART_INTERRUPTED_MESSAGE}`, e.replyTo, e.replyInThread);
    log.info('journal', 'orphan-closed', { scope, card: Boolean(e.cardMessageId), viaCard: closed });
  }
  const now = Date.now();
  // f03p-infra-#5: after an orderly shutdown, what matters is how long the
  // service was down — a message that waited out a 10-minute drain is still
  // fresh if the restart itself was quick.
  const ageOf = (q: { storedAt: number }): number =>
    now - (snapshot.closedAt !== undefined ? Math.max(q.storedAt, snapshot.closedAt) : q.storedAt);
  for (const [scope, entries] of snapshot.queued) {
    const fresh = entries.filter((q) => ageOf(q) <= REPLAY_MAX_AGE_MS);
    const stale = entries.filter((q) => ageOf(q) > REPLAY_MAX_AGE_MS);
    for (const q of fresh) pending.push(scope, q.msg);
    if (stale.length > 0) {
      const last = stale[stale.length - 1]!.msg;
      await notify(
        last.chatId,
        `⚠️ 服务重启前收到的 ${stale.length} 条消息没来得及处理（已超过 ${REPLAY_MAX_AGE_MS / 60_000} 分钟），请重发。`,
        last.messageId,
        Boolean(last.threadId),
      );
    }
    log.info('journal', 'queued-recovered', { scope, replayed: fresh.length, stale: stale.length });
  }
}

function startKnownChatsRefreshTimer(
  channel: LarkChannel,
  controls: Controls,
): { stop(): void } {
  const intervalMs = 30 * 60 * 1000;
  const refresh = async (): Promise<void> => {
    const chats = await fetchKnownChats(channel);
    if (chats.length > 0) {
      controls.knownChats = chats;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function sendNonAllowedGroupHint(
  channel: LarkChannel,
  chatId: string,
  replyToMessageId: string,
): Promise<void> {
  const text =
    '当前群尚未加入响应列表，所以 bot 不会处理消息。\n' +
    'Bot owner/管理员可在本群发 /invite group 加入白名单。';
  try {
    await channel.send(chatId, { text }, { replyTo: replyToMessageId });
  } catch {
    await channel.send(chatId, { text });
  }
}

/**
 * The SDK (@larksuite/channel >= 0.4.1) normalizes a merge_forward whose
 * sub-messages it could not fetch — after its own retries — to this exact
 * sentinel, rather than the empty `<forwarded_messages/>` it emits for a
 * genuinely empty forward. Distinguishing the two is the whole point of that
 * fix: pre-0.4.1 a transient Feishu 5xx/timeout on `im.v1.message.get` was
 * silently indistinguishable from empty, so the agent saw an empty forward and
 * replied "转发内容是空的，请重新转发一次".
 */
const FORWARD_FETCH_FAILED_CONTENT = '<forwarded_messages status="fetch_failed"/>';

/** True when a message is a merge_forward the SDK failed to fetch (see above). */
function isForwardFetchFailed(msg: NormalizedMessage): boolean {
  return (
    msg.rawContentType === 'merge_forward' &&
    msg.content.trim() === FORWARD_FETCH_FAILED_CONTENT
  );
}

async function sendForwardFetchFailedHint(
  channel: LarkChannel,
  chatId: string,
  replyToMessageId: string,
): Promise<void> {
  const text =
    '这条合并转发的内容没能从飞书拉取到（上游超时/网络抖动，已自动重试仍失败），' +
    '所以我没收到里面的消息。麻烦稍后重新转发一次。';
  try {
    await channel.send(chatId, { text }, { replyTo: replyToMessageId });
  } catch {
    await channel.send(chatId, { text });
  }
}

interface IntakeDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  msg: NormalizedMessage;
  controls: Controls;
  chatModeCache: ChatModeCache;
  logThreadModeOverride: LogThreadModeOverride;
  executor: RunExecutor;
  pool: ProcessPool;
}

type LogThreadModeOverride = (input: {
  chatId: string;
  resolvedMode: ChatMode;
  threadId: string;
}) => void;

async function intakeMessage(deps: IntakeDeps): Promise<void> {
  const {
    channel,
    agent,
    sessions,
    sessionCatalog,
    workspaces,
    activeRuns,
    pending,
    msg,
    controls,
    chatModeCache,
    logThreadModeOverride,
    executor,
    pool,
  } = deps;
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
  // Resolve scope (and underlying chat mode) once at intake — every
  // downstream consumer keys off these.
  const resolvedMode = await chatModeCache.resolve(channel, msg.chatId);
  // Feishu delivers a sizable fraction of topic-group message events without a
  // `thread_id` (notably the message that opens a new topic). We route topic
  // replies (`replyInThread`) and isolate per-topic session scope off it, so a
  // missing one makes the reply escape into a brand-new topic AND collapses the
  // scope to the chat level. When getChatMode says this is a topic group but
  // the event dropped `thread_id`, backfill it from the raw message — the same
  // recovery the card-click path uses.
  let threadId = msg.threadId;
  if (!threadId && resolvedMode === 'topic') {
    threadId = await lookupMessageThreadId(channel, msg.messageId);
    if (threadId) {
      log.info('intake', 'thread-id-backfilled', {
        chatId: msg.chatId,
        msgId: msg.messageId,
        threadId,
      });
    }
  }
  // Carry the (possibly backfilled) threadId on the message so the batched
  // flush — which reads `firstMsg.threadId` for reply routing and topic scope —
  // sees it.
  const emsg: NormalizedMessage = threadId === msg.threadId ? msg : { ...msg, threadId };
  // Some groups are converted into topic groups after creation. In that state
  // getChatMode can lag behind the message event shape, so threadId is the
  // stronger signal for topic-scoped sessions and reply routing.
  const chatMode = threadId ? 'topic' : resolvedMode;
  if (threadId && resolvedMode !== 'topic') {
    chatModeCache.invalidate(msg.chatId);
    logThreadModeOverride({
      chatId: msg.chatId,
      resolvedMode,
      threadId,
    });
  }
  const scope = chatMode === 'topic' && threadId
    ? `${msg.chatId}:${threadId}`
    : msg.chatId;
  log.info('intake', 'enter', {
    scope,
    // f0.3.4: ms timing so latency can be read off the (minute-precision) jsonl.
    ...latencyFields(msg.createTime),
    chatType: msg.chatType,
    chatMode,
    resolvedMode,
    threadId,
    msgId: msg.messageId,
    sender: msg.senderId,
    preview,
    resources: msg.resources.length,
  });

  const senderFacts = senderFactsOf(msg);
  noteOwnerTenant(controls, msg.senderId, senderFacts);
  const accessDecision =
    msg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, msg.senderId, senderFacts)
      : canUseGroup(controls.profileConfig, controls, msg.chatId, msg.senderId, senderFacts);
  if (!accessDecision.ok) {
    log.info('intake', 'skip-not-allowed-user', {
      scope,
      sender: msg.senderId.slice(-6),
      reason: accessDecision.reason,
    });
    if (msg.chatType !== 'p2p' && accessDecision.reason === 'denied-chat' && msg.mentionedBot) {
      void sendNonAllowedGroupHint(channel, msg.chatId, msg.messageId).catch((err) =>
        log.warn('intake', 'non-allowed-hint-failed', { err: String(err) }),
      );
    }
    return;
  }

  // Group-mention policy. p2p is always unrestricted; in groups (regular and
  // topic) we drop messages that don't @bot when the user has opted into the
  // quiet-by-default behavior. A per-chat override (set from /config's group
  // picker) takes priority over the global setting, so one group can respond
  // to everything while others stay @-only (or vice versa). Slash commands are
  // NOT exempt — the user chose strict mode so the group stays uniformly quiet
  // unless mentioned. @全员 is already filtered by SDK
  // (`respondToMentionAll: false`), so any event reaching here is either
  // targeted or undirected chatter.
  if (
    msg.chatType !== 'p2p' &&
    requireMentionForChat(controls.profileConfig, controls.cfg, msg.chatId) &&
    !msg.mentionedBot
  ) {
    log.info('intake', 'skip-no-mention', { scope, chatType: msg.chatType });
    return;
  }

  // A merge_forward whose sub-messages the SDK could not fetch (transient
  // upstream failure, already retried inside @larksuite/channel) arrives as the
  // fetch_failed sentinel. Feeding it to the agent would read as an empty
  // forward, so surface a recoverable hint and skip the run — the user can
  // resend once the upstream recovers.
  if (isForwardFetchFailed(emsg)) {
    log.warn('intake', 'forward-fetch-failed', {
      scope,
      msgId: emsg.messageId,
      chatType: emsg.chatType,
    });
    await sendForwardFetchFailedHint(channel, emsg.chatId, emsg.messageId).catch((err) =>
      log.warn('intake', 'forward-fetch-failed-hint-failed', { err: String(err) }),
    );
    return;
  }

  // f04-group-cmd-model: in a group only the owner/admins may use slash
  // commands — registered or not. A non-admin's `/…` (also `@bot /…`) is
  // neither run as our command nor queued for the agent (Claude Code / Codex
  // would treat it as their own built-in command). It does not cancel what
  // others have queued in this scope either. Hint only when the bot was
  // @-mentioned (the sender is clearly talking to it); otherwise silent, so a
  // no-@ group never gets a bot reply to someone pasting a path.
  if (
    emsg.chatType !== 'p2p' &&
    isSlashMessage(emsg) &&
    groupSlashDenied(controls.profileConfig, controls, { isGroup: true, senderId: emsg.senderId })
  ) {
    log.info('intake', 'group-slash-denied', {
      scope,
      sender: emsg.senderId.slice(-6),
      cmd: slashName(emsg),
      hinted: emsg.mentionedBot === true,
    });
    if (emsg.mentionedBot) {
      const opts = emsg.threadId
        ? { replyTo: emsg.messageId, replyInThread: true }
        : { replyTo: emsg.messageId };
      void channel
        .send(emsg.chatId, { text: GROUP_SLASH_ADMIN_ONLY_REPLY }, opts)
        .catch((err: unknown) => log.warn('intake', 'group-slash-hint-failed', { err: String(err) }));
    }
    return;
  }

  const handled = await tryHandleCommand({
    channel,
    msg: emsg,
    scope,
    chatMode,
    sessions,
    workspaces,
    agent,
    activeRuns,
    sessionCatalog,
    sessionCatalogIdentity: await commandSessionCatalogIdentity({
      msg: emsg,
      scope,
      mode: chatMode,
      workspaces,
      controls,
      access: accessDecision,
    }),
    runExecutor: executor,
    processPool: pool,
    controls,
  });
  if (handled) {
    const dropped = pending.cancel(scope);
    log.info('intake', 'command', { scope, droppedPending: dropped.length });
    return;
  }

  // aiduCAT: ignore pure-emoji / sticker-style messages — never trigger a run.
  // (Spec: the bot must not respond to reactions.) Empty or emoji-only text
  // with no attachments and no explicit command falls through silently.
  const rawText = emsg.content.trim();
  const isEmojiOnly =
    rawText.length > 0 &&
    !/\p{L}|\p{N}/u.test(rawText.slice(0, 64)) && // no letters/digits at all
    emsg.resources.length === 0;
  if (isEmojiOnly) {
    log.info('intake', 'emoji-only-ignored', { scope, len: rawText.length });
    return;
  }
  // f031-stab-#6 (upstream #286): a bare @ that QUOTES a message is a
  // question about that message, not an empty ping — let it through.
  // (In a topic, reply-to = topic root is structure, not a quote.)
  const quotesSomething = Boolean(replyQuoteTargetForMessage(emsg, chatMode));
  if (rawText.length === 0 && emsg.resources.length === 0 && !quotesSomething) {
    log.info('intake', 'empty-ignored', { scope });
    return;
  }

  const size = pending.push(scope, emsg);
  log.info('intake', 'queued', { scope, queueSize: size, debounceMs: DEBOUNCE_MS });
}

interface RunBatchDeps {
  channel: LarkChannel;
  executor: RunExecutor;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  media: MediaCache;
  batch: NormalizedMessage[];
  controls: Controls;
  /** f03p-slim-#7: lazy — resolves the shared CotClient on first use. */
  cotClient: () => Promise<CotClient>;
  callbackAuth?: CallbackAuth;
  activePolicyFingerprints: Map<string, string>;
  lastRunModelByScope: Map<string, string>;
  scope: string;
  mode: ChatMode;
  /** f031-stab-#5: the streaming card exists — record its id for restart recovery. */
  onCardOpened?: (messageId: string) => void;
  /** f03p-infra-#6: how the agent's turn ended (done / error / interrupted / idle_timeout). */
  onTerminal?: (terminal: string) => void;
  /** f0.3.4: the reaction added at flush start; released when real output shows or the round ends. */
  workingReaction?: WorkingReaction;
  /** f0.3.5: the「☤aiduCATing…」card opened at intake; the run adopts it. */
  earlyCard?: EarlyCard;
}

/**
 * f031-stab-#16: steps that run before the agent starts (attachments, quote,
 * topic context, prompt, run setup). Their errors used to be swallowed by
 * log.fail('flush') and the user got nothing; tagged here so the flush
 * catch can answer with an explicit error.
 */
type PreRunStep = 'attachments' | 'quote' | 'topic' | 'prompt' | 'run-setup';
const PRE_RUN_STEP_LABEL: Record<PreRunStep, string> = {
  attachments: '处理附件',
  quote: '读取引用的消息',
  topic: '读取话题上下文',
  prompt: '整理消息内容',
  'run-setup': '准备运行 agent',
};

export class PreRunError extends Error {
  constructor(
    readonly step: PreRunStep,
    readonly original: unknown,
  ) {
    super(`pre-run step ${step} failed: ${original instanceof Error ? original.message : String(original)}`);
    this.name = 'PreRunError';
  }
}

async function preRun<T>(step: PreRunStep, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new PreRunError(step, err);
  }
}

export function preRunFailureText(err: PreRunError, audience: ErrorAudience = 'owner-dm'): string {
  if (audience === 'public') return PRE_RUN_FAILED_PUBLIC_NOTICE;
  const raw = err.original instanceof Error ? err.original.message : String(err.original);
  const reason = raw.replace(/\s+/g, ' ').trim().slice(0, 200) || '未知错误';
  return `⚠️ 这条消息没能交给 agent：${PRE_RUN_STEP_LABEL[err.step]}时出错（${reason}）。请重发一次；反复出现请查看 aiduCAT 日志。`;
}

async function sendPreRunFailure(
  channel: LarkChannel,
  msg: NormalizedMessage,
  err: PreRunError,
  botOwnerId: string | undefined,
): Promise<void> {
  // f0.4 之后的修复 (bwrap): only the owner's private chat sees the reason.
  const audience: ErrorAudience =
    msg.chatType === 'p2p' && Boolean(botOwnerId) && msg.senderId === botOwnerId ? 'owner-dm' : 'public';
  const text = preRunFailureText(err, audience);
  const opts = msg.threadId
    ? { replyTo: msg.messageId, replyInThread: true }
    : { replyTo: msg.messageId };
  try {
    await channel.send(msg.chatId, { text }, opts);
  } catch {
    await channel.send(msg.chatId, { text });
  }
}

async function runAgentBatch(deps: RunBatchDeps): Promise<void> {
  const {
    channel,
    executor,
    sessions,
    sessionCatalog,
    workspaces,
    media,
    batch,
    controls,
    cotClient,
    callbackAuth,
    activePolicyFingerprints,
    lastRunModelByScope,
    scope,
    mode,
  } = deps;
  if (batch.length === 0) return;
  // f03p-infra-#6: report how the turn ended, whichever reply path runs.
  const trackedAgentStream = async (...args: Parameters<typeof processAgentStream>): Promise<RunState> => {
    const state = await processAgentStream(...args);
    deps.onTerminal?.(state.terminal);
    return state;
  };
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return;

  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;

  const resourceItems = batch.flatMap((m) =>
    m.resources.map((r) => ({ messageId: m.messageId, resource: r })),
  );
  const attachments = await preRun('attachments', () =>
    media.resolve(resourceItems, controls.profileConfig.attachments),
  );
  if (attachments.length > 0) {
    log.info('media', 'resolved', { count: attachments.length });
    for (const attachment of attachments) {
      log.info('attachment', 'decision', {
        decision: attachment.decision,
        kind: attachment.kind,
        hash: attachment.hash,
        size: attachment.size,
        sourceMessageId: attachment.sourceMessageId,
        reason: attachment.rejectionReason,
      });
    }
  }

  // Collect any reply-quote targets in the batch. Dedup so the same target
  // quoted by multiple messages in one batch only fetches once. Filter out
  // ids that are themselves in the batch — those are already in the prompt.
  const batchIds = new Set(batch.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      batch
        .map((m) => replyQuoteTargetForMessage(m, mode))
        .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
    ),
  ];
  const quotes: QuotedContext[] = [];
  for (const targetId of quoteTargets) {
    const q = await preRun('quote', () => fetchQuotedContext(channel, targetId));
    if (q) {
      quotes.push(q);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }

  // Topic upstream context. When the bot is pulled into a topic for the FIRST
  // time (no session yet for this scope), the topic's earlier messages — the
  // root question that may never have @-mentioned the bot, plus prior replies —
  // live nowhere the agent can see them. Fetch them so it isn't blind to what
  // the user is pointing at. An already-engaged topic keeps that history in its
  // resumed session, so we skip the fetch there.
  let topicContext: QuotedContext[] = [];
  if (mode === 'topic' && threadId && !sessions.getRaw(scope)) {
    const exclude = new Set([...batchIds, ...quoteTargets]);
    topicContext = await preRun('topic', () =>
      fetchTopicContext(channel, threadId, {
        maxMessages: 40,
        excludeIds: exclude,
      }),
    );
    if (topicContext.length > 0) {
      log.info('topic', 'context-fetched', {
        scope,
        threadId,
        count: topicContext.length,
      });
    }
  }

  // Detect a model switch since this scope's last run. When resuming an
  // existing conversation the transcript still claims the old model, so tell
  // the (now-switched) agent its model changed — otherwise it keeps echoing
  // the previously-announced model. Only fires when a prior model was seen
  // for this scope (never on the first run) and the selection actually
  // changed. `requestedModel` (the `--model` value, or undefined for default)
  // is reused below to log requested-vs-actual against the init event.
  const agentKind = controls.profileConfig.agentKind;
  // f04-group-cmd-model: a group with its own /model runs that; everyone else
  // the profile default. The run (model arg, provider env, effort, window,
  // 60% compact) is started from this per-chat view of the profile.
  const runProfile = profileForChat(
    controls.profileConfig,
    firstMsg.chatType === 'p2p' ? undefined : chatId,
  );
  const modelPref = runProfile.preferences.model;
  const modelSelection = normalizeModelSelection(agentKind, modelPref);
  const requestedModel = resolveModelArg(agentKind, modelPref);
  const prevModel = lastRunModelByScope.get(scope);
  const modelSwitched = prevModel !== undefined && prevModel !== modelSelection;
  lastRunModelByScope.set(scope, modelSelection);
  const extraInstructions = modelSwitched
    ? [
        `用户刚把本会话使用的模型切换为「${modelLabel(agentKind, modelPref)}」。` +
          '之前的对话里可能提到别的模型,请以当前模型为准;若被问到你用的是什么模型,据此回答。',
      ]
    : undefined;

  const prompt = await preRun('prompt', async () =>
    buildPrompt(batch, attachments, quotes, topicContext, channel.botIdentity, extraInstructions),
  );
  log.info('prompt', 'built', {
    promptChars: prompt.length,
    quotes: quotes.length,
    topicContext: topicContext.length,
    ...(modelSwitched ? { modelSwitchedTo: modelSelection } : {}),
  });

  // For topic groups: thread the reply so it lands in the same topic as the
  // user's message. Otherwise the SDK posts at top level and the user's
  // topic discussion breaks visually.
  // aiduCAT: drop the quote ("回复 xxx") decoration in p2p chats — cards
  // should stand alone. Topic groups keep threading so replies land in-topic.
  const sendOpts: { replyTo?: string; replyInThread?: boolean } =
    mode === 'topic' && threadId
      ? { replyTo: lastMsg.messageId, replyInThread: true }
      : {};
  log.info('flush', 'reply-target', {
    scope,
    mode,
    chatId,
    threadId,
    replyTo: sendOpts.replyTo,
    replyInThread: sendOpts.replyInThread === true,
  });

  const firstFacts = senderFactsOf(firstMsg);
  const accessDecision =
    firstMsg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, firstMsg.senderId, firstFacts)
      : canUseGroup(controls.profileConfig, controls, firstMsg.chatId, firstMsg.senderId, firstFacts);
  const scopeContext: ScopeContext = {
    source: 'im',
    chatType: firstMsg.chatType,
    chatId,
    actorId: firstMsg.senderId,
    ...(threadId ? { threadId } : {}),
  };
  const capability =
    capabilityFor(controls.profileConfig);
  const flow = await preRun('run-setup', async () => startRunFlow({
    scopeId: scope,
    // f0.2+: the selected model's declared window drives the 60% compact env.
    // f0.3.4: combo cache only — never waits on 10router.
    modelWindow: resolveModelWindow(runProfile, modelSelection),
    scope: scopeContext,
    prompt,
    attachments: attachments.map(toPolicyAttachment),
    access: accessDecision,
    capability,
    profileConfig: runProfile,
    sessions,
    sessionCatalog,
    workspaces,
    executor,
    now: Date.now(),
    stopGraceMs: getAgentStopGraceMs(controls.cfg),
    observability: {
      profile: controls.profile,
      agent: capability.agentId,
      source: 'im',
      stage: 'submit',
    },
  }));
  if (!flow.ok) {
    log.info('run-flow', 'rejected', { scope, code: flow.rejectReason.code });
    log.warn('policy', 'denied', {
      scope,
      source: 'im',
      code: flow.rejectReason.code,
    });
    await channel.send(chatId, { markdown: flow.rejectReason.userVisible }, sendOpts);
    return;
  }

  const { execution, cwdRealpath: cwd } = flow;
  activePolicyFingerprints.set(scope, flow.policy.policyFingerprint);
  const handle = execution.handle;
  // f0.4 之后的修复 (bwrap): an agent failure shows a friendly notice to
  // anyone but the owner in a private chat; the raw error stays in the log.
  const eventStream = presentAgentErrors(
    execution.subscribe(),
    errorAudienceOf(accessDecision, firstMsg.chatType),
  );
  if (flow.resumeFrom) {
    log.info('session', 'resume', { sessionId: flow.resumeFrom, cwd });
  } else {
    log.info('session', 'fresh', { cwd });
  }
  const recordSession = (evt: AgentEvent): void => {
    recordRunSessionEvent({
      scopeId: scope,
      sessions,
      sessionCatalog,
      capability,
      policy: flow.policy,
      event: evt,
    });
    if (evt.type === 'system' && evt.sessionId) {
      log.info('session', 'set', { sessionId: evt.sessionId });
    }
    // Ground truth for "which model is actually running": claude reports the
    // model it loaded in its init event. Logging requested-vs-actual reveals
    // whether the --model pin took effect or claude silently fell back (e.g.
    // an id this claude build/account doesn't recognize).
    if (evt.type === 'system' && evt.model) {
      log.info('session', 'model', {
        requested: requestedModel ?? 'default',
        actual: evt.model,
      });
    }
    if (evt.type === 'system' && evt.threadId) {
      log.info('session', 'set-thread', { threadId: evt.threadId });
    }
  };

  // Resolve idle-timeout for this run: scope override (on SessionEntry) wins
  // over global default (preferences). 0 / undefined = no watchdog.
  const scopeOverride = sessions.getIdleTimeoutMinutes(scope);
  const idleTimeoutMs =
    scopeOverride !== undefined
      ? scopeOverride > 0
        ? scopeOverride * 60_000
        : undefined
      : getRunIdleTimeoutMs(controls.cfg);
  // f031-stab-#4: plus a hard cap per tool call (idle pauses while tools run).
  const runTimeouts: RunTimeouts = { idleMs: idleTimeoutMs, toolMs: getRunToolTimeoutMs(controls.cfg) };
  if (idleTimeoutMs || runTimeouts.toolMs) {
    log.info('flush', 'idle-watchdog', { idleTimeoutMs, toolTimeoutMs: runTimeouts.toolMs });
  }

  // f0.3.5: groups get the same reply mode as DMs (the streaming card with
  // its panel). Upstream forced groups to rich text (post) "so <at user_id>
  // becomes a mention", which left groups with no card, no panel and no
  // early ☤Thinking… card (winter 2026-11-02 01:44: first output 93s after
  // the message). aiduCAT never passes mentions to the SDK anyway; agent-
  // written `<at user_id="ou_…">` tags are kept as card mentions by
  // sanitizeCardMarkdown. Tool visibility in groups still follows
  // getShowToolCalls (f031-sec-#4).
  const replyMode = getMessageReplyMode(controls.cfg);
  log.info('flush', 'reply-mode', { mode: replyMode, chatType: firstMsg.chatType });
  // f03p-slim-#4: a profile with features.cot=false never uses CoT.
  const cotMessages = getEffectiveCotMessages(controls.cfg, controls.profileConfig);
  // Card replies already carry their own terminal status; a separate COT
  // bubble would expose a second "task completed" message outside the card.
  const cotEnabled = cotMessages !== 'off' && replyMode !== 'card';

  // Re-read prefs on every flush so toggling /config mid-stream takes
  // effect immediately. Cheap object lookups, no allocation when on.
  const filterForPrefs = (state: RunState): RunState => {
    if (getShowToolCalls(controls.cfg, firstMsg.chatType)) return state;
    return { ...state, blocks: state.blocks.filter((b) => b.kind !== 'tool') };
  };
  const cardRenderOptions: import('../card/run-renderer').RunCardRenderOptions = {
    // aiduCAT: surface model + start time in the meta panel.
    model: modelSelection,
    // f0.4+: panel icon = this profile's coding agent.
    agentKind,
    startedAt: Date.now(),
    // aiduCAT: reasoning effort + this model's context window (f0.3.4: from
    // the cached 10router combo entry, never a network wait).
    effort: runProfile.preferences.effort,
    contextWindow: contextWindowForModel(modelSelection),
    ...(callbackAuth
      ? {
          signCallback: (action: string) =>
            callbackAuth.sign({
              runId: execution.runId,
              scope,
              chatId,
              operatorOpenId: firstMsg.senderId,
              action,
              policyFingerprint: flow.policy.policyFingerprint,
              ttlMs: 24 * 60 * 60 * 1000,
            }),
        }
      : {}),
  };

  // aiduCAT: no plain-text ack. (An earlier "aiduCATing…" cue was dropped —
  // the streaming card's own status footer already signals liveness, and the
  // extra bubble carried a replyTo which rendered as "回复 xxx" quotes.)

  // aiduCAT: the working reaction is the instant "已启动" cue. f0.3.4: it is
  // added at flush start (see startWorkingReaction); here we only take it
  // over. Once actual run output starts arriving (card mode: first state
  // update with content) it is removed early — 猴哥: "一旦开始了下面的工作，
  // 我的消息下的这个飞书表情就可以消失了". Fallback removal in `finally`.
  const workingReaction =
    deps.workingReaction ??
    (usesEarlyCard(controls) ? NO_REACTION : startWorkingReaction(channel, lastMsg.messageId, lastMsg.createTime));

  try {
    if (cotEnabled) {
      const { CotPublisher, consumeCotEvents } = await import('./cot');
      const cotPublisher = new CotPublisher({
        client: await cotClient(),
        chatId,
        // The CoT bubble follows this origin message's thread. In a topic the
        // triggering message is itself in-topic, so the bubble lands in the
        // topic; message_cot has no thread_id receive type, so origin is the
        // only lever we have (see CotClient.create).
        originMessageId: lastMsg.messageId,
        runId: execution.runId,
        scope,
        inputPreview: lastMsg.content,
      });
      await cotPublisher.start();
      if (!cotPublisher.disabled) {
        const cotDone = consumeCotEvents(execution.subscribe(), cotPublisher, {
          detail: cotMessages,
        });
        const finalState = await trackedAgentStream(
          handle,
          eventStream,
          scope,
          runTimeouts,
          recordSession,
          async () => {},
          sessions,
        capability.agentId, execution.forceClose);
        await cotDone;
        if (cotPublisher.degradedReason) {
          await sendCotDegradedNotice({
            channel,
            chatId,
            scope,
            sendOpts,
            reason: cotPublisher.degradedReason,
          });
        }
        await sendFinalReply({
          channel,
          chatId,
          scope,
          state: finalAnswerOnlyState(finalState),
          replyMode,
          sendOpts,
          cardRenderOptions,
        });
        return;
      }
      log.warn('cot', 'fallback-existing-reply', { reason: 'create-disabled' });
    }

    if (replyMode === 'card') {
      let latestState: RunState = initialState;
      let producerStarted = false;
      // f0.3.1 #3: `lastPatchError` comes from our pnpm patch of the SDK — a
      // throttled patch that failed in the SDK's timer lands here instead of
      // becoming an unhandledRejection.
      let cardCtrl:
        | {
            update(next: object | ((current: object) => object)): Promise<void>;
            readonly messageId?: string;
            readonly lastPatchError?: unknown;
          }
        | undefined;
      const loggedPatchCodes = new Set<string>();
      const notePatchError = () => {
        const err = cardCtrl?.lastPatchError;
        if (!err) return;
        const code = larkErrorCode(err);
        if (loggedPatchCodes.has(String(code))) return;
        loggedPatchCodes.add(String(code));
        log.warn('card', 'patch-failed', {
          scope,
          code,
          err: err instanceof Error ? err.message : String(err),
        });
      };
      const degrade = async (err: unknown, state: RunState, step: string) => {
        const shown = filterForPrefs(state);
        await deliverAfterCardFailure({
          channel,
          chatId,
          scope,
          state: shown,
          sendOpts,
          renderOptions: cardRenderOptions,
          messageId: producerStarted ? cardCtrl?.messageId || undefined : undefined,
          err,
          rejectedCard: renderCard(shown, cardRenderOptions),
          step,
        });
      };
      const cardProducer = async (ctrl: NonNullable<typeof cardCtrl>): Promise<void> => {
        producerStarted = true;
        if (progress.abandoned()) return;
        cardCtrl = ctrl;
        if (ctrl.messageId) deps.onCardOpened?.(ctrl.messageId);
        await ctrl.update(renderCard(filterForPrefs(latestState), cardRenderOptions));
        await renderDone;
      };
      const freshCard = () =>
        channel.stream(
          chatId,
          { card: { initial: renderCard(initialState, cardRenderOptions), producer: cardProducer } },
          sendOpts,
        );
      // f0.3.5: take over the「☤aiduCATing…」card opened at intake.
      const earlyCard = deps.earlyCard;
      const progress = createLazyProgressStream(scope, replyMode, lastMsg.createTime, () =>
        earlyCard
          ? earlyCard.adopt(cardProducer as Parameters<typeof earlyCard.adopt>[0], freshCard)
          : freshCard(),
      );
      const renderDone = trackedAgentStream(
        handle,
        eventStream,
        scope,
        runTimeouts,
        recordSession,
        async (state) => {
          latestState = state;
          // aiduCAT: the Typing reaction is only the "已启动" cue. The moment
          // real work shows up on the card (first thinking/tool/text update),
          // drop it — the streaming card itself carries liveness from here.
          if (
            state.reasoning.content.trim() ||
            state.blocks.length > 0 ||
            state.finalText
          ) {
            workingReaction.release();
          }
          if (shouldOpenProgressStream(filterForPrefs(state))) progress.ensureOpen();
          if (cardCtrl) {
            await cardCtrl.update(renderCard(filterForPrefs(state), cardRenderOptions));
            notePatchError();
          }
        },
        sessions,
        // (diagnostics)
        capability.agentId, execution.forceClose);
      // f0.3.4: claude runs open the card right away — the initial render is
      // the "☤Thinking…" placeholder with the model logo in the panel header —
      // instead of waiting for the first tool call / text (10–200s). Later
      // updates patch this same card; continuation cards, degrade, /stop and
      // the empty-run recall all work off it unchanged. Codex keeps the lazy
      // open (its final answer is sent separately; an eager card would only
      // be recalled).
      if (controls.profileConfig.agentKind !== 'codex') progress.ensureOpen();
      let degraded = false;
      try {
        await awaitRenderAwareStream({
          mode: replyMode,
          progress,
          renderDone,
          producerStarted: () => producerStarted,
          fallback: async (state, streamErr) => {
            if (controls.profileConfig.agentKind === 'codex') return;
            if (renderText(filterForPrefs(state)).trim() === '') return;
            // f0.3.1 #1: the card is there but the stream died — fix it in place.
            if (producerStarted && cardCtrl?.messageId) {
              degraded = true;
              await degrade(streamErr, state, 'stream-failed');
              return;
            }
            try {
              const rendered = renderCardWithInfo(filterForPrefs(state), cardRenderOptions);
              const result = await channel.send(chatId, { card: rendered.card }, sendOpts);
              requireMessageReceipt(result, 'card');
              // f03p-fix-#8: the rest of a long answer as 「续 i/N」 cards.
              await sendContinuationCards({ channel, chatId, scope, pages: rendered.continuations, sendOpts });
            } catch (err) {
              degraded = true;
              await degrade(err, state, 'fallback-card');
            }
          },
          // f0.3.1 #1: the final patch was rejected (or failed late).
          onProducerFailure:
            controls.profileConfig.agentKind === 'codex'
              ? undefined
              : async (err, state) => {
                  degraded = true;
                  await degrade(err, state, 'final-patch');
                },
        });
      } catch (err) {
        if (controls.profileConfig.agentKind !== 'codex') throw err;
        log.fail('stream', err, { mode: replyMode, step: 'progress-stream' });
      }
      // f03p-fix-#8: the streaming card shows page 1 of a long answer — the
      // rest follows as ordered 「续 i/N」 cards (no plain-text copy).
      if (!degraded && controls.profileConfig.agentKind !== 'codex' && progress.opened() && !progress.abandoned()) {
        const pages = renderCardWithInfo(filterForPrefs(latestState), cardRenderOptions).continuations;
        await sendContinuationCards({ channel, chatId, scope, pages, sendOpts });
      }
      await recallIfEmptyStreamedReply(channel, progress, filterForPrefs(latestState), scope);
      // aiduCAT: In card mode, if the progress stream card successfully opened, it already
      // renders both the final answer (blocks or finalText) and the collapsible panel in one unified card.
      // Only invoke sendFinalReply if the progress stream was never opened or was abandoned.
      if (controls.profileConfig.agentKind === 'codex' && (!progress.opened() || progress.abandoned())) {
        await sendFinalReply({
          channel,
          chatId,
          scope,
          state: finalReplyState(progress, filterForPrefs(latestState)),
          replyMode,
          sendOpts,
          cardRenderOptions,
        });
      }
    } else if (replyMode === 'markdown') {
      let latestState: RunState = initialState;
      let producerStarted = false;
      let markdownCtrl: { setContent(markdown: string): Promise<void> } | undefined;
      const progress = createLazyProgressStream(scope, replyMode, lastMsg.createTime, () =>
        channel.stream(
          chatId,
          {
            markdown: async (ctrl) => {
              producerStarted = true;
              if (progress.abandoned()) return;
              markdownCtrl = ctrl;
              await ctrl.setContent(renderText(filterForPrefs(latestState)));
              await renderDone;
            },
          },
          sendOpts,
        ),
      );
      // f031-stab-#6 (upstream #299/#183): a failed streaming update (rate
      // limit 230020, oversize, network) used to abort processAgentStream
      // mid-run and the rest of the answer was lost. Keep consuming the run;
      // once it ends, deliver the whole answer as a plain message.
      let mdUpdateFailed: unknown;
      const deliverFullAnswer = async (state: RunState, err: unknown): Promise<void> => {
        const body = renderText(filterForPrefs(state));
        log.warn('stream', 'markdown-degraded', {
          scope,
          code: (err as { response?: { data?: { code?: unknown } } })?.response?.data?.code,
          err: err instanceof Error ? err.message : String(err),
        });
        if (!body.trim()) return;
        await channel.send(
          chatId,
          { markdown: `⚠️ 流式消息更新失败，完整回答如下：\n\n${body}` },
          sendOpts,
        );
      };
      const renderDone = trackedAgentStream(
        handle,
        eventStream,
        scope,
        runTimeouts,
        recordSession,
        async (state) => {
          latestState = state;
          if (shouldOpenProgressStream(filterForPrefs(state))) progress.ensureOpen();
          if (markdownCtrl && mdUpdateFailed === undefined) {
            try {
              await markdownCtrl.setContent(renderText(filterForPrefs(state)));
            } catch (err) {
              if (controls.profileConfig.agentKind === 'codex') throw err;
              mdUpdateFailed = err;
            }
          }
        },
        sessions,
      capability.agentId, execution.forceClose);
      let mdDelivered = false;
      try {
        await awaitRenderAwareStream({
          mode: replyMode,
          progress,
          renderDone,
          producerStarted: () => producerStarted,
          fallback: async (state) => {
            if (controls.profileConfig.agentKind === 'codex') return;
            const body = renderText(filterForPrefs(state));
            if (body.trim()) {
              mdDelivered = true;
              await channel.send(chatId, { markdown: body }, sendOpts);
            }
          },
          // f031-stab-#6: the final markdown flush failed — answer as a message.
          onProducerFailure:
            controls.profileConfig.agentKind === 'codex'
              ? undefined
              : async (err, state) => {
                  mdDelivered = true;
                  await deliverFullAnswer(state, err);
                },
        });
      } catch (err) {
        if (controls.profileConfig.agentKind !== 'codex') throw err;
        log.fail('stream', err, { mode: replyMode, step: 'progress-stream' });
      }
      if (mdUpdateFailed !== undefined && !mdDelivered) {
        await deliverFullAnswer(latestState, mdUpdateFailed);
      }
      await recallIfEmptyStreamedReply(channel, progress, filterForPrefs(latestState), scope);
      if (controls.profileConfig.agentKind === 'codex') {
        await sendFinalReply({
          channel,
          chatId,
          scope,
          state: finalReplyState(progress, filterForPrefs(latestState)),
          replyMode,
          sendOpts,
          cardRenderOptions,
        });
      }
    } else {
      // text mode: drain the agent stream without sending anything during
      // the run, then post the final rendered text once as a plain markdown
      // (msg_type=post) message — no card, no streaming, no typewriter.
      const finalState = await trackedAgentStream(
        handle,
        eventStream,
        scope,
        runTimeouts,
        recordSession,
        async () => {},
        sessions,
      capability.agentId, execution.forceClose);
      await sendFinalReply({
        channel,
        chatId,
        scope,
        state:
          controls.profileConfig.agentKind === 'codex'
            ? finalAnswerOnlyState(filterForPrefs(finalState))
            : filterForPrefs(finalState),
        replyMode,
        sendOpts,
        cardRenderOptions,
      });
    }
  } catch (err) {
    log.fail('stream', err);
  } finally {
    activePolicyFingerprints.delete(scope);
    workingReaction.release();
  }
}

interface LazyProgressStream {
  /**
   * Mirrors the underlying `channel.stream(...)` promise, and stays pending
   * forever while no stream has been opened — so callers can race it against
   * the render loop exactly as if the stream had been created up front.
   */
  readonly settled: Promise<unknown>;
  opened(): boolean;
  ensureOpen(): void;
  /**
   * True once the reply went out without this stream. A producer that starts
   * after that must render nothing, or the user gets the same answer twice.
   */
  abandoned(): boolean;
  abandon(): void;
}

/**
 * Wrap a progress stream so the user-visible message is only created once the
 * run has something worth showing (see `shouldOpenProgressStream`).
 *
 * The SDK starts a stream eagerly: `channel.stream(...)` sends a card before
 * the producer runs, and finishes it with a "(no content)" placeholder when the
 * producer never supplied any text. A Codex round that only produces a final
 * answer (delivered separately by `sendFinalReply`) used to hit exactly that:
 * an empty card sat in the chat for seconds until `recall-empty` cleaned it up.
 */
function createLazyProgressStream(
  scope: string,
  mode: 'card' | 'markdown',
  msgCreateTime: unknown,
  open: () => Promise<unknown>,
): LazyProgressStream {
  let stream: Promise<unknown> | undefined;
  let givenUp = false;
  let settle!: (result: Promise<unknown>) => void;
  const settled = new Promise<unknown>((resolve, reject) => {
    settle = (result) => {
      result.then(resolve, reject);
    };
  });
  return {
    settled,
    opened: () => stream !== undefined,
    ensureOpen: () => {
      if (stream) return;
      log.info('outbound', 'progress-stream-open', { scope, mode, ...latencyFields(msgCreateTime) });
      stream = open();
      settle(stream);
    },
    abandoned: () => givenUp,
    abandon: () => {
      givenUp = true;
    },
  };
}

/**
 * Is there anything in this state that will still be on screen when the run
 * ends? Footer status lines ("正在思考…") don't count: the terminal event drops
 * them, so a stream opened for a footer alone can still finish empty — which is
 * the placeholder-then-recall churn we're avoiding.
 *
 * Terminal states don't count either. By then the stream has nothing left to
 * stream, and whatever the run produced goes out as a normal reply
 * (`sendFinalReply`, or the stream fallback) instead of a card that would be
 * created only to be finished a moment later.
 *
 * `state` must already be `filterForPrefs`-projected, and emptiness is measured
 * with `renderText` in both reply modes so it matches the rule
 * `recallIfEmptyStreamedReply` applies: a stream we open is one that survives.
 */
function shouldOpenProgressStream(state: RunState): boolean {
  if (state.terminal !== 'running') return false;
  return renderText({ ...state, footer: null }).trim() !== '';
}

/**
 * What Codex's dedicated final reply may carry, given what the progress stream
 * already put on screen.
 *
 * `finalAnswerOnlyState` falls back to the run's text blocks when Codex held
 * nothing back for the end — correct where nothing was streamed (CoT, text
 * mode, a stream we gave up on), but those blocks are already visible once a
 * stream rendered them, and repeating them posts the same words a second time.
 * Codex leaves the answer in `blocks` more often than it looks: any abnormal
 * turn end (`turn.failed`, or the process exiting before `turn.completed`)
 * flushes the pending message as text instead of `final_text`.
 *
 * Terminal notices are dropped for the same reason — the stream rendered them.
 */
function finalReplyState(progress: LazyProgressStream, state: RunState): RunState {
  if (!progress.opened() || progress.abandoned()) return finalAnswerOnlyState(state);
  return {
    ...state,
    blocks: state.finalText ? [{ kind: 'text', content: state.finalText, streaming: false }] : [],
    reasoning: { content: '', active: false, segments: 0 },
    footer: null,
    terminal: 'done',
    errorMsg: undefined,
  };
}

/**
 * Backstop for a progress stream that was opened on real content and still
 * ended up empty — e.g. `/config` hiding tool calls mid-run, which retroactively
 * empties a tool-only render. The SDK fills such a card with its "(no content)"
 * placeholder, so recall it instead of leaving noise in the chat.
 *
 * `finalState` must already be `filterForPrefs`-projected (what the user sees).
 */
async function recallIfEmptyStreamedReply(
  channel: LarkChannel,
  progress: LazyProgressStream,
  finalState: RunState,
  scope: string,
): Promise<void> {
  if (!progress.opened()) return;
  // An abandoned stream renders nothing, so whatever message it eventually
  // posts is empty by construction. It is still in flight (that is why we gave
  // up on it), so clean up in the background instead of blocking the run on it.
  if (progress.abandoned()) {
    void progress.settled.then(
      (result) => recallStreamedMessage(channel, result, scope),
      () => {},
    );
    return;
  }
  if (renderText(finalState).trim() !== '') return;
  const result = await progress.settled.catch(() => undefined);
  await recallStreamedMessage(channel, result, scope);
}

async function recallStreamedMessage(
  channel: LarkChannel,
  streamResult: unknown,
  scope: string,
): Promise<void> {
  const messageId = (streamResult as { messageId?: string } | undefined)?.messageId;
  if (!messageId) return;
  try {
    await channel.recallMessage(messageId);
    log.info('outbound', 'recall-empty', { scope, messageId });
  } catch (err) {
    log.warn('outbound', 'recall-empty-failed', {
      scope,
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function sendFinalReply(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  state: RunState;
  replyMode: ReturnType<typeof getMessageReplyMode>;
  sendOpts: { replyTo?: string; replyInThread?: boolean };
  cardRenderOptions: { signCallback?: (action: string) => string };
}): Promise<void> {
  const body = renderText(input.state);

  // Nothing deliverable to send (agent produced no text on a clean finish;
  // error/interrupt/timeout keep `body` non-empty via their notices). Skip
  // rather than post an empty card that renders as "(no content)".
  if (!body.trim()) {
    log.info('outbound', 'skip-empty', { scope: input.scope, mode: input.replyMode });
    return;
  }

  if (input.replyMode === 'card') {
    const rendered = renderCardWithInfo(input.state, input.cardRenderOptions);
    const result = await input.channel.send(input.chatId, { card: rendered.card }, input.sendOpts);
    requireMessageReceipt(result, 'card');
    log.info('outbound', 'sent', outboundLogFields(input, 'card', body, result));
    // f03p-fix-#8: a long answer continues on 「续 i/N」 cards.
    await sendContinuationCards({
      channel: input.channel,
      chatId: input.chatId,
      scope: input.scope,
      pages: rendered.continuations,
      sendOpts: input.sendOpts,
    });
  } else if (input.replyMode === 'markdown') {
    if (body.trim()) {
      const result = await input.channel.send(
        input.chatId,
        { markdown: body },
        input.sendOpts,
      );
      requireMessageReceipt(result, 'markdown');
      log.info('outbound', 'sent', outboundLogFields(input, 'markdown', body, result));
    }
  } else if (body.trim()) {
    const result = await input.channel.send(
      input.chatId,
      { markdown: body },
      input.sendOpts,
    );
    requireMessageReceipt(result, 'text');
    log.info('outbound', 'sent', outboundLogFields(input, 'text', body, result));
  }
}

function requireMessageReceipt(result: { messageId?: string }, type: string): void {
  if (!result.messageId?.trim()) {
    throw new Error(`final ${type} reply missing message receipt`);
  }
}

async function sendCotDegradedNotice(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  sendOpts: { replyTo?: string; replyInThread?: boolean };
  reason: string;
}): Promise<void> {
  log.warn('cot', 'degraded', {
    scope: input.scope,
    reason: input.reason,
    replyInThread: input.sendOpts.replyInThread === true,
  });
  try {
    await input.channel.send(
      input.chatId,
      { markdown: 'COT 过程消息更新失败，已停止展示过程；最终答案仍会继续发送。' },
      input.sendOpts,
    );
  } catch (err) {
    log.warn('cot', 'degraded-notice-failed', {
      scope: input.scope,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function outboundLogFields(
  input: {
    scope?: string;
    replyMode: ReturnType<typeof getMessageReplyMode>;
    sendOpts?: { replyTo?: string; replyInThread?: boolean };
  },
  type: string,
  body: string,
  result?: { messageId?: string },
): Record<string, unknown> {
  return {
    type,
    scope: input.scope,
    mode: input.replyMode,
    chars: body.length,
    messageId: result?.messageId,
    replyTo: input.sendOpts?.replyTo,
    replyInThread: input.sendOpts?.replyInThread === true,
  };
}

/**
 * Drive the agent's event stream into a stateful RunState, calling `flush`
 * on every state transition. Used by both card and markdown reply modes —
 * the only difference between the two is what `flush` does with the state.
 */
async function processAgentStream(
  handle: RunHandle,
  events: AsyncIterable<AgentEvent>,
  scope: string,
  timeouts: RunTimeouts,
  recordSession: (event: AgentEvent) => void,
  flush: (state: RunState) => Promise<void>,
  stats: Pick<SessionStore, 'recordUsage' | 'recordMessage' | 'recordModel' | 'recordTurnTps'>,
  agentId: string,
  // issue #9 (P1): the executor's hard exit, used when stop() cannot end the
  // run (child already dead, event stream wedged on a grandchild stdout
  // handle). Undefined in callers without an execution (tests).
  forceClose: (reason: string) => Promise<void> | undefined,
): Promise<RunState> {
  const runStart = Date.now();
  let state: RunState = initialState;
  // f0.3.5: this turn's TPS, timed here (model generation only, tool windows
  // removed) — never from the CLI's session-cumulative duration fields.
  const tpsMeter = new TurnTpsMeter();
  // issue #9 (P1): true once this function reached a terminal state — the
  // watchdog's delayed force-close must not fire after a normal end.
  let settled = false;

  // Idle watchdog: claude going silent for `idleTimeoutMs` is treated as
  // "presumed hung", we stop() and surface a timeout marker on the card.
  //
  // BUT — claude can legitimately be silent for a long time when it's
  // waiting on a long-running tool call (e.g. `lark-cli` printing an
  // OAuth URL and blocking until the user clicks authorize). In that
  // case there's no event stream activity from claude itself, only the
  // tool subprocess running. We track which tool_use ids haven't matched
  // a tool_result yet, and pause the watchdog whenever the set is
  // non-empty.
  //
  // The watchdog re-arms when:
  //  - a tool_result drains the in-flight set to zero, OR
  //  - any non-tool event arrives while the set is empty.
  //
  // f031-stab-#4: RunWatchdog adds a hard cap per tool call on top, so a
  // wedged tool can no longer keep the scope blocked until a manual /stop.
  const watchdog = new RunWatchdog({
    idleMs: timeouts.idleMs,
    toolMs: timeouts.toolMs,
    onFire: (fire) => {
      handle.interrupted = true;
      if (fire.kind === 'idle') log.warn('agent', 'idle-timeout', { scope, idleTimeoutMs: fire.ms });
      else log.warn('agent', 'tool-timeout', { scope, tool: fire.toolName, toolTimeoutMs: fire.ms });
      void handle.run.stop().catch(() => {
        /* stop errors are non-fatal */
      });
      // issue #9 (P1): stop() is a no-op once the child already exited, and
      // then nothing ever ends the event stream — the slot froze for two
      // hours on 2026-11-08. Give the stream a short window to end on its
      // own; if this function is still running (no terminal state reached),
      // force-close: synthetic terminal + process-tree kill.
      const FORCE_CLOSE_AFTER_MS = 10_000;
      setTimeout(() => {
        if (settled) return;
        log.fail(
          'agent',
          new Error(`watchdog ${fire.kind} fire did not end the run`),
          { scope, action: 'force-close', afterMs: FORCE_CLOSE_AFTER_MS },
        );
        const close = forceClose(`watchdog-${fire.kind}-timeout`);
        if (close) {
          close.catch((err) => {
            log.fail('agent', err, { scope, event: 'watchdog-force-close-failed' });
          });
        }
      }, FORCE_CLOSE_AFTER_MS).unref();
    },
  });
  watchdog.start();

  // fix(2026-10-30): empty-run guard - count events that prove the agent
  // genuinely produced something (text/thinking/final_text/tool/usage).
  // A claude process that dies instantly after spawn (seen after /stop or
  // right after a long run: process-pool residue) emits only system+done,
  // so the old code rendered an empty Done card the user never saw -
  // manifesting as "must send the message twice".
  let substantiveEvents = 0;

  try {
    for await (const evt of events) {
      if (handle.interrupted) break;
      tpsMeter.observe(evt);

      // Track tool flight before re-arming the idle timer so the arm step
      // sees the correct set size. tool_use opens a window; tool_result
      // closes it. Other event types are bookkept after the if/else.
      if (evt.type === 'tool_use') {
        watchdog.toolStarted(evt.id, evt.name);
        log.info('agent', 'tool-in-flight', {
          tool: evt.name,
          inFlight: watchdog.inFlight,
        });
      } else if (evt.type === 'tool_result') {
        watchdog.toolFinished(evt.id);
        log.info('agent', 'tool-done', { inFlight: watchdog.inFlight });
      } else {
        watchdog.activity();
      }

      if (evt.type === 'system') {
        recordSession(evt);
        // f031-#12: /status shows the model the CLI really ran.
        stats.recordModel(scope, evt.model);
        continue;
      }
      // fix(2026-10-30): any of these proves the agent really ran.
      if (
        evt.type === 'text' ||
        evt.type === 'thinking' ||
        evt.type === 'final_text' ||
        evt.type === 'tool_use' ||
        evt.type === 'usage'
      ) {
        substantiveEvents++;
      }
      // f0.2+ /status: count the agent's answer as one assistant message.
      // f031-func-#8: only on 'done' — both adapters end every turn with it;
      // counting codex's 'final_text' too made each codex turn count twice.
      if (evt.type === 'done') {
        stats.recordMessage(scope, 'agent');
      }
      if (evt.type === 'usage') {
        // f031-#8/#10: per-call main-line snapshots drive the /status context
        // readout; the once-per-turn cumulative result drives session totals.
        stats.recordUsage(scope, {
          // Codex (OpenAI semantics) counts cached tokens INSIDE input_tokens;
          // claude reports them separately. Normalise to the claude shape.
          inputTokens:
            agentId === 'codex' && evt.inputTokens !== undefined
              ? Math.max(0, evt.inputTokens - (evt.cachedInputTokens ?? 0))
              : evt.inputTokens,
          outputTokens: evt.outputTokens,
          cachedInputTokens: evt.cachedInputTokens,
          cacheCreationInputTokens: evt.cacheCreationInputTokens,
          cumulative: evt.cumulative,
          sidechain: evt.sidechain,
        });
        const { costUsd, inputTokens, outputTokens } = evt;
        if (costUsd !== undefined || inputTokens !== undefined || outputTokens !== undefined) {
          log.info('agent', 'usage', {
            // f0.3.5: claude's total_cost_usd is SESSION-cumulative on a
            // resumed session, so name it that way (it is not this turn's).
            ...(costUsd !== undefined ? { sessionCostUsd: Number(costUsd.toFixed(4)) } : {}),
            // f0.3.5: keys without "token" — the logger redacts any key that
            // contains it, which made these counts useless ("[REDACTED]").
            ...(inputTokens !== undefined ? { inTok: inputTokens } : {}),
            ...(outputTokens !== undefined ? { outTok: outputTokens } : {}),
            ...(evt.callFinal ? { callFinal: true } : {}),
            // f031-#8: cache fields + kind, so the journal can explain /status.
            ...(evt.cachedInputTokens !== undefined ? { cacheRead: evt.cachedInputTokens } : {}),
            ...(evt.cacheCreationInputTokens !== undefined ? { cacheCreate: evt.cacheCreationInputTokens } : {}),
            ...(evt.cumulative ? { cumulative: true } : {}),
            ...(evt.sidechain ? { sidechain: true } : {}),
          });
          if (costUsd !== undefined) reportMetric('session_cost_usd', costUsd);
          if (inputTokens !== undefined) reportMetric('tokens_in', inputTokens);
          if (outputTokens !== undefined) reportMetric('tokens_out', outputTokens);
        }
        // aiduCAT: fall through to reduce() so the panel header can show the
        // context-window percentage — usage rides on the state now.
      }

      // fix(2026-10-30): empty-run detection at terminal events. An
      // empty round is surfaced as an explicit error terminal so the
      // user sees a visible failure card instead of a silent empty
      // Done card (the "send twice" bug).
      const prevTerminal = state.terminal;
      const prevFooter = state.footer;
      state = reduce(state, evt);
      // f0.3.5: a turn that ended normally feeds the session average
      // (/status). Interrupted/failed turns are skipped. f0.3.6: no longer
      // shown on the card (Wei: TPS only in /status).
      if (evt.type === 'done' && evt.terminationReason === 'normal') {
        const turn = tpsMeter.finish();
        log.info('agent', 'turn-tps', { outTok: turn.outputTokens, genMs: turn.genMs, tps: turn.tps ?? null });
        if (turn.tps !== undefined) stats.recordTurnTps(scope, turn.outputTokens, turn.genMs);
      }
      // f0.3.1 #4: must run AFTER reduce — reduce('done') unconditionally sets
      // terminal='done' and used to wipe the guard's error (f0.3 bug).
      if (
        (agentId === 'claude' || agentId === 'hermes') &&
        (state.terminal === 'done' || state.terminal === 'error') &&
        (evt.type === 'done' || evt.type === 'error') &&
        substantiveEvents === 0 &&
        !handle.interrupted
      ) {
        log.warn('run', 'empty-no-output', {
          scope,
          terminal: evt.type,
        });
        state = markEmptyRun(state);
      }
      if (state.footer !== prevFooter || state.terminal !== prevTerminal) {
        log.info('card', 'transition', { footer: state.footer, terminal: state.terminal });
      }
      await flush(state);
      // Stop iterating as soon as we have a terminal state. Some claude
      // versions don't close stdout immediately after the result event, which
      // would leave the for-await waiting forever otherwise.
      if (state.terminal !== 'running') break;
    }
  } finally {
    watchdog.dispose();
  }

  // If state already reached a terminal event (done/error/etc.) before the
  // watchdog or interrupt could land, don't clobber it — that real terminal
  // wins. This avoids "claude finished but flush was slow → timer fired
  // mid-flush → user sees 'idle_timeout' on a successful run".
  if (state.terminal === 'running') {
    const fired = watchdog.firedWith;
    if (fired) {
      state = markIdleTimeout(
        state,
        Math.round(fired.ms / 60_000),
        fired.kind === 'tool' ? fired.toolName : undefined,
      );
    } else if (handle.interrupted) {
      state = markInterrupted(state);
    } else {
      state = finalizeIfRunning(state);
    }
  }
  log.info('card', 'final', { scope, terminal: state.terminal, interrupted: handle.interrupted });
  reportMetric('run_e2e_ms', Date.now() - runStart, { terminal: state.terminal });
  await flush(state);
  settled = true;
  if (handle.interrupted) {
    await handle.run.stop();
  }
  return state;
}

async function awaitRenderAwareStream(input: {
  mode: 'card' | 'markdown';
  progress: LazyProgressStream;
  renderDone: Promise<RunState>;
  producerStarted: () => boolean;
  fallback: (state: RunState, streamErr?: unknown) => Promise<void>;
  /**
   * f0.3.1 #1: a stream whose producer already ran failed at (or after) the
   * terminal flush — i.e. the final card patch was rejected. When set, this
   * handles it instead of throwing / only logging.
   */
  onProducerFailure?: (err: unknown, state: RunState) => Promise<void>;
}): Promise<void> {
  const streamResult = input.progress.settled.then(
    () => ({ kind: 'stream' as const, ok: true as const }),
    (err) => ({ kind: 'stream' as const, ok: false as const, err }),
  );
  const renderResult = input.renderDone.then(
    (state) => ({ kind: 'render' as const, ok: true as const, state }),
    (err) => ({ kind: 'render' as const, ok: false as const, err }),
  );
  const first = await Promise.race([streamResult, renderResult]);
  if (!first.ok) {
    if (first.kind === 'stream') {
      log.fail('stream', first.err, { mode: input.mode, step: 'stream' });
      const rendered = await renderResult;
      if (!rendered.ok) throw rendered.err;
      await runFallbackReply(input.mode, rendered.state, input.fallback, first.err);
      return;
    }
    throw first.err;
  }

  if (first.kind === 'stream') {
    const rendered = await renderResult;
    if (!rendered.ok) throw rendered.err;
    return;
  }

  // Nothing durable ever showed up, so no progress message was opened at all
  // (the common Codex final-only round). Whatever the run ended with still has
  // to reach the user as a standalone reply.
  if (!input.progress.opened()) {
    log.info('outbound', 'progress-stream-skipped', { mode: input.mode });
    await runFallbackReply(input.mode, first.state, input.fallback);
    return;
  }

  // The run ended before the stream did. A producer that hasn't started yet is
  // usually just a card still being created (two API round trips), so give the
  // stream its grace window rather than replying immediately — an immediate
  // fallback would post the same answer twice once the stream catches up.
  const terminal = await Promise.race([
    streamResult,
    delay(STREAM_TERMINAL_GRACE_MS).then(() => undefined),
  ]);

  if (!terminal) {
    if (input.producerStarted()) {
      log.warn('stream', 'terminal-grace-expired', {
        mode: input.mode,
        graceMs: STREAM_TERMINAL_GRACE_MS,
      });
      void streamResult.then(async (result) => {
        if (!result.ok) {
          log.fail('stream', result.err, { mode: input.mode, step: 'stream-terminal-late' });
          if (input.onProducerFailure) {
            await input.onProducerFailure(result.err, first.state).catch((err) => {
              log.fail('stream', err, { mode: input.mode, step: 'degrade-late' });
            });
          }
        }
      });
      return;
    }
    // Still nothing on screen after the grace window: give up on the stream and
    // reply without it. `abandon()` keeps a late producer from rendering the
    // same answer again; the empty message it leaves is recalled in cleanup.
    input.progress.abandon();
    log.warn('stream', 'producer-not-started-before-agent-terminal', { mode: input.mode });
    await runFallbackReply(input.mode, first.state, input.fallback);
    return;
  }

  if (!terminal.ok) {
    // A stream that failed before producing anything delivered nothing, so the
    // reply still has to go out; one that failed later already showed its
    // content and the error is the caller's to handle.
    if (input.producerStarted()) {
      if (!input.onProducerFailure) throw terminal.err;
      log.fail('stream', terminal.err, { mode: input.mode, step: 'final-patch' });
      await input.onProducerFailure(terminal.err, first.state);
      return;
    }
    log.fail('stream', terminal.err, { mode: input.mode, step: 'stream' });
    await runFallbackReply(input.mode, first.state, input.fallback, terminal.err);
  }
}

async function runFallbackReply(
  mode: 'card' | 'markdown',
  state: RunState,
  fallback: (state: RunState, streamErr?: unknown) => Promise<void>,
  streamErr?: unknown,
): Promise<void> {
  try {
    await fallback(state, streamErr);
  } catch (err) {
    log.fail('stream', err, { mode, step: 'fallback' });
  }
}

/**
 * f0.3.4: ms timing for the latency trail (intake enter → flush start →
 * reaction added → progress-stream-open). `atMs` is this host's clock;
 * `sinceMsgMs` is measured from the Feishu message create_time.
 */
export function latencyFields(msgCreateTime: unknown, now = Date.now()): { atMs: number; sinceMsgMs?: number } {
  const t = typeof msgCreateTime === 'number' ? msgCreateTime : Number(msgCreateTime);
  return Number.isFinite(t) && t > 0 ? { atMs: now, sinceMsgMs: now - t } : { atMs: now };
}

/** f0.3.4: a working reaction added once, released (removed) at most once. */
interface WorkingReaction {
  release(): void;
}

/** f0.3.5: card mode has no reaction (the「☤aiduCATing…」card is the cue). */
const NO_REACTION: WorkingReaction = { release() {} };

/**
 * f0.3.5: the「☤aiduCATing…」card at intake replaces the reaction for card-mode
 * Claude profiles. Codex keeps its lazy card (an early one would only be
 * recalled) and markdown/text modes have no card, so both keep the reaction.
 */
function usesEarlyCard(controls: Pick<Controls, 'cfg' | 'profileConfig'>): boolean {
  return getMessageReplyMode(controls.cfg) === 'card' && controls.profileConfig.agentKind !== 'codex';
}

function startWorkingReaction(channel: LarkChannel, messageId: string, msgCreateTime?: unknown): WorkingReaction {
  const promise = addWorkingReaction(channel, messageId, latencyFields(msgCreateTime));
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      scheduleWorkingReactionCleanup(channel, messageId, promise);
    },
  };
}

function scheduleWorkingReactionCleanup(
  channel: LarkChannel,
  messageId: string,
  reactionPromise: Promise<string | undefined> | undefined,
): void {
  if (!reactionPromise) return;

  void (async () => {
    const reactionResult = reactionPromise.then(
      (reactionId) => ({ ok: true as const, reactionId }),
      (err) => ({ ok: false as const, err }),
    );
    const settled = await Promise.race([
      reactionResult,
      delay(REACTION_CLEANUP_GRACE_MS).then(() => undefined),
    ]);

    if (!settled) {
      log.warn('reaction', 'cleanup-deferred', {
        messageId,
        graceMs: REACTION_CLEANUP_GRACE_MS,
      });
      void reactionResult.then((result) => {
        if (!result.ok || !result.reactionId) return;
        void removeReaction(channel, messageId, result.reactionId);
      });
      return;
    }

    if (!settled.ok || !settled.reactionId) return;
    await removeReaction(channel, messageId, settled.reactionId);
  })();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPrompt(
  batch: NormalizedMessage[],
  attachments: LocalAttachment[],
  quotes: QuotedContext[] = [],
  topicContext: QuotedContext[] = [],
  botIdentity?: { openId: string; name?: string },
  extraInstructions?: string[],
): string {
  const first = batch[0];
  if (!first) return '';

  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  // When the debounce window merged messages (possibly from several senders —
  // common in bot-at-bot group chats), annotate each segment with its sender
  // so the agent can tell who said what. Single-message batches stay verbatim.
  const annotate = batch.length > 1;
  const texts = batch
    .map((m) => {
      const text = stripAttachmentRefs(m.content, fileKeys).trim();
      if (!text) return '';
      // f031-sec-#6: another bot's words in a merged batch are data, not orders.
      const body = annotate && senderTypeOf(m) === 'bot' ? untrustedText(text) : text;
      return annotate ? `${senderAnnotation(m)} ${body}` : body;
    })
    .filter(Boolean);
  const userPart =
    texts.length > 0
      ? texts.join('\n\n')
      : attachments.length > 0
        ? '请看下面的附件。'
        : quotes.length > 0
          ? '用户仅 @ 了你，请根据其引用的消息识别并处理请求；不要将此视为普通 ping。'
          : '（对方发来一条没有正文的消息——通常是只 @ 了你的唤醒（ping）。请简短回应。）';

  const senderType = senderTypeOf(first);
  const mentions = mergeMentions(batch);
  const instructions = [
    ...BRIDGE_AGENT_INSTRUCTIONS,
    ...downloadFailedInstructions(attachments),
    ...(extraInstructions ?? []),
  ];

  return buildAgentPrompt({
    context: {
      chatId: first.chatId,
      chatType: first.chatType,
      senderId: first.senderId,
      ...(first.senderName ? { senderName: first.senderName } : {}),
      ...(senderType ? { senderType } : {}),
      ...(botIdentity?.openId ? { botOpenId: botIdentity.openId } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(first.threadId ? { threadId: first.threadId } : {}),
      messageIds: batch.map((m) => m.messageId),
      source: 'im',
    },
    instructions,
    userInput: userPart,
    ...(topicContext.length > 0 ? { topicContext: topicContext.map(toPromptTopicMessage) } : {}),
    quotedMessages: quotes.map(toPromptQuote),
    interactiveCards: batch.map(toPromptInteractiveCard).filter(isDefined),
    attachments: attachments.map(toPromptAttachment),
  });
}

/**
 * f031-fix-#1: name every attachment whose download failed, so the agent still
 * answers but tells the user which file it never saw.
 */
function downloadFailedInstructions(attachments: readonly LocalAttachment[]): string[] {
  const failed = attachments.filter((a) => a.rejectionReason === DOWNLOAD_FAILED);
  if (failed.length === 0) return [];
  const names = failed.map((a) => {
    const kind = a.kind === 'image' ? '图片' : '文件';
    return a.originalName ? `${kind}「${a.originalName}」` : `${kind}（消息 ${a.sourceMessageId}）`;
  });
  return [
    `有 ${failed.length} 个附件没下载下来：${names.join('、')}（见 user_input.attachments 里 rejectionReason=download-failed 的条目）。其余内容照常处理，但回答里要明确告诉用户这些附件你没看到，需要的话请对方重发。`,
  ];
}

/**
 * Classify the sender as human or bot from the raw Feishu event
 * (`sender.sender_type`: 'user' = human, 'app' = bot). The normalizer drops
 * this field, so read it off `msg.raw` (`includeRawEvent: true` above).
 * Unknown / missing values return undefined — omit rather than guess.
 */
function senderTypeOf(msg: NormalizedMessage): 'user' | 'bot' | undefined {
  const raw = msg.raw as { sender?: { sender_type?: unknown } } | undefined;
  const senderType = raw?.sender?.sender_type;
  if (senderType === 'user') return 'user';
  if (senderType === 'app' || senderType === 'bot') return 'bot';
  return undefined;
}

function senderAnnotation(msg: NormalizedMessage): string {
  const name = msg.senderName ?? msg.senderId;
  const type = senderTypeOf(msg);
  return type ? `[${name} (${type})]:` : `[${name}]:`;
}

function mergeMentions(batch: NormalizedMessage[]): BridgePromptMention[] {
  const seen = new Set<string>();
  const out: BridgePromptMention[] = [];
  for (const msg of batch) {
    for (const mention of msg.mentions ?? []) {
      const dedupeKey = mention.openId ?? `${mention.name ?? ''}:${mention.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        ...(mention.openId ? { openId: mention.openId } : {}),
        ...(mention.name ? { name: mention.name } : {}),
        ...(mention.isBot !== undefined ? { isBot: mention.isBot } : {}),
      });
    }
  }
  return out;
}

function replyQuoteTargetForMessage(
  msg: NormalizedMessage,
  mode: ChatMode,
): string | undefined {
  const replyTo = msg.replyToMessageId;
  if (!replyTo) return undefined;

  // Feishu topic messages use root_id/parent_id as the topic root anchor even
  // for ordinary in-topic messages. Treat that as structure, not a quote.
  if (mode === 'topic' && msg.threadId && msg.rootId && replyTo === msg.rootId) {
    return undefined;
  }
  return replyTo;
}

function stripAttachmentRefs(text: string, fileKeys: string[]): string {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
    out = out.replace(
      new RegExp(
        `<\\s*(?:file|image|img|audio|video|media|folder)\\b[^>]*\\bkey\\s*=\\s*["']${escaped}["'][^>]*>`,
        'gi',
      ),
      '',
    );
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

function toPromptQuote(q: QuotedContext): BridgePromptQuotedMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptTopicMessage(q: QuotedContext): BridgePromptTopicMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.senderType ? { senderType: q.senderType } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptInteractiveCard(m: NormalizedMessage): BridgePromptInteractiveCard | undefined {
  if (m.rawContentType !== 'interactive') return undefined;
  const rawContent = (m.raw as { message?: { content?: unknown } } | undefined)
    ?.message?.content;
  if (typeof rawContent !== 'string' || rawContent.length === 0) return undefined;
  return {
    messageId: m.messageId,
    content: parseJsonOrRaw(rawContent),
  };
}

function parseJsonOrRaw(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
