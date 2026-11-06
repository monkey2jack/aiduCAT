import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import { logoImgKeyForAgent } from '../../../src/card/model-logo.js';

// f0.4+ fix (Wei 2026-11-02 19:33): the logo sits at the LEFT of the panel
// header and does not flip on expand. f0.4+ (Wei 2026-11-04): the logo is
// the coding agent (Claude Code / Codex / Hermes), never the model vendor.

type Header = {
  icon: { tag: string; img_key?: string };
  icon_position?: string;
  icon_expanded_angle?: number;
  vertical_align?: string;
};

const thinking = reduce(initialState, { type: 'thinking', delta: '想一想' });

function header(state: RunState, opts: Parameters<typeof renderCard>[1]): Header {
  const card = renderCard(state, { startedAt: Date.now(), ...opts }) as {
    body: { elements: Array<{ tag: string; header?: Header }> };
  };
  const panel = card.body.elements.find((e) => e.tag === 'collapsible_panel');
  expect(panel).toBeDefined();
  return panel!.header!;
}

describe('panel header agent icon', () => {
  it.each(['claude', 'codex', 'hermes'] as const)('%s → its own custom_icon on the left, no rotation', (agent) => {
    const key = logoImgKeyForAgent(agent);
    expect(key).toBeTruthy();
    for (const s of [thinking, reduce(thinking, { type: 'done', terminationReason: 'normal' })]) {
      const h = header(s, { agentKind: agent, model: 'aiduPARK' });
      expect(h.icon).toMatchObject({ tag: 'custom_icon', img_key: key });
      expect(h.icon_position).toBe('left');
      expect(h.icon_expanded_angle).toBe(0);
    }
  });

  it('three agents have three different icons', () => {
    const keys = new Set(['claude', 'codex', 'hermes'].map((a) => logoImgKeyForAgent(a as 'claude')));
    expect(keys.size).toBe(3);
  });

  it('the model no longer picks the icon: Codex on a Claude model shows Codex', () => {
    const h = header(thinking, { agentKind: 'codex', model: 'claude-opus-4-8' });
    expect(h.icon.img_key).toBe(logoImgKeyForAgent('codex'));
  });

  it('header is always one line → icon centered (f0.4++: placeholder has no panel)', () => {
    expect(header(thinking, { agentKind: 'claude', model: 'M' }).vertical_align).toBe('center');
  });

  it('no agent given → chevron stays on the right and flips -180', () => {
    const h = header(thinking, { model: 'aiduPARK' });
    expect(h.icon.tag).toBe('standard_icon');
    expect(h.icon_position).toBe('right');
    expect(h.icon_expanded_angle).toBe(-180);
  });
});

describe('logo keys file lookup (f0.4+ fix 2026-11-04)', () => {
  it('prefers the repo assets over a stale assets/ under the working directory', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../../src/card/model-logo.ts', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('const candidates = ['), src.indexOf('];', src.indexOf('const candidates = [')));
    expect(block.indexOf("'../assets/lark-logo-keys.json'")).toBeGreaterThan(-1);
    expect(block.indexOf('process.cwd()')).toBeGreaterThan(block.indexOf("'../../assets/lark-logo-keys.json'"));
  });
});
