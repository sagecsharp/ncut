import { describe, expect, it } from 'vitest';
import { TIP_DELAY, TOOL_SELECTOR, placeTip, readTip, tipDelay, tipKind, tipLines } from './tips';

const view = { width: 1000, height: 700 };
const size = { width: 100, height: 40 };

describe('tips', () => {
  it('placeTip puts the tip below the anchor, centered, 6 px away', () => {
    const p = placeTip({ left: 200, top: 100, width: 60, height: 20 }, size, view);
    expect(p).toEqual({ left: 180, top: 126, side: 'bottom' });
  });

  it('placeTip flips above at the bottom edge and stays below when neither side fits', () => {
    const low = placeTip({ left: 200, top: 660, width: 60, height: 20 }, size, view);
    expect(low.side).toBe('top');
    expect(low.top).toBe(660 - 6 - 40);
    const tiny = placeTip({ left: 200, top: 10, width: 60, height: 20 }, { width: 100, height: 60 }, { width: 1000, height: 80 });
    expect(tiny.side).toBe('bottom');
    expect(tiny.top).toBe(80 - 8 - 60);
  });

  it('placeTip clamps x 8 px from both window edges', () => {
    expect(placeTip({ left: 0, top: 100, width: 20, height: 20 }, size, view).left).toBe(8);
    expect(placeTip({ left: 990, top: 100, width: 20, height: 20 }, size, view).left).toBe(1000 - 8 - 100);
  });

  it('placeTip left flips to the right at the left edge', () => {
    const near = placeTip({ left: 20, top: 300, width: 30, height: 30 }, size, view, 'left');
    expect(near.side).toBe('right');
    expect(near.left).toBe(20 + 30 + 6);
    const far = placeTip({ left: 500, top: 300, width: 30, height: 30 }, size, view, 'left');
    expect(far).toEqual({ left: 500 - 6 - 100, top: 300 + 15 - 20, side: 'left' });
  });

  it('tipLines: name only, name and does, does that repeats the name is dropped', () => {
    expect(tipLines({ name: 'undo' })).toEqual({ head: 'undo', keys: [], does: null, warn: null });
    expect(tipLines({ name: 'undo', does: 'take back the last change' }).does).toBe('take back the last change');
    expect(tipLines({ name: 'undo', does: ' undo ' }).does).toBeNull();
  });

  it('tipLines: on adds ": on" or ": off", off wins over why, why shows without off', () => {
    expect(tipLines({ name: 'snap', on: true }).head).toBe('snap: on');
    expect(tipLines({ name: 'snap', on: false }).head).toBe('snap: off');
    expect(tipLines({ name: 'undo', off: 'make a change first' }, 'nothing to undo').warn).toBe('make a change first');
    expect(tipLines({ name: 'undo' }, 'nothing to undo').warn).toBe('nothing to undo');
  });

  it('tipDelay: tool 450, field 900, warm 60 inside the window, keyboard 0', () => {
    expect(tipDelay('tool', 0, 1000, false)).toBe(450);
    expect(tipDelay('field', 0, 1000, false)).toBe(900);
    expect(tipDelay('tool', 1400, 1000, false)).toBe(TIP_DELAY.warm);
    expect(tipDelay('field', 1400, 1000, false)).toBe(900);
    expect(tipDelay('tool', 1400, 1000, true)).toBe(0);
    expect(tipDelay('field', 0, 1000, true)).toBe(0);
  });

  it('tipKind: buttons, selects, tabs and menu items are tools, section heads and divs are fields', () => {
    // no dom here: a fake element answers matches() for the selector parts it stands for
    const parts = TOOL_SELECTOR.split(', ');
    expect(parts).toContain('button:not(.props-section-head)');
    expect(parts).toContain('select');
    expect(parts).toContain('[role="tab"]');
    expect(parts).toContain('[role^="menuitem"]');
    const el = (tool: boolean) => ({ matches: ((sel: string) => tool && sel === TOOL_SELECTOR) as Element['matches'] });
    expect(tipKind(el(true))).toBe('tool');
    expect(tipKind(el(false))).toBe('field');
  });

  it('readTip parses keys, on and side, and ignores bad json', () => {
    const el = (attrs: Record<string, string>) => ({ getAttribute: (n: string) => attrs[n] ?? null });
    expect(readTip(el({}))).toBeNull();
    expect(readTip(el({ 'data-tip': '' }))).toBeNull();
    const r = readTip(
      el({
        'data-tip': 'split',
        'data-tip-does': 'cut it',
        'data-tip-keys': '[["s"],["ctrl","b"]]',
        'data-tip-on': 'true',
        'data-tip-side': 'left',
        'data-tip-why': 'split',
        'data-tip-off': 'select first',
      }),
    )!;
    expect(r.data).toEqual({ name: 'split', does: 'cut it', keys: [['s'], ['ctrl', 'b']], on: true, off: 'select first' });
    expect(r.side).toBe('left');
    expect(r.why).toBe('split');
    const bad = readTip(el({ 'data-tip': 'x', 'data-tip-keys': '{nope', 'data-tip-on': 'false', 'data-tip-side': 'sideways' }))!;
    expect(bad.data.keys).toBeUndefined();
    expect(bad.data.on).toBe(false);
    expect(bad.side).toBe('bottom');
    expect(readTip(el({ 'data-tip': 'x', 'data-tip-keys': '[1,2]' }))!.data.keys).toBeUndefined();
  });
});
