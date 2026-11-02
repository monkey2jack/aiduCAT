/**
 * aiduCAT /model interactive card: (provider +) combo dropdown + effort
 * dropdown + submit.
 *
 * f0.2 (猴哥点单): when extra providers are configured, the card carries TWO
 * selects — provider first, then model (combo) — both submitted together;
 * submit-time validation checks the model belongs to the chosen provider.
 * Without extra providers the card keeps its f0.1 shape (no provider row).
 *
 * 猴哥点单 (f0.1): the submit button is only reachable once BOTH selects
 * have a value — implemented by disabling the submit until the form is
 * complete via Feishu's select "required" validation (a required empty
 * select blocks form submit with a native prompt), plus a client-side hint.
 */

import { GATEWAY_TRANSLATED, isClaudeModelId } from '../agent/claude/model-id';
import { DEFAULT_PROVIDER, DEFAULT_PROVIDER_VALUE } from '../bot/model-providers';

const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const CODEX_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'ultra'] as const;
const ALL_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

/** effort shows capitalized in cards (Max/High) but travels lowercase. */
function effortLabel(effort: string): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export interface ModelCardOpts {
  /** Combo names from the chosen provider (live or cached). */
  combos: Array<{ id: string; name: string; label?: string }>;
  /** Provider dropdown choices (default first). Empty = hide provider row. */
  providers?: Array<{ id: string; label: string }>;
  /** Currently stored provider preference, if any. */
  currentProvider?: string;
  /** f0.2: display name of the default gateway (e.g. 10router). */
  defaultProviderName?: string;
  /** Fetch source for the model list (hint line). */
  source?: 'live' | 'cached' | 'unavailable';
  /** Total models available before the dropdown cap (hint line). */
  totalModels?: number;
  /** Currently stored model preference (combo name), if any. */
  currentModel?: string;
  /** Currently stored effort, if any. */
  currentEffort?: string;
  /** Agent runtime kind (claude or codex), used for dynamic effort hints and options. */
  agentKind?: 'claude' | 'codex' | 'hermes';
  /**
   * f04-group-cmd-model: set when /model was opened in a group — the card
   * then only changes this group. `own` = the group already has its own
   * model (shows the「恢复跟随默认」button); otherwise it follows the default.
   */
  chatScope?: { own: boolean };
}

