import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../core/logger';

/**
 * aiduCAT: coding-agent icon in the panel header.
 *
 * The Feishu card renders `custom_icon` in the collapsible panel header's
 * icon slot. Feishu requires images to be uploaded first (im/v1/images) and
 * referenced by `img_key` — external URLs are rejected. The image_key map
 * ships with the repo as a static asset (assets/lark-logo-keys.json).
 *
 * f0.4++ (Wei 2026-11-04「根据用户使用的工具来决定 logo」「把原来那些模型的
 * logo 去掉」): only the three coding agents (Claude Code / Codex / Hermes
 * Agent) have icons; the old per-model vendor logos are gone. A Codex
 * profile on a Claude combo still shows Codex. Icons: lobehub
 * icons-static-png claudecode-color / codex-color / hermesagent @128px,
 * uploaded once with the 嘟嘟 bot.
 *
 * No sensitive data here: img_key values are opaque Feishu references.
 */

export type AgentLogoKind = 'claude' | 'codex' | 'hermes';

type LogoKey = 'claudecode' | 'codex' | 'hermes';

const AGENT_LOGO: Record<AgentLogoKind, LogoKey> = {
  claude: 'claudecode',
  codex: 'codex',
  hermes: 'hermes',
};

let cachedKeys: Partial<Record<LogoKey, string>> | undefined;

function loadKeys(): Partial<Record<LogoKey, string>> {
  if (cachedKeys) return cachedKeys;
  // f0.4+ fix (2026-11-04): the module's own repo first. summer runs with
  // WorkingDirectory=/data/home, where a stale assets/lark-logo-keys.json
  // (Oct 27, no agent keys) shadowed the shipped one, so the agent icons
  // never loaded. CWD is only the last resort now.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // built bundle lives in <repo>/dist/ → ../assets
    join(here, '../assets/lark-logo-keys.json'),
    // source tree (src/card/) → ../../assets
    join(here, '../../assets/lark-logo-keys.json'),
    join(process.cwd(), 'assets', 'lark-logo-keys.json'),
  ];
  for (const p of candidates) {
    try {
      cachedKeys = JSON.parse(readFileSync(p, 'utf8')) as Partial<Record<LogoKey, string>>;
      return cachedKeys;
    } catch {
      // try next candidate
    }
  }
  log.warn('card', 'logo-keys-unavailable', {});
  cachedKeys = {};
  return cachedKeys;
}

/** Feishu image_key for a coding agent, or undefined when un-mapped/unloaded. */
export function logoImgKeyForAgent(agent: AgentLogoKind | undefined): string | undefined {
  if (!agent) return undefined;
  const key = AGENT_LOGO[agent];
  return key ? loadKeys()[key] : undefined;
}
