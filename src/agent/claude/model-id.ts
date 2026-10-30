/**
 * f031-stab-#15: is this a Claude model (official id, CLI alias, or a gateway
 * name like `Claude-Opus-4.6` / `cu/claude-opus-5-5`)? `undefined` = CLI
 * default, treated as Claude. Anything else behind the gateway (Gemini, GPT,
 * GLM, Kimi…) is translated by the gateway and gets no `--effort`.
 */
export function isClaudeModelId(model: string | undefined): boolean {
  if (!model) return true;
  return /claude|opus|sonnet|haiku/i.test(model);
}

/** f031-fix-#2: label shown next to a non-Claude model on a Claude profile. */
export const GATEWAY_TRANSLATED = '经网关翻译';
