import { describe, expect, it } from 'vitest';
import type { EffectClip, ImageClip, Project, TextClip, Transition, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createEffectClip, createProject, createTrack } from './factory';
import { CUT_EPS, previousClipOnTrack, transitionSpan, transitionsAt } from './transitions';

let n = 0;
function vid(trackId: string, start: number, duration: number, transition?: Transition | null): VideoClip {
  return {
    id: `v${++n}`,
    type: 'video',
    trackId,
    start,
    duration,
    name: 'v',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'a',
    trimStart: 0,
    speed: 1,
    volume: 1,
    muted: false,
    transform: { ...DEFAULT_TRANSFORM },
    transition,
  };
}
function img(trackId: string, start: number, duration: number, transition?: Transition | null): ImageClip {
  return { id: `i${++n}`, type: 'image', trackId, start, duration, name: 'i', fadeIn: 0, fadeOut: 0, assetId: 'a', transform: { ...DEFAULT_TRANSFORM }, transition };
}
function txt(trackId: string, start: number, duration: number, transition?: Transition | null): TextClip {
  return {
    id: `t${++n}`,
    type: 'text',
    trackId,
    start,
    duration,
    name: 't',
    fadeIn: 0,
    fadeOut: 0,
    text: 'x',
    fontFamily: 'Kode Mono',
    fontSize: 40,
    fontWeight: 400,
    italic: false,
    color: '#fff',
    background: null,
    align: 'center',
    transform: { ...DEFAULT_TRANSFORM },
    transition,
  };
}
const tr = (duration: number, id = 'fade'): Transition => ({ id, duration });

function setup(): { p: Project; a: string; b: string } {
  const p = createProject('t');
  const second = createTrack('video', 'video 2');
  p.tracks = [second, ...p.tracks];
  return { p, a: p.tracks[1]!.id, b: second.id };
}

describe('previousClipOnTrack', () => {
  it('finds the clip that ends right where the clip starts', () => {
    const { p, a } = setup();
    const c1 = vid(a, 0, 4);
    const c2 = vid(a, 4, 3);
    p.clips = [c1, c2];
    expect(previousClipOnTrack(p, c2)).toBe(c1);
  });
  it('null for the first clip', () => {
    const { p, a } = setup();
    const c1 = vid(a, 0, 4);
    p.clips = [c1, vid(a, 4, 3)];
    expect(previousClipOnTrack(p, c1)).toBeNull();
  });
  it('null when there is a gap', () => {
    const { p, a } = setup();
    const c2 = vid(a, 5, 3);
    p.clips = [vid(a, 0, 4), c2];
    expect(previousClipOnTrack(p, c2)).toBeNull();
  });
  it('tolerates a tiny gap or overlap within CUT_EPS', () => {
    const { p, a } = setup();
    const c1 = vid(a, 0, 4);
    const c2 = vid(a, 4 + CUT_EPS / 2, 3);
    p.clips = [c1, c2];
    expect(previousClipOnTrack(p, c2)).toBe(c1);
    const c3 = vid(a, 4 - CUT_EPS / 2, 3);
    p.clips = [c1, c3];
    expect(previousClipOnTrack(p, c3)).toBe(c1);
  });
  it('rejects a gap bigger than CUT_EPS', () => {
    const { p, a } = setup();
    const c1 = vid(a, 0, 4);
    const c2 = vid(a, 4 + CUT_EPS * 5, 3);
    p.clips = [c1, c2];
    expect(previousClipOnTrack(p, c2)).toBeNull();
  });
  it('ignores clips on other tracks', () => {
    const { p, a, b } = setup();
    const other = vid(b, 0, 4);
    const c2 = vid(a, 4, 3);
    p.clips = [other, c2];
    expect(previousClipOnTrack(p, c2)).toBeNull();
  });
  it('ignores non visual clips', () => {
    const { p, a } = setup();
    const fx: EffectClip = createEffectClip('shake', 'fx', a, 0, { duration: 4 });
    const c2 = vid(a, 4, 3);
    p.clips = [fx, c2];
    expect(previousClipOnTrack(p, c2)).toBeNull();
  });
  it('works across visual types (image, text)', () => {
    const { p, a } = setup();
    const i = img(a, 0, 2);
    const t = txt(a, 2, 2);
    const v = vid(a, 4, 2);
    p.clips = [i, t, v];
    expect(previousClipOnTrack(p, t)).toBe(i);
    expect(previousClipOnTrack(p, v)).toBe(t);
  });
  it('does not return the clip itself', () => {
    const { p, a } = setup();
    const c = vid(a, 0, 0.0005);
    p.clips = [c];
    expect(previousClipOnTrack(p, c)).toBeNull();
  });
  it('does not mix up a clip that starts where another starts', () => {
    const { p, a } = setup();
    const c1 = vid(a, 0, 4);
    const c2 = vid(a, 4, 4);
    const c3 = vid(a, 8, 4);
    p.clips = [c3, c1, c2];
    expect(previousClipOnTrack(p, c3)).toBe(c2);
    expect(previousClipOnTrack(p, c2)).toBe(c1);
  });
});

