import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import { initialState, reduce } from '../../../src/card/run-state.js';
import { logoImgKeyForModel } from '../../../src/card/model-logo.js';

// f0.4+ fix (Wei 2026-11-02 19:33): the model logo sits at the LEFT of the
// panel header, right before the model id, and does not flip on expand.
// Feishu's icon_position defaults to `right`, so it must be explicit.

type Header = { icon: { tag: string; img_key?: string }; icon_position?: string; icon_expanded_angle?: number };

function header(model: string): Header {
  const s = reduce(initialState, { type: 'thinking', delta: '想一想' });
  const card = renderCard(s, { model, startedAt: Date.now() }) as {
    body: { elements: Array<{ tag: string; header?: Header }> };
  };
  const panel = card.body.elements.find((e) => e.tag === 'collapsible_panel');
  expect(panel).toBeDefined();
  return panel!.header!;
}

describe('panel header icon placement', () => {
  it('model with a logo → custom_icon on the left, no rotation', () => {
    const key = logoImgKeyForModel('aiduPARK');
    expect(key).toBeTruthy();
    const h = header('aiduPARK');
    expect(h.icon).toMatchObject({ tag: 'custom_icon', img_key: key });
    expect(h.icon_position).toBe('left');
    expect(h.icon_expanded_angle).toBe(0);
  });

  it('model without a logo → chevron stays on the right and flips -180', () => {
    const model = 'zz-unknown-model-xyz';
    expect(logoImgKeyForModel(model)).toBeUndefined();
    const h = header(model);
    expect(h.icon.tag).toBe('standard_icon');
    expect(h.icon_position).toBe('right');
    expect(h.icon_expanded_angle).toBe(-180);
  });
});
