import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTextClip } from '../lib/factory';
import type { Crop, ImageClip, Project, ShapeClip, Track, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { type Layer3D, MAX_MOTION_BLUR_SAMPLES, TEXTURE_MAX, resetClipErrors, textureSize, blendOp, extrudeFades, imagePixelSize, getClipBoxWorld, motionBlurTimes, pruneSamples, releaseRenderResources, setCanvasChannel, textureQuality, containSize, cropRect, getClipBox, hitTestBox, normalizeCrop, planeFor, radiusPx, renderFrame, visibleClipsAt } from './draw';
import type { ClipBox, DrawSource, SourceResolver } from './draw';
import { SCENE_RETRY_MS, releaseSceneRenderer, renderScene, sceneRendererCount, startBlocked } from './scene3d/renderer';
import { effectRunnerCount, releaseEffectRunner } from './effects/runner';
import { releaseTransitionRunner, transitionRunnerCount } from './transitions/runner';
import { clipLookCount, releaseClipLook } from './clipLook';

let seq = 0;
function video(trackId: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip {
  return {
    id: `v${++seq}`,
    type: 'video',
    trackId,
    start,
    duration,
    name: 'v',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'vid',
    trimStart: 0,
    speed: 1,
    volume: 1,
    muted: false,
    transform: { ...DEFAULT_TRANSFORM },
    ...over,
  };
}
function image(trackId: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip {
  return {
    id: `i${++seq}`,
    type: 'image',
    trackId,
    start,
    duration,
    name: 'i',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'img',
    transform: { ...DEFAULT_TRANSFORM },
    ...over,
  };
}
function shape(trackId: string, start: number, duration: number, over: Partial<ShapeClip> = {}): ShapeClip {
  return {
    id: `s${++seq}`,
    type: 'shape',
    trackId,
    start,
    duration,
    name: 's',
    fadeIn: 0,
    fadeOut: 0,
    kind: 'rect',
    width: 400,
    height: 200,
    color: '#ffffff',
    transform: { ...DEFAULT_TRANSFORM },
    ...over,
  };
}
function track(id: string, kind: 'video' | 'audio', hidden = false): Track {
  return { id, kind, name: id, muted: false, hidden, locked: false };
}
function project(clips: Project['clips'], tracks: Track[], over: Partial<Project> = {}): Project {
  return {
    id: 'p',
    name: 'p',
    createdAt: 0,
    updatedAt: 0,
    width: 1920,
    height: 1080,
    fps: 30,
    background: '#123456',
    assets: [
      { id: 'vid', name: 'vid', kind: 'video', mime: 'video/mp4', size: 1, duration: 10, width: 1000, height: 1000, hasAudio: true, createdAt: 0 },
      { id: 'img', name: 'img', kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 0, height: 0, hasAudio: false, createdAt: 0 },
    ],
    tracks,
    clips,
    ...over,
  };
}

describe('containSize', () => {
  it('fits inside the canvas keeping the aspect ratio', () => {
    expect(containSize(1000, 1000, 1920, 1080)).toEqual({ width: 1080, height: 1080 });
    expect(containSize(3840, 1080, 1920, 1080)).toEqual({ width: 1920, height: 540 });
    expect(containSize(960, 540, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });
  it('falls back to the canvas for invalid sizes', () => {
    expect(containSize(0, 0, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(containSize(100, -1, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });
});

describe('hitTestBox', () => {
  const box: ClipBox = { cx: 100, cy: 100, width: 200, height: 20, rotation: 0 };
  it('unrotated box', () => {
    expect(hitTestBox(box, 100, 100)).toBe(true);
    expect(hitTestBox(box, 199, 109)).toBe(true);
    expect(hitTestBox(box, 201, 100)).toBe(false);
    expect(hitTestBox(box, 100, 111)).toBe(false);
  });
  it('rotated 90 degrees swaps the axes', () => {
    const r = { ...box, rotation: 90 };
    expect(hitTestBox(r, 100, 190)).toBe(true);
    expect(hitTestBox(r, 190, 100)).toBe(false);
    expect(hitTestBox(r, 100, 100)).toBe(true);
  });
  it('rotation is clockwise (canvas convention, y down)', () => {
    // box 200x20 rotated 45 deg clockwise: its long axis points down-right
    const r = { ...box, rotation: 45 };
    expect(hitTestBox(r, 100 + 60, 100 + 60)).toBe(true);
    expect(hitTestBox(r, 100 + 60, 100 - 60)).toBe(false);
  });
  it('rotation 180 / -90 / 360 behave', () => {
    expect(hitTestBox({ ...box, rotation: 180 }, 190, 100)).toBe(true);
    expect(hitTestBox({ ...box, rotation: -90 }, 100, 190)).toBe(true);
    expect(hitTestBox({ ...box, rotation: 360 }, 190, 100)).toBe(true);
    expect(hitTestBox({ ...box, rotation: 360 }, 100, 190)).toBe(false);
  });
});

describe('visibleClipsAt', () => {
  it('returns clips bottom layer first and skips hidden/audio tracks', () => {
    const tracks = [track('top', 'video'), track('mid', 'video', true), track('bot', 'video'), track('aud', 'audio')];
    const a = video('top', 0, 5);
    const b = video('mid', 0, 5);
    const c = image('bot', 0, 5);
    const au = { ...video('aud', 0, 5) };
    const p = project([a, b, c, au], tracks);
    expect(visibleClipsAt(p, 1).map((x) => x.id)).toEqual([c.id, a.id]);
  });
  it('is half-open', () => {
    const tracks = [track('t', 'video')];
    const a = video('t', 1, 2);
    const p = project([a], tracks);
    expect(visibleClipsAt(p, 0.99)).toHaveLength(0);
    expect(visibleClipsAt(p, 1)).toHaveLength(1);
    expect(visibleClipsAt(p, 2.999)).toHaveLength(1);
    expect(visibleClipsAt(p, 3)).toHaveLength(0);
  });
  it('ignores audio clips', () => {
    const tracks = [track('t', 'video'), track('a', 'audio')];
    const p = project(
      [
        {
          id: 'x',
          type: 'audio',
          trackId: 'a',
          start: 0,
          duration: 5,
          name: 'a',
          fadeIn: 0,
          fadeOut: 0,
          assetId: 'aud',
          trimStart: 0,
          speed: 1,
          volume: 1,
          muted: false,
        },
      ],
      tracks,
    );
    expect(visibleClipsAt(p, 1)).toEqual([]);
  });
});

describe('getClipBox', () => {
  const tracks = [track('t', 'video')];
  it('uses the asset size for contain fit and applies scale/offset/rotation', () => {
    const c = video('t', 0, 1, { transform: { x: 10, y: -20, scale: 0.5, rotation: 30, opacity: 1 } });
    const b = getClipBox(project([c], tracks), c);
    expect(b).toEqual({ cx: 970, cy: 520, width: 540, height: 540, rotation: 30 });
  });
  it('prefers an explicit natural size', () => {
    const c = video('t', 0, 1);
    const b = getClipBox(project([c], tracks), c, { width: 1920, height: 960 });
    expect(b.width).toBe(1920);
    expect(b.height).toBe(960);
  });
  it('falls back to the full canvas when the asset has no size (images with 0x0)', () => {
    const c = image('t', 0, 1);
    const b = getClipBox(project([c], tracks), c);
    expect(b).toMatchObject({ cx: 960, cy: 540, width: 1920, height: 1080 });
  });
  it('falls back to the full canvas for an unknown asset', () => {
    const c = video('t', 0, 1, { assetId: 'missing' });
    const b = getClipBox(project([c], tracks), c);
    expect(b).toMatchObject({ width: 1920, height: 1080 });
  });
  it('scales the fallback box too', () => {
    const c = image('t', 0, 1, { transform: { ...DEFAULT_TRANSFORM, scale: 2 } });
    expect(getClipBox(project([c], tracks), c)).toMatchObject({ width: 3840, height: 2160 });
  });
});

/* ---------- renderFrame with a recording fake context ---------- */

interface Call {
  op: string;
  args: unknown[];
  alpha: number;
  fill: unknown;
  comp: string;
}

class FakeCtx {
  calls: Call[] = [];
  globalAlpha = 1;
  fillStyle: unknown = '#000';
  globalCompositeOperation = 'source-over';
  font = '';
  textBaseline = 'alphabetic';
  textAlign = 'start';
  private stack: Array<{ a: number; f: unknown; c: string }> = [];
  private rec(op: string, args: unknown[]): void {
    this.calls.push({ op, args, alpha: this.globalAlpha, fill: this.fillStyle, comp: this.globalCompositeOperation });
  }
  save(): void {
    this.stack.push({ a: this.globalAlpha, f: this.fillStyle, c: this.globalCompositeOperation });
    this.rec('save', []);
  }
  restore(): void {
    const s = this.stack.pop();
    if (s) {
      this.globalAlpha = s.a;
      this.fillStyle = s.f;
      this.globalCompositeOperation = s.c;
    }
    this.rec('restore', []);
  }
  translate(...a: number[]): void {
    this.rec('translate', a);
  }
  rotate(...a: number[]): void {
    this.rec('rotate', a);
  }
  scale(...a: number[]): void {
    this.rec('scale', a);
  }
  fillRect(...a: number[]): void {
    this.rec('fillRect', a);
  }
  drawImage(...a: unknown[]): void {
    this.rec('drawImage', a);
  }
  beginPath(): void {
    this.rec('beginPath', []);
  }
  closePath(): void {
    this.rec('closePath', []);
  }
  moveTo(...a: number[]): void {
    this.rec('moveTo', a);
  }
  lineTo(...a: number[]): void {
    this.rec('lineTo', a);
  }
  arcTo(...a: number[]): void {
    this.rec('arcTo', a);
  }
  rect(...a: number[]): void {
    this.rec('rect', a);
  }
  clip(): void {
    this.rec('clip', []);
  }
  fill(): void {
    this.rec('fill', []);
  }
  stroke(): void {
    this.rec('stroke', []);
  }
  fillText(...a: unknown[]): void {
    this.rec('fillText', a);
  }
  get depth(): number {
    return this.stack.length;
  }
  ops(name: string): Call[] {
    return this.calls.filter((c) => c.op === name);
  }
}

const asCtx = (f: FakeCtx) => f as unknown as CanvasRenderingContext2D;
const mkSource = (tag: string, w = 1920, h = 1080): DrawSource => ({ image: { tag } as unknown as CanvasImageSource, width: w, height: h });
const tagOf = (c: Call) => (c.args[0] as unknown as { tag: string }).tag;

describe('renderFrame', () => {
  const tracks = [track('top', 'video'), track('bot', 'video')];

  it('paints the background first, then clips bottom-first', () => {
    const top = image('top', 0, 5);
    const bot = video('bot', 0, 5);
    const p = project([top, bot], tracks);
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), p, 1, (clip) => mkSource(clip.id));
    const first = ctx.calls.find((c) => c.op === 'fillRect')!;
    expect(first.args).toEqual([0, 0, 1920, 1080]);
    expect(first.fill).toBe('#123456');
    expect(first.alpha).toBe(1);
    const draws = ctx.ops('drawImage').map(tagOf);
    expect(draws).toEqual([bot.id, top.id]);
    // background rect is drawn before any image
    expect(ctx.calls.indexOf(first)).toBeLessThan(ctx.calls.findIndex((c) => c.op === 'drawImage'));
  });

  it('balances save/restore and leaves the context state clean', () => {
    const p = project([video('top', 0, 5, { transform: { ...DEFAULT_TRANSFORM, rotation: 20 } })], tracks);
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), p, 1, () => mkSource('a'));
    expect(ctx.ops('save').length).toBe(ctx.ops('restore').length);
    expect(ctx.depth).toBe(0);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('translates to the box center, rotates, and draws centered', () => {
    const c = video('top', 0, 5, { transform: { x: 100, y: 50, scale: 0.5, rotation: 90, opacity: 1 } });
    const p = project([c], tracks);
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), p, 1, () => mkSource('a', 1920, 1080));
    const t = ctx.ops('translate')[0]!;
    expect(t.args).toEqual([1060, 590]);
    const r = ctx.ops('rotate')[0]!;
    expect(r.args[0]).toBeCloseTo(Math.PI / 2, 9);
    const d = ctx.ops('drawImage')[0]!;
    expect(d.args.slice(1)).toEqual([-480, -270, 960, 540]);
    // order: translate, rotate, drawImage
    const order = ctx.calls.map((x) => x.op).filter((o) => ['translate', 'rotate', 'drawImage'].includes(o));
    expect(order).toEqual(['translate', 'rotate', 'drawImage']);
  });

  it('does not rotate when rotation is 0', () => {
    const p = project([image('top', 0, 5)], tracks);
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), p, 1, () => mkSource('a'));
    expect(ctx.ops('rotate')).toHaveLength(0);
  });

  it('applies opacity and fades to globalAlpha', () => {
    const c = video('top', 0, 10, { fadeIn: 2, fadeOut: 2, transform: { ...DEFAULT_TRANSFORM, opacity: 0.5 } });
    const p = project([c], tracks);
    const alphaAt = (t: number): number | undefined => {
      const ctx = new FakeCtx();
      renderFrame(asCtx(ctx), p, t, () => mkSource('a'));
      return ctx.ops('drawImage')[0]?.alpha;
    };
    expect(alphaAt(1)).toBeCloseTo(0.25, 9);
    expect(alphaAt(5)).toBeCloseTo(0.5, 9);
    expect(alphaAt(9)).toBeCloseTo(0.25, 9);
  });

  it('skips fully transparent clips without resolving their source', () => {
    const c = video('top', 0, 10, { fadeIn: 2 });
    const hidden = image('bot', 0, 10, { transform: { ...DEFAULT_TRANSFORM, opacity: 0 } });
    const p = project([c, hidden], tracks);
    const ctx = new FakeCtx();
    let calls = 0;
    renderFrame(asCtx(ctx), p, 0, () => {
      calls++;
      return mkSource('a');
    });
    expect(ctx.ops('drawImage')).toHaveLength(0);
    expect(calls).toBe(0);
  });

  it('skips clips whose source is missing but still draws the others', () => {
    const a = video('top', 0, 5);
    const b = image('bot', 0, 5);
    const p = project([a, b], tracks);
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), p, 1, (clip) => (clip.id === a.id ? null : mkSource(clip.id)));
    expect(ctx.ops('drawImage').map(tagOf)).toEqual([b.id]);
    expect(ctx.depth).toBe(0);
  });

  it('survives a drawImage that throws', () => {
    const p = project([video('top', 0, 5), image('bot', 0, 5)], tracks);
    const ctx = new FakeCtx();
    let n = 0;
    ctx.drawImage = () => {
      n++;
      throw new Error('not ready');
    };
    expect(() => renderFrame(asCtx(ctx), p, 1, () => mkSource('a'))).not.toThrow();
    expect(n).toBe(2);
    expect(ctx.depth).toBe(0);
  });

  it('skips hidden tracks and clips outside the time', () => {
    const t2 = [track('top', 'video', true), track('bot', 'video')];
    const a = video('top', 0, 5);
    const b = video('bot', 2, 1);
    const p = project([a, b], t2);
    const ctx = new FakeCtx();
    const asked: string[] = [];
    renderFrame(asCtx(ctx), p, 1, (c) => {
      asked.push(c.id);
      return mkSource(c.id);
    });
    expect(asked).toEqual([]);
    renderFrame(asCtx(ctx), p, 3, (c) => {
      asked.push(c.id);
      return mkSource(c.id);
    });
    expect(asked).toEqual([]);
    renderFrame(asCtx(ctx), p, 2, (c) => {
      asked.push(c.id);
      return mkSource(c.id);
    });
    expect(asked).toEqual([b.id]);
  });

  it('asks for the right source time (trim and speed) and 0 for images', () => {
    const v = video('top', 5, 10, { trimStart: 2, speed: 2 });
    const i = image('bot', 0, 100);
    const p = project([v, i], tracks);
    const asked: Record<string, number> = {};
    const resolver: SourceResolver = (c, st) => {
      asked[c.id] = st;
      return mkSource(c.id);
    };
    renderFrame(asCtx(new FakeCtx()), p, 8, resolver);
    expect(asked[v.id]).toBeCloseTo(2 + 3 * 2, 9);
    expect(asked[i.id]).toBe(0);
  });

  it('uses the natural size reported by the source for the box', () => {
    const c = image('top', 0, 5);
    const p = project([c], tracks);
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), p, 1, () => mkSource('a', 500, 500));
    expect(ctx.ops('drawImage')[0]!.args.slice(1)).toEqual([-540, -540, 1080, 1080]);
  });

  it('falls back to a black background', () => {
    const p = project([], tracks, { background: '' });
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), p, 0, () => null);
    expect(ctx.ops('fillRect')[0]!.fill).toBe('#000000');
  });
});

