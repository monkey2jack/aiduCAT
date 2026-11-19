import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  displayModelName,
  dshModelCatalog,
  isDefaultModel,
  modelLabel,
  normalizeModelSelection,
  readDshProfileModels,
  resetDshProfileModelsCache,
  resolveModelArg,
  supportedModels,
} from '../../../src/agent/models.js';

describe('agent model catalog', () => {
  it('offers a distinct catalog per agent kind, each led by the default sentinel', () => {
    const claude = supportedModels('claude');
    const codex = supportedModels('codex');
    expect(claude[0]?.value).toBe(DEFAULT_MODEL);
    expect(codex[0]?.value).toBe(DEFAULT_MODEL);
    expect(claude.map((m) => m.value)).toContain('claude-opus-4-8');
    expect(codex.map((m) => m.value)).toContain('gpt-5-codex');
    expect(claude.map((m) => m.value)).not.toContain('gpt-5-codex');
  });

  it('treats unset and the default sentinel as "use agent default"', () => {
    expect(isDefaultModel(undefined)).toBe(true);
    expect(isDefaultModel('')).toBe(true);
    expect(isDefaultModel(DEFAULT_MODEL)).toBe(true);
    expect(isDefaultModel('claude-opus-4-8')).toBe(false);
  });

  it('coerces unknown / cross-agent selections back to the default option', () => {
    expect(normalizeModelSelection('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(normalizeModelSelection('claude', undefined)).toBe(DEFAULT_MODEL);
    // aiduCAT: free-form gateway combo ids pass through — behind 10router
    // the useful model names sit outside the hardcoded picker catalog.
    expect(normalizeModelSelection('claude', 'Gemini-3.8-Flash')).toBe('Gemini-3.8-Flash');
    // Gateway ids with a vendor prefix or version tag pass through too.
    expect(normalizeModelSelection('claude', 'cu/claude-opus-5-5')).toBe('cu/claude-opus-5-5');
    expect(normalizeModelSelection('claude', 'model@2026-10')).toBe('model@2026-10');
    // Anything outside the charset still falls back.
    expect(normalizeModelSelection('claude', 'gpt-6-astra(xhigh)')).toBe(DEFAULT_MODEL);
  });

  it('resolves the --model argument, omitting it for the default', () => {
    expect(resolveModelArg('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveModelArg('claude', DEFAULT_MODEL)).toBeUndefined();
    expect(resolveModelArg('claude', undefined)).toBeUndefined();
    // aiduCAT: free-form combo ids are forwarded verbatim.
    expect(resolveModelArg('claude', 'Gemini-3.8-Flash')).toBe('Gemini-3.8-Flash');
  });

  it('labels a stored value using the picker option text', () => {
    expect(modelLabel('claude', 'claude-opus-4-8')).toBe('Opus 4.8（最新）');
    expect(modelLabel('claude', DEFAULT_MODEL)).toContain('跟随默认');
  });
});

describe('card model name', () => {
  const originalHome = process.env.DSH_HOME;

  afterEach(() => {
    resetDshProfileModelsCache();
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
  });

  it('reports the model the profile declares, not a hard-coded label', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-label-'));
    try {
      const profileDir = join(dir, 'profiles', 'headless');
      await mkdir(profileDir, { recursive: true });
      await writeFile(
        join(profileDir, 'cordis.patch.yml'),
        [
          '- id: agent-default-model',
          '  name: "@deepseek-ai/dsh-agent-default-model"',
          '  config:',
          '    provider: aidu',
          '    model: Real-Model-From-Profile',
          '',
        ].join('\n'),
        'utf8',
      );
      process.env.DSH_HOME = dir;
      resetDshProfileModelsCache();
      // A stale configured label must lose to what the profile actually boots.
      expect(
        displayModelName('dsh', { dsh: { modelLabel: 'stale-label' } }, DEFAULT_MODEL),
      ).toBe('Real-Model-From-Profile');
      // An explicit pick rides the --patch overlay: it IS what runs next turn,
      // so it must win over the profile's default declaration.
      expect(
        displayModelName('dsh', { dsh: { modelLabel: 'stale-label' } }, 'Explicit-Pick'),
      ).toBe('Explicit-Pick');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the configured label when the profile is unreadable', () => {
    process.env.DSH_HOME = join(tmpdir(), 'dsh-home-missing-for-label');
    resetDshProfileModelsCache();
    expect(
      displayModelName('dsh', { dsh: { modelLabel: 'Fallback-Label' } }, DEFAULT_MODEL),
    ).toBe('Fallback-Label');
    expect(displayModelName('dsh', {}, DEFAULT_MODEL)).toBe('跟随 DSH profile');
  });

  it('passes every other agent kind through unchanged', () => {
    expect(displayModelName('claude', {}, 'claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(displayModelName('codex', {}, DEFAULT_MODEL)).toBe(DEFAULT_MODEL);
    // A dsh label never leaks onto another agent kind, and an absent selection
    // stays absent so the renderer omits the field entirely.
    expect(displayModelName('claude', { dsh: { modelLabel: 'x' } }, undefined)).toBeUndefined();
  });
});

describe('dsh model catalog', () => {
  const originalHome = process.env.DSH_HOME;

  afterEach(() => {
    resetDshProfileModelsCache();
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
  });

  it('reads the provider and model list from the profile patch layer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-profile-'));
    try {
      const profileDir = join(dir, 'profiles', 'headless');
      await mkdir(profileDir, { recursive: true });
      await writeFile(
        join(profileDir, 'cordis.patch.yml'),
        [
          '# aidu provider',
          '- id: agent-default-model',
          '  name: "@deepseek-ai/dsh-agent-default-model"',
          '  config:',
          '    provider: aidu',
          '    model: DeepSeek-V4.1-Flash-1017',
          '- id: llm-pi-ai',
          '  name: "@deepseek-ai/dsh-llm-pi-ai"',
          '  config:',
          '    providers:',
          '      aidu:',
          '        apiKeyEnv: AIDU_API_KEY',
          '        models:',
          '          - id: DeepSeek-V4.1-Flash-1017',
          '            contextWindow: 1048576',
          '          - id: GPT-OSS-20B',
          '            contextWindow: 128000',
          '      gpt:',
          '        apiKeyEnv: GPT_API_KEY',
          '        models:',
          '          - id: gpt-6-astra',
          '',
        ].join('\n'),
        'utf8',
      );
      process.env.DSH_HOME = dir;
      resetDshProfileModelsCache();

      expect(readDshProfileModels()).toMatchObject({
        provider: 'aidu',
        model: 'DeepSeek-V4.1-Flash-1017',
      });

      const catalog = dshModelCatalog();
      // "Follow the profile" leads and names the model it currently boots.
      expect(catalog[0]?.value).toBe(DEFAULT_MODEL);
      expect(catalog[0]?.label).toContain('DeepSeek-V4.1-Flash-1017');
      const values = catalog.map((m) => m.value);
      expect(values).toContain('DeepSeek-V4.1-Flash-1017');
      expect(values).toContain('GPT-OSS-20B');
      // Provider sections must not bleed into each other.
      expect(values).not.toContain('apiKeyEnv');
      // A second provider's models are NOT routable through the aidu overlay:
      // the --patch restates provider=aidu, so listing a gpt id would fail the
      // turn with UNKNOWN_MODEL at the gateway.
      expect(values).not.toContain('gpt-6-astra');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('auto-refreshes when the profile changes, like the combo cache does', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-refresh-'));
    const profileDir = join(dir, 'profiles', 'headless');
    const file = join(profileDir, 'cordis.patch.yml');
    const write = (models: string[]) =>
      writeFile(
        file,
        [
          '- id: agent-default-model',
          '  name: "@deepseek-ai/dsh-agent-default-model"',
          '  config:',
          '    provider: aidu',
          `    model: ${models[0]}`,
          '- id: llm-pi-ai',
          '  name: "@deepseek-ai/dsh-llm-pi-ai"',
          '  config:',
          '    providers:',
          '      aidu:',
          '        apiKeyEnv: AIDU_API_KEY',
          '        models:',
          ...models.map((m) => `          - id: ${m}`),
          '',
        ].join('\n'),
        'utf8',
      );
    try {
      await mkdir(profileDir, { recursive: true });
      await write(['Model-A', 'Model-B']);
      process.env.DSH_HOME = dir;
      resetDshProfileModelsCache();
      expect(dshModelCatalog().map((m) => m.value)).toEqual([
        DEFAULT_MODEL,
        'Model-A',
        'Model-B',
      ]);

      // The desktop GUI writes this same file. Adding a model there must show
      // up on the next read without a service restart.
      await write(['Model-A', 'Model-B', 'Model-C']);
      const future = new Date(Date.now() + 5_000);
      const { utimes } = await import('node:fs/promises');
      await utimes(file, future, future);
      expect(dshModelCatalog().map((m) => m.value)).toEqual([
        DEFAULT_MODEL,
        'Model-A',
        'Model-B',
        'Model-C',
      ]);

      // Removing one is reflected too — the cache is not append-only.
      await write(['Model-C']);
      await utimes(file, new Date(), new Date(Date.now() + 10_000));
      expect(dshModelCatalog().map((m) => m.value)).toEqual([DEFAULT_MODEL, 'Model-C']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('degrades to the follow-the-profile option when no profile is readable', () => {
    process.env.DSH_HOME = join(tmpdir(), 'dsh-home-that-does-not-exist');
    resetDshProfileModelsCache();
    const catalog = supportedModels('dsh');
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.value).toBe(DEFAULT_MODEL);
  });
});


describe('opencode model catalog and display', () => {
  it('lists OpenCode free models and default sentinel', () => {
    const catalog = supportedModels('openchamber');
    expect(catalog[0]?.value).toBe(DEFAULT_MODEL);
    const values = catalog.map((m) => m.value);
    expect(values).toContain('opencode/hy4-flash-free');
    expect(values).toContain('opencode/deepseek-v4.1-flash-free');
  });

  it('displayModelName strips provider prefix and defaults to active model name', () => {
    expect(displayModelName('openchamber', {}, 'opencode/hy4-flash-free')).toBe('hy4-flash-free');
    expect(displayModelName('openchamber', {}, DEFAULT_MODEL)).toBe('hy4-flash-free');
  });
});
