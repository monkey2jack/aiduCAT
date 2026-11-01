import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { logoImgKeyForModel, vendorLogoForModel } from '../../../src/card/model-logo.js';

describe('model → vendor logo mapping (f0.2)', () => {
  it('maps the models 猴哥 actually runs', () => {
    expect(vendorLogoForModel('Gemini-3.8-Flash')).toBe('gemini');
    expect(vendorLogoForModel('claude-opus-4-8')).toBe('claude');
    expect(vendorLogoForModel('claude-sonnet-5')).toBe('claude');
    expect(vendorLogoForModel('gpt-5-codex')).toBe('openai');
    expect(vendorLogoForModel('GLM-5.3-Flash')).toBe('zhipu');
    expect(vendorLogoForModel('kimi-k3')).toBe('kimi');
    expect(vendorLogoForModel('deepseek-v4')).toBe('deepseek');
    expect(vendorLogoForModel('qwen3-max')).toBe('qwen');
    expect(vendorLogoForModel('grok-5')).toBe('grok');
    expect(vendorLogoForModel('doubao-seed-2')).toBe('doubao');
  });

  it('falls back per family for upstream default aliases', () => {
    expect(vendorLogoForModel('opusplan')).toBe('claude');
    expect(vendorLogoForModel('o3')).toBe('openai');
    expect(vendorLogoForModel('gemma-3')).toBe('gemma');
    expect(vendorLogoForModel('moonshot-v2')).toBe('kimi');
  });

  it('returns undefined for unknown models (chevron fallback)', () => {
    expect(vendorLogoForModel('some-custom-combo')).toBeUndefined();
    expect(vendorLogoForModel(undefined)).toBeUndefined();
    expect(vendorLogoForModel('')).toBeUndefined();
  });

  it('aiduPARK combo gets the dedicated wing logo (moved from the old monkey combo, 2026-11-02)', () => {
    // 10router /api/combos lists it as `aiduPARK`; match is case-insensitive
    // and tolerates provider prefixes / suffixes.
    for (const id of ['aiduPARK', 'aidupark', 'AIDUPARK', '10router/aiduPARK', 'aiduPARK[1m]', 'aiduPARK-v2']) {
      expect(vendorLogoForModel(id), id).toBe('aidupark');
    }
    // dedicated logo wins over vendor words that may appear in a combo name
    expect(vendorLogoForModel('aiduPARK-gemini')).toBe('aidupark');
    expect(vendorLogoForModel('aiduPARK-claude-opus')).toBe('aidupark');
    expect(vendorLogoForModel('gpt-aiduPARK')).toBe('aidupark');
  });

  it('old monkey combo no longer gets the dedicated logo (falls back to normal matching)', () => {
    expect(vendorLogoForModel('monkey')).toBeUndefined();
    expect(vendorLogoForModel('Monkey')).toBeUndefined();
    expect(logoImgKeyForModel('monkey')).toBeUndefined();
    // a monkey-named combo that carries a vendor word just gets that vendor
    expect(vendorLogoForModel('monkey-gemini')).toBe('gemini');
  });

  it('aiduPARK resolves to the same img_key the monkey combo used (no re-upload)', () => {
    const keys = JSON.parse(readFileSync(join(process.cwd(), 'assets', 'lark-logo-keys.json'), 'utf8')) as Record<string, string>;
    expect(keys.monkey).toBeUndefined();
    expect(keys.aidupark).toBe('img_v3_0216t_366c2964-2f84-4c45-9fa3-7ee8ea088bdg');
    expect(logoImgKeyForModel('aiduPARK')).toBe(keys.aidupark);
  });

  it('every non-aiduPARK combo on 10router keeps its usual vendor logo', () => {
    // combo ids as listed by 10router /api/combos on 2026-11-02
    expect(vendorLogoForModel('Claude-Opus-4.6')).toBe('claude');
    expect(vendorLogoForModel('Claude-Sonnet-4.6')).toBe('claude');
    expect(vendorLogoForModel('Gemini-3.8-Flash')).toBe('gemini');
    expect(vendorLogoForModel('DeepSeek-V4.1-Flash')).toBe('deepseek');
    expect(vendorLogoForModel('DeepSeek-V4-Pro')).toBe('deepseek');
    expect(vendorLogoForModel('GLM-5.3')).toBe('zhipu');
    expect(vendorLogoForModel('GLM-5.3-FlashX')).toBe('zhipu');
    expect(vendorLogoForModel('Qwen3.8-Flash')).toBe('qwen');
    expect(vendorLogoForModel('Qwen3.8-Max')).toBe('qwen');
    expect(vendorLogoForModel('GPT-OSS-20B')).toBe('openai');
  });
});