describe('blendOp', () => {
  it('maps modes to canvas composite operations, normal to null', () => {
    expect(blendOp(undefined)).toBeNull();
    expect(blendOp('normal')).toBeNull();
    expect(blendOp('add')).toBe('lighter');
    for (const m of ['screen', 'multiply', 'overlay', 'darken', 'lighten', 'difference'] as const) expect(blendOp(m)).toBe(m);
  });
});

describe('crop helpers', () => {
  it('normalizeCrop returns null when nothing is cut', () => {
    expect(normalizeCrop(undefined)).toBeNull();
    expect(normalizeCrop(null)).toBeNull();
    expect(normalizeCrop({ left: 0, top: 0, right: 0, bottom: 0 })).toBeNull();
  });
  it('clamps negative and huge values, keeping at least 1% per axis', () => {
    const c = normalizeCrop({ left: -1, top: 2, right: 0.5, bottom: 2 })!;
    expect(c.left).toBe(0);
    expect(c.right).toBe(0.5);
    expect(c.top + c.bottom).toBeCloseTo(0.99, 9);
    const d = normalizeCrop({ left: 0.9, right: 0.9, top: 0, bottom: 0 })!;
    expect(1 - d.left - d.right).toBeCloseTo(0.01, 9);
    expect(d.left).toBeCloseTo(d.right, 9);
  });
  it('cropRect keeps the kept part where it was (origin at the box center)', () => {
    const crop: Crop = { left: 0.25, top: 0, right: 0, bottom: 0.5 };
    expect(cropRect(400, 200, crop)).toEqual({ x: -100, y: -100, width: 300, height: 100 });
    expect(cropRect(400, 200, null)).toEqual({ x: -200, y: -100, width: 400, height: 200 });
  });
  it('radiusPx is a share of the shorter half side', () => {
    expect(radiusPx(undefined, 400, 200)).toBe(0);
    expect(radiusPx(0, 400, 200)).toBe(0);
    expect(radiusPx(0.5, 400, 200)).toBe(50);
    expect(radiusPx(1, 400, 200)).toBe(100);
    expect(radiusPx(5, 400, 200)).toBe(100);
  });
});

