import { beforeEach, describe, expect, it } from 'vitest';
import { evalKeys } from '../../lib/anim';
import { createProject } from '../../lib/factory';
import { hasKeyedPose } from '../../engine/parent';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { DEFAULT_TRANSFORM } from '../../types';
import type { Clip, ImageClip, Keyframe, Keyframes, MediaAsset, Project, TextClip } from '../../types';
import { flyPlan, flyPlanFull, soundOf, staggerPlan } from './cascade';
import type { FlyOpts } from './cascade';
import { flySelection } from './cascadeActions';

const tracks = [{ id: 't0' }, { id: 't1' }, { id: 't2' }, { id: 'a0' }];
const base: FlyOpts = { kind: 'rise', direction: 'in', amount: 1, duration: 0.5, seed: 3, width: 1920, height: 1080 };

const text = (id: string, duration: number, x = 0, y = 0, extra: Partial<TextClip> = {}): TextClip =>
  ({ id, trackId: 't0', start: 0, duration, name: id, fadeIn: 0, fadeOut: 0, type: 'text', transform: { x, y, scale: 1, rotation: 0, opacity: 1 }, ...extra }) as unknown as TextClip;
const k = (t: number, v: number, ease: Keyframe['ease'] = 'linear'): Keyframe => ({ t, v, ease });
const apply = <T extends Clip>(clip: T, keys: Keyframes): T => {
  const merged: Keyframes = { ...(clip.keyframes ?? {}), ...keys };
  for (const p of Object.keys(merged)) if (merged[p]!.length === 0) delete merged[p];
  return { ...clip, keyframes: merged };
};
const fly = <T extends Clip>(clip: T, over: Partial<FlyOpts>): T => apply(clip, flyPlan(clip, 0, 1, { ...base, ...over }));
const times = (c: Clip, prop: string) => c.keyframes![prop]!.map((q) => q.t);

describe('round 19: a hand made animation is not an earlier fly', () => {
  it('a 5 s slide on x keeps its end when a fly in writes x', () => {
    const clip = text('a', 6, 0, 0, { keyframes: { x: [k(0, -200, 'ease-out'), k(5, 0)] } });
    const out = flyPlan(clip, 0, 1, { ...base, kind: 'left' });
    expect(out.x!.map((q) => q.t)).toEqual([0, 0.5, 5]);
    expect(out.x![2]!.v).toBe(0);
    // the fly ends on the user's curve
    expect(out.x![1]!.v).toBeCloseTo(evalKeys(clip.keyframes!.x!, 0.5), 6);
  });
  it('same on the out side', () => {
    const clip = text('a', 6, 0, 0, { keyframes: { x: [k(0, 100), k(1, 0, 'ease-in'), k(6, -200)] } });
    const out = flyPlan(clip, 0, 1, { ...base, kind: 'left', direction: 'out' });
    expect(out.x!.map((q) => q.t)).toEqual([0, 1, 5.5, 6]);
  });
  it('a user track on a property the fly never touches is left alone', () => {
    const clip = text('a', 6, 0, 0, { keyframes: { x: [k(0, 0, 'ease-out'), k(2, 50), k(4, 80)] } });
    const out = flyPlan(clip, 0, 1, base);
    expect(out.x).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(['opacity', 'y']);
    const outFly = flyPlan(text('b', 6, 0, 0, { keyframes: { x: [k(0, 0), k(4, 50, 'ease-in'), k(6, 80)] } }), 0, 1, { ...base, direction: 'out' });
    expect(outFly.x).toBeUndefined();
  });
  it('a fly with a different span on a property is not stripped either', () => {
    // a real scatter, then the user stretches only x: x does not belong to the fly any more
    let clip = text('a', 4, 120);
    clip = fly(clip, { kind: 'scatter' });
    clip = { ...clip, keyframes: { ...clip.keyframes!, x: [k(0, -500, 'ease-out'), k(3, 120)] } };
    const out = flyPlan(clip, 0, 1, { ...base, kind: 'zoom' });
    expect(out.x).toBeUndefined();
    expect(out.y!.map((q) => q.t)).toEqual([0.5]);
  });
  it('a real earlier fly is still replaced', () => {
    let clip = text('a', 4, 120);
    clip = fly(clip, { kind: 'left' });
    clip = fly(clip, { kind: 'left', duration: 0.3, seed: 9 });
    expect(times(clip, 'x')).toEqual([0, 0.3]);
    expect(times(clip, 'opacity')).toEqual([0, 0.3]);
  });
});

