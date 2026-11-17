import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addFrameTap, frameTapOn, onTapWanted, scopeDebug, tapCounts, tapFrame, wantFrame } from './scopeTap';

const offs: (() => void)[] = [];
const track = (off: () => void) => {
  offs.push(off);
  return off;
};
const zero = () => {
  for (const k of Object.keys(scopeDebug) as (keyof typeof scopeDebug)[]) scopeDebug[k] = 0;
};

beforeEach(zero);
afterEach(() => {
  for (const off of offs.splice(0)) off();
  zero();
});

describe('the frame tap', () => {
  it('no listeners, no count', () => {
    expect(frameTapOn()).toBe(false);
    tapFrame(null, 0, 0, 'output', true);
    expect(scopeDebug.taps).toBe(0);
  });
  it('addFrameTap asks for a picture unless want is false', () => {
    const wanted = vi.fn();
    track(onTapWanted(wanted));
    track(addFrameTap(() => undefined));
    expect(wanted).toHaveBeenCalledTimes(1);
    track(addFrameTap(() => undefined, false));
    expect(wanted).toHaveBeenCalledTimes(1);
    wantFrame();
    expect(wanted).toHaveBeenCalledTimes(2);
  });
  it('removing the last listener stops the taps', () => {
    const f = vi.fn();
    const off = addFrameTap(f, false);
    const off2 = addFrameTap(() => undefined, false);
    tapFrame(null, 1, 1, 'output', false);
    expect(f).toHaveBeenCalledTimes(1);
    off();
    tapFrame(null, 1, 1, 'output', false);
    expect(f).toHaveBeenCalledTimes(1);
    expect(frameTapOn()).toBe(true);
    off2();
    expect(frameTapOn()).toBe(false);
    const before = scopeDebug.taps;
    tapFrame(null, 1, 1, 'output', false);
    expect(scopeDebug.taps).toBe(before);
  });
  it('tapCounts', () => {
    expect(tapCounts('output', 'output')).toBe(true);
    expect(tapCounts('scene', 'output')).toBe(false);
    expect(tapCounts('source', 'source')).toBe(true);
  });
  it('a null tap reaches listeners', () => {
    const f = vi.fn();
    track(addFrameTap(f, false));
    tapFrame(null, 0, 0, 'source', true);
    expect(f).toHaveBeenCalledWith(null, 0, 0, 'source', true);
    expect(scopeDebug.taps).toBe(1);
  });
});