describe('renderFrame: crop, radius, blend', () => {
  const tracks = [track('top', 'video'), track('bot', 'video')];

  it('draws only the kept source rectangle into the matching part of the box', () => {
    const c = image('top', 0, 5, { crop: { left: 0.25, top: 0.5, right: 0.25, bottom: 0 } });
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), project([c], tracks), 1, () => mkSource('a', 1920, 1080));
    const d = ctx.ops('drawImage')[0]!;
    // source 1920x1080, box is the full canvas
    expect(d.args.slice(1)).toEqual([480, 540, 960, 540, -480, 0, 960, 540]);
    expect(ctx.ops('clip')).toHaveLength(0);
  });

  it('a clip with no crop or radius takes the plain 5 argument path', () => {
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), project([image('top', 0, 5)], tracks), 1, () => mkSource('a'));
    expect(ctx.ops('drawImage')[0]!.args).toHaveLength(5);
    expect(ctx.ops('clip')).toHaveLength(0);
    expect(ctx.ops('beginPath')).toHaveLength(0);
  });

  it('clips with a rounded path only when radius is above 0', () => {
    const none = new FakeCtx();
    renderFrame(asCtx(none), project([image('top', 0, 5, { radius: 0 })], tracks), 1, () => mkSource('a'));
    expect(none.ops('clip')).toHaveLength(0);
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), project([image('top', 0, 5, { radius: 0.5 })], tracks), 1, () => mkSource('a'));
    expect(ctx.ops('clip')).toHaveLength(1);
    expect(ctx.ops('arcTo')).toHaveLength(4);
    // radius 0.5 of the 1080 high box = 270 px corners
    expect(ctx.ops('arcTo')[0]!.args[4]).toBe(270);
    const order = ctx.calls.map((x) => x.op).filter((o) => ['clip', 'drawImage'].includes(o));
    expect(order).toEqual(['clip', 'drawImage']);
  });

  it('rounds the cropped rectangle', () => {
    const c = image('top', 0, 5, { radius: 1, crop: { left: 0.5, top: 0, right: 0, bottom: 0 } });
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), project([c], tracks), 1, () => mkSource('a'));
    // kept 960 x 1080: corners are half the shorter side
    expect(ctx.ops('arcTo')[0]!.args[4]).toBe(480);
    expect(ctx.ops('drawImage')[0]!.args).toHaveLength(9);
  });

  it('crops a shape by clipping to the kept rectangle, open on the sides that are not cut', () => {
    const c = shape('top', 0, 5, { crop: { left: 0.25, top: 0, right: 0, bottom: 0 } });
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), project([c], tracks), 1, () => null);
    const r = ctx.ops('rect')[0]!;
    expect(r.args[0]).toBe(-100);
    expect(r.args[1]).toBeLessThan(-1000);
    expect(ctx.ops('clip')).toHaveLength(1);
    expect(ctx.calls.findIndex((x) => x.op === 'clip')).toBeLessThan(ctx.calls.findIndex((x) => x.op === 'fill'));
  });

  it('ignores radius for non rect shapes (no clip path)', () => {
    const st = new FakeCtx();
    renderFrame(asCtx(st), project([shape('top', 0, 5, { kind: 'star', radius: 1 })], tracks), 1, () => null);
    expect(st.ops('clip')).toHaveLength(0);
  });

  it('sets the composite operation for the draw and restores source-over after', () => {
    const c = video('top', 0, 5, { blend: 'add' });
    const plain = image('bot', 0, 5);
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), project([c, plain], tracks), 1, (clip) => mkSource(clip.id));
    expect(ctx.ops('drawImage').map((d) => d.comp)).toEqual(['source-over', 'lighter']);
    expect(ctx.globalCompositeOperation).toBe('source-over');
    expect(ctx.depth).toBe(0);
  });

  it('maps every blend mode', () => {
    for (const [mode, op] of [['screen', 'screen'], ['multiply', 'multiply'], ['overlay', 'overlay'], ['darken', 'darken'], ['lighten', 'lighten'], ['difference', 'difference'], ['normal', 'source-over']] as const) {
      const ctx = new FakeCtx();
      renderFrame(asCtx(ctx), project([shape('top', 0, 5, { blend: mode })], tracks), 1, () => null);
      expect(ctx.ops('fill')[0]!.comp).toBe(op);
    }
  });

  it('draws shape clips in layer order, bottom first', () => {
    const a = shape('top', 0, 5, { color: '#aa0000' });
    const b = shape('bot', 0, 5, { color: '#00bb00' });
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), project([a, b], tracks), 1, () => null);
    expect(ctx.ops('fill').map((x) => x.fill)).toEqual(['#00bb00', '#aa0000']);
    expect(ctx.depth).toBe(0);
  });
});

