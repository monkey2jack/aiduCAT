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
  | 'moonshot' | 'google' | 'anthropic' | 'stability' | 'inception' | 'monkey';

let cachedKeys: Partial<Record<VendorLogo, string>> | undefined;

function loadKeys(): Partial<Record<VendorLogo, string>> {
  if (cachedKeys) return cachedKeys;
  try {
    // assets/ ships next to the compiled dist/ — walk up from CWD first
    // (service runs with WorkingDirectory=repo root), then from this module.
    const candidates = [
      join(process.cwd(), 'assets', 'lark-logo-keys.json'),
      join(dirname(fileURLToPath(import.meta.url)), '../../assets/lark-logo-keys.json'),
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
  [/monkey/, 'monkey'],
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
