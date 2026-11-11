import { describe, expect, it } from 'vitest';
import { createProject, createShapeClip, createTextClip } from '../lib/factory';
import type { Clip, ImageClip, Project, VideoClip, VisualClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { neededClipsAt, paintListAt, planeFor, visibleClipsAt } from './draw';
import type { DrawSource } from './draw';
import { DEFAULT_CAMERA, cameraRig } from './scene3d/camera';

let seq = 0;
const video = (trackId: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id: `fv${++seq}`, type: 'video', trackId, start, duration, name: 'v', fadeIn: 0, fadeOut: 0, assetId: 'vid', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const image = (trackId: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id: `fi${++seq}`, type: 'image', trackId, start, duration, name: 'i', fadeIn: 0, fadeOut: 0, assetId: 'img', transform: { ...DEFAULT_TRANSFORM }, ...over,
});

/** a project with one video track: a box from 0 to 10 that shows a video on its front */
function scene(picStart = 2, picDur = 4): { p: Project; solid: VisualClip; pic: VideoClip } {
  const p = createProject();
  const t = p.tracks.find((x) => x.kind === 'video')!;
  const pic = video(t.id, picStart, picDur);
  const solid = image(t.id, 0, 10, { threeD: true, shape: 'box', faces: { front: { clip: pic.id } } });
  p.clips.push(solid, pic);
  return { p, solid, pic };
}
const ids = (l: readonly Clip[]) => l.map((c) => c.id);
const withClips = (p: Project, f: (c: Clip) => Clip): Project => ({ ...p, clips: p.clips.map(f) });

describe('the lists leave out a clip that lives on a solid', () => {
  it('visibleClipsAt and paintListAt do not paint it on its own', () => {
    const { p, solid, pic } = scene();
    expect(ids(visibleClipsAt(p, 3))).toEqual([solid.id]);
    expect(ids(paintListAt(p, 3))).toEqual([solid.id]);
    // without the fill the clip paints as before
    const bare = withClips(p, (c) => (c.id === solid.id ? ({ ...c, faces: undefined } as Clip) : c));
    expect(ids(visibleClipsAt(bare, 3)).sort()).toEqual([solid.id, pic.id].sort());
  });
  it('a flat clip, a missing clip or a side the shape does not have names nobody', () => {
    const { p, solid, pic } = scene();
    const flat = withClips(p, (c) => (c.id === solid.id ? ({ ...c, threeD: false } as Clip) : c));
    expect(ids(visibleClipsAt(flat, 3))).toContain(pic.id);
    const gone = withClips(p, (c) => (c.id === solid.id ? ({ ...c, faces: { front: { clip: 'nope' } } } as Clip) : c));
    expect(ids(visibleClipsAt(gone, 3))).toContain(pic.id);
    const wrong = withClips(p, (c) => (c.id === solid.id ? ({ ...c, faces: { roof: { clip: pic.id } } } as Clip) : c));
    expect(ids(visibleClipsAt(wrong, 3))).toContain(pic.id);
  });
  it('the clip is not on its own before or after its range either', () => {
    const { p, pic } = scene();
    expect(ids(visibleClipsAt(p, 1))).not.toContain(pic.id);
    expect(ids(visibleClipsAt(p, 8))).not.toContain(pic.id);
  });
});

describe('neededClipsAt keeps the pictures on the sides ready', () => {
  it('includes the face source while it plays', () => {
    const { p, solid, pic } = scene();
    expect(ids(neededClipsAt(p, 3))).toEqual([solid.id, pic.id]);
  });
  it('not outside the source range (the side shows the own picture there)', () => {
    const { p, solid } = scene();
    expect(ids(neededClipsAt(p, 1))).toEqual([solid.id]);
    expect(ids(neededClipsAt(p, 7))).toEqual([solid.id]);
  });
  it('stays in the list while it plays, also when its solid is not on screen (a decoder runs one frame after the other)', () => {
    const { p, pic } = scene(12, 3);
    // the solid ends at 10, the picture plays 12..15
    expect(ids(neededClipsAt(p, 13))).toEqual([pic.id]);
  });
  it('a source on a hidden track is not a source at all', () => {
    const { p, pic } = scene();
    const t2 = { ...p.tracks[0]!, id: 'tx', hidden: true };
    const moved: Project = { ...p, tracks: [...p.tracks, t2], clips: p.clips.map((c) => (c.id === pic.id ? { ...c, trackId: 'tx' } : c)) };
    expect(ids(neededClipsAt(moved, 3))).not.toContain(pic.id);
  });
  it('a color side needs nothing', () => {
    const p = createProject();
    const t = p.tracks.find((x) => x.kind === 'video')!;
    const solid = createShapeClip(t.id, 0, { threeD: true, shape: 'box', duration: 5, faces: { all: { color: '#ff0000' } } });
    p.clips.push(solid);
    expect(ids(neededClipsAt(p, 1))).toEqual([solid.id]);
  });
});

describe('a clip on a solid is not part of a transition', () => {
  it('it is not painted, so no transition item is made for it', () => {
    const { p, solid } = scene(0, 10);
    const t = p.tracks.find((x) => x.kind === 'video')!;
    const second = image(t.id, 10, 5, { transition: { id: 'fade', duration: 1 } as never });
    const q: Project = { ...p, clips: [...p.clips, second] };
    expect(ids(paintListAt(q, 10.2))).toContain(second.id);
    const r = withClips(q, (c) => (c.id === solid.id ? ({ ...c, faces: { front: { clip: second.id } } } as Clip) : c));
    expect(ids(paintListAt(r, 10.2))).not.toContain(second.id);
  });
});

describe('planeFor with sides', () => {
  const rig = () => cameraRig(DEFAULT_CAMERA, 1280, 720);
  const own = { image: { width: 640, height: 360 } as unknown as CanvasImageSource, width: 640, height: 360 };
  const src = (w: number, h: number): DrawSource => ({ image: { width: w, height: h } as unknown as CanvasImageSource, width: w, height: h });

  it('a video on a side becomes a side picture, with a fit window against the side', () => {
    const { p, solid, pic } = scene();
    const s = src(1600, 900);
    const plane = planeFor(p, { clip: solid, source: own, alpha: 1, time: 3, resolve: (c) => (c.id === pic.id ? s : null) }, rig(), 'default')!;
    expect(plane.faces?.front).toBeDefined();
    expect(Object.keys(plane.faces!)).toEqual(['front']);
    expect(plane.faces!.front!.image).toBe(s.image);
    expect(plane.faces!.front!.cacheKey).toBeUndefined();
    // a video fills the front: the window is inside the picture
    const uv = plane.faces!.front!.uv!;
    expect(uv[0]).toBeGreaterThanOrEqual(0);
    expect(uv[0] + uv[2]).toBeLessThanOrEqual(1 + 1e-9);
    expect(plane.faces!.front!.clip).toBeUndefined();
  });
  it('no resolver, a source that is not ready or a time outside the range: the own picture, never a throw', () => {
    const { p, solid, pic } = scene();
    const a = planeFor(p, { clip: solid, source: own, alpha: 1, time: 3 }, rig(), 'default')!;
    const b = planeFor(p, { clip: solid, source: own, alpha: 1, time: 3, resolve: () => null }, rig(), 'default')!;
    const c = planeFor(p, { clip: solid, source: own, alpha: 1, time: 8, resolve: (cl) => (cl.id === pic.id ? src(10, 10) : null) }, rig(), 'default')!;
    for (const plane of [a, b, c]) {
      expect(plane).not.toBeNull();
      expect(plane.faces).toBeUndefined();
    }
  });
  it('a clip with no filled side has no faces field at all', () => {
    const p = createProject();
    const t = p.tracks.find((x) => x.kind === 'video')!;
    const solid = image(t.id, 0, 5, { threeD: true, shape: 'box' });
    p.clips.push(solid);
    const plane = planeFor(p, { clip: solid, source: own, alpha: 1, time: 1 }, rig(), 'default')!;
    expect('faces' in plane).toBe(false);
  });
  it('a color side is a tiny picture with a color key (no canvas here: left out)', () => {
    const p = createProject();
    const t = p.tracks.find((x) => x.kind === 'video')!;
    const solid = image(t.id, 0, 5, { threeD: true, shape: 'box', faces: { all: { color: '#00ff80' }, top: null } });
    p.clips.push(solid);
    const plane = planeFor(p, { clip: solid, source: own, alpha: 1, time: 1 }, rig(), 'default')!;
    const f = plane.faces;
    // where a canvas exists every side but the top carries the color
    if (f) {
      expect(Object.keys(f).sort()).toEqual(['back', 'bottom', 'front', 'left', 'right']);
      expect(f.front!.cacheKey).toBe('facecolor:#00ff80');
    }
  });
  it('a text on a side of a cylinder: building the plane never throws', () => {
    const p = createProject();
    const t = p.tracks.find((x) => x.kind === 'video')!;
    const txt = createTextClip(t.id, 0, { text: 'hi', duration: 5 });
    const solid = createShapeClip(t.id, 0, { threeD: true, shape: 'cylinder', duration: 5, faces: { side: { clip: txt.id } } });
    p.clips.push(solid, txt);
    expect(ids(visibleClipsAt(p, 1))).toEqual([solid.id]);
    expect(() => planeFor(p, { clip: solid, source: null, alpha: 1, time: 1 }, rig(), 'default')).not.toThrow();
  });
});