describe('planeFor: 3d crop and radius', () => {
  const tracks = [track('t', 'video')];
  const rig = { eye: [960, 540, -1500] } as unknown as Parameters<typeof planeFor>[2];
  const layer = (clip: VideoClip | ImageClip): Layer3D => ({ clip, source: mkSource('a', 1080, 1080), alpha: 1, time: 0 });
  const corner = (m: Float32Array, x: number, y: number) => [m[0]! * x + m[4]! * y + m[12]!, m[1]! * x + m[5]! * y + m[13]!];

  it('has no uv window or radius without crop / radius', () => {
    const c = video('t', 0, 5, { threeD: true });
    const p = planeFor(project([c], tracks), layer(c), rig)!;
    expect(p.uv).toBeUndefined();
    expect(p.radius).toBeUndefined();
  });

  it('shrinks the plane to the kept rectangle and samples the matching uv window', () => {
    const c = video('t', 0, 5, { threeD: true, crop: { left: 0.5, top: 0, right: 0, bottom: 0.5 } });
    const p = planeFor(project([c], tracks), layer(c), rig)!;
    expect(p.uv).toEqual([0.5, 0, 0.5, 0.5]);
    // box is 1080 x 1080 centered at (960, 540): the kept quarter is its top right one
    const tl = corner(p.model, -0.5, -0.5);
    const br = corner(p.model, 0.5, 0.5);
    expect(tl[0]).toBeCloseTo(960, 3);
    expect(tl[1]).toBeCloseTo(0, 3);
    expect(br[0]).toBeCloseTo(960 + 540, 3);
    expect(br[1]).toBeCloseTo(540, 3);
  });

  it('wraps keep their geometry and only change the uv window', () => {
    const c = video('t', 0, 5, { threeD: true, shape: 'box', crop: { left: 0.5, top: 0, right: 0, bottom: 0 } });
    const base = planeFor(project([{ ...c, crop: null }], tracks), layer({ ...c, crop: null }), rig)!;
    const p = planeFor(project([c], tracks), layer(c), rig)!;
    expect(p.uv).toEqual([0.5, 0, 0.5, 1]);
    expect(Array.from(p.model)).toEqual(Array.from(base.model));
    expect(p.radius).toBeUndefined();
  });

  it('radius is in plane pixels of the kept rectangle, planes of media only', () => {
    const c = video('t', 0, 5, { threeD: true, radius: 0.5, crop: { left: 0.5, top: 0, right: 0, bottom: 0 } });
    const p = planeFor(project([c], tracks), layer(c), rig)!;
    expect(p.size).toEqual([540, 1080]);
    expect(p.radius).toBe(135);
    const w = video('t', 0, 5, { threeD: true, shape: 'sphere', radius: 0.5 });
    expect(planeFor(project([w], tracks), layer(w), rig)!.radius).toBeUndefined();
  });
});

