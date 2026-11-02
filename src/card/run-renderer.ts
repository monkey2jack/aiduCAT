import { deepMaskEmails } from './mask-email';
import { timeoutNotice, type Block, type RunState, type ToolEntry } from './run-state';
import { logoImgKeyForModel } from './model-logo';
import { maskEmails } from './mask-email';
import { TRUNCATION_NOTE, sanitizeCardMarkdown, sanitizePlainText, truncateUtf8, utf8Bytes } from './sanitize';
import { jsonBytes, paginateMarkdown } from './paginate';
import { toolHeaderText } from './tool-render';
const REASONING_MAX = 1500;
/** f0.3.1 #2: answer budget inside the card (UTF-8 bytes, before JSON escaping). */
export const ANSWER_MAX_BYTES = 25_000;
/** f0.3.1 #2: whole card JSON budget — Feishu rejects cards over 30KB (230025). */
export const CARD_MAX_BYTES = 28_000;
/** f03p-fix-#8: answer budget of each 「续 i/N」 continuation card (JSON bytes). */
export const CONTINUATION_ANSWER_MAX_BYTES = 25_000;
/** Strict (degrade-retry) render: smaller answer, no reasoning/tool list. */
const STRICT_ANSWER_MAX_BYTES = 12_000;
const ERROR_MSG_MAX_BYTES = 1_000;

interface RenderBudget {
  answerBytes: number;
  reasoningMax: number;
  toolLines: number;
}

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
type Group = ToolGroup | TextGroup;

export interface RunCardRenderOptions {
  signCallback?: (action: string) => string;
  /** aiduCAT: model name shown in the meta panel (e.g. Gemini-3.8-Flash). */
  model?: string;
  /** aiduCAT: epoch ms when the run started, for elapsed-time in meta panel. */
  startedAt?: number;
  /** aiduCAT: reasoning effort (low..max), shown on the panel header line 1. */
  effort?: string;
  /** aiduCAT: model context window (tokens) from 10router; enables the
   * context-usage percentage on header line 1. Undefined = no percentage. */
  contextWindow?: number;
  /** f0.2: the clarify question the user just answered — buttons collapse
   * into a chosen-answer line so the same card can't be answered twice. */
  clarifyAnswered?: string;
  /** f0.3.1 #1: degrade-retry render after Feishu rejected the normal card —
   * image URLs dropped, answer capped at 12KB, no reasoning/tool list. */
  strict?: boolean;
}

export interface RenderResult {
  card: object;
  /** The answer did not fit this card; `continuations` carries the rest. */
  answerTruncated: boolean;
  bytes: number;
  /** f03p-fix-#8: answer pages for cards 2..N (sanitized markdown), in order. */
  continuations: string[];
}

export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  return renderCardWithInfo(state, options).card;
}

/**
 * f0.3.1 #2: render, then shrink until the card JSON fits `CARD_MAX_BYTES`
 * (tool list and reasoning first, then the answer). f03p-fix-#8: an answer
 * that does not fit is paged — this card shows page 1 with「…（未完，见下一张卡）」
 * and `continuations` holds the rest for `renderContinuationCard`.
 */
export function renderCardWithInfo(
  state: RunState,
  options: RunCardRenderOptions = {},
): RenderResult {
  const budget: RenderBudget = options.strict
    ? { answerBytes: STRICT_ANSWER_MAX_BYTES, reasoningMax: 0, toolLines: 0 }
    : { answerBytes: ANSWER_MAX_BYTES, reasoningMax: REASONING_MAX, toolLines: Number.POSITIVE_INFINITY };
  let r = buildCard(state, options, budget);
  if (r.bytes > CARD_MAX_BYTES) {
    budget.reasoningMax = Math.min(budget.reasoningMax, 500);
    budget.toolLines = Math.min(budget.toolLines, 40);
    r = buildCard(state, options, budget);
  }
  for (let i = 0; i < 6 && r.bytes > CARD_MAX_BYTES; i++) {
    budget.answerBytes = Math.max(1_000, budget.answerBytes - (r.bytes - CARD_MAX_BYTES) - 1_000);
    r = buildCard(state, options, budget);
  }
  if (r.bytes > CARD_MAX_BYTES) {
    budget.reasoningMax = 0;
    budget.toolLines = 0;
    r = buildCard(state, options, budget);
  }
  return r;
}

