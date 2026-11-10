import { describe, expect, it } from 'vitest';
import type { Clip, Project, TextClip, VideoClip, ImageClip, ShapeClip, EffectClip, CameraClip } from '../../types';
import { frameInfo, isStaticAt } from './frameStatic';

const base = { trackId: 't1', start: 0, duration: 10, fadeIn: 0, fadeOut: 0 };
const tf = () => ({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 });

function video(id: string, over: Partial<VideoClip> = {}): VideoClip {
  return { ...base, id, name: id, type: 'video', assetId: 'a', trimStart: 0, speed: 1, volume: 1, muted: false, transform: tf(), ...over };
}
function image(id: string, over: Partial<ImageClip> = {}): ImageClip {
  return { ...base, id, name: id, type: 'image', assetId: 'i', transform: tf(), ...over };
}
function text(id: string, over: Partial<TextClip> = {}): TextClip {
  return {
    ...base, id, name: id, type: 'text', text: 'hi', fontFamily: 'x', fontSize: 40, fontWeight: 400, italic: false, color: '#fff',
    background: null, align: 'center', transform: tf(), ...over,
  };
}
function shape(id: string, over: Partial<ShapeClip> = {}): ShapeClip {
  return { ...base, id, name: id, type: 'shape', kind: 'rect', width: 100, height: 100, color: '#f00', transform: tf(), ...over };
}
function effect(id: string, over: Partial<EffectClip> = {}): EffectClip {
  return { ...base, id, name: id, type: 'effect', effect: 'blur', amount: 1, params: {}, seed: 1, ...over };
}
function camera(id: string, over: Partial<CameraClip> = {}): CameraClip {
  return { ...base, id, name: id, type: 'camera', x: 0, y: 0, z: 0, pan: 0, tilt: 0, roll: 0, fov: 50, ...over };
}
function project(clips: Clip[]): Project {
  return {
    id: 'p', name: 'p', createdAt: 0, updatedAt: 0, width: 1920, height: 1080, fps: 30, background: '#000', assets: [],
    tracks: [{ id: 't1', kind: 'video', name: 'v', muted: false, hidden: false, locked: false }],
    clips,
  };
}
const kf = { opacity: [{ t: 0, v: 0, ease: 'linear' as const }, { t: 1, v: 1, ease: 'linear' as const }] };
const anim = { id: 'fade', duration: 1 };

describe('isStaticAt: static clips', () => {
  it('plain image, text, shape and video clips are static', () => {
    const clips = [image('i'), text('t'), shape('s'), video('v')];
    const p = project(clips);
    for (const c of clips) expect(isStaticAt(p, c, 5)).toBe(true);
  });
  it('styled text (stroke, shadow, gradient, extrude) is static', () => {
    const c = text('t', {
      stroke: { color: '#000', width: 0.1 }, shadow: { color: '#000', opacity: 1, blur: 0.1, distance: 0.1, angle: 45 },
      gradient: { from: '#fff', to: '#000', angle: 90 }, extrude: { depth: 0.2, angle: 45, color: '#333' }, curve: 30,
    });
    expect(isStaticAt(project([c]), c, 5)).toBe(true);
  });
  it('look, mask, crop and blend are static', () => {
    const c = image('i', {
      adjust: { brightness: 0.1, contrast: 0, saturation: 0, hue: 0, temperature: 0 }, blend: 'screen', crop: { left: 0.1, top: 0, right: 0, bottom: 0 },
      mask: { shape: 'rect', x: 0, y: 0, width: 1, height: 1, rotation: 0, feather: 0, invert: false },
    });
    expect(isStaticAt(project([c]), c, 5)).toBe(true);
  });
  it('empty keyframes and null animations are static', () => {
    const c = text('t', { keyframes: {}, motionIn: null, animLoop: null, counter: null, highlight: null, motionBlur: null, lookAt: 'none' });
    expect(isStaticAt(project([c]), c, 5)).toBe(true);
  });
  it('draw-on values without keyframes are static', () => {
    const c = shape('s', { drawStart: 0, drawEnd: 0.5 });
    expect(isStaticAt(project([c]), c, 5)).toBe(true);
  });
  it('a fade that is not running at this time is static', () => {
    const c = image('i', { fadeIn: 1, fadeOut: 1 });
    expect(isStaticAt(project([c]), c, 5)).toBe(true);
  });
});