describe('renderFrame: clip motions', () => {
  const tracks = [track('top', 'video'), track('bot', 'video')];
  const firstDraw = (clips: Project['clips'], t: number) => {
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), project(clips, tracks), t, () => mkSource('a'));
    return ctx;
  };

  it('a clip without motions takes the old path', () => {
    const ctx = firstDraw([image('top', 0, 5)], 0.1);
    expect(ctx.ops('drawImage')[0]!.alpha).toBe(1);
  });
  it('fade in lowers the alpha at the start and is back to 1 at rest', () => {
    const c = image('top', 0, 5, { motionIn: { id: 'fade', duration: 1 } });
    expect(firstDraw([c], 0.5).ops('drawImage')[0]!.alpha).toBeCloseTo(0.5, 6);
    expect(firstDraw([c], 2).ops('drawImage')[0]!.alpha).toBe(1);
  });
  it('fade out lowers the alpha at the end', () => {
    const c = image('top', 0, 5, { motionOut: { id: 'fade', duration: 1 } });
    expect(firstDraw([c], 4.5).ops('drawImage')[0]!.alpha).toBeCloseTo(0.5, 6);
  });
  it('a slide starts outside the canvas (translate moves far away)', () => {
    const c = image('top', 0, 5, { motionIn: { id: 'slide-left', duration: 1 } });
    const ctx = firstDraw([c], 0.001);
    const tr = ctx.ops('translate').map((x) => x.args[0] as number);
    expect(Math.max(...tr)).toBeGreaterThan(1920 + 960);
  });
  it('is deterministic for the same (project, time)', () => {
    const c = image('top', 0, 5, { motionLoop: { id: 'shake', duration: 1 } });
    const a = firstDraw([c], 1.37).calls.map((x) => [x.op, x.args]);
    const b = firstDraw([c], 1.37).calls.map((x) => [x.op, x.args]);
    expect(a).toEqual(b);
  });
  it('grouped clips follow edits of the clips array', () => {
    const a = image('top', 0, 5);
    const clips = [a];
    const p = project(clips, tracks);
    expect(visibleClipsAt(p, 1)).toHaveLength(1);
    const b = image('top', 0, 5);
    expect(visibleClipsAt({ ...p, clips: [a, b] }, 1)).toHaveLength(2);
    clips.push(b);
    expect(visibleClipsAt(p, 1)).toHaveLength(2);
  });
});

describe('textureQuality', () => {
  it('steps 1, 2, 4 so an animated scale keeps the same texture size', () => {
    const qs = new Set<number>();
    for (let s = 0.7; s <= 1.3; s += 0.01) qs.add(textureQuality(s, 200, 100));
    expect(qs.size).toBe(1);
    expect(textureQuality(0.5, 200, 100)).toBe(1);
    expect(textureQuality(1.2, 200, 100)).toBe(2);
    expect(textureQuality(2, 200, 100)).toBe(4);
    expect(textureQuality(9, 200, 100)).toBe(4);
  });
  it('is capped by the max texture size', () => {
    expect(textureQuality(3, 2048, 100)).toBe(2);
    expect(textureQuality(3, 8192, 100)).toBeCloseTo(0.5, 9);
  });
});

describe('pruneSamples', () => {
  it('drops samples under 1/512 of the total and renormalizes', () => {
    const out = pruneSamples([
      { offset: -2, weight: 0.001 },
      { offset: -1, weight: 0.5 },
      { offset: 0, weight: 1 },
    ]);
    expect(out.map((s) => s.offset)).toEqual([-1, 0]);
    expect(out[0]!.weight + out[1]!.weight).toBeCloseTo(1, 9);
    expect(out[1]!.weight).toBeCloseTo(2 / 3, 9);
  });
  it('keeps everything that matters and the order', () => {
    const out = pruneSamples([
      { offset: 0, weight: 1 },
      { offset: 1, weight: 1 },
      { offset: 2, weight: 1 },
      { offset: 3, weight: 1 },
    ]);
    expect(out).toHaveLength(4);
    expect(out.map((s) => s.offset)).toEqual([0, 1, 2, 3]);
    expect(out[0]!.weight).toBeCloseTo(0.25, 9);
  });
  it('always keeps the largest', () => {
    const out = pruneSamples([{ offset: 0, weight: 1e-9 }, { offset: 1, weight: 1e-8 }]);
    expect(out.some((s) => s.offset === 1)).toBe(true);
  });
});

describe('releaseRenderResources', () => {
  it('can be called for both channels without canvases', () => {
    expect(() => {
      releaseRenderResources('export');
      releaseRenderResources('preview');
    }).not.toThrow();
  });
});

describe('release without a dom', () => {
  it('every release function is safe when nothing was built', () => {
    expect(() => {
      releaseSceneRenderer('export');
      releaseEffectRunner('export');
      releaseTransitionRunner('export');
      releaseClipLook('export');
      releaseRenderResources('export');
      releaseRenderResources('preview');
    }).not.toThrow();
    expect(sceneRendererCount()).toBe(0);
    expect(effectRunnerCount()).toBe(0);
    expect(transitionRunnerCount()).toBe(0);
    expect(clipLookCount()).toBe(0);
  });
});

describe('3d renderer start retry', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('startBlocked is true only before the retry time', () => {
    expect(startBlocked(undefined, 5)).toBe(false);
    expect(startBlocked(100, 99)).toBe(true);
    expect(startBlocked(100, 100)).toBe(false);
  });
  it('a failed start is tried again after the wait, not cached forever', () => {
    let made = 0;
    class NoGl {
      constructor() {
        made++;
      }
      getContext() {
        return null;
      }
    }
    vi.stubGlobal('OffscreenCanvas', NoGl);
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const plane = { image: {}, model: new Array(16).fill(0), alpha: 1 } as unknown as Parameters<typeof renderScene>[0][number];
    const call = () => renderScene([plane], [], new Array(16).fill(0) as never, [0, 0, 0] as never, 10, 10, 'retry-test');
    expect(call()).toBeNull();
    expect(made).toBe(1);
    expect(call()).toBeNull();
    expect(made).toBe(1);
    vi.setSystemTime(1_000_000 + SCENE_RETRY_MS + 1);
    expect(call()).toBeNull();
    expect(made).toBe(2);
    // releasing clears the wait
    releaseSceneRenderer('retry-test');
    expect(call()).toBeNull();
    expect(made).toBe(3);
  });
});