describe('round 19: fly in and fly out on a short clip', () => {
  const fade = (c: Clip, t: number) => evalKeys(c.keyframes!.opacity!, t);
  const ypos = (c: Clip, t: number) => evalKeys(c.keyframes!.y!, t);

  it('in then out on a clip shorter than the fly: 0 -> 1 -> 0, far -> rest -> far', () => {
    let clip = text('a', 0.4, 0, 10);
    clip = fly(clip, { duration: 0.5 });
    clip = fly(clip, { duration: 0.5, direction: 'out' });
    expect(fade(clip, 0)).toBe(0);
    expect(fade(clip, 0.2)).toBeCloseTo(1, 6);
    expect(fade(clip, 0.4)).toBe(0);
    expect(ypos(clip, 0)).toBeGreaterThan(10);
    expect(ypos(clip, 0.2)).toBeCloseTo(10, 6);
    expect(ypos(clip, 0.4)).toBeGreaterThan(10);
    expect(times(clip, 'opacity')).toEqual([0, 0.2, 0.4]);
  });
  it('out then in on a clip shorter than the fly', () => {
    let clip = text('a', 0.4, 0, 10);
    clip = fly(clip, { duration: 0.5, direction: 'out' });
    clip = fly(clip, { duration: 0.5 });
    expect(fade(clip, 0)).toBe(0);
    expect(fade(clip, 0.2)).toBeCloseTo(1, 6);
    expect(fade(clip, 0.4)).toBe(0);
    expect(ypos(clip, 0)).toBeGreaterThan(10);
    expect(ypos(clip, 0.2)).toBeCloseTo(10, 6);
    expect(ypos(clip, 0.4)).toBeGreaterThan(10);
  });
  it('partly overlapping spans share the clip: the clip rests exactly in the middle', () => {
    let clip = text('a', 1, 0, 10);
    clip = fly(clip, { duration: 0.8 });
    clip = fly(clip, { duration: 0.5, direction: 'out' });
    expect(times(clip, 'opacity')).toEqual([0, 0.5, 1]);
    expect(fade(clip, 0.5)).toBeCloseTo(1, 6);
    expect(ypos(clip, 0.5)).toBeCloseTo(10, 6);
    expect(ypos(clip, 0)).toBeGreaterThan(10);
    expect(ypos(clip, 1)).toBeGreaterThan(10);
  });
  it('partly overlapping, the other way round', () => {
    let clip = text('a', 1, 0, 10);
    clip = fly(clip, { duration: 0.8, direction: 'out' });
    clip = fly(clip, { duration: 0.5 });
    expect(times(clip, 'opacity')).toEqual([0, 0.5, 1]);
    expect(fade(clip, 0.5)).toBeCloseTo(1, 6);
    expect(ypos(clip, 0.5)).toBeCloseTo(10, 6);
    expect(fade(clip, 0)).toBe(0);
    expect(fade(clip, 1)).toBe(0);
  });
  it('a longer new fly is cut to half the clip', () => {
    let clip = text('a', 1, 0, 10);
    clip = fly(clip, { duration: 0.4 });
    clip = fly(clip, { duration: 0.9, direction: 'out' });
    expect(times(clip, 'opacity')).toEqual([0, 0.5, 1]);
  });
  it('flies that just touch stay as they are and rest is the other fly\'s rest pose', () => {
    let clip = text('a', 1, 0, 10);
    clip = fly(clip, { duration: 0.5 });
    clip = fly(clip, { duration: 0.5, direction: 'out' });
    expect(times(clip, 'opacity')).toEqual([0, 0.5, 1]);
    expect(fade(clip, 0.5)).toBeCloseTo(1, 6);
    expect(ypos(clip, 0.5)).toBeCloseTo(10, 6);
  });
  it('separate flies on a long clip are untouched by each other', () => {
    let clip = text('a', 4, 0, 10);
    clip = fly(clip, { duration: 0.5 });
    clip = fly(clip, { duration: 0.5, direction: 'out' });
    expect(times(clip, 'opacity')).toEqual([0, 0.5, 3.5, 4]);
    expect(fade(clip, 2)).toBe(1);
  });
});

