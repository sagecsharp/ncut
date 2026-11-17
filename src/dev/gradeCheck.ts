/**
 * dev only, imported by nothing: checks of the grade on the real gpu. in the dev page:
 *   const m = await import('/src/dev/gradeCheck.ts'); await m.gradeParity(); await m.gradeScene(); await m.lutScene();
 * gradeParity runs a grid of 8 bit colors through the clip look and the grade effect for 8 grades and compares both with
 * the typescript mirror (engine/grade.ts gradeColor and ditherAt), then 7 lut cases through the lut look and the lut effect
 * against gradeLutColor. gradeScene times a 4k export bare, with an adjust and with an adjust plus a grade. lutScene adds
 * the lut: a 33 point lut last and a 4096 point shaper with a 65 point table first, against the adjust plus grade.
 */
import type { ClipAdjust, ClipGrade, MediaAsset, VisualClip } from '../types';
import { parseCube, writeCube } from '../lib/cube';
import type { LutTable } from '../lib/cube';
import type { Rgb3 } from '../lib/gradeMath';
import { clipLookTexture, releaseClipLook } from '../engine/clipLook';
import { gradeDefFor } from '../engine/effects/defs/grade';
import { getEffect } from '../engine/effects/registry';
import { releaseEffectRunner, renderEffects } from '../engine/effects/runner';
import { DEMO_GRADE, ditherAt, gradeData, gradeLutColor } from '../engine/grade';
import type { GradeData } from '../engine/grade';
import { withLuts } from '../engine/lutScope';
import type { LutLookup } from '../engine/lutScope';
import { importFiles } from '../media/importer';
import { useEditor } from '../store/editorStore';
import { bench } from './bench';

const CHANNEL = 'grade-check';
/** 9 levels per channel, 9 x 9 x 9 colors laid out on a 27 x 27 picture */
const LEVELS = Array.from({ length: 9 }, (_, k) => Math.round((k * 255) / 8));
const SIDE = 27;

const FIXED: { name: string; grade: ClipGrade }[] = [
  { name: 'lift', grade: { liftR: 0.1, liftG: -0.05, liftB: 0.2, liftY: 0.05 } },
  { name: 'gamma', grade: { gammaR: 0.3, gammaG: -0.2, gammaB: 0.1, gammaY: 0.25 } },
  { name: 'gain', grade: { gainR: 0.2, gainG: -0.1, gainB: 0.15, gainY: -0.2 } },
  { name: 'offset', grade: { offsetR: 0.05, offsetG: -0.04, offsetB: 0.08, offsetY: 0.03 } },
  {
    name: 'luma s',
    grade: {
      curves: {
        y: [
          [0, 0],
          [0.25, 0.18],
          [0.75, 0.82],
          [1, 1],
        ],
      },
    },
  },
  {
    name: 'rgb lists',
    grade: {
      curves: {
        r: [
          [0, 0],
          [0.5, 0.58],
          [1, 1],
        ],
        g: [
          [0, 0.04],
          [0.5, 0.46],
          [1, 1],
        ],
        b: [
          [0, 0],
          [0.4, 0.3],
          [1, 0.92],
        ],
      },
    },
  },
  {
    name: 'color curves',
    grade: {
      curves: {
        hueSat: [
          [0, 0.7],
          [0.35, 0.3],
          [0.7, 0.8],
        ],
        hueHue: [
          [0.1, 0.56],
          [0.6, 0.45],
        ],
        lumaSat: [
          [0, 0.3],
          [0.5, 0.55],
          [1, 0.4],
        ],
      },
    },
  },
  { name: 'demo', grade: DEMO_GRADE },
];

/** the lut cases name one lut media id, its table (made when a check runs, not at load) sits behind a lookup like in a render */
const LUT_ID = 'lut-check';
const LUT_KEY = 'lut-check-table';

