import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, EffectClip, Keyframe, Project, TextClip, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createEffectClip, createProject, createTextClip } from '../lib/factory';
import { SPEED_MAX } from '../lib/keyBezier';
import { propLimits, useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): Clip => proj().clips.find((c) => c.id === id)!;
const keysOf = (id: string, prop: string): Keyframe[] => clipOf(id).keyframes![prop]!;

function mkVideo(id: string, trackId: string, over: Partial<VideoClip> = {}): VideoClip {
  return { id, type: 'video', trackId, start: 0, duration: 10, name: id, fadeIn: 0, fadeOut: 0, assetId: 'a', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over };
}

let v = '';
beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  const p = createProject('handles');
  v = p.tracks[0]!.id;
  ed().openProject({ ...p, clips: [mkVideo('c1', v)] });
});

const H = (speed: number, influence: number) => ({ speed, influence });

describe('handles in the store', () => {
  it('junk handles are dropped', () => {
    const junk = [
      { t: 0, v: 0, ease: 'bezier', out: H(1e12, 5) },
      { t: 1, v: 10, ease: 'ease', in: H(1, 0.5), out: H(1, 0.5) },
      { t: 2, v: 20, ease: 'bezier', in: H(1, 0.5), out: H(Number.NaN, 0.5) },
      { t: 3, v: 30, ease: 'bezier', in: H(3, 0.0001), out: H(1, 0.5) },
    ] as Keyframe[];
    ed().setClipKeyframes('c1', { x: junk });
    const k = keysOf('c1', 'x');
    // speed and influence clamped
    expect(k[0]!.out).toEqual(H(SPEED_MAX, 1));
    // in after a bezier part stays, out on a named ease goes
    expect(k[1]!.in).toEqual(H(1, 0.5));
    expect('out' in k[1]!).toBe(false);
    // not finite is missing, in after a named ease goes
    expect('out' in k[2]!).toBe(false);
    expect('in' in k[2]!).toBe(false);
    // the last key has no out. its in follows a bezier part, so it stays (clamped)
    expect(k[3]!.in).toEqual(H(3, 0.001));
    expect('out' in k[3]!).toBe(false);
    for (const key of k) expect(Object.values(key).includes(undefined)).toBe(false);
  });

  it('speeds are never clamped to the value range', () => {
    ed().setClipKeyframes('c1', {
      opacity: [
        { t: 0, v: 0, ease: 'bezier', out: H(500, 0.4) },
        { t: 1, v: 1, ease: 'ease', in: H(-500, 0.4) },
      ],
    });
    const k = keysOf('c1', 'opacity');
    expect(k[0]!.out).toEqual(H(500, 0.4));
    expect(k[1]!.in).toEqual(H(-500, 0.4));
  });

  it('an old project writes the same json', () => {
    ed().setClipKeyframes('c1', {
      x: [
        { t: 0, v: 5, ease: 'ease-in' },
        { t: 2, v: 9, ease: 'ease' },
        { t: 2.00001, v: 7 } as Keyframe,
      ],
    });
    expect(JSON.stringify(keysOf('c1', 'x'))).toBe('[{"t":0,"v":5,"ease":"ease-in"},{"t":2.00001,"v":7,"ease":"ease"}]');
    // the same keys written again are no change at all
    const p = proj();
    ed().setClipKeyframes('c1', { x: keysOf('c1', 'x') });
    expect(proj()).toBe(p);
  });

  it('sameKeyframes sees a handle change', () => {
    const keys = (speed: number): Keyframe[] => [
      { t: 0, v: 0, ease: 'bezier', out: H(speed, 0.3) },
      { t: 2, v: 4, ease: 'ease', in: H(1, 0.3) },
    ];
    ed().setClipKeyframes('c1', { x: keys(1) });
    const steps = ed().past.length;
    // the same handles: no step
    ed().setClipKeyframes('c1', { x: keys(1) });
    expect(ed().past.length).toBe(steps);
    // another out speed: one step
    ed().setClipKeyframes('c1', { x: keys(2) });
    expect(ed().past.length).toBe(steps + 1);
    expect(keysOf('c1', 'x')[0]!.out).toEqual(H(2, 0.3));
    ed().undo();
    expect(keysOf('c1', 'x')[0]!.out).toEqual(H(1, 0.3));
  });

  it('merged keys keep the earlier in', () => {
    ed().setClipKeyframes('c1', {
      x: [
        { t: 0, v: 0, ease: 'bezier', out: H(1, 0.5) },
        { t: 1, v: 4, ease: 'bezier', in: H(2, 0.5), out: H(1, 0.3) },
        { t: 1, v: 6, ease: 'bezier', in: H(9, 0.9), out: H(5, 0.4) },
        { t: 3, v: 8, ease: 'ease', in: H(1, 0.5) },
      ],
    });
    const k = keysOf('c1', 'x');
    expect(k).toHaveLength(3);
    expect(k[1]!.v).toBe(6);
    expect(k[1]!.in).toEqual(H(2, 0.5));
    expect(k[1]!.out).toEqual(H(5, 0.4));
    expect(k[1]!.ease).toBe('bezier');
  });

  it('moveKeyframe keeps the handles tidy', () => {
    ed().setClipKeyframes('c1', {
      x: [
        { t: 0, v: 0, ease: 'bezier', out: H(1, 0.5) },
        { t: 2, v: 4, ease: 'ease', in: H(1, 0.5) },
        { t: 4, v: 8, ease: 'ease' },
      ],
    });
    // the first key moves past the last: the new first key loses its in, the moved key (now last) loses its out
    ed().moveKeyframe('c1', 'x', 0, 5);
    const k = keysOf('c1', 'x');
    expect(k.map((q) => q.t)).toEqual([2, 4, 5]);
    expect(k[0]!.in).toBeUndefined();
    expect(k[2]!.out).toBeUndefined();
  });

  it('propLimits matches clampProp', () => {
    const p0 = proj();
    const fx = createEffectClip('motion-blur', 'mb', p0.tracks[0]!.id, 0) as EffectClip;
    const tx = createTextClip(p0.tracks[0]!.id, 0) as TextClip;
    const vid = clipOf('c1');
    expect(propLimits(vid, 'x')).toEqual({ min: -Infinity, max: Infinity });
    expect(propLimits(vid, 'opacity')).toEqual({ min: 0, max: 1 });
    expect(propLimits(fx, 'p.shutter')).toEqual({ min: 0, max: 1440 });
    expect(propLimits(fx, 'p.nope')).toBeNull();
    expect(propLimits(tx, 'p.shutter')).toBeNull();
    expect(propLimits(vid, 'p.shutter')).toBeNull();
    expect(propLimits(vid, 'nope')).toBeNull();
    // a crop pair: what the other edge takes is not free
    ed().updateClip('c1', { crop: { left: 0, top: 0, right: 0.5, bottom: 0 } });
    const lim = propLimits(clipOf('c1'), 'crop.left')!;
    expect(lim.min).toBe(0);
    expect(lim.max).toBeCloseTo(0.49, 10);
    // setClipValue past a limit lands on it
    ed().setClipValue('c1', 'opacity', 0, 5);
    expect((clipOf('c1') as VideoClip).transform.opacity).toBe(1);
    ed().setClipValue('c1', 'crop.left', 0, 0.9);
    expect((clipOf('c1') as VideoClip).crop?.left).toBeCloseTo(lim.max, 10);
  });
});