describe('round 19: replacing a fly of another kind leaves no lone key', () => {
  it('scatter then zoom reports x, y and rotation as unkeyed with their rest value', () => {
    let clip = text('a', 4, 120, 30);
    clip = fly(clip, { kind: 'scatter' });
    const res = flyPlanFull(clip, 0, 1, { ...base, kind: 'zoom' });
    const un = Object.fromEntries(res.unkeyed.map((u) => [u.prop, u.value]));
    expect(Object.keys(un).sort()).toEqual(['rotation', 'x', 'y']);
    expect(un.x).toBeCloseTo(120, 6);
    expect(un.y).toBeCloseTo(30, 6);
    expect(un.rotation).toBeCloseTo(0, 6);
    expect(res.keys.scale).toBeDefined();
    // flyPlan itself keeps its shape
    expect(flyPlan(clip, 0, 1, { ...base, kind: 'zoom' })).toEqual(res.keys);
  });
  it('a property that still has 2 keys is not reported', () => {
    const clip = text('a', 4, 0, 0, { keyframes: { y: [k(0, 9), k(2, 5), k(4, 7)] } });
    expect(flyPlanFull(clip, 0, 1, base).unkeyed).toEqual([]);
  });
});

/* ---------- store level ---------- */

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <T extends Clip>(id: string): T => proj().clips.find((c) => c.id === id) as T;
const asset = (id: string): MediaAsset => ({ id, name: id, kind: 'image', mime: 'image/x', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 });
const image = (trackId: string, id: string, duration: number, x: number, y: number): ImageClip => ({
  id, type: 'image', trackId, start: 0, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM, x, y },
});
function open(clips: (t: string) => Clip[]): void {
  ed().openProject({ ...createProject('r19'), assets: [asset('img1')], clips: [] });
  ed().addTrack('video');
  const t = proj().tracks[0]!.id;
  useEditor.setState({ project: { ...proj(), clips: clips(t) }, past: [], future: [], selection: clips(t).map((c) => c.id) });
}

describe('round 19: flySelection with a replaced fly', () => {
  beforeEach(() => {
    useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
    useUi.setState({ toasts: [] });
  });

  it('scatter then zoom: x, y, rotation rest on their static value, in one undo step', () => {
    open((t) => [image(t, 'c1', 4, 120, 30)]);
    flySelection('scatter', 'in', 1, 1, 5);
    expect(clipOf('c1').keyframes!.x).toBeDefined();
    useEditor.setState({ past: [], future: [] });
    const before = proj();
    flySelection('zoom', 'in', 1, 1, 5);
    const c = clipOf<ImageClip>('c1');
    expect(c.keyframes!.x).toBeUndefined();
    expect(c.keyframes!.y).toBeUndefined();
    expect(c.keyframes!.rotation).toBeUndefined();
    expect(c.keyframes!.scale).toHaveLength(2);
    expect(c.transform.x).toBeCloseTo(120, 6);
    expect(c.transform.y).toBeCloseTo(30, 6);
    expect(c.transform.rotation).toBeCloseTo(0, 6);
    expect(hasKeyedPose(c)).toBe(true); // scale is still keyed
    expect(ed().past.length).toBe(1);
    ed().undo();
    expect(proj()).toEqual(before);
    ed().redo();
    expect(clipOf<ImageClip>('c1').transform.x).toBeCloseTo(120, 6);
  });

  it('out side: the rest value is the one at the start of the fly out, not the far end', () => {
    open((t) => [image(t, 'c1', 4, 50, -20)]);
    flySelection('scatter', 'out', 1, 1, 5);
    flySelection('zoom', 'out', 1, 1, 5);
    const c = clipOf<ImageClip>('c1');
    expect(c.keyframes!.x).toBeUndefined();
    expect(c.transform.x).toBeCloseTo(50, 6);
    expect(c.transform.y).toBeCloseTo(-20, 6);
  });
});

/* ---------- sound ---------- */

const m = (id: string, type: 'video' | 'audio', trackId: string, start: number, duration: number, group: string, assetId = 'a', trimStart = 0, speed = 1): Clip =>
  ({ id, type, trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId, trimStart, speed, volume: 1, group, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 } }) as unknown as Clip;

