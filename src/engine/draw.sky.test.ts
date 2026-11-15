import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../lib/factory';
import type { ImageClip, MediaAsset, Project, SceneSky, Track, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { renderFrame, renderSceneView, setCanvasChannel } from './draw';
import type { DrawSource, SourceResolver } from './draw';
import { renderScene } from './scene3d/renderer';
import { DEFAULT_CAMERA, cameraRig } from './scene3d/camera';
import { type SkyPicture, skyRay } from './scene3d/sky';

const GL = { tag: 'gl' };
vi.mock('./scene3d/renderer', async (orig) => ({ ...(await orig<typeof import('./scene3d/renderer')>()), renderScene: vi.fn(() => GL) }));

interface Call {
  op: string;
  args: unknown[];
}

class FakeCtx {
  calls: Call[] = [];
  globalAlpha = 1;
  fillStyle: unknown = '#000';
  globalCompositeOperation = 'source-over';
  canvas = { width: 1920, height: 1080 };
  private rec(op: string, args: unknown[]): void {
    this.calls.push({ op, args });
  }
  save(): void {
    this.rec('save', []);
  }
  restore(): void {
    this.rec('restore', []);
  }
  setTransform(...a: number[]): void {
    this.rec('setTransform', a);
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
  ops(name: string): Call[] {
    return this.calls.filter((c) => c.op === name);
  }
}
const asCtx = (f: FakeCtx) => f as unknown as CanvasRenderingContext2D;
const mkSource = (tag: string, w = 1920, h = 1080): DrawSource => ({ image: { tag } as unknown as CanvasImageSource, width: w, height: h });
const tagOf = (c: Call) => (c.args[0] as { tag: string }).tag;

let seq = 0;
const image = (trackId: string, over: Partial<ImageClip> = {}): ImageClip => ({
  id: `sk${++seq}`, type: 'image', trackId, start: 0, duration: 10, name: 'i', fadeIn: 0, fadeOut: 0, assetId: 'img', transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const asset = (id: string, w: number, h: number): MediaAsset => ({ id, name: id, kind: 'image', mime: 'image/png', size: 1, duration: 0, width: w, height: h, hasAudio: false, createdAt: 0 });
const light = { sky: '#8090a0', horizon: '#808080', ground: '#404040', sun: 0, sunColor: '#fff4e0', sunTurn: -35, sunHeight: 45 };
const FACES = ['s0', 's1', 's2', 's3', 's4', 's5'];
const skyOf = (over: Partial<SceneSky> = {}): SceneSky => ({ faces: FACES, turn: 0, brightness: 1, blur: 0, light, ...over });
const PIC: SkyPicture = { key: 'k', size: 64, faces: [], close() {} };

/** a project with a top and a bottom video track (index 0 is the top), six sky pictures and a sky on them */
function skyProject(clips: (top: string, bot: string) => (ImageClip | VideoClip)[], sky: SceneSky | null = skyOf()): Project {
  const p = createProject();
  const top: Track = { id: 'top', kind: 'video', name: 'top', muted: false, hidden: false, locked: false };
  const bot: Track = { id: 'bot', kind: 'video', name: 'bot', muted: false, hidden: false, locked: false };
  p.tracks = [top, bot];
  p.assets = [...FACES.map((id) => asset(id, 64, 64)), asset('img', 400, 300)];
  p.clips = clips('top', 'bot');
  p.sky = sky;
  return p;
}

const withSky: SourceResolver = Object.assign((clip: VideoClip | ImageClip) => mkSource(clip.id), { sky: () => PIC });
const noSky: SourceResolver = (clip) => mkSource(clip.id);
const calls = () => vi.mocked(renderScene).mock.calls;
const skyArg = (i: number) => calls()[i]![10] as { pic: SkyPicture; ray: Float32Array; maxFace: number } | null;

beforeEach(() => {
  vi.mocked(renderScene).mockClear();
});

describe('paintLayers with a sky', () => {
  it('a sky behind 2d clips is rendered alone before the first 2d clip', () => {
    const p = skyProject((t) => [image(t)]);
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), p, 1, withSky);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]![0]).toEqual([]);
    expect(skyArg(0)!.pic).toBe(PIC);
    const ops = ctx.calls.map((c) => c.op === 'drawImage' ? `draw:${tagOf(c)}` : c.op);
    const bg = ops.indexOf('fillRect');
    const gl = ops.indexOf('draw:gl');
    const clip = ops.findIndex((o) => o.startsWith('draw:') && o !== 'draw:gl');
    expect(bg).toBeGreaterThanOrEqual(0);
    expect(gl).toBeGreaterThan(bg);
    expect(clip).toBeGreaterThan(gl);
  });

  it('a sky rides in the first run of 3d clips in one render', () => {
    const p = skyProject((t, b) => [image(t), image(b, { threeD: true })]);
    renderFrame(asCtx(new FakeCtx()), p, 1, withSky);
    expect(calls()).toHaveLength(1);
    expect((calls()[0]![0] as unknown[]).length).toBe(1);
    expect(skyArg(0)!.pic).toBe(PIC);
  });

  it('only the first run carries the sky', () => {
    const p = skyProject((t, b) => [image(t, { threeD: true }), image('mid'), image(b, { threeD: true })]);
    p.tracks = [p.tracks[0]!, { id: 'mid', kind: 'video', name: 'mid', muted: false, hidden: false, locked: false }, p.tracks[1]!];
    renderFrame(asCtx(new FakeCtx()), p, 1, withSky);
    expect(calls()).toHaveLength(2);
    expect(skyArg(0)!.pic).toBe(PIC);
    expect(skyArg(1)).toBeNull();
  });

  it('no sky: a 3d frame renders as before, with no sky', () => {
    const p = skyProject((t) => [image(t, { threeD: true })], null);
    renderFrame(asCtx(new FakeCtx()), p, 1, withSky);
    expect(calls()).toHaveLength(1);
    expect(skyArg(0)).toBeNull();
  });

  it('no sky: a 2d frame never asks for a 3d render', () => {
    const p = skyProject((t) => [image(t)], null);
    renderFrame(asCtx(new FakeCtx()), p, 1, withSky);
    expect(calls()).toHaveLength(0);
  });

  it('an empty frame still shows the sky', () => {
    const p = skyProject(() => []);
    const ctx = new FakeCtx();
    renderFrame(asCtx(ctx), p, 1, withSky);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]![0]).toEqual([]);
    expect(ctx.ops('drawImage').map(tagOf)).toEqual(['gl']);
  });

  it('a resolver without sky pictures draws no sky', () => {
    renderFrame(asCtx(new FakeCtx()), skyProject((t) => [image(t, { threeD: true })]), 1, noSky);
    renderFrame(asCtx(new FakeCtx()), skyProject((t) => [image(t)]), 1, noSky);
    expect(calls()).toHaveLength(1);
    expect(skyArg(0)).toBeNull();
  });

  it('a sky whose picture is gone is not drawn', () => {
    const p = skyProject((t, b) => [image(t, { threeD: true }), image(b)]);
    p.assets = p.assets.filter((a) => a.id !== 's3');
    renderFrame(asCtx(new FakeCtx()), p, 1, withSky);
    expect(calls().length).toBeGreaterThan(0);
    for (let i = 0; i < calls().length; i++) expect(skyArg(i)).toBeNull();
  });
});

describe('the scene view and the inset', () => {
  it('the scene view draws the sky through the view camera', () => {
    const p = skyProject((t) => [image(t, { threeD: true })], skyOf({ turn: 40 }));
    const cam = { ...DEFAULT_CAMERA, pan: 30 };
    renderSceneView(asCtx(new FakeCtx()), p, 1, withSky, cam);
    expect(calls()).toHaveLength(1);
    expect((calls()[0]![0] as unknown[]).length).toBe(1);
    expect((calls()[0]![1] as unknown[]).length).toBe(1);
    const want = skyRay(cameraRig(cam, p.width, p.height), 40);
    expect(Array.from(skyArg(0)!.ray)).toEqual(Array.from(want));
  });

  it('the inset channel asks for faces of at most 512', () => {
    const p = skyProject((t) => [image(t, { threeD: true })]);
    const ctx = new FakeCtx();
    setCanvasChannel(ctx.canvas as unknown as OffscreenCanvas, 'inset');
    try {
      renderFrame(asCtx(ctx), p, 1, withSky);
      expect(skyArg(0)!.maxFace).toBe(512);
    } finally {
      setCanvasChannel(ctx.canvas as unknown as OffscreenCanvas, 'default');
    }
  });
});
