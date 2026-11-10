import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, Keyframe, ShapeClip, TextClip, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject, createShapeClip, createTextClip } from '../lib/factory';
import { baseValue } from '../lib/anim';
import { cleanKeyframes, useEditor } from './editorStore';

const ed = () => useEditor.getState();
const clipOf = (id: string): Clip => ed().project!.clips.find((c) => c.id === id)!;
const k = (t: number, v: number, ease: Keyframe['ease'] = 'linear'): Keyframe => ({ t, v, ease });

let seq = 0;
function mkVideo(trackId: string, over: Partial<VideoClip> = {}): VideoClip {
  return {
    id: `lv${++seq}`,
    type: 'video',
    trackId,
    start: 2,
    duration: 10,
    name: 'v',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'vid10',
    trimStart: 0,
    speed: 1,
    volume: 1,
    muted: false,
    transform: { ...DEFAULT_TRANSFORM },
    ...over,
  };
}

const ASSETS = [{ id: 'vid10', name: 'vid10', kind: 'video' as const, mime: 'video/mp4', size: 1, duration: 10, width: 1920, height: 1080, hasAudio: true, createdAt: 0 }];

function open(make: (track: string) => Clip[]): string[] {
  useEditor.setState({ clipboard: [] });
  const p = createProject('lk', undefined, 30);
  const clips = make(p.tracks[0]!.id);
  ed().openProject({ ...p, assets: [...ASSETS], clips });
  return clips.map((c) => c.id);
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

/** the key lists of a clip as a plain record, to compare before and after */
const lists = (id: string) => JSON.parse(JSON.stringify(clipOf(id).keyframes ?? {})) as Record<string, Keyframe[]>;

describe('one key list per property', () => {
  it('a key on one look property never adds, moves or removes a key of another', () => {
    const [id] = open((t) => [
      mkVideo(t, { crop: { left: 0, top: 0, right: 0, bottom: 0 }, keyframes: { 'crop.left': [k(0, 0), k(4, 0.4)], 'crop.top': [k(1, 0.1), k(3, 0.2)], radius: [k(2, 0.5)], x: [k(0, 0), k(4, 40)] } }),
    ]);
    const before = lists(id!);
    // a value typed into one property at the playhead writes ONE key in ITS list
    ed().setClipValue(id!, 'crop.left', 4, 0.3);
    const after = lists(id!);
    expect(after['crop.left']!.map((q) => q.t)).toEqual([0, 2, 4]);
    for (const p of ['crop.top', 'radius', 'x']) expect(after[p], p).toEqual(before[p]);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  });

  it('toggleKeyframe adds and removes only the key of its own property, even where other properties have keys', () => {
    const [id] = open((t) => [mkVideo(t, { keyframes: { 'crop.left': [k(0, 0), k(4, 0.4)], 'adjust.hue': [k(2, 10), k(6, 20)] } })]);
    const before = lists(id!);
    ed().toggleKeyframe(id!, 'adjust.brightness', 4); // local 2: the time of a key of hue
    let after = lists(id!);
    expect(after['adjust.brightness']!.map((q) => q.t)).toEqual([2]);
    expect(after['adjust.hue']).toEqual(before['adjust.hue']);
    expect(after['crop.left']).toEqual(before['crop.left']);
    // a key at the same time of another property is not the key of this one: toggle adds, it does not remove
    ed().toggleKeyframe(id!, 'crop.left', 4);
    after = lists(id!);
    expect(after['crop.left']!.map((q) => q.t)).toEqual([0, 2, 4]);
    expect(after['adjust.hue']).toEqual(before['adjust.hue']);
    expect(after['adjust.brightness']!.map((q) => q.t)).toEqual([2]);
    // and toggling it again removes just that one
    ed().toggleKeyframe(id!, 'crop.left', 4);
    after = lists(id!);
    expect(after['crop.left']).toEqual(before['crop.left']);
    expect(after['adjust.hue']).toEqual(before['adjust.hue']);
    expect(after['adjust.brightness']!.map((q) => q.t)).toEqual([2]);
  });

  it('setKeyframe with an easing changes the easing of its own key only', () => {
    const [id] = open((t) => [mkVideo(t, { keyframes: { 'crop.left': [k(0, 0), k(4, 0.4)], 'crop.right': [k(0, 0), k(4, 0.4)] } })]);
    ed().setKeyframe(id!, 'crop.left', 2, undefined, 'hold');
    const after = lists(id!);
    expect(after['crop.left']![0]!.ease).toBe('hold');
    expect(after['crop.right']!.map((q) => q.ease)).toEqual(['linear', 'linear']);
  });

  it('removing the last key of one property leaves the others keyed and keeps the value', () => {
    const [id] = open((t) => [mkVideo(t, { keyframes: { radius: [k(1, 0.6)], 'crop.left': [k(0, 0), k(4, 0.4)] } })]);
    ed().removeKeyframe(id!, 'radius', 3);
    const c = clipOf(id!) as VideoClip;
    expect(c.keyframes!.radius).toBeUndefined();
    expect(c.keyframes!['crop.left']).toHaveLength(2);
    expect(c.radius).toBe(0.6);
  });

  it('moveKeyframe with a property moves that property only', () => {
    const [id] = open((t) => [mkVideo(t, { keyframes: { 'crop.left': [k(1, 0), k(4, 0.4)], 'crop.top': [k(1, 0), k(4, 0.4)] } })]);
    ed().moveKeyframe(id!, 'crop.left', 3, 5);
    const after = lists(id!);
    expect(after['crop.left']!.map((q) => q.t)).toEqual([3, 4]);
    expect(after['crop.top']!.map((q) => q.t)).toEqual([1, 4]);
  });
});

describe('writing a look value', () => {
  it('a static crop value creates the crop with the other edges at 0', () => {
    const [id] = open((t) => [mkVideo(t)]);
    ed().setClipValue(id!, 'crop.right', 3, 0.3);
    expect((clipOf(id!) as VideoClip).crop).toEqual({ left: 0, top: 0, right: 0.3, bottom: 0 });
  });

  it('values are clamped to the hard range of the property', () => {
    const [id] = open((t) => [mkVideo(t)]);
    ed().setClipValue(id!, 'crop.left', 3, 5);
    expect((clipOf(id!) as VideoClip).crop!.left).toBe(0.95);
    ed().setClipValue(id!, 'adjust.hue', 3, -999);
    expect((clipOf(id!) as VideoClip).adjust!.hue).toBe(-180);
    ed().setKeyframe(id!, 'radius', 3, 7);
    expect((clipOf(id!) as VideoClip).keyframes!.radius![0]!.v).toBe(1);
  });

  it('a number of points is a whole number', () => {
    const [id] = open((t) => [createShapeClip(t, 2, { duration: 10, kind: 'polygon' })]);
    ed().setClipValue(id!, 'points', 3, 7.4);
    expect((clipOf(id!) as ShapeClip).points).toBe(7);
    ed().setKeyframe(id!, 'points', 3, 9.6);
    expect((clipOf(id!) as ShapeClip).keyframes!.points![0]!.v).toBe(10);
  });

  it('a mask value cannot be written or keyed while there is no mask', () => {
    const [id] = open((t) => [mkVideo(t)]);
    ed().setClipValue(id!, 'mask.x', 3, 0.5);
    ed().setKeyframe(id!, 'mask.x', 3, 0.5);
    ed().toggleKeyframe(id!, 'mask.x', 3);
    expect(clipOf(id!)).toEqual(ed().project!.clips[0]);
    expect((clipOf(id!) as VideoClip).mask).toBeUndefined();
    expect((clipOf(id!) as VideoClip).keyframes).toBeUndefined();
  });

  it('a text outline width can only be keyed with an outline', () => {
    const [plain, outlined] = open((t) => [createTextClip(t, 2, { duration: 4 }), createTextClip(t, 2, { duration: 4, stroke: { color: '#000', width: 0.1 } })]);
    ed().toggleKeyframe(plain!, 'stroke.width', 3);
    expect(clipOf(plain!).keyframes).toBeUndefined();
    ed().toggleKeyframe(outlined!, 'stroke.width', 3);
    expect(clipOf(outlined!).keyframes!['stroke.width']).toEqual([{ t: 1, v: 0.1, ease: 'ease' }]);
  });

  it('thickness (no stored value yet) can be written, keyed with an explicit value, and toggle alone does nothing', () => {
    const [id] = open((t) => [mkVideo(t)]);
    ed().toggleKeyframe(id!, 'shapeDepth', 3);
    expect(clipOf(id!).keyframes).toBeUndefined();
    ed().setKeyframe(id!, 'shapeDepth', 3, 250);
    expect(clipOf(id!).keyframes!.shapeDepth).toEqual([{ t: 1, v: 250, ease: 'ease' }]);
    ed().clearKeyframes(id!, 3, 'shapeDepth');
    expect((clipOf(id!) as VideoClip).shapeDepth).toBe(250);
    ed().setClipValue(id!, 'shapeDepth', 3, 120);
    expect((clipOf(id!) as VideoClip).shapeDepth).toBe(120);
  });

  it('one edit of a field is one undo step', () => {
    const [id] = open((t) => [mkVideo(t)]);
    ed().setClipValue(id!, 'adjust.contrast', 3, 0.4);
    expect(baseValue(clipOf(id!), 'adjust.contrast')).toBe(0.4);
    ed().undo();
    expect((clipOf(id!) as VideoClip).adjust).toBeUndefined();
  });
});

describe('cleanKeyframes with look properties', () => {
  const v = mkVideo('t');
  const t: TextClip = createTextClip('t', 0, {});
  it('keeps every look property of its clip and drops names the clip does not have', () => {
    const out = cleanKeyframes(v, {
      'crop.left': [k(0, 0), k(1, 0.5)],
      'adjust.hue': [k(0, 0), k(1, 90)],
      'mask.x': [k(0, 0)],
      shapeDepth: [k(0, 100)],
      fontSize: [k(0, 50)],
      points: [k(0, 5)],
      nonsense: [k(0, 1)],
      'crop.middle': [k(0, 1)],
    })!;
    expect(Object.keys(out).sort()).toEqual(['adjust.hue', 'crop.left', 'mask.x', 'shapeDepth']);
    expect(cleanKeyframes(t, { fontSize: [k(0, 50)], 'shadow.blur': [k(0, 0.2)], points: [k(0, 5)] })).toEqual({
      fontSize: [{ t: 0, v: 50, ease: 'linear' }],
      'shadow.blur': [{ t: 0, v: 0.2, ease: 'linear' }],
    });
  });

  it('clamps and rounds the values like a single write', () => {
    const out = cleanKeyframes(v, { 'crop.top': [k(0, 3)], 'adjust.brightness': [k(0, -4), k(1, 0.5)] })!;
    expect(out['crop.top']![0]!.v).toBe(0.95);
    expect(out['adjust.brightness']!.map((q) => q.v)).toEqual([-1, 0.5]);
    const s = createShapeClip('t', 0, {});
    expect(cleanKeyframes(s, { points: [k(0, 7.4), k(1, 99)] })!.points!.map((q) => q.v)).toEqual([7, 12]);
  });

  it('sorts, drops broken keys and still empties a property with no good key', () => {
    const out = cleanKeyframes(v, { radius: [k(2, 0.5), k(1, 0.1), { t: NaN, v: 1, ease: 'linear' }], 'crop.left': [{ t: 0, v: Infinity, ease: 'linear' }] })!;
    expect(out.radius!.map((q) => q.t)).toEqual([1, 2]);
    expect(out['crop.left']).toBeUndefined();
  });
});
