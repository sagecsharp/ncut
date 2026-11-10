import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShapeClip, createTextClip } from '../lib/factory';
import type { ImageClip, Keyframe, Project, Track, VisualClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { animatesPicture } from '../lib/anim';
import { renderFrame } from './draw';
import type { DrawSource } from './draw';

// the gpu steps are replaced by recorders that hand the picture back: what is checked is the clip they are given
const looks: VisualClip[] = [];
const masks: VisualClip[] = [];
vi.mock('./clipLook', async (orig) => {
  const real = await orig<typeof import('./clipLook')>();
  return {
    ...real,
    clipLookTexture: (image: CanvasImageSource, _w: number, _h: number, clip: VisualClip) => {
      looks.push(clip);
      return image;
    },
  };
});
vi.mock('./mask', async (orig) => {
  const real = await orig<typeof import('./mask')>();
  return {
    ...real,
    maskedPicture: (image: CanvasImageSource, _w: number, _h: number, clip: VisualClip) => {
      masks.push(clip);
      return image;
    },
  };
});

interface Call {
  op: string;
  args: unknown[];
  font: string;
}

/** a recording 2d context: the operations with their arguments, and the font at every fillText */
class FakeCtx {
  calls: Call[] = [];
  globalAlpha = 1;
  fillStyle: unknown = '#000';
  strokeStyle: unknown = '#000';
  lineWidth = 1;
  lineJoin = 'miter';
  globalCompositeOperation = 'source-over';
  font = '';
  textBaseline = 'alphabetic';
  textAlign = 'start';
  letterSpacing = '';
  shadowColor = '';
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  private rec(op: string, args: unknown[]): void {
    this.calls.push({ op, args, font: this.font });
  }
  save = () => this.rec('save', []);
  restore = () => this.rec('restore', []);
  translate = (...a: number[]) => this.rec('translate', a);
  rotate = (...a: number[]) => this.rec('rotate', a);
  scale = (...a: number[]) => this.rec('scale', a);
  fillRect = (...a: number[]) => this.rec('fillRect', a);
  drawImage = (...a: unknown[]) => this.rec('drawImage', a);
  beginPath = () => this.rec('beginPath', []);
  closePath = () => this.rec('closePath', []);
  moveTo = (...a: number[]) => this.rec('moveTo', a);
  lineTo = (...a: number[]) => this.rec('lineTo', a);
  arcTo = (...a: number[]) => this.rec('arcTo', a);
  arc = (...a: number[]) => this.rec('arc', a);
  ellipse = (...a: number[]) => this.rec('ellipse', a);
  rect = (...a: number[]) => this.rec('rect', a);
  clip = () => this.rec('clip', []);
  fill = () => this.rec('fill', []);
  stroke = () => this.rec('stroke', []);
  fillText = (...a: unknown[]) => this.rec('fillText', a);
  strokeText = (...a: unknown[]) => this.rec('strokeText', a);
  measureText = (t: string) => ({ width: Array.from(t).length * 10 });
  setTransform = () => undefined;
  createLinearGradient = () => ({ addColorStop: () => undefined });
  createRadialGradient = () => ({ addColorStop: () => undefined });
  ops(name: string): Call[] {
    return this.calls.filter((c) => c.op === name);
  }
}

const asCtx = (f: FakeCtx) => f as unknown as CanvasRenderingContext2D;
const mkSource = (tag: string, w = 1920, h = 1080): DrawSource => ({ image: { tag } as unknown as CanvasImageSource, width: w, height: h });
const track = (id: string): Track => ({ id, kind: 'video', name: id, muted: false, hidden: false, locked: false });
const k = (t: number, v: number): Keyframe => ({ t, v, ease: 'linear' });
const project = (clips: Project['clips']): Project => ({
  id: 'p',
  name: 'p',
  createdAt: 0,
  updatedAt: 0,
  width: 1920,
  height: 1080,
  fps: 30,
  background: '#123456',
  assets: [{ id: 'img', name: 'img', kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 0, height: 0, hasAudio: false, createdAt: 0 }],
  tracks: [track('top')],
  clips,
});

let seq = 0;
const image = (over: Partial<ImageClip> = {}): ImageClip => ({
  id: `kl${++seq}`,
  type: 'image',
  trackId: 'top',
  start: 0,
  duration: 5,
  name: 'i',
  fadeIn: 0,
  fadeOut: 0,
  assetId: 'img',
  transform: { ...DEFAULT_TRANSFORM },
  ...over,
});

/** the project drawn at a time on a fresh context */
function draw(clip: VisualClip, time: number): FakeCtx {
  const ctx = new FakeCtx();
  renderFrame(asCtx(ctx), project([clip]), time, () => mkSource('a'));
  return ctx;
}

beforeAll(() => {
  // the text measuring canvas
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return { font: '', measureText: (t: string) => ({ width: Array.from(t).length * 10 }) };
      }
    },
  );
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  looks.length = 0;
  masks.length = 0;
});