describe('imagePixelSize', () => {
  it('reads the pixels of the image itself, not the reported size', () => {
    expect(imagePixelSize({ width: 2048, height: 1024 }, 8000, 4000)).toEqual({ w: 2048, h: 1024 });
    expect(imagePixelSize({ naturalWidth: 640, naturalHeight: 360, width: 99, height: 99 }, 1, 1)).toEqual({ w: 640, h: 360 });
    expect(imagePixelSize({ videoWidth: 1280, videoHeight: 720, width: 0, height: 0 }, 1, 1)).toEqual({ w: 1280, h: 720 });
    expect(imagePixelSize({ displayWidth: 1920, displayHeight: 1080 }, 1, 1)).toEqual({ w: 1920, h: 1080 });
  });
  it('falls back to the given size', () => {
    expect(imagePixelSize({}, 300, 200)).toEqual({ w: 300, h: 200 });
    expect(imagePixelSize(null, 300, 200)).toEqual({ w: 300, h: 200 });
    expect(imagePixelSize({ width: { baseVal: 1 }, height: 0 }, 300, 200)).toEqual({ w: 300, h: 200 });
    expect(imagePixelSize({ naturalWidth: 0, naturalHeight: 0 }, 300, 200)).toEqual({ w: 300, h: 200 });
  });
});

describe('extrudeFades', () => {
  const t = (extrude?: { depth: number } | null) => createTextClip('t', 0, { extrude: extrude as never });
  it('only a text with an extrude below full alpha takes the picture path', () => {
    const ex = { depth: 0.3, angle: 45, color: '#000' };
    expect(extrudeFades(t(ex), 0.5)).toBe(true);
    expect(extrudeFades(t(ex), 1)).toBe(false);
    expect(extrudeFades(t({ ...ex, depth: 0 }), 0.5)).toBe(false);
    expect(extrudeFades(t(null), 0.5)).toBe(false);
    expect(extrudeFades(t(), 0.5)).toBe(false);
    expect(extrudeFades(shape('t', 0, 1) as never, 0.5)).toBe(false);
  });
});

describe('motionBlurTimes', () => {
  it('spreads samples evenly over the shutter, ends included', () => {
    const t = motionBlurTimes(2, 30, { shutter: 0.5, samples: 3 });
    expect(t).toHaveLength(3);
    expect(t[0]).toBeCloseTo(2 - 1 / 120, 9);
    expect(t[1]).toBeCloseTo(2, 9);
    expect(t[2]).toBeCloseTo(2 + 1 / 120, 9);
  });
  it('is empty for no blur, a closed shutter, one sample or a bad fps', () => {
    expect(motionBlurTimes(1, 30, null)).toEqual([]);
    expect(motionBlurTimes(1, 30, undefined)).toEqual([]);
    expect(motionBlurTimes(1, 30, { shutter: 0, samples: 8 })).toEqual([]);
    expect(motionBlurTimes(1, 30, { shutter: 0.5, samples: 1 })).toEqual([]);
    expect(motionBlurTimes(1, 30, { shutter: 0.5, samples: Number.NaN })).toEqual([]);
    expect(motionBlurTimes(1, 0, { shutter: 0.5, samples: 8 })).toEqual([]);
  });
  it('caps the samples at 32 and the shutter at 2 frames', () => {
    const t = motionBlurTimes(5, 10, { shutter: 9, samples: 500 });
    expect(t).toHaveLength(MAX_MOTION_BLUR_SAMPLES);
    expect(t[t.length - 1]! - t[0]!).toBeCloseTo(2 / 10, 9);
  });
  it('a lower quality uses fewer copies but at least 2', () => {
    expect(motionBlurTimes(1, 30, { shutter: 1, samples: 16 }, 0.5)).toHaveLength(8);
    expect(motionBlurTimes(1, 30, { shutter: 1, samples: 16 }, 0.01)).toHaveLength(2);
  });
});

describe('parents in the renderer', () => {
  const tracks = [track('t', 'video')];
  it('getClipBoxWorld without a parent is getClipBox', () => {
    const c = shape('t', 0, 5, { transform: { ...DEFAULT_TRANSFORM, x: 40 } });
    const p = project([c], tracks);
    expect(getClipBoxWorld(p, c, 1)).toEqual(getClipBox(p, c));
  });
  it('getClipBoxWorld follows the parent', () => {
    const par = shape('t', 0, 5, { transform: { ...DEFAULT_TRANSFORM, x: 100, rotation: 90, scale: 2 } });
    const kid = shape('t', 0, 5, { parent: par.id, transform: { ...DEFAULT_TRANSFORM, x: 10 } });
    const p = project([par, kid], tracks);
    const b = getClipBoxWorld(p, kid, 1);
    expect(b.cx).toBeCloseTo(960 + 100, 6);
    expect(b.cy).toBeCloseTo(540 + 20, 6);
    expect(b.rotation).toBeCloseTo(90, 6);
    expect(b.width).toBeCloseTo(800, 6);
  });
  it('a 3d plane sits in its parent frame', () => {
    const par = shape('t', 0, 5, { transform: { ...DEFAULT_TRANSFORM, x: 100 } });
    const kid = video('t', 0, 5, { threeD: true, parent: par.id, transform: { ...DEFAULT_TRANSFORM, x: 10, z: 50 } });
    const p = project([par, kid], tracks);
    const rig = { eye: [960, 540, -1500] } as unknown as Parameters<typeof planeFor>[2];
    const plane = planeFor(p, { clip: kid, source: mkSource('a', 1080, 1080), alpha: 1, time: 1 }, rig)!;
    expect([plane.model[12], plane.model[13], plane.model[14]]).toEqual([1070, 540, 50]);
  });
});