/**
 * f03p-fix-#8: one 「续 i/N」 card carrying answer page `page` (from
 * `RenderResult.continuations`). Pages other than the last end with the
 * same「…（未完，见下一张卡）」note as card 1.
 */
export function renderContinuationCard(page: string, index: number, total: number): object {
  const label = `续 ${index}/${total}`;
  return deepMaskEmails({
    schema: '2.0',
    config: { streaming_mode: false, summary: { content: label } },
    body: { elements: [noteMd(label), markdown(index < total ? page + TRUNCATION_NOTE : page)] },
  });
}

/** f03p-fix-#8: plain text for continuation pages whose card Feishu rejected. */
export function continuationPlainText(pages: string[]): string {
  return maskEmails(sanitizePlainText(pages.join('\n\n')).trim());
}

/** The raw answer as the card shows it (text blocks, or Codex finalText). */
function rawAnswerBlocks(state: RunState): string[] {
  const answerBlocks: string[] = [];
  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      const trimmed = group.content.trim();
      if (trimmed) {
        // aiduCAT clarify: strip anything from a [CLARIFY] sentinel on — the
        // marker line (complete or half-streamed) never reaches the card.
        answerBlocks.push((group.content.split('[CLARIFY]')[0] ?? '').replace(/\n+$/, ''));
      }
    }
  }
  // Codex delivers the terminal response as `finalText` rather than stream text blocks.
  // Ensure it renders in the answer area above the panel so codex and claude have
  // the exact same unified single-card layout.
  if (state.finalText && state.finalText.trim()) {
    const stripped = (state.finalText.split('[CLARIFY]')[0] ?? '').replace(/\n+$/, '');
    if (!answerBlocks.some((b) => b.includes(stripped) || stripped.includes(b))) {
      answerBlocks.push(stripped);
    }
  }
  return answerBlocks.filter((b) => b.trim());
}

/**
 * f0.3.1 #1: the whole answer as plain text for the IM fallback message —
 * images become `alt (url)`, HTML dropped, emails masked, never truncated.
 * Falls back to the error notice when the run produced no answer.
 */
export function answerPlainText(state: RunState): string {
  const text = sanitizePlainText(rawAnswerBlocks(state).join('\n\n')).trim();
  if (text) return maskEmails(text);
  if (state.terminal === 'error' && state.errorMsg) return maskEmails(`⚠️ ${sanitizePlainText(state.errorMsg)}`);
  if (state.terminal === 'idle_timeout') return timeoutNotice(state);
  return '';
}

