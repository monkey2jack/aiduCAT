import { describe, expect, it } from 'vitest';
import { modelCard, modelSavedCard } from '../../../src/card/model-card.js';

// f031-fix-#2 (零死角, audit-quality #15 UI half): behind 10router a non-Claude
// model (Gemini/GPT/GLM…) is translated by the gateway and gets no --effort —
// the /model card says so instead of pretending it is native.
describe('f031-fix-#2 /model marks non-Claude models as 经网关翻译', () => {
  const combos = [
    { id: '1', name: 'Claude-Opus-4.6' },
    { id: '2', name: 'Gemini-3.8-Flash' },
  ];

  it('f031-fix-#2 dropdown labels non-Claude models only (claude profile)', () => {
    const card = modelCard({ combos, agentKind: 'claude', source: 'live' });
    const json = JSON.stringify(card);
    expect(json).toContain('Gemini-3.8-Flash · 经网关翻译');
    expect(json).not.toContain('Claude-Opus-4.6 · 经网关翻译');
    // value stays the raw model id
    expect(json).toContain('"value":"Gemini-3.8-Flash"');
  });

  it('f031-fix-#2 current-selection line says the current non-Claude model is translated and effort does not apply', () => {
    const json = JSON.stringify(modelCard({ combos, agentKind: 'claude', currentModel: 'Gemini-3.8-Flash', currentEffort: 'max' }));
    expect(json).toMatch(/当前: `Gemini-3\.8-Flash`（经网关翻译，effort 不生效）/);
    const native = JSON.stringify(modelCard({ combos, agentKind: 'claude', currentModel: 'Claude-Opus-4.6' }));
    expect(native).not.toContain('经网关翻译，effort');
  });

  it('f031-fix-#2 codex profile is untouched (its models are native there)', () => {
    const json = JSON.stringify(modelCard({ combos: [{ id: '1', name: 'gpt-5.5' }], agentKind: 'codex', currentModel: 'gpt-5.5' }));
    expect(json).not.toContain('经网关翻译');
  });

  it('f031-fix-#2 saved card notes the translation for a non-Claude model', () => {
    expect(JSON.stringify(modelSavedCard('Gemini-3.8-Flash', 'max', 'default', '10router', 'claude'))).toContain('经网关翻译');
    expect(JSON.stringify(modelSavedCard('Claude-Opus-4.6', 'max', 'default', '10router', 'claude'))).not.toContain('经网关翻译');
    expect(JSON.stringify(modelSavedCard('跟随默认', '默认', 'default', '10router', 'claude'))).not.toContain('经网关翻译');
  });
});