/** the film look: r^0.8, 0.95 g + 0.03, b^1.2 */
const film = (c: Rgb3): Rgb3 => [c[0] ** 0.8, 0.95 * c[1] + 0.03, c[2] ** 1.2];
const shaper = (x: number): number => x ** 0.75;
const row = (c: Rgb3): string => c.map((v) => Math.min(1, Math.max(0, v)).toFixed(6)).join(' ');

/** a .cube text with a 1d shaper first and a 3d table after it (the 1d rows come first in a file) */
function shaperText(size1: number, size3: number): string {
  const lines = ['TITLE "shaper"', `LUT_1D_SIZE ${size1}`, `LUT_3D_SIZE ${size3}`];
  for (let i = 0; i < size1; i++) {
    const v = shaper(i / (size1 - 1));
    lines.push(row([v, v, v]));
  }
  for (let b = 0; b < size3; b++) {
    for (let g = 0; g < size3; g++) {
      for (let r = 0; r < size3; r++) lines.push(row(film([r / (size3 - 1), g / (size3 - 1), b / (size3 - 1)])));
    }
  }
  return lines.join('\n') + '\n';
}

const filmText = (size: number): string => writeCube({ title: 'film', size, sample: (r, g, b) => film([r, g, b]) });
const tableOf = (text: string): LutTable => ({ ...parseCube(text), key: LUT_KEY });

const LUT_CASES: { name: string; grade: ClipGrade; table: () => LutTable }[] = [
  { name: 'lut 17 first', grade: { lut: { media: LUT_ID } }, table: () => tableOf(filmText(17)) },
  { name: 'lut 33 last', grade: { lut: { media: LUT_ID, last: true } }, table: () => tableOf(filmText(33)) },
  { name: 'lut 1d shaper + 3d', grade: { lut: { media: LUT_ID } }, table: () => tableOf(shaperText(33, 9)) },
  { name: 'lut 16 to 235', grade: { lut: { media: LUT_ID, tv: true } }, table: () => tableOf(filmText(17)) },
  { name: 'lut half mix', grade: { lut: { media: LUT_ID, mix: 0.5 } }, table: () => tableOf(filmText(17)) },
  {
    name: 'lut 2 points',
    grade: { lut: { media: LUT_ID } },
    table: () => tableOf(writeCube({ title: 'two', size: 2, sample: (r, g, b) => [r * 0.9 + 0.05, g, b * 0.8] })),
  },
  {
    name: 'lut with wheels and curves',
    grade: {
      liftB: 0.04,
      gainR: 0.06,
      gammaY: 0.1,
      curves: {
        y: [
          [0, 0],
          [0.3, 0.26],
          [0.75, 0.8],
          [1, 1],
        ],
        r: [
          [0, 0],
          [0.5, 0.54],
          [1, 1],
        ],
      },
      lut: { media: LUT_ID },
    },
    table: () => tableOf(filmText(17)),
  },
];

type Ctx2d = OffscreenCanvasRenderingContext2D;

/** the grid as a picture, and the same colors as numbers */
function gridPicture(): { canvas: OffscreenCanvas; colors: [number, number, number][] } {
  const colors: [number, number, number][] = [];
  const data = new Uint8ClampedArray(SIDE * SIDE * 4);
  let p = 0;
  for (const r of LEVELS) {
    for (const g of LEVELS) {
      for (const b of LEVELS) {
        colors.push([r, g, b]);
        data.set([r, g, b, 255], p * 4);
        p++;
      }
    }
  }
  const canvas = new OffscreenCanvas(SIDE, SIDE);
  const ctx = canvas.getContext('2d') as Ctx2d;
  ctx.putImageData(new ImageData(data, SIDE, SIDE), 0, 0);
  return { canvas, colors };
}

/** read a gl canvas back into 8 bit rgba */
function readBack(src: CanvasImageSource): Uint8ClampedArray {
  const c = new OffscreenCanvas(SIDE, SIDE);
  const ctx = c.getContext('2d', { willReadFrequently: true }) as Ctx2d;
  ctx.drawImage(src, 0, 0);
  return ctx.getImageData(0, 0, SIDE, SIDE).data;
}

