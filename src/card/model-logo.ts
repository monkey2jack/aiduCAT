import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../core/logger';

/**
 * aiduCAT f0.2: model/vendor logo in the panel header.
 *
 * The Feishu card renders `custom_icon` in the collapsible panel header's
 * icon slot. Feishu requires images to be uploaded first (im/v1/images) and
 * referenced by `img_key` — external URLs are rejected. The 29 vendor PNGs
 * were uploaded once (2026-10-19, lobehub icons-static-png 1.97.1 @128px);
 * the resulting image_key map ships with the repo as a static asset.
 *
 * No sensitive data here: img_key values are opaque Feishu references.
 */

export type VendorLogo =
  | 'openai' | 'gemini' | 'claude' | 'grok' | 'xai' | 'deepseek' | 'qwen'
  | 'kimi' | 'doubao' | 'hunyuan' | 'minimax' | 'stepfun' | 'zhipu'
  | 'chatglm' | 'baichuan' | 'yi' | 'spark' | 'wenxin' | 'sensenova'
  | 'internlm' | 'mistral' | 'cohere' | 'nvidia' | 'meta' | 'gemma'
  | 'moonshot' | 'google' | 'anthropic' | 'stability' | 'inception' | 'aidupark'
  // f0.4+ agent icons (Wei 2026-11-04): the panel shows the coding agent, not the model vendor.
  | 'claudecode' | 'codex' | 'hermes';

let cachedKeys: Partial<Record<VendorLogo, string>> | undefined;

function loadKeys(): Partial<Record<VendorLogo, string>> {
  if (cachedKeys) return cachedKeys;
  try {
    // f0.4+ fix (2026-11-04): the module's own repo first. summer runs with
    // WorkingDirectory=/data/home, where a stale assets/lark-logo-keys.json
    // (Oct 27, no agent keys) shadowed the shipped one, so the new agent
    // icons never loaded. CWD is only the last resort now.
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      // f03p-slim: built bundle lives in <repo>/dist/ → ../assets
      join(here, '../assets/lark-logo-keys.json'),
      // source tree (src/card/) → ../../assets
      join(here, '../../assets/lark-logo-keys.json'),
      join(process.cwd(), 'assets', 'lark-logo-keys.json'),
    ];
    for (const p of candidates) {
      try {
        cachedKeys = JSON.parse(readFileSync(p, 'utf8')) as Partial<Record<VendorLogo, string>>;
        return cachedKeys;
      } catch {
        // try next candidate
      }
    }
  } catch {
    // fall through
  }
  log.warn('card', 'logo-keys-unavailable', {});
  cachedKeys = {};
  return cachedKeys;
}

/**
 * Keyword → vendor mapping, first match wins. Model ids come from gateway
 * combos (`Gemini-3.8-Flash`, `gpt-5-codex`, `claude-opus-4-8`…) and upstream
 * CLI defaults, so matching is lowercase substring based and ordered from the
 * most specific vendor keyword to the most generic.
 */
const VENDOR_PATTERNS: Array<[RegExp, VendorLogo]> = [
  // 猴哥的 10router 专属 combo `aiduPARK`（2026-11-02 起，替代旧 combo
  // `monkey`）用黑白翅膀徽标。放第一位：combo 名里可能带别的厂商词
  // （如 aiduPARK-gemini），专属图标优先。旧的 `monkey` 不再有专属图标。
  [/aidupark/, 'aidupark'],
  [/mercury|inception/, 'inception'],
  [/gemini|palm|bard/, 'gemini'],
  [/gemma/, 'gemma'],
  [/claude|opus|sonnet|haiku/, 'claude'],
  [/gpt|o1|o3|o4|chatgpt|codex|davinci/, 'openai'],
  [/grok/, 'grok'],
  [/kimi|moonshot/, 'kimi'],
  [/deepseek/, 'deepseek'],
  [/qwen|qwq|tongyi/, 'qwen'],
  [/doubao|seed-/, 'doubao'],
  [/hunyuan/, 'hunyuan'],
  [/glm|zhipu|chatglm/, 'zhipu'],
  [/minimax|abab/, 'minimax'],
  [/step/, 'stepfun'],
  [/baichuan/, 'baichuan'],
  [/yi-|^yi/, 'yi'],
  [/spark/, 'spark'],
  [/wenxin|ernie/, 'wenxin'],
  [/sensenova|sensechat/, 'sensenova'],
  [/internlm|intern/, 'internlm'],
  [/mistral|mixtral/, 'mistral'],
  [/cohere|command-r/, 'cohere'],
  [/llama|meta-/, 'meta'],
  [/sdxl|stable-diffusion|stability/, 'stability'],
  [/grok|colossus/, 'grok'],
  [/nova/, 'nvidia'],
  [/nvidia/, 'nvidia'],
];

/** Resolve a model id to a vendor logo key, or undefined when no match. */
export function vendorLogoForModel(model: string | undefined): VendorLogo | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  for (const [re, vendor] of VENDOR_PATTERNS) {
    if (re.test(m)) return vendor;
  }
  return undefined;
}

/** Feishu image_key for a model id, or undefined when un-mapped/unloaded. */
export function logoImgKeyForModel(model: string | undefined): string | undefined {
  const vendor = vendorLogoForModel(model);
  if (!vendor) return undefined;
  return loadKeys()[vendor];
}

/**
 * f0.4+ (Wei 2026-11-04「根据用户使用的工具来决定 logo」): the card icon is the
 * coding agent the profile runs (Claude Code / Codex / Hermes Agent), not the
 * model vendor — a Codex profile on a Claude combo still shows Codex.
 * Icons: lobehub icons-static-png claudecode-color / codex-color / hermesagent
 * @128px, uploaded once with the 嘟嘟 bot (img_key works across our apps).
 */
export type AgentLogoKind = 'claude' | 'codex' | 'hermes';

const AGENT_LOGO: Record<AgentLogoKind, VendorLogo> = {
  claude: 'claudecode',
  codex: 'codex',
  hermes: 'hermes',
};

/** Feishu image_key for a coding agent, or undefined when un-mapped/unloaded. */
export function logoImgKeyForAgent(agent: AgentLogoKind | undefined): string | undefined {
  if (!agent) return undefined;
  const vendor = AGENT_LOGO[agent];
  return vendor ? loadKeys()[vendor] : undefined;
}