describe('isStaticAt: rules that make it false', () => {
  const p = (c: Clip) => project([c]);
  it('keyframes', () => {
    const c = image('i', { keyframes: kf });
    expect(isStaticAt(p(c), c, 5)).toBe(false);
  });
  it('ready-made motions', () => {
    for (const key of ['motionIn', 'motionOut', 'motionLoop'] as const) {
      const c = image('i', { [key]: anim });
      expect(isStaticAt(p(c), c, 5)).toBe(false);
    }
  });
  it('text animations', () => {
    for (const key of ['animIn', 'animOut', 'animLoop'] as const) {
      const c = text('t', { [key]: anim });
      expect(isStaticAt(p(c), c, 5)).toBe(false);
    }
  });
  it('counter and highlight', () => {
    const a = text('a', { counter: { from: 0, to: 10, decimals: 0 } });
    const b = text('b', { highlight: { color: '#ff0', mode: 'word' } });
    expect(isStaticAt(p(a), a, 5)).toBe(false);
    expect(isStaticAt(p(b), b, 5)).toBe(false);
  });
  it('a fade window that holds the time', () => {
    const c = image('i', { fadeIn: 2, fadeOut: 2 });
    expect(isStaticAt(p(c), c, 1)).toBe(false);
    expect(isStaticAt(p(c), c, 2)).toBe(false);
    expect(isStaticAt(p(c), c, 9)).toBe(false);
    expect(isStaticAt(p(c), c, 5)).toBe(true);
  });
  it('motion blur', () => {
    const c = image('i', { motionBlur: { shutter: 0.5, samples: 8 } });
    expect(isStaticAt(p(c), c, 5)).toBe(false);
  });
  it('3d clips and look at', () => {
    const a = image('a', { threeD: true });
    const b = image('b', { lookAt: 'camera' });
    expect(isStaticAt(p(a), a, 5)).toBe(false);
    expect(isStaticAt(p(b), b, 5)).toBe(false);
  });
  it('effect, camera and audio clips', () => {
    const e = effect('e');
    const c = camera('c');
    const a = { ...base, id: 'au', name: 'au', type: 'audio', assetId: 'x', trimStart: 0, speed: 1, volume: 1, muted: false } as Clip;
    expect(isStaticAt(p(e), e, 5)).toBe(false);
    expect(isStaticAt(p(c), c, 5)).toBe(false);
    expect(isStaticAt(p(a), a, 5)).toBe(false);
  });
  it('a key it does not know', () => {
    const c = { ...image('i'), wobble: 3 } as unknown as Clip;
    expect(isStaticAt(p(c), c, 5)).toBe(false);
    const d = { ...image('d'), transform: { ...tf(), shake: 1 } } as unknown as Clip;
    expect(isStaticAt(p(d), d, 5)).toBe(false);
  });
  it('a transition that runs at this time', () => {
    const a = image('a', { start: 0, duration: 5 });
    const b = image('b', { start: 5, duration: 5, transition: { id: 'fade', duration: 1 } });
    const proj = project([a, b]);
    expect(isStaticAt(proj, b, 5.2)).toBe(false);
    expect(isStaticAt(proj, b, 4.6)).toBe(false);
    expect(isStaticAt(proj, b, 7)).toBe(true);
  });
});

describe('isStaticAt: parents', () => {
  it('a child of a static parent is static', () => {
    const parent = shape('p');
    const child = text('c', { parent: 'p' });
    expect(isStaticAt(project([parent, child]), child, 5)).toBe(true);
  });
  it('a child of a moving parent is not', () => {
    const parent = shape('p', { keyframes: kf });
    const child = text('c', { parent: 'p' });
    expect(isStaticAt(project([parent, child]), child, 5)).toBe(false);
  });
  it('a moving grandparent counts', () => {
    const g = shape('g', { motionLoop: anim });
    const p = shape('p', { parent: 'g' });
    const c = text('c', { parent: 'p' });
    expect(isStaticAt(project([g, p, c]), c, 5)).toBe(false);
  });
  it('a camera parent is not static', () => {
    const cam = camera('cam');
    const c = text('c', { parent: 'cam' });
    expect(isStaticAt(project([cam, c]), c, 5)).toBe(false);
  });
  it('a loop of parents is not static', () => {
    const a = shape('a', { parent: 'b' });
    const b = shape('b', { parent: 'a' });
    expect(isStaticAt(project([a, b]), a, 5)).toBe(false);
  });
  it('an unknown parent id is no parent', () => {
    const c = text('c', { parent: 'gone' });
    expect(isStaticAt(project([c]), c, 5)).toBe(true);
  });
});

describe('frameInfo', () => {
  it('lists the painted clips in order and says when all are static', () => {
    const a = image('a');
    const b = text('b');
    const info = frameInfo(project([a, b]), 5);
    expect(info.key).toBe('a,b,|a,b,');
    expect(info.allStatic).toBe(true);
    expect(info.videos).toEqual([]);
  });
  it('the key changes when a clip leaves', () => {
    const a = image('a', { duration: 4 });
    const b = text('b');
    const proj = project([a, b]);
    expect(frameInfo(proj, 3).key).not.toBe(frameInfo(proj, 5).key);
  });
  it('an empty frame is static', () => {
    const info = frameInfo(project([image('a', { start: 20 })]), 1);
    expect(info.key).toBe('|');
    expect(info.allStatic).toBe(true);
  });
  it('collects the video clips', () => {
    const v = video('v');
    const info = frameInfo(project([v, text('t')]), 5);
    expect(info.videos).toEqual([v]);
    expect(info.allStatic).toBe(true);
  });
  it('an effect clip on screen is never static', () => {
    expect(frameInfo(project([image('a'), effect('e')]), 5).allStatic).toBe(false);
  });
  it('a camera clip on screen is never static, off screen it is', () => {
    const cam = camera('c', { start: 6, duration: 2 });
    const proj = project([image('a'), cam]);
    expect(frameInfo(proj, 7).allStatic).toBe(false);
    expect(frameInfo(proj, 5).allStatic).toBe(true);
  });
  it('a running transition is never static', () => {
    const a = image('a', { start: 0, duration: 5 });
    const b = image('b', { start: 5, duration: 5, transition: { id: 'fade', duration: 1 } });
    const proj = project([a, b]);
    expect(frameInfo(proj, 5.1).allStatic).toBe(false);
    expect(frameInfo(proj, 7).allStatic).toBe(true);
  });
  it('one animated clip makes the frame not static', () => {
    expect(frameInfo(project([image('a'), text('t', { animLoop: anim })]), 5).allStatic).toBe(false);
  });
  it('a hidden track paints nothing', () => {
    const proj = project([text('t', { animLoop: anim })]);
    proj.tracks[0]!.hidden = true;
    const info = frameInfo(proj, 5);
    expect(info.key).toBe('|');
    expect(info.allStatic).toBe(true);
  });
});