/** /model — the selection card. */
export function modelCard(opts: ModelCardOpts): object {
  const src = opts.source ?? 'unavailable';
  const overflowHint =
    opts.totalModels && opts.totalModels > opts.combos.length
      ? `\n_仅列前 ${opts.combos.length}/${opts.totalModels} 个;其余用 \`/model <模型名>\`直发_`
      : '';
  const hint =
    (src === 'unavailable'
      ? '⚠️ 暂时取不到模型列表'
      : src === 'cached'
        ? '_列表来自缓存_'
        : '') + overflowHint;

  // f031-fix-#2: on a Claude profile a non-Claude model is translated by the
  // gateway (and gets no --effort) — say so instead of passing it off as native.
  const translated = (model: string | undefined): boolean =>
    opts.agentKind === 'claude' && Boolean(model) && !isClaudeModelId(model);
  const comboValues =
    opts.combos.length > 0
      ? opts.combos.map((c) => ({
          text: {
            tag: 'plain_text',
            content: translated(c.name) ? `${c.label ?? c.name} · ${GATEWAY_TRANSLATED}` : (c.label ?? c.name),
          },
          value: c.name,
        }))
      // Feishu select_static rejects an empty options array — always give the
      // user something, and the unavailable hint above explains why.
      : [{ text: { tag: 'plain_text', content: '（取不到模型列表）' }, value: '__none__' }];

  const isCodex = opts.agentKind === 'codex';
  const isClaude = opts.agentKind === 'claude';
  const effortLevels = isCodex ? CODEX_EFFORT_LEVELS : isClaude ? CLAUDE_EFFORT_LEVELS : ALL_EFFORT_LEVELS;

  const modelElements: object[] = [];

  // f0.2 猴哥点单 (2026-10-19 版式): three labelled dropdown sections —
  // Provider / Model / Effort Level — separated by hr, then the submit
  // button with its side note. No caption paragraphs, no blank lines.
  // A one-line fallback hint only renders when the model list is degraded.
  const providerSelect = {
    tag: 'select_static',
    name: 'provider',
    placeholder: { tag: 'plain_text', content: '选择 provider' },
    ...(opts.currentProvider &&
    opts.currentProvider !== DEFAULT_PROVIDER &&
    opts.providers?.some((p) => p.id === opts.currentProvider)
      ? { initial_option: opts.currentProvider }
      : { initial_option: DEFAULT_PROVIDER_VALUE }),
    options: (opts.providers ?? []).map((p) => ({
      text: { tag: 'plain_text', content: p.label },
      value: p.id === DEFAULT_PROVIDER ? DEFAULT_PROVIDER_VALUE : p.id,
    })),
  };
  const modelSelect = {
    tag: 'select_static',
    name: 'combo',
    placeholder: { tag: 'plain_text', content: '选择模型' },
    ...(opts.currentModel && opts.combos.some((c) => c.name === opts.currentModel)
      ? { initial_option: opts.currentModel }
      : {}),
    options: comboValues,
  };

  const effortSelect = {
    tag: 'select_static',
    name: 'effort',
    placeholder: { tag: 'plain_text', content: '选择推理强度' },
    ...(opts.currentEffort && (effortLevels as readonly string[]).includes(opts.currentEffort)
      ? { initial_option: opts.currentEffort }
      : {}),
    options: effortLevels.map((level) => ({
      // Display capitalized (Max/High), value stays lowercase for the CLI.
      text: { tag: 'plain_text', content: effortLabel(level) },
      value: level,
    })),
  };

  // 猴哥点单: Provider / Model / Effort 三个下拉一行三列（字段短，一行足够）。
  modelElements.push({
    tag: 'column_set',
    flex_mode: 'stretch',
    columns: [
      ...(opts.providers && opts.providers.length > 1
        ? [{
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [
              { tag: 'markdown', content: '**Provider**' },
              providerSelect,
            ],
          }]
        : []),
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [
          { tag: 'markdown', content: '**Model**' },
          modelSelect,
        ],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [
          { tag: 'markdown', content: '**Effort**' },
          effortSelect,
        ],
      },
    ],
  });

  const currentBits = [
    opts.currentModel
      ? `\`${opts.currentModel}\`${translated(opts.currentModel) ? `（${GATEWAY_TRANSLATED}，effort 不生效）` : ''}`
      : '跟随默认',
    // f0.2: show the configured provider NAME, not the internal id — the
    // default sentinel renders as the default gateway's name (e.g. 10router).
    opts.providers && opts.providers.length > 1
      ? ` · ${
          !opts.currentProvider ||
          opts.currentProvider === DEFAULT_PROVIDER ||
          opts.currentProvider === DEFAULT_PROVIDER_VALUE
            ? (opts.defaultProviderName?.trim() || '默认')
            : (opts.providers.find((p) => p.id === opts.currentProvider)?.label ?? opts.currentProvider)
        }`
      : '',
    ` · effort: ${opts.currentEffort ? effortLabel(opts.currentEffort) : '默认'}`,
  ].join('');

  return {
    schema: '2.0',
    config: {},
    body: {
      elements: [
        { tag: 'markdown', content: opts.chatScope ? '**模型切换（只改本群）**' : '**模型切换**' },
        ...(opts.chatScope
          ? [{
              tag: 'markdown',
              content: opts.chatScope.own
                ? '_本群用自己的模型；不想单独设了就点「恢复跟随默认」_'
                : '_本群现在跟随默认模型；在这里选了就只对本群生效_',
            }]
          : []),
        ...(hint
          ? [{ tag: 'markdown', content: `_当前: ${currentBits} · ${hint.replace(/\n/g, ' ')}_` }]
          : [{ tag: 'markdown', content: `_当前: ${currentBits}_` }]),
        {
          tag: 'form',
          name: 'model_form',
          elements: [
            ...modelElements,
            {
              tag: 'column_set',
              flex_mode: 'none',
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
                    name: 'model_submit',
                    behaviors: [{ type: 'callback', value: { cmd: 'model.submit' } }],
                  }],
                },
                {
                  tag: 'column',
                  width: 'auto',
                  vertical_align: 'center',
                  elements: [{
                    tag: 'button',
                    text: { tag: 'plain_text', content: '❌ 取消' },
                    type: 'default',
                    name: 'model_cancel',
                    behaviors: [{ type: 'callback', value: { cmd: 'model.cancel' } }],
                  }],
                },
                ...(opts.chatScope?.own
                  ? [{
                      tag: 'column',
                      width: 'auto',
                      vertical_align: 'center',
                      elements: [{
                        tag: 'button',
                        text: { tag: 'plain_text', content: '↩️ 恢复跟随默认' },
                        type: 'default',
                        name: 'model_reset',
                        behaviors: [{ type: 'callback', value: { cmd: 'model.reset' } }],
                      }],
                    }]
                  : []),
              ],
            },
          ],
        },
      ],
    },
  };
}

