import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../lib/factory';
import { useEditor } from '../store/editorStore';
import type { MediaAsset } from '../types';
import { SKY_SAMPLE, faceDirection } from '../engine/scene3d/sky';
import { SkyError, importSkyFiles, skyFromAssets, skyFromFaces } from './skyImport';
import { importFiles, deleteAsset } from './importer';
import { sampleSky } from './skyFaces';

vi.mock('./skyFaces', () => ({ sampleSky: vi.fn() }));
vi.mock('./importer', () => ({ importFiles: vi.fn(), deleteAsset: vi.fn(async () => undefined) }));
vi.mock('./registry', () => ({ getAssetBlob: () => new Blob(['x']) }));

const N = SKY_SAMPLE;
const sample = sampleSky as unknown as ReturnType<typeof vi.fn>;
const importMock = importFiles as unknown as ReturnType<typeof vi.fn>;
const deleteMock = deleteAsset as unknown as ReturnType<typeof vi.fn>;

const img = (id: string, name: string, w: number, h: number): MediaAsset => ({ id, name, kind: 'image', mime: 'image/png', size: 1, duration: 0, width: w, height: h, hasAudio: false, createdAt: 0 });

const grey = (): Uint8ClampedArray[] =>
  [0, 1, 2, 3, 4, 5].map(() => {
    const out = new Uint8ClampedArray(N * N * 4);
    for (let i = 0; i < N * N; i++) out.set([0x80, 0x80, 0x80, 255], i * 4);
    return out;
  });

/** a cube whose colors follow the direction, so every seam fits */
function seamless(): Uint8ClampedArray[] {
  return [0, 1, 2, 3, 4, 5].map((f) => {
    const out = new Uint8ClampedArray(N * N * 4);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const d = faceDirection(f, (x + 0.5) / N, (y + 0.5) / N);
        const len = Math.hypot(d[0], d[1], d[2]);
        const o = (y * N + x) * 4;
        for (let c = 0; c < 3; c++) out[o + c] = Math.round(127.5 + (120 * d[c]!) / len);
        out[o + 3] = 255;
      }
    }
    return out;
  });
}

const SIDES = ['posx', 'negx', 'posy', 'negy', 'posz', 'negz'];
const WORDS = ['right', 'left', 'top', 'bottom', 'front', 'back'];

function open(extra: MediaAsset[] = []): void {
  const p = createProject('t');
  p.assets = [
    img('cross', 'sky_cross.png', 1024, 768),
    img('pano', 'pano.jpg', 2048, 1024),
    img('photo', 'photo.png', 1280, 1024),
    ...SIDES.map((n, i) => img(`s${i}`, `sky_${n}.png`, 512, 512)),
    ...WORDS.map((n, i) => img(`w${i}`, `${n}.jpg`, 512, 512)),
    ...'abcdef'.split('').map((n, i) => img(`l${i}`, `${n}.png`, 512, 512)),
    { ...img('vid', 'clip.mp4', 1920, 1080), kind: 'video', mime: 'video/mp4', duration: 4 },
    ...extra,
  ];
  useEditor.getState().openProject(p);
}

async function refusal(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (e) {
    expect(e).toBeInstanceOf(SkyError);
    return (e as Error).message;
  }
  throw new Error('expected a SkyError');
}

beforeEach(() => {
  sample.mockReset();
  sample.mockImplementation(async () => grey());
  importMock.mockReset();
  deleteMock.mockClear();
  open();
});