describe('transitionSpan', () => {
  it('null when the clip has no transition', () => {
    const { p, a } = setup();
    const c = vid(a, 4, 3);
    p.clips = [vid(a, 0, 4), c];
    expect(transitionSpan(p, c)).toBeNull();
    const d = vid(a, 8, 3, null);
    p.clips.push(d);
    expect(transitionSpan(p, d)).toBeNull();
  });
  it('null for zero, negative or NaN durations', () => {
    const { p, a } = setup();
    for (const d of [0, -1, NaN]) {
      const c = vid(a, 4, 3, tr(d));
      p.clips = [vid(a, 0, 4), c];
      expect(transitionSpan(p, c), String(d)).toBeNull();
    }
  });
  it('null for clips that are not visual', () => {
    const { p, a } = setup();
    const fx = createEffectClip('shake', 'fx', a, 0, { duration: 3 });
    (fx as unknown as { transition: Transition }).transition = tr(1);
    p.clips = [fx];
    expect(transitionSpan(p, fx)).toBeNull();
  });
  it('with a previous clip: centered on the cut', () => {
    const { p, a } = setup();
    const c1 = vid(a, 0, 4);
    const c2 = vid(a, 4, 4, tr(1, 'wipe'));
    p.clips = [c1, c2];
    const s = transitionSpan(p, c2)!;
    expect(s.start).toBeCloseTo(3.5, 9);
    expect(s.end).toBeCloseTo(4.5, 9);
    expect(s.from).toBe(c1);
    expect(s.to).toBe(c2);
    expect(s.id).toBe('wipe');
  });
  it('is symmetric around the cut for several durations', () => {
    const { p, a } = setup();
    const c1 = vid(a, 0, 10);
    for (const d of [0.2, 0.5, 1, 3, 8]) {
      const c2 = vid(a, 10, 10, tr(d));
      p.clips = [c1, c2];
      const s = transitionSpan(p, c2)!;
      expect(10 - s.start, String(d)).toBeCloseTo(d / 2, 9);
      expect(s.end - 10, String(d)).toBeCloseTo(d / 2, 9);
      expect(s.end - s.start).toBeCloseTo(d, 9);
    }
  });
  it('never more than half of the incoming clip', () => {
    const { p, a } = setup();
    const c1 = vid(a, 0, 10);
    const c2 = vid(a, 10, 2, tr(9));
    p.clips = [c1, c2];
    const s = transitionSpan(p, c2)!;
    expect(s.start).toBeCloseTo(9, 9);
    expect(s.end).toBeCloseTo(11, 9);
  });
  it('never more than half of the outgoing clip', () => {
    const { p, a } = setup();
    const c1 = vid(a, 0, 0.6);
    const c2 = vid(a, 0.6, 10, tr(5));
    p.clips = [c1, c2];
    const s = transitionSpan(p, c2)!;
    expect(s.start).toBeCloseTo(0.3, 9);
    expect(s.end).toBeCloseTo(0.9, 9);
  });
  it('never reaches past either clip', () => {
    const { p, a } = setup();
    const c1 = vid(a, 2, 1);
    const c2 = vid(a, 3, 1.5, tr(100));
    p.clips = [c1, c2];
    const s = transitionSpan(p, c2)!;
    expect(s.start).toBeGreaterThanOrEqual(c1.start);
    expect(s.end).toBeLessThanOrEqual(c2.start + c2.duration);
  });
  it('from nothing: plays inside the clip head', () => {
    const { p, a } = setup();
    const c = vid(a, 5, 4, tr(1.5));
    p.clips = [c];
    const s = transitionSpan(p, c)!;
    expect(s.start).toBe(5);
    expect(s.end).toBeCloseTo(6.5, 9);
    expect(s.from).toBeNull();
    expect(s.to).toBe(c);
  });
  it('from nothing: capped to the clip length', () => {
    const { p, a } = setup();
    const c = vid(a, 5, 1, tr(3));
    p.clips = [c];
    const s = transitionSpan(p, c)!;
    expect(s.start).toBe(5);
    expect(s.end).toBe(6);
  });
  it('after a gap the transition comes from nothing', () => {
    const { p, a } = setup();
    const c1 = vid(a, 0, 3);
    const c2 = vid(a, 4, 4, tr(1));
    p.clips = [c1, c2];
    const s = transitionSpan(p, c2)!;
    expect(s.from).toBeNull();
    expect(s.start).toBe(4);
    expect(s.end).toBe(5);
  });
  it('works for image and text clips', () => {
    const { p, a } = setup();
    const i = img(a, 0, 3);
    const t = txt(a, 3, 3, tr(1));
    p.clips = [i, t];
    const s = transitionSpan(p, t)!;
    expect(s.from).toBe(i);
    expect(s.start).toBeCloseTo(2.5, 9);
  });
  it('a previous clip on another track does not count', () => {
    const { p, a, b } = setup();
    const c1 = vid(b, 0, 4);
    const c2 = vid(a, 4, 4, tr(1));
    p.clips = [c1, c2];
    expect(transitionSpan(p, c2)!.from).toBeNull();
  });
});