describe('counter text in the renderer', () => {
  beforeAll(() => {
    class FakeOffscreen {
      getContext() {
        return { font: '', measureText: (t: string) => ({ width: Array.from(t).length * 10 }) };
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
  });
  afterAll(() => vi.unstubAllGlobals());

  const tracks = [track('top', 'video')];
  const drawnTexts = (ctx: FakeCtx) => ctx.ops('fillText').map((c) => c.args[0]);

  it('draws the number of the frame time in place of {n}', () => {
    const t = createTextClip('top', 0, { text: 'got {n}%', duration: 2, counter: { from: 0, to: 100, decimals: 0, separator: false, ease: 'linear', hold: 0 } });
    const p = project([t], tracks);
    const a = new FakeCtx();
    renderFrame(asCtx(a), p, 1, () => null);
    expect(drawnTexts(a).join('')).toContain('got 50%');
    const b = new FakeCtx();
    renderFrame(asCtx(b), p, 0.5, () => null);
    expect(drawnTexts(b).join('')).toContain('got 25%');
  });

  it('a text without a counter is drawn as it is', () => {
    const t = createTextClip('top', 0, { text: 'got {n}%', duration: 2 });
    const a = new FakeCtx();
    renderFrame(asCtx(a), project([t], tracks), 1, () => null);
    expect(drawnTexts(a).join('')).toContain('got {n}%');
  });
});

describe('render channels', () => {
  it('the inset channel can be released and a canvas can be marked and unmarked', () => {
    const canvas = {} as unknown as HTMLCanvasElement;
    expect(() => {
      setCanvasChannel(canvas, 'inset');
      releaseRenderResources('inset');
      setCanvasChannel(canvas, 'default');
    }).not.toThrow();
    expect(effectRunnerCount()).toBe(0);
  });
});

describe('planeFor: 3d depth text', () => {
  class FakeCanvas {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      const target: Record<string, unknown> = {
        font: '',
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        measureText: (s: string) => ({ width: Array.from(s).length * 10 }),
      };
      return new Proxy(target, {
        get: (tg, k: string) => (k in tg ? tg[k] : () => undefined),
        set: (tg, k: string, v) => {
          tg[k] = v;
          return true;
        },
        has: (tg, k: string) => k in tg,
      });
    }
  }
  beforeAll(() => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  });
  afterAll(() => vi.unstubAllGlobals());

  const tracks = [track('t', 'video')];
  const rig = { eye: [960, 540, -1500] } as unknown as Parameters<typeof planeFor>[2];
  const ex = { depth: 0.5, angle: 45, color: '#ff0000' };
  const text = (over: Record<string, unknown> = {}) => createTextClip('t', 0, { threeD: true, fontFamily: 'Depth A', fontSize: 40, duration: 5, ...over } as never);
  const build = (c: ReturnType<typeof text>, alpha = 1, time = 1) => {
    const sides: NonNullable<ReturnType<typeof planeFor>>[] = [];
    const face = planeFor(project([c], tracks), { clip: c, source: null, alpha, time }, rig, 'default', sides)!;
    return { face, sides };
  };

  it('a 3d text with an extrude is a face plus a stack of side planes behind it', () => {
    const { face, sides } = build(text({ extrude: ex }));
    // 0.5 x 40 = 20 px of depth: one plane per 2 px
    expect(sides.length).toBe(10);
    // every side is the face moved back along z (an unrotated plane: +z), farthest first
    const zs = sides.map((p) => p.model[14]! - face.model[14]!);
    expect(zs[0]).toBeCloseTo(20, 4);
    expect(zs[zs.length - 1]).toBeCloseTo(2, 4);
    for (let i = 1; i < zs.length; i++) expect(zs[i]!).toBeLessThan(zs[i - 1]!);
    for (const p of sides) {
      expect(p.model[12]).toBe(face.model[12]);
      expect(p.model[13]).toBe(face.model[13]);
      expect(p.alpha).toBe(1);
    }
  });

  it('the sides share one silhouette picture and key, which differ from the face', () => {
    const { face, sides } = build(text({ extrude: ex }));
    expect(new Set(sides.map((p) => p.image)).size).toBe(1);
    expect(new Set(sides.map((p) => p.cacheKey)).size).toBe(1);
    expect(sides[0]!.image).not.toBe(face.image);
    expect(sides[0]!.cacheKey).not.toBe(face.cacheKey);
  });

  it('the depth follows the clip scale and the stack turns with the clip', () => {
    const c = text({ extrude: ex, transform: { ...DEFAULT_TRANSFORM, scale: 2, rotY: 90 } });
    const { face, sides } = build(c);
    // rotY 90 turns the local z axis to the x axis: the stack reaches 40 px sideways, not in z
    const dx = Math.abs(sides[0]!.model[12]! - face.model[12]!);
    const dz = Math.abs(sides[0]!.model[14]! - face.model[14]!);
    expect(Math.hypot(dx, dz)).toBeCloseTo(40, 3);
    expect(dx).toBeGreaterThan(39);
  });

  it('the sides carry the clip opacity and the stack size: the renderer makes them composite to texel alpha x opacity', () => {
    const { face, sides } = build(text({ extrude: ex }), 0.5);
    expect(face.alpha).toBe(0.5);
    expect(face.stack).toBeUndefined();
    for (const p of sides) {
      expect(p.alpha).toBe(0.5);
      expect(p.stack).toBe(sides.length);
    }
    const solid = build(text({ extrude: ex }), 1);
    expect(solid.sides[0]!.alpha).toBe(1);
    expect(solid.sides[0]!.stack).toBe(solid.sides.length);
  });

  it('dragging the extrude colour or depth does not redraw the face', () => {
    // the planes of a clip are reused, so read what is needed before the next build
    const a = build(text({ id: 'drag', extrude: ex }));
    const aFace = { key: a.face.cacheKey, image: a.face.image };
    const aSide = a.sides[0]!.cacheKey;
    const aCount = a.sides.length;
    const b = build(text({ id: 'drag', extrude: { ...ex, color: '#00ff00', angle: 10 } }));
    expect(b.face.cacheKey).toBe(aFace.key);
    expect(b.face.image).toBe(aFace.image);
    // the silhouette carries the colour
    expect(b.sides[0]!.cacheKey).not.toBe(aSide);
    const c = build(text({ id: 'drag', extrude: { ...ex, color: '#00ff00', depth: 1 } }));
    expect(c.face.cacheKey).toBe(aFace.key);
    expect(c.sides.length).toBeGreaterThan(aCount);
  });

  it('a chroma key keeps the flat extrude in the picture instead of side planes', () => {
    const { sides } = build(text({ extrude: ex, chromaKey: { color: '#00ff00', tolerance: 0.3, softness: 0.1, spill: 0.5 } }));
    expect(sides.length).toBe(0);
  });

  it('a mask keeps the side planes (the silhouette goes through it too)', () => {
    const { sides } = build(text({ extrude: ex, mask: { shape: 'ellipse', x: 0, y: 0, width: 0.5, height: 0.5, rotation: 0, feather: 0, invert: false } }));
    expect(sides.length).toBe(10);
    expect(new Set(sides.map((p) => p.image)).size).toBe(1);
  });

  it('drops the planes when the clip is drawn unstacked and when the render resources are released', () => {
    const c = text({ id: 'gone', extrude: ex });
    const a = build(c).sides[0];
    expect(build(c).sides[0]).toBe(a);
    // flat for a moment: the entry is deleted, a later stack is built again
    build({ ...c, extrude: null });
    expect(build(c).sides[0]).not.toBe(a);
    const b = build(c).sides[0];
    expect(build(c).sides[0]).toBe(b);
    releaseRenderResources('preview');
    expect(build(c).sides[0]).not.toBe(b);
  });

  it('the default thickness of a solid is measured on the unpadded box (a stroke or animation does not change it)', () => {
    const thick = (c: ReturnType<typeof text>) => {
      const m = planeFor(project([c], tracks), { clip: c, source: null, alpha: 1, time: 1 }, rig)!.model;
      return Math.hypot(m[8]!, m[9]!, m[10]!);
    };
    const plain = thick(text({ shape: 'box' }));
    expect(plain).toBeGreaterThan(1);
    expect(thick(text({ shape: 'box', stroke: { color: '#000', width: 0.3 } }))).toBeCloseTo(plain, 6);
    expect(thick(text({ shape: 'box', animIn: { id: 'fade', duration: 1 } }))).toBeCloseTo(plain, 6);
    // every other solid is as deep as wide
    const w = (c: ReturnType<typeof text>) => {
      const m = planeFor(project([c], tracks), { clip: c, source: null, alpha: 1, time: 1 }, rig)!.model;
      return Math.hypot(m[8]!, m[9]!, m[10]!);
    };
    expect(w(text({ shape: 'cylinder', stroke: { color: '#000', width: 0.3 } }))).toBeCloseTo(w(text({ shape: 'cylinder' })), 6);
  });

  it('a text with a broken shadow or stroke still gets a finite plane', () => {
    const c = text({ extrude: ex, shadow: { color: '#000', opacity: 1 }, stroke: { color: '#000', width: Number.NaN } });
    const { face, sides } = build(c);
    expect(Array.from(face.model).every(Number.isFinite)).toBe(true);
    expect(sides.length).toBeGreaterThan(0);
    const big = text({ stroke: { color: '#000', width: 1e9 } });
    expect(() => build(big)).not.toThrow();
    const img = build(big).face.image as unknown as { width: number; height: number };
    expect(img.width).toBeLessThanOrEqual(TEXTURE_MAX);
    expect(img.height).toBeLessThanOrEqual(TEXTURE_MAX);
  });

  it('keeps the planes while nothing changes and rebuilds them when the pose does', () => {
    const c = text({ extrude: ex });
    const a = build(c).sides;
    const b = build(c).sides;
    expect(b[0]).toBe(a[0]);
    const moved = { ...c, transform: { ...c.transform, x: 50 } };
    expect(build(moved).sides[0]).not.toBe(a[0]);
  });

  it('a 3d text without an extrude, a flat one and non-text clips yield only their one plane', () => {
    expect(build(text()).sides.length).toBe(0);
    expect(build(text({ extrude: { ...ex, depth: 0 } })).sides.length).toBe(0);
    expect(build(text({ extrude: ex, threeD: false })).sides.length).toBe(0);
    const v = video('t', 0, 5, { threeD: true });
    const sides: never[] = [];
    expect(planeFor(project([v], tracks), { clip: v, source: mkSource('a', 100, 100), alpha: 1, time: 1 }, rig, 'default', sides)).not.toBeNull();
    expect(sides.length).toBe(0);
  });

  it('planeFor without a sides list returns the face only', () => {
    const c = text({ extrude: ex });
    expect(planeFor(project([c], tracks), { clip: c, source: null, alpha: 1, time: 1 }, rig)).not.toBeNull();
  });
});

