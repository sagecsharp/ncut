import { describe, expect, it } from 'vitest';
import type { ImageClip, Project, Track, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { containSize, getClipBox, hitTestBox, renderFrame, visibleClipsAt } from './draw';
import type { ClipBox, DrawSource, SourceResolver } from './draw';

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
}

class FakeCtx {
  calls: Call[] = [];
  globalAlpha = 1;
  fillStyle: unknown = '#000';
  globalCompositeOperation = 'source-over';
  font = '';
  textBaseline = 'alphabetic';
  textAlign = 'start';
  private stack: Array<{ a: number; f: unknown }> = [];
  private rec(op: string, args: unknown[]): void {
    this.calls.push({ op, args, alpha: this.globalAlpha, fill: this.fillStyle });
  }
  save(): void {
    this.stack.push({ a: this.globalAlpha, f: this.fillStyle });
    this.rec('save', []);
  }
  restore(): void {
    const s = this.stack.pop();
    if (s) {
      this.globalAlpha = s.a;
      this.fillStyle = s.f;
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