describe('transitionsAt', () => {
  it('empty when no clip has a transition', () => {
    const { p, a } = setup();
    p.clips = [vid(a, 0, 4), vid(a, 4, 4)];
    expect(transitionsAt(p, 4)).toEqual([]);
    expect(transitionsAt({ ...p, clips: [] }, 4)).toEqual([]);
  });
  it('finds the running transition across the cut', () => {
    const { p, a } = setup();
    const c1 = vid(a, 0, 4);
    const c2 = vid(a, 4, 4, tr(1));
    p.clips = [c1, c2];
    expect(transitionsAt(p, 3.4)).toEqual([]);
    expect(transitionsAt(p, 3.6)).toHaveLength(1);
    expect(transitionsAt(p, 4)).toHaveLength(1);
    expect(transitionsAt(p, 4.4)).toHaveLength(1);
    expect(transitionsAt(p, 4.6)).toEqual([]);
    expect(transitionsAt(p, 4)[0]!.to).toBe(c2);
  });
  it('start inclusive, end exclusive', () => {
    const { p, a } = setup();
    p.clips = [vid(a, 0, 4), vid(a, 4, 4, tr(1))];
    expect(transitionsAt(p, 3.5)).toHaveLength(1);
    expect(transitionsAt(p, 4.5)).toEqual([]);
  });
  it('from nothing: only inside the head', () => {
    const { p, a } = setup();
    p.clips = [vid(a, 2, 5, tr(1))];
    expect(transitionsAt(p, 1.9)).toEqual([]);
    expect(transitionsAt(p, 2)).toHaveLength(1);
    expect(transitionsAt(p, 2.9)).toHaveLength(1);
    expect(transitionsAt(p, 3)).toEqual([]);
  });
  it('lists one transition per track at the same time', () => {
    const { p, a, b } = setup();
    p.clips = [vid(a, 0, 4), vid(a, 4, 4, tr(1)), vid(b, 0, 4), vid(b, 4, 4, tr(2, 'zoom'))];
    const at = transitionsAt(p, 4);
    expect(at).toHaveLength(2);
    expect(at.map((s) => s.id).sort()).toEqual(['fade', 'zoom']);
  });
  it('skips a zero length transition', () => {
    const { p, a } = setup();
    p.clips = [vid(a, 0, 4), vid(a, 4, 4, tr(0))];
    expect(transitionsAt(p, 4)).toEqual([]);
  });
  it('ignores transitions on non visual clips', () => {
    const { p, a } = setup();
    const fx = createEffectClip('shake', 'fx', a, 0, { duration: 3 });
    (fx as unknown as { transition: Transition }).transition = tr(1);
    p.clips = [fx];
    expect(transitionsAt(p, 0.5)).toEqual([]);
  });
});