/** the largest difference in 8 bit levels between a readback and what the mirror says (gradeLutColor of the grade data) */
function worstAgainst(back: Uint8ClampedArray, colors: [number, number, number][], d: GradeData): number {
  let worst = 0;
  for (let i = 0; i < colors.length; i++) {
    const [r, g, b] = colors[i]!;
    const out = gradeLutColor([r / 255, g / 255, b / 255], d);
    const x = i % SIDE;
    const y = Math.floor(i / SIDE);
    const n = ditherAt(x, y);
    for (let k = 0; k < 3; k++) {
      const want = Math.round(255 * Math.min(1, Math.max(0, out[k]! + n)));
      worst = Math.max(worst, Math.abs(back[i * 4 + k]! - want));
    }
  }
  return worst;
}

/** one grade through the clip look and the grade effect, each against the mirror. 255 = it did not draw. a lut needs its scope around the call */
function checkOne(canvas: OffscreenCanvas, colors: [number, number, number][], grade: ClipGrade): { look: number; effect: number } {
  const d = gradeData(grade);
  if (!d) return { look: 255, effect: 255 };
  const lit = clipLookTexture(canvas, SIDE, SIDE, { grade } as VisualClip, 'export');
  const look = lit === canvas ? 255 : worstAgainst(readBack(lit), colors, d);
  const pass = { def: gradeDefFor(d), time: 0, duration: 1, amount: 1, seed: 1, params: {}, grade: d };
  const out = renderEffects(canvas, SIDE, SIDE, [pass], { channel: CHANNEL, projectWidth: SIDE, projectHeight: SIDE });
  const effect = out ? worstAgainst(readBack(out), colors, d) : 255;
  return { look, effect };
}

/**
 * the clip look and the grade effect against the typescript mirror, on a 9 x 9 x 9 grid of 8 bit colors, for the fixed grades
 * and the lut cases (tables written by writeCube and read back by parseCube, behind a lookup like in a render). ok when none
 * is more than 1 level off
 */
export async function gradeParity(): Promise<{ ok: boolean; worst: number; grades: { name: string; look: number; effect: number }[] }> {
  const { canvas, colors } = gridPicture();
  if (!getEffect('grade')) throw new Error('the grade effect is not registered');
  const grades: { name: string; look: number; effect: number }[] = [];
  let worst = 0;
  try {
    for (const { name, grade } of FIXED) {
      const r = checkOne(canvas, colors, grade);
      grades.push({ name, ...r });
      worst = Math.max(worst, r.look, r.effect);
    }
    for (const { name, grade, table: make } of LUT_CASES) {
      const table = make();
      const lookup: LutLookup = (id) => (id === LUT_ID ? table : null);
      const r = withLuts(lookup, () => checkOne(canvas, colors, grade));
      grades.push({ name, ...r });
      worst = Math.max(worst, r.look, r.effect);
    }
  } finally {
    releaseClipLook('export');
    releaseEffectRunner(CHANNEL);
  }
  return { ok: worst <= 1, worst, grades };
}

const ADJUST: ClipAdjust = { brightness: 0.08, contrast: 0.12, saturation: 0.1, hue: 6, temperature: 0.05 };
const SCENE_GRADE: ClipGrade = {
  liftB: 0.04,
  liftY: 0.02,
  gammaY: 0.1,
  gainR: 0.06,
  gainB: -0.05,
  curves: {
    y: [
      [0, 0],
      [0.3, 0.26],
      [0.75, 0.8],
      [1, 1],
    ],
    r: [
      [0, 0],
      [0.5, 0.54],
      [1, 1],
    ],
    b: [
      [0, 0.02],
      [0.5, 0.47],
      [1, 1],
    ],
    hueSat: [
      [0, 0.6],
      [0.35, 0.4],
      [0.7, 0.6],
    ],
  },
};

