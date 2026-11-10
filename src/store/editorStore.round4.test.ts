import { beforeEach, describe, expect, it } from 'vitest';
import type { CameraClip, Clip, ImageClip, Project, ShapeClip, TextClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createCameraClip, createProject, createTextClip } from '../lib/factory';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <T extends Clip>(id: string): T => proj().clips.find((c) => c.id === id) as T;

function open(make: (v: string) => Clip[] = () => []): string {
  const p = createProject('r4');
  const v = p.tracks[0]!.id;
  ed().openProject({
    ...p,
    assets: [{ id: 'img', name: 'img', kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 }],
    clips: make(v),
  });
  return v;
}

function image(trackId: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip {
  return { id: 'im' + start, type: 'image', trackId, start, duration, name: 'i', fadeIn: 0, fadeOut: 0, assetId: 'img', transform: { ...DEFAULT_TRANSFORM }, ...over };
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('shape clips', () => {
  it('adds a shape with a preset and selects it', () => {
    open();
    const id = ed().addShape({ start: 1, preset: { kind: 'star', color: '#ff0000', width: 200, height: 100, name: 'star' } });
    const c = clipOf<ShapeClip>(id);
    expect(c.type).toBe('shape');
    expect(c.kind).toBe('star');
    expect(c.start).toBe(1);
    expect(c.width).toBe(200);
    expect(ed().selection).toEqual([id]);
  });

  it('a preset cannot override identity or placement', () => {
    const v = open();
    const id = ed().addShape({ trackId: v, start: 2, preset: { id: 'evil', trackId: 'nope', start: 99, type: 'text' as never } });
    const c = clipOf<ShapeClip>(id);
    expect(c.type).toBe('shape');
    expect(c.trackId).toBe(v);
    expect(c.start).toBe(2);
  });

  it('updateClip sets and removes shape and look fields', () => {
    open();
    const id = ed().addShape();
    ed().updateClip(id, { color2: '#000000', stroke: { color: '#fff', width: 4 }, blend: 'screen', radius: 0.5, crop: { left: 0.1, top: 0, right: 0, bottom: 0 } });
    let c = clipOf<ShapeClip>(id);
    expect(c.color2).toBe('#000000');
    expect(c.stroke).toEqual({ color: '#fff', width: 4 });
    expect(c.blend).toBe('screen');
    expect(c.radius).toBe(0.5);
    expect(c.crop?.left).toBe(0.1);
    ed().updateClip(id, { motionIn: { id: 'pop', duration: 0.5 } });
    c = clipOf<ShapeClip>(id);
    expect(c.motionIn).toEqual({ id: 'pop', duration: 0.5 });
  });

  it('camera target is accepted by updateClip', () => {
    const v = open((t) => [createCameraClip(t, 0)]);
    void v;
    const cam = proj().clips[0] as CameraClip;
    ed().updateClip(cam.id, { target: 'abc' });
    expect(clipOf<CameraClip>(cam.id).target).toBe('abc');
  });
});

describe('markers', () => {
  it('adds sorted markers, reuses one at the same time, and is undoable', () => {
    open();
    const b = ed().addMarker(5, 'b');
    const a = ed().addMarker(2, 'a');
    expect(proj().markers?.map((m) => m.name)).toEqual(['a', 'b']);
    expect(ed().addMarker(5.0004)).toBe(b);
    expect(proj().markers).toHaveLength(2);
    ed().undo();
    expect(proj().markers?.map((m) => m.id)).toEqual([b]);
    ed().redo();
    expect(proj().markers?.map((m) => m.id)).toEqual([a, b]);
  });

  it('updates, keeps the order, and removes', () => {
    open();
    const a = ed().addMarker(1, 'a');
    const b = ed().addMarker(2, 'b');
    ed().updateMarker(a, { time: 3, name: 'later' });
    expect(proj().markers?.map((m) => [m.id, m.time, m.name])).toEqual([
      [b, 2, 'b'],
      [a, 3, 'later'],
    ]);
    ed().updateMarker(a, { time: -4 });
    expect(proj().markers?.[0]).toMatchObject({ id: a, time: 0 });
    ed().removeMarker(b);
    expect(proj().markers?.map((m) => m.id)).toEqual([a]);
    const before = ed().past.length;
    ed().removeMarker('missing');
    ed().updateMarker('missing', { time: 1 });
    expect(ed().past.length).toBe(before);
  });
});

describe('split keeps entrances on the left half and exits on the right half', () => {
  it('visual clip: transition and motions', () => {
    open((v) => [
      image(v, 0, 4, {
        transition: { id: 'cross-fade', duration: 0.6 },
        motionIn: { id: 'pop', duration: 0.5 },
        motionOut: { id: 'fade', duration: 0.5 },
        motionLoop: { id: 'float', duration: 2 },
      }),
    ]);
    const [rightId] = ed().splitClips(2, ['im0']);
    const left = clipOf<ImageClip>('im0');
    const right = clipOf<ImageClip>(rightId!);
    expect(left.transition).toEqual({ id: 'cross-fade', duration: 0.6 });
    expect(left.motionIn).toBeDefined();
    expect(left.motionOut).toBeUndefined();
    expect(left.motionLoop).toBeDefined();
    expect(right.transition).toBeUndefined();
    expect(right.motionIn).toBeUndefined();
    expect(right.motionOut).toEqual({ id: 'fade', duration: 0.5 });
    expect(right.motionLoop).toBeDefined();
  });

  it('text clip: letter animations', () => {
    open((v) => [createTextClip(v, 0, { id: 'tx', duration: 4, animIn: { id: 'typewriter', duration: 0.6 }, animOut: { id: 'fade', duration: 0.6 } })]);
    const [rightId] = ed().splitClips(2, ['tx']);
    const left = clipOf<TextClip>('tx');
    const right = clipOf<TextClip>(rightId!);
    expect(left.animIn).toBeDefined();
    expect(left.animOut).toBeUndefined();
    expect(right.animIn).toBeUndefined();
    expect(right.animOut).toBeDefined();
  });
});