function buildCard(
  state: RunState,
  options: RunCardRenderOptions,
  budget: RenderBudget,
): RenderResult {
  const elements: object[] = [];
  const withLinks = !options.strict;

  // aiduCAT: answer (text blocks or final_text) first, single aiduPOP panel below.
  // f03p-fix-#8: an answer over the budget is paged — page 1 here (cut at a
  // paragraph / code / table boundary), the rest goes to 「续 i/N」 cards.
  let answerTruncated = false;
  let continuations: string[] = [];
  const clean = rawAnswerBlocks(state).map((raw) => sanitizeCardMarkdown(raw, { withLinks }));
  const total = clean.reduce((n, t) => n + jsonBytes(t), 0);
  if (total <= budget.answerBytes) {
    for (const text of clean) if (text.trim()) elements.push(markdown(text));
  } else {
    const note = jsonBytes(TRUNCATION_NOTE);
    const pages = paginateMarkdown(
      clean.join('\n\n'),
      Math.max(500, budget.answerBytes - note),
      CONTINUATION_ANSWER_MAX_BYTES - note,
    );
    answerTruncated = pages.length > 1;
    continuations = pages.slice(1);
    const first = (pages[0] ?? '') + (answerTruncated ? TRUNCATION_NOTE : '');
    if (first.trim()) elements.push(markdown(first));
  }
  // f0.3.1 #4: an error with no answer (e.g. the empty-run guard) must be
  // visible without expanding the collapsed panel.
  if (elements.length === 0 && state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ ${errorText(state.errorMsg)}`));
  }
  // f03p-infra-#6: a stopped card can carry a note too ("服务重启后自动继续").
  if (elements.length === 0 && state.terminal === 'interrupted' && state.errorMsg) {
    elements.push(noteMd(errorText(state.errorMsg)));
  }
  // f031-stab-#4: a timeout (idle or one tool over its cap) says so on the
  // card itself — ⚠️Timeout in the summary alone left the user guessing.
  if (state.terminal === 'idle_timeout') {
    elements.push(noteMd(timeoutNotice(state)));
  }

  // f0.2 猴哥点单: the live status word (☤Reasoning... / ☤Tooling... /
  // ☤aiduCATing...) moved INTO the panel header line 1, leftmost — ahead of
  // the 💭/🛠️/⏱️ counters. It disappears once the run ends; the panel border
  // color carries the result. No standalone status line above the panel.
  // f0.2+ 猴哥点单 (2026-10-20): the live status line moves OUT of the panel —
  // rendered between the answer and the panel. Words renamed: Reasoning→
  // Thinking, Tooling→Processing. Header keeps only hard counters.
  const statusWord =
    state.terminal === 'running'
      ? state.footer === 'tool_running'
        ? 'Processing…'
        : state.footer === 'streaming' || state.footer === 'received'
          ? 'aiduCATing…'
          : 'Thinking…'
      : '';

  // aiduCAT: one collapsed panel carrying reasoning + every tool call + the
  // run meta header (aiduPOP layout). Hidden when there is nothing to show.
  // f0.3.6: two-stage placeholder — until the agent shows anything (first
  // thinking, tool call or answer text) the card is the single「☤aiduCATing…」
  // line; the panel joins the same card on the next full-card update.
  const popPanel = awaitingAgent(state) ? null : aiduPopPanel(state, options, budget);
  // f0.2+ 猴哥点单: notation size so the status line reads as a caption,
  // matching the panel body size instead of full answer text.
  if (statusWord) elements.push(noteMd(`☤${statusWord}`));
  if (popPanel) elements.push(popPanel);

  // aiduCAT clarify: when the run ended while waiting on a parsed
  // [CLARIFY] marker, render the question + one button per option right
  // below the answer. A click forwards the choice back into the scope's
  // pending queue so the agent's session resumes with the answer.
  if (state.clarify && state.terminal !== 'running' && !options.clarifyAnswered) {
    // f0.2 猴哥点单: dropdown instead of a button array — select_static is
    // naturally single-choice (repeat clicks just re-open the same form) and
    // routes through the SAME cardAction submit path /model uses, which is
    // known-good; the old button array's callbacks never reached the bot.
    elements.push(
      markdown(`⁉️ **TBC**：${sanitizeCardMarkdown(state.clarify.question, { withLinks })}\n_下拉选择后点确认_`),
    );
    elements.push({
      tag: 'form',
      name: 'clarify_form',
      elements: [
        {
          tag: 'select_static',
          name: 'clarify_choice',
          placeholder: { tag: 'plain_text', content: '选择一个选项' },
          options: state.clarify.options.map((option) => ({
            text: { tag: 'plain_text', content: option },
            value: option,
          })),
        },
        {
          tag: 'column_set',
          flex_mode: 'stretch',
          columns: [
            {
              tag: 'column',
              width: 'auto',
              vertical_align: 'center',
              elements: [{
                tag: 'button',
                text: { tag: 'plain_text', content: '✅ 确认' },
                type: 'primary',
                form_action_type: 'submit',
                name: 'clarify_submit',
                behaviors: [
                  {
                    type: 'callback',
                    value: {
                      cmd: 'clarify.answer',
                      arg: JSON.stringify({ q: state.clarify!.question }),
                    },
                  },
                ],
              }],
            },
          ],
        },
      ],
    });
  }
  // f0.2: answered state — swap the question+buttons for a single receipt
  // line so the same card can't be answered twice.
  if (options.clarifyAnswered) {
    elements.push(markdown(`✅ **已选**：${options.clarifyAnswered}`));
  }

  // aiduCAT: terminal state is expressed by the panel border color (aiduPOP
  // style) — 完成绿 / 停止黄 / 出错红 — not by a trailing text note. Keep an
  // empty-answer fallback note so a streamed card is never fully empty.
  if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd('🚫'));
  }

  // aiduCAT: no footer status line and no stop button — the live status word
  // lives at the far left of the panel header while running and vanishes on
  // completion (border color takes over), and stopping goes through /stop.

  // Mask raw emails across every text field so the Feishu tenant audit doesn't
  // reject the (streamed) card with a 400 EMAIL_ADDRESS — see mask-email.ts.
  const card = deepMaskEmails({
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state) },
    },
    body: { elements },
  });
  return { card, answerTruncated, bytes: utf8Bytes(JSON.stringify(card)), continuations };
}

function errorText(msg: string): string {
  return truncateUtf8(sanitizeCardMarkdown(msg, { withLinks: false }), ERROR_MSG_MAX_BYTES, '…');
}

/**
 * aiduCAT single panel (aiduPOP layout): the collapsed header carries only
 * `model · 💭 thinking-count · 🛠️ tool-count · ⏱️ elapsed` (see metaHeader),
 * and the body holds the thinking text plus one entry per tool call. Rendered below the
 * answer; omitted entirely for a run with no reasoning, tools, or meta.
 *
 * While running, the footer already carries the live status line, so the
 * collapsed header stays pure meta (counts + elapsed); on completion the
 * counts/values are final.
 */
function aiduPopPanel(state: RunState, options: RunCardRenderOptions, budget: RenderBudget): object | null {
  const tools = state.blocks.filter((b): b is Extract<Block, { kind: 'tool' }> => b.kind === 'tool');
  const hasReasoning = state.reasoning.content.trim().length > 0;
  const hasError = state.terminal === 'error' && !!state.errorMsg;

  const meta = metaHeader(state, options);
  if (!hasReasoning && tools.length === 0 && !meta) return null;

  const title = meta;

  const bodyParts: string[] = [];
  if (hasError) bodyParts.push(`⚠️ ${errorText(state.errorMsg!)}`);
  if (hasReasoning && budget.reasoningMax > 0) {
    // aiduCAT: 💭 marks a thinking burst — same emoji as the collapsed header.
    bodyParts.push(`💭 ${truncate(state.reasoning.content, budget.reasoningMax)}`);
  }
  if (tools.length > 0 && budget.toolLines > 0) {
    // Latest tool on top so the freshest activity is what you see on expand.
    // 猴哥点菜单：每个工具用自己的专属 emoji（👩🏻‍💻Bash 等），不再加统一的 🫧。
    const shown = tools.slice().reverse().slice(0, budget.toolLines);
    const lines = shown.map((b) => `- ${toolHeaderText(b.tool)}`);
    if (tools.length > shown.length) lines.push(`- …另有 ${tools.length - shown.length} 个更早的工具调用`);
    bodyParts.push(lines.join('\n'));
  }

  return collapsiblePanel({
    title,
    expanded: false,
    // aiduCAT: border color carries the terminal state (aiduPOP style) —
    // running/none grey, done green, stopped/timeout yellow, error red.
    border: panelBorderColor(state),
    body: sanitizeCardMarkdown(bodyParts.join('\n\n'), { withLinks: !options.strict }) || '_（无过程记录）_',
    // f0.2 猴哥点单: the panel header icon slot shows the current model's
    // vendor logo; un-mapped models keep the default chevron.
    ...(options.model && logoImgKeyForModel(options.model)
      ? { logoImgKey: logoImgKeyForModel(options.model) }
      : {}),
  });
}

/**
 * f0.3.6: the run is still on the「☤aiduCATing…」placeholder — the agent has
 * produced no thinking, tool call or answer yet. Every such event moves
 * `footer` off 'received' (see run-state reduce); `finalText` covers gateways
 * that only send the final answer. Terminal states always keep the panel
 * (its border colour carries the result).
 */
export function awaitingAgent(state: RunState): boolean {
  return (
    state.terminal === 'running' &&
    state.footer === 'received' &&
    state.blocks.length === 0 &&
    !state.reasoning.content.trim() &&
    !(state.finalText && state.finalText.trim())
  );
}

/** aiduCAT: 完成绿 / 停止黄 / 出错红 / 运行或无过程灰。 */
function panelBorderColor(state: RunState): 'grey' | 'green' | 'yellow' | 'red' {
  if (state.terminal === 'done') return 'green';
  if (state.terminal === 'interrupted' || state.terminal === 'idle_timeout') return 'yellow';
  if (state.terminal === 'error') return 'red';
  return 'grey';
}

/**
 * Collapsed panel header, one line: `model · 💭 n · 🛠️ n · ⏱️ elapsed`.
 * Elapsed keeps ticking across card updates because renderCard is re-run on
 * every streaming update with the fixed `options.startedAt`.
 */
function metaHeader(state: RunState, options: RunCardRenderOptions): string {
  // f0.2+ 猴哥点单 (2026-10-20): one-line minimal header —
  //   modelID · 思考n · 工具n · 耗时ns   (no emoji, no effort/ctx line)
  // The model vendor logo stays in the header icon slot (left side).
  const parts: string[] = [];
  if (options.model) parts.push(options.model);
  parts.push(`💭 ${state.reasoning.segments}`);
  const toolCount = state.blocks.filter((b) => b.kind === "tool").length;
  parts.push(`🛠️ ${toolCount}`);
  if (options.startedAt) {
    const secs = Math.max(0, Math.round((Date.now() - options.startedAt) / 1000));
    const label = secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : `${secs}s`;
    parts.push(`⏱️ ${label}`);
  }
  // f0.3.6 (Wei 2026-11-02): no per-turn ⚡ here — TPS lives only in
  // /status (session average), so the card and /status never disagree.
  return parts.join(" · ");
}

function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

interface PanelOpts {
  title: string;
  expanded: boolean;
  border: 'grey' | 'red' | 'blue' | 'green' | 'yellow';
  body: string;
  /** f0.2: model logo img_key — replaces the chevron in the header icon slot. */
  logoImgKey?: string;
}

function collapsiblePanel(opts: PanelOpts): object {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: panelHeader(opts.title, opts.logoImgKey),
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '4px',
    padding: '6px 8px 6px 8px',
    elements: [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
}

function panelHeader(titleMd: string, logoImgKey?: string): object {
  return {
    // aiduCAT: text_size=notation shrinks the collapsed header title to match
    // aiduPOP's small panel type (verified live: <font> tags are ignored on
    // panel headers, text_size on the title markdown is not).
    title: { tag: 'markdown', content: titleMd, text_size: 'notation' },
    vertical_align: 'center',
    // f0.2 猴哥点单: logo replaces the chevron in the header icon slot.
    // Feishu's icon_position defaults to `right` (open.feishu.cn card JSON 2.0
    // collapsible_panel: left = far left of the title area, right = far right,
    // follow_text = right after the text), so the logo must ask for `left`
    // explicitly to sit just before the model id (f0.4+ fix, Wei 11-02 19:33).
    // A logo is not an arrow: angle 0 keeps it upright when the panel expands.
    // Without a logo we keep the chevron pinned right, flipping -180 on expand,
    // so the collapse affordance stays.
    ...(logoImgKey
      ? {
          icon: { tag: 'custom_icon', img_key: logoImgKey, size: '16px 16px' },
          icon_position: 'left',
          icon_expanded_angle: 0,
        }
      : {
          icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
          icon_position: 'right',
          icon_expanded_angle: -180,
        }),
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function noteMd(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '⭕️Stop';
  if (state.terminal === 'idle_timeout') return '⚠️Timeout';
  if (state.terminal === 'error') return '❌Error';
  if (state.terminal === 'done') return '✅Done';
  if (state.footer === 'tool_running') return '☤Processing…';
  // f0.3.5: the placeholder card (received) reads the same as streaming.
  if (state.footer === 'streaming' || state.footer === 'received') return '☤aiduCATing…';
  return '☤Thinking…';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