/** 4k footage exported bare, with an adjust, and with an adjust plus a grade: the time of the whole export and of render per frame */
export async function gradeScene(): Promise<Record<string, unknown>> {
  const asset = await bench.footage(3840, 2160, 30, 3);
  const make = (kind: 'bare' | 'adjust' | 'grade') => {
    const p = bench.videoProject(asset, { width: 3840, height: 2160, fps: 30, seconds: 3 });
    for (const c of p.clips) {
      if (c.type !== 'video') continue;
      if (kind !== 'bare') c.adjust = { ...ADJUST };
      if (kind === 'grade') c.grade = structuredClone(SCENE_GRADE);
    }
    return p;
  };
  const out: Record<string, { ms: number; renderMs: number; frames: number }> = {};
  for (const kind of ['bare', 'adjust', 'grade'] as const) {
    const r = await bench.export(make(kind));
    const frames = r.stats?.frames ?? 0;
    out[kind] = { ms: r.ms, renderMs: frames > 0 ? Math.round((r.stats!.renderMs / frames) * 100) / 100 : 0, frames };
  }
  const over = (a: number, b: number) => (b > 0 ? Math.round((a / b - 1) * 1000) / 10 : 0);
  return {
    ...out,
    gradeOverAdjust: { exportPercent: over(out.grade!.ms, out.adjust!.ms), renderPercent: over(out.grade!.renderMs, out.adjust!.renderMs) },
  };
}

/** a lut file imported into the open project (found again by name) */
async function importLut(name: string, text: string): Promise<MediaAsset> {
  const have = useEditor.getState().project!.assets.find((a) => a.name === name);
  if (have) return have;
  const [asset] = await importFiles([new File([text], name)]);
  if (!asset) throw new Error(`${name} could not be imported`);
  return asset;
}

/**
 * 4k footage exported bare, with an adjust plus a grade, plus a 33 point film lut last, and plus a 4096 point shaper with a
 * 65 point table first: the time of the whole export and of render per frame, each lut over the adjust plus grade, and the
 * time to read a 65 point text. the lut files are imported like a user would (importFiles), the export reads them through
 * the store
 */
export async function lutScene(): Promise<Record<string, unknown>> {
  const asset = await bench.footage(3840, 2160, 30, 3);
  const filmAsset = await importLut('film.cube', filmText(33));
  const shaperAsset = await importLut('shaper.cube', shaperText(4096, 65));
  const text65 = filmText(65);
  const t0 = performance.now();
  parseCube(text65);
  const parseMs = Math.round((performance.now() - t0) * 10) / 10;
  const make = (kind: 'bare' | 'grade' | 'film33' | 'shaper65') => {
    const p = bench.videoProject(asset, { width: 3840, height: 2160, fps: 30, seconds: 3 });
    if (kind === 'film33') p.assets.push(filmAsset);
    if (kind === 'shaper65') p.assets.push(shaperAsset);
    for (const c of p.clips) {
      if (c.type !== 'video') continue;
      if (kind !== 'bare') {
        c.adjust = { ...ADJUST };
        c.grade = structuredClone(SCENE_GRADE);
      }
      if (kind === 'film33') c.grade = { ...c.grade, lut: { media: filmAsset.id, last: true } };
      if (kind === 'shaper65') c.grade = { ...c.grade, lut: { media: shaperAsset.id } };
    }
    return p;
  };
  const out: Record<string, { ms: number; renderMs: number; frames: number }> = {};
  for (const kind of ['bare', 'grade', 'film33', 'shaper65'] as const) {
    const r = await bench.export(make(kind));
    const frames = r.stats?.frames ?? 0;
    out[kind] = { ms: r.ms, renderMs: frames > 0 ? Math.round((r.stats!.renderMs / frames) * 100) / 100 : 0, frames };
  }
  const over = (a: number, b: number) => (b > 0 ? Math.round((a / b - 1) * 1000) / 10 : 0);
  const versus = (kind: 'film33' | 'shaper65') => ({ exportPercent: over(out[kind]!.ms, out.grade!.ms), renderPercent: over(out[kind]!.renderMs, out.grade!.renderMs) });
  return { ...out, film33OverGrade: versus('film33'), shaper65OverGrade: versus('shaper65'), parseMs };
}