describe('keyed look values reach the picture drawn at the frame time', () => {
  it('crop: the kept part of the source follows the key', () => {
    const c = image({ keyframes: { 'crop.left': [k(0, 0), k(4, 0.5)] } });
    const at = (t: number) => draw(c, t).ops('drawImage')[0]!.args.slice(1);
    // the source is 1920 x 1080 and the box the whole canvas
    expect(at(0)).toEqual([-960, -540, 1920, 1080]);
    expect(at(2)).toEqual([480, 0, 1440, 1080, -480, -540, 1440, 1080]);
    expect(at(4)).toEqual([960, 0, 960, 1080, 0, -540, 960, 1080]);
    // the stored clip never changed
    expect(c.crop).toBeUndefined();
  });

  it('corner radius: the rounded path follows the key', () => {
    const c = image({ keyframes: { radius: [k(0, 0), k(4, 1)] } });
    expect(draw(c, 0).ops('arcTo')).toHaveLength(0);
    // half way = 0.5 of the 1080 high box
    expect(draw(c, 2).ops('arcTo')[0]!.args[4]).toBe(270);
    expect(draw(c, 4).ops('arcTo')[0]!.args[4]).toBe(540);
  });

  it('color correction: the look step is given the values at the time', () => {
    const c = image({ adjust: { brightness: 0, contrast: 0, saturation: 0, hue: 0, temperature: 0 }, keyframes: { 'adjust.brightness': [k(0, 0), k(4, 1)] } });
    draw(c, 3);
    expect(looks.at(-1)!.adjust!.brightness).toBe(0.75);
    draw(c, 1);
    expect(looks.at(-1)!.adjust!.brightness).toBe(0.25);
    // a clip with no correction but a keyed value gets one: nothing is stored, the frame has it
    const bare = image({ keyframes: { 'adjust.contrast': [k(0, 0), k(4, 0.8)] } });
    draw(bare, 2);
    expect(looks.at(-1)!.adjust!.contrast).toBeCloseTo(0.4, 9);
    expect(bare.adjust).toBeUndefined();
  });

  it('color key: the look step is given the key values at the time', () => {
    const c = image({ chromaKey: { color: '#00d000', tolerance: 0.1, softness: 0.1, spill: 0.1 }, keyframes: { 'chromaKey.tolerance': [k(0, 0), k(4, 1)] } });
    draw(c, 2);
    expect(looks.at(-1)!.chromaKey!.tolerance).toBe(0.5);
    expect(looks.at(-1)!.chromaKey!.color).toBe('#00d000');
  });

  it('mask: the masking step is given the mask at the time', () => {
    const mask = { shape: 'rect', x: 0, y: 0, width: 1, height: 1, rotation: 0, feather: 0, invert: false } as const;
    const c = image({ mask, keyframes: { 'mask.width': [k(0, 0), k(4, 1)], 'mask.rotation': [k(0, 0), k(4, 90)] } });
    draw(c, 1);
    expect(masks.at(-1)!.mask!.width).toBe(0.25);
    expect(masks.at(-1)!.mask!.rotation).toBe(22.5);
    expect(masks.at(-1)!.mask!.height).toBe(1);
    expect(c.mask!.width).toBe(1);
  });

  it('text: the font size and the outline width follow the keys', () => {
    const t = createTextClip('top', 0, { text: 'hey', fontFamily: 'Kode Mono', fontSize: 40, duration: 5, stroke: { color: '#000', width: 0.1 }, keyframes: { fontSize: [k(0, 40), k(4, 80)], 'stroke.width': [k(0, 0.1), k(4, 0.3)] } });
    const size = (ctx: FakeCtx) => /(\d+(?:\.\d+)?)px/.exec(ctx.ops('fillText')[0]!.font)![1];
    expect(size(draw(t, 0))).toBe('40');
    expect(size(draw(t, 2))).toBe('60');
    expect(size(draw(t, 4))).toBe('80');
    // the box behind a text follows the size too: the second frame is not served from the first
    expect(t.fontSize).toBe(40);
  });

  it('shape: the width and the corner count follow the keys', () => {
    const s = createShapeClip('top', 0, { kind: 'rect', width: 100, height: 100, duration: 5, keyframes: { width: [k(0, 100), k(4, 500)] } });
    const wide = (t: number) => {
      const ctx = draw(s, t);
      const r = ctx.ops('rect')[0] ?? ctx.ops('fillRect').at(-1)!;
      return r.args[2] as number;
    };
    expect(wide(0)).toBe(100);
    expect(wide(2)).toBe(300);
    expect(wide(4)).toBe(500);
    const poly = createShapeClip('top', 0, { kind: 'polygon', width: 100, height: 100, duration: 5, keyframes: { points: [k(0, 3), k(4, 9)] } });
    const corners = (t: number) => draw(poly, t).ops('lineTo').length;
    // a polygon is a path of `points` corners (one move, points - 1 lines, closed)
    expect([corners(0), corners(2), corners(4)]).toEqual([2, 5, 8]);
  });
});

describe('keyed look values and the picture caches', () => {
  it('a clip with a keyed color, mask or style is drawn without a texture key of its own', () => {
    expect(animatesPicture(image({ keyframes: { 'adjust.hue': [k(0, 0)] } }))).toBe(true);
    expect(animatesPicture(createTextClip('top', 0, { keyframes: { fontSize: [k(0, 40)] } }))).toBe(true);
    expect(animatesPicture(createShapeClip('top', 0, { keyframes: { height: [k(0, 40)] } }))).toBe(true);
    expect(animatesPicture(image({ keyframes: { 'crop.left': [k(0, 0)] } }))).toBe(false);
  });

  it('the same time drawn twice gives the same picture, another time another one (no stale picture served)', () => {
    const c = image({ adjust: { brightness: 0, contrast: 0, saturation: 0, hue: 0, temperature: 0 }, keyframes: { 'adjust.brightness': [k(0, 0), k(4, 1)] } });
    for (const t of [1, 3, 1, 2]) {
      draw(c, t);
      expect(looks.at(-1)!.adjust!.brightness).toBe(t / 4);
    }
  });
});