describe('skyFromAssets', () => {
  it('one cross picture makes a sky with the measured light', async () => {
    const made = await skyFromAssets(['cross']);
    expect(made.sky.asset).toBe('cross');
    expect(made.sky.faces).toBeUndefined();
    expect(made.sky).toMatchObject({ turn: 0, brightness: 1, blur: 0 });
    expect(made.sky.light.sky).toBe('#808080');
    expect(made.sky.light.sun).toBe(0);
    expect(made.notes).toEqual([]);
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it('a 2:1 picture is refused as a panorama', async () => {
    expect(await refusal(skyFromAssets(['pano']))).toContain('"pano.jpg" is a 2:1 panorama. ncut takes cube maps');
    expect(sample).not.toHaveBeenCalled();
  });

  it('a 5:4 picture is refused as not a cube map', async () => {
    expect(await refusal(skyFromAssets(['photo']))).toContain('"photo.png" is not shaped like a cube map. ncut takes a cross');
  });

  it('six pictures named posx to negz make a sky in side order whatever their order', async () => {
    const made = await skyFromAssets(['s3', 's0', 's5', 's1', 's4', 's2']);
    expect(made.sky.faces).toEqual(['s0', 's1', 's2', 's3', 's4', 's5']);
    expect(made.sky.asset).toBeUndefined();
    expect(made.sky.turns).toBeUndefined();
    expect(made.notes).toEqual([]);
  });

  it('six word named pictures whose seams do not fit are fixed and say so', async () => {
    const good = seamless();
    // right and left come swapped
    sample.mockImplementation(async () => [good[1]!, good[0]!, ...good.slice(2)]);
    const made = await skyFromAssets(['w0', 'w1', 'w2', 'w3', 'w4', 'w5']);
    expect(made.sky.faces).toEqual(['w1', 'w0', 'w2', 'w3', 'w4', 'w5']);
    expect(made.sky.turns).toBeUndefined();
    expect(made.notes).toHaveLength(1);
    expect(made.notes[0]!.startsWith('fixed the sides to fit their seams: ')).toBe(true);
    expect(made.notes[0]).toContain('swapped left and right');
  });

  it('six pictures whose names say nothing are refused', async () => {
    expect(await refusal(skyFromAssets(['l0', 'l1', 'l2', 'l3', 'l4', 'l5']))).toBe(
      'could not tell the six sides apart by their names. name them like px, nx, py, ny, pz, nz or right, left, top, bottom, front, back',
    );
  });

  it('two pictures are refused', async () => {
    expect(await refusal(skyFromAssets(['s0', 's1']))).toBe('a sky is 1 picture (a cross or a strip) or 6 pictures, one per side. this was 2');
  });

  it('a video is refused', async () => {
    expect(await refusal(skyFromAssets(['vid']))).toBe('"clip.mp4" is not a picture');
  });

  it('keep carries turn, brightness and blur over', async () => {
    const made = await skyFromAssets(['cross'], { turn: 270, brightness: 1.5, blur: 0.25 });
    expect(made.sky).toMatchObject({ turn: -90, brightness: 1.5, blur: 0.25 });
  });

  it('says so when there is no project, no media or the file cannot be read', async () => {
    expect(await refusal(skyFromAssets(['nope']))).toBe('that media is not in the project anymore');
    sample.mockImplementation(async () => {
      throw new Error('the file of "sky_cross.png" is missing');
    });
    expect(await refusal(skyFromAssets(['cross']))).toBe('could not read "sky_cross.png"');
    useEditor.getState().closeProject();
    expect(await refusal(skyFromAssets(['cross']))).toBe('open a project first');
  });
});

describe('skyFromFaces', () => {
  it('skyFromFaces takes the order and turns as given', async () => {
    const order = ['s5', 's4', 's3', 's2', 's1', 's0'];
    const made = await skyFromFaces(order, [0, 5, 0, 0, 0, 3]);
    expect(made.sky.faces).toEqual(order);
    expect(made.sky.turns).toEqual([0, 1, 0, 0, 0, 3]);
    expect(made.notes).toEqual([]);
    expect(sample.mock.calls[0]![0]).toEqual({ faces: order, turns: [0, 1, 0, 0, 0, 3] });
    const plain = await skyFromFaces(order, [0, 0, 0, 0, 0, 0]);
    expect(plain.sky.turns).toBeUndefined();
  });
});

describe('importSkyFiles', () => {
  it('importSkyFiles refuses hdr and exr before importing', async () => {
    const msg = await refusal(importSkyFiles([new File(['x'], 'sky.hdr')]));
    expect(msg).toBe('hdr and exr pictures cannot be read here. save the sides as png or jpg first');
    expect(await refusal(importSkyFiles([new File(['x'], 'SKY.EXR'), new File(['x'], 'a.png')]))).toContain('hdr and exr');
    expect(importMock).not.toHaveBeenCalled();
  });

  it('importSkyFiles removes the imported media again when they are no sky', async () => {
    const added = [img('x1', 'one.png', 100, 100), img('x2', 'two.png', 100, 100)];
    open(added);
    importMock.mockResolvedValue(added);
    const msg = await refusal(importSkyFiles([new File(['x'], 'one.png'), new File(['x'], 'two.png')]));
    expect(msg).toContain('a sky is 1 picture');
    expect(deleteMock.mock.calls.map((c) => c[0]).sort()).toEqual(['x1', 'x2']);
  });

  it('names the skipped file when a partial import is no sky', async () => {
    const added = ['a', 'b', 'c', 'd', 'e'].map((n) => img(n, `${n}.png`, 100, 100));
    open(added);
    importMock.mockImplementation(async (_f: File[], o: { onSkip?: (n: string, w: string) => void }) => {
      o.onSkip?.('bad.tga', 'unsupported file type');
      return added;
    });
    const msg = await refusal(importSkyFiles([new File(['x'], 'a.png')]));
    expect(msg).toContain('this was 5');
    expect(msg).toContain('skipped: bad.tga (unsupported file type)');
  });

  it('says when none of the files could be imported', async () => {
    importMock.mockImplementation(async (_f: File[], o: { onSkip?: (n: string, w: string) => void }) => {
      o.onSkip?.('notes.txt', 'unsupported file type');
      return [];
    });
    expect(await refusal(importSkyFiles([new File(['x'], 'notes.txt')]))).toBe('none of the files could be imported: notes.txt (unsupported file type)');
  });
});
