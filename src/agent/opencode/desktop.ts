import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ModelOption } from '../models';

const require = createRequire(import.meta.url);

export interface OpenchamberDesktopSession {
  sessionId?: string;
  cwd?: string;
  model?: string;
  effort?: string;
}

export interface OpenchamberSettings {
  lastDirectory?: string;
  lastSelectedModel?: string;
  lastSelectedEffort?: string;
}

export function readOpenchamberSettings(): OpenchamberSettings {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!home) return {};
  const settingsPath = join(home, '.config', 'openchamber', 'settings.json');
  try {
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const lastDirectory = typeof s.lastDirectory === 'string' ? s.lastDirectory : undefined;
    const lastSelectedModel = typeof s.lastSelectedModel === 'string' ? s.lastSelectedModel : undefined;
    const lastSelectedEffort =
      lastSelectedModel && typeof s.lastUsedEfforts?.[lastSelectedModel] === 'string'
        ? s.lastUsedEfforts[lastSelectedModel]
        : typeof s.lastEffort === 'string'
          ? s.lastEffort
          : undefined;
    return { lastDirectory, lastSelectedModel, lastSelectedEffort };
  } catch {
    return {};
  }
}

export function resolveOpenchamberActiveSession(): OpenchamberDesktopSession {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!home) return {};
  const settings = readOpenchamberSettings();
  const dbPath = join(home, '.local', 'share', 'opencode', 'opencode.db');

  let sessionId: string | undefined;
  let cwd: string | undefined = settings.lastDirectory;

  try {
    const sqliteMod = require('node:sqlite');
    if (sqliteMod?.DatabaseSync && existsSync(dbPath)) {
      const db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true });
      try {
        if (cwd) {
          const norm = cwd.replace(/\\/g, '/');
          const row = db
            .prepare(
              'SELECT id, title, directory FROM session_v2 WHERE directory = ? OR directory = ? ORDER BY time_updated DESC LIMIT 1',
            )
            .get(cwd, norm) as { id?: string; directory?: string } | undefined;
          if (row?.id) {
            sessionId = row.id;
          }
        }
        if (!sessionId) {
          const row = db
            .prepare('SELECT id, title, directory FROM session_v2 ORDER BY time_updated DESC LIMIT 1')
            .get() as { id?: string; directory?: string } | undefined;
          if (row?.id) {
            sessionId = row.id;
            cwd = row.directory ?? cwd;
          }
        }
      } finally {
        db.close();
      }
    }
  } catch {
    // node:sqlite unavailable or db busy; degrade gracefully
  }

  return {
    sessionId,
    cwd,
    model: settings.lastSelectedModel,
    effort: settings.lastSelectedEffort,
  };
}

export const OPENCODE_DEFAULT_MODEL = 'default';

export const OPENCODE_FREE_MODELS: ModelOption[] = [
  { value: OPENCODE_DEFAULT_MODEL, label: '跟随默认（当前 Hunyuan 4 Flash）' },
  { value: 'opencode/hy4-flash-free', label: 'Hunyuan 4 Flash · Free' },
  { value: 'opencode/deepseek-v4.1-flash-free', label: 'DeepSeek V4.1 Flash · Free' },
  { value: 'opencode/mimo-v2.6-flash-free', label: 'MiMo V2.6 Flash · Free' },
  { value: 'opencode/longcat-2.5-free', label: 'LongCat 2.5 · Free' },
  { value: 'opencode/inkling-2-small-free', label: 'Inkling 2 Small · Free' },
  { value: 'opencode/flint-40b-free', label: 'Flint 40B · Free' },
  { value: 'opencode/beam-free', label: 'Beam · Free' },
  { value: 'opencode/iceman-free', label: 'Iceman · Free' },
  { value: 'opencode/nemotron-3.5-lightning-free', label: 'Nemotron 3.5 Lightning · Free' },
  { value: 'opencode/nemotron-3.5-super-vl-free', label: 'Nemotron 3.5 Super VL · Free' },
  { value: 'opencode/tidepool-alpha-free', label: 'Tidepool Alpha · Free' },
  { value: 'opencode/big-pickle', label: 'Big Pickle · Free' },
  { value: 'deepseek/deepseek-flash', label: 'DeepSeek Flash' },
  { value: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
];

export function opencodeModelCatalog(): ModelOption[] {
  const activeModel = readOpenchamberSettings().lastSelectedModel;
  if (!activeModel || activeModel === 'opencode/hy4-flash-free') {
    return OPENCODE_FREE_MODELS.map((m) => ({ ...m }));
  }
  const defaultLabel = `跟随默认（当前 ${activeModel.replace(/^opencode\//, '')}）`;
  return OPENCODE_FREE_MODELS.map((m) =>
    m.value === OPENCODE_DEFAULT_MODEL ? { ...m, label: defaultLabel } : { ...m },
  );
}