describe('textureSize', () => {
  it('is whole pixels between 2 and the maximum, and never NaN', () => {
    expect(textureSize(100.2, 50, 1)).toEqual({ w: 101, h: 50 });
    expect(textureSize(0, 0, 1)).toEqual({ w: 2, h: 2 });
    expect(textureSize(Number.NaN, Number.POSITIVE_INFINITY, 1)).toEqual({ w: 2, h: 2 });
    expect(textureSize(1e9, 10, 4)).toEqual({ w: TEXTURE_MAX, h: 40 });
    expect(textureSize(10, 10, Number.NaN)).toEqual({ w: 2, h: 2 });
  });
  it('textureQuality survives a broken scale or size', () => {
    expect(textureQuality(Number.NaN, 100, 100)).toBe(1);
    expect(textureQuality(0.5, Number.NaN, Number.NaN)).toBe(1);
  });
});

describe('one bad clip does not stop the frame', () => {
  const tracks = [track('top', 'video'), track('mid', 'video'), track('bot', 'video')];
  afterEach(() => {
    vi.restoreAllMocks();
    resetClipErrors();
  });

  it('paints the clips around a clip whose picture throws, and warns once per clip', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = image('mid', 0, 5);
    const a = image('bot', 0, 5);
    const b = image('top', 0, 5);
    const p = project([a, bad, b], tracks);
    const resolve: SourceResolver = (c) => {
      if (c.id === bad.id) throw new Error('boom');
      return mkSource(c.id);
    };
    const ctx = new FakeCtx();
    expect(() => renderFrame(asCtx(ctx), p, 1, resolve)).not.toThrow();
    expect(ctx.ops('drawImage').map(tagOf)).toEqual([a.id, b.id]);
    renderFrame(asCtx(new FakeCtx()), p, 2, resolve);
    renderFrame(asCtx(new FakeCtx()), p, 3, resolve);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(bad.id);
  });

  it('leaves the canvas state as it found it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = image('mid', 0, 5, { transform: { ...DEFAULT_TRANSFORM, opacity: 0.5 } });
    const ok = image('top', 0, 5);
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), project([bad, ok], tracks), 1, (c) => {
      if (c.id === bad.id) {
        ctx.save();
        ctx.globalAlpha = 0.1;
        ctx.globalCompositeOperation = 'lighter';
        throw new Error('boom');
      }
      return mkSource(c.id);
    });
    // the clip after it was drawn at its own alpha with the normal composite op
    const last = ctx.ops('drawImage').pop()!;
    expect(last.alpha).toBe(1);
    expect(last.comp).toBe('source-over');
    expect(ctx.globalAlpha).toBe(1);
    expect(ctx.globalCompositeOperation).toBe('source-over');
  });

  it('a throwing 3d clip is dropped from its scene, the others stay', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // a 3d video whose source object throws when read
    const bad = video('mid', 0, 5, { threeD: true });
    const p = project([bad], tracks);
    const src = { image: {} as unknown as CanvasImageSource, get width(): number { throw new Error('boom'); }, height: 10 } as DrawSource;
    // a context that belongs to a canvas, so the 3d run really builds its planes
    const ctx = Object.assign(new FakeCtx(), { canvas: { width: 1920, height: 1080 } });
    expect(() => renderFrame(asCtx(ctx), p, 1, () => src)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