/** /model submit — result card shown in place after saving. */
export function modelSavedCard(
  model: string,
  effort: string,
  provider?: string,
  defaultProviderName?: string,
  agentKind?: 'claude' | 'codex' | 'hermes',
  /** f04-group-cmd-model: 'chat' = saved for this group only. */
  scope?: 'chat' | 'default',
): object {
  const note =
    agentKind === 'claude' && model !== '跟随默认' && !isClaudeModelId(model)
      ? `\n\n_非 Claude 模型：${GATEWAY_TRANSLATED}，effort 不生效_`
      : '';
  const named =
    !provider || provider === 'default'
      ? defaultProviderName?.trim() || '默认'
      : provider;
  const providerBit = ` · provider \`${named}\``;
  return {
    schema: '2.0',
    config: {},
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            `✅ 已保存${scope === 'chat' ? '（只改本群）' : ''}：模型 \`${model}\`${providerBit} · effort \`${effortLabel(effort)}\`${note}\n\n_下一轮对话生效; 已在跑的任务不受影响_`,
        },
      ],
    },
  };
}

/** f04-group-cmd-model: /model reset result, shown in place of the form. */
export function modelResetCard(text: string): object {
  return {
    schema: '2.0',
    config: {},
    body: {
      elements: [{ tag: 'markdown', content: text }],
    },
  };
}

/** /model cancel — restores the previous card contents (no-op stub for now). */
export function modelCancelledCard(): object {
  return {
    schema: '2.0',
    config: {},
    body: {
      elements: [{ tag: 'markdown', content: '已取消,未做修改。' }],
    },
  };
}

/** Parse submitted form values into (provider, model, effort); null = keep current. */
export function parseModelCardSubmit(
  formValue: Record<string, unknown>,
  combos: Array<{ name: string }>,
  validProviders?: Array<string>,
): { provider: string | null; model: string | null; effort: string | null } {
  const rawModel = String(formValue.combo ?? '').trim();
  const validModel =
    rawModel !== '' && rawModel !== '__none__' && combos.some((c) => c.name === rawModel)
      ? rawModel
      : null;
  const rawEffort = String(formValue.effort ?? '').trim();
  const validEffort = (ALL_EFFORT_LEVELS as readonly string[]).includes(rawEffort) ? rawEffort : null;
  const rawProvider = String(formValue.provider ?? '').trim();
  const validProvider =
    rawProvider && (!validProviders || validProviders.includes(rawProvider)) ? rawProvider : null;
  return { provider: validProvider, model: validModel, effort: validEffort };
}