describe('round 19: soundOf', () => {
  it('a video with a trimmed tail still has its sound', () => {
    const clips = [m('v', 'video', 't0', 0, 4, 'g'), m('s', 'audio', 'a0', 0, 5, 'g')];
    expect(soundOf(clips).get('s')!.id).toBe('v');
  });
  it('another start is no sound of it', () => {
    const clips = [m('v', 'video', 't0', 0, 4, 'g'), m('s', 'audio', 'a0', 1, 3, 'g')];
    expect(soundOf(clips).size).toBe(0);
  });
  it('trim mode: the trimmed video and its longer sound are cut together', () => {
    const clips = [
      m('v1', 'video', 't1', 0, 4, 'g1'),
      m('s1', 'audio', 'a0', 0, 5, 'g1'),
      m('v2', 'video', 't0', 0, 4, 'g2'),
      m('s2', 'audio', 'a0', 0, 5, 'g2'),
    ];
    const plan = staggerPlan(clips, 'layer', 30, 30, { mode: 'trim', tracks });
    expect(plan.places.map((p) => p.id).sort()).toEqual(['s2', 'v2']);
    const v = plan.places.find((p) => p.id === 'v2')!;
    const s = plan.places.find((p) => p.id === 's2')!;
    expect(v.start).toBeCloseTo(1, 6);
    expect(s.start).toBeCloseTo(1, 6);
    expect(v.duration).toBeCloseTo(3, 6);
    expect(s.duration).toBeCloseTo(4, 6);
    expect(s.trimStart).toBeCloseTo(1, 6);
    expect(plan.left).toEqual([]);
  });
  it('trim mode: a sound that would get too short keeps the whole pair where it is', () => {
    const clips = [
      m('v1', 'video', 't1', 0, 4, 'g1'),
      m('s1', 'audio', 'a0', 0, 4, 'g1'),
      m('v2', 'video', 't0', 0, 4, 'g2'),
      m('s2', 'audio', 'a0', 0, 1, 'g2'),
    ];
    const plan = staggerPlan(clips, 'layer', 60, 30, { mode: 'trim', tracks });
    expect(plan.places).toEqual([]);
    expect(plan.left.map((l) => l.id).sort()).toEqual(['s2', 'v2']);
  });
});

describe('round 19: the right picture for each sound', () => {
  it('prefers the picture with the same asset', () => {
    const clips = [m('a', 'video', 't0', 0, 4, 'g', 'x'), m('b', 'video', 't1', 0, 4, 'g', 'y'), m('s1', 'audio', 'a0', 0, 4, 'g', 'y'), m('s2', 'audio', 'a0', 0, 4, 'g', 'x')];
    const lead = soundOf(clips);
    expect(lead.get('s1')!.id).toBe('b');
    expect(lead.get('s2')!.id).toBe('a');
  });
  it('same asset: the same trim and speed decides', () => {
    const clips = [m('a', 'video', 't0', 0, 4, 'g', 'x', 0), m('b', 'video', 't1', 0, 4, 'g', 'x', 3), m('s', 'audio', 'a0', 0, 4, 'g', 'x', 3)];
    expect(soundOf(clips).get('s')!.id).toBe('b');
    const fast = [m('a', 'video', 't0', 0, 4, 'g', 'x', 0, 1), m('b', 'video', 't1', 0, 4, 'g', 'x', 0, 2), m('s', 'audio', 'a0', 0, 4, 'g', 'x', 0, 2)];
    expect(soundOf(fast).get('s')!.id).toBe('b');
  });
  it('identical pictures: two sounds do not pile up on the first', () => {
    const clips = [m('a', 'video', 't0', 0, 4, 'g'), m('b', 'video', 't1', 0, 4, 'g'), m('s1', 'audio', 'a0', 0, 4, 'g'), m('s2', 'audio', 'a0', 0, 4, 'g')];
    const lead = soundOf(clips);
    expect(lead.get('s1')!.id).toBe('a');
    expect(lead.get('s2')!.id).toBe('b');
  });
  it('no picture of their asset: two different assets still get different pictures', () => {
    const clips = [m('a', 'video', 't0', 0, 4, 'g', 'x'), m('b', 'video', 't1', 0, 4, 'g', 'y'), m('s1', 'audio', 'a0', 0, 4, 'g', 'p'), m('s2', 'audio', 'a0', 0, 4, 'g', 'q')];
    const lead = soundOf(clips);
    expect(lead.get('s1')!.id).toBe('a');
    expect(lead.get('s2')!.id).toBe('b');
  });
  it('falls back to the first picture when only one fits', () => {
    const clips = [m('a', 'video', 't0', 0, 4, 'g', 'x'), m('s1', 'audio', 'a0', 0, 4, 'g', 'p'), m('s2', 'audio', 'a0', 0, 4, 'g', 'q')];
    const lead = soundOf(clips);
    expect(lead.get('s1')!.id).toBe('a');
    expect(lead.get('s2')!.id).toBe('a');
  });
});
