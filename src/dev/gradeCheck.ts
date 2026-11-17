/**
 * dev only, imported by nothing: checks of the grade on the real gpu. in the dev page:
 *   const m = await import('/src/dev/gradeCheck.ts'); await m.gradeParity(); await m.gradeScene();
 * gradeParity runs a grid of 8 bit colors through the clip look and the grade effect for 8 grades and compares both with
 * the typescript mirror (engine/grade.ts gradeColor and ditherAt). gradeScene times a 4k export bare, with an adjust
 * and with an adjust plus a grade.
 */
import type { ClipAdjust, ClipGrade, VisualClip } from '../types';
import { clipLookTexture, releaseClipLook } from '../engine/clipLook';
import { getEffect } from '../engine/effects/registry';
import { releaseEffectRunner, renderEffects } from '../engine/effects/runner';
import { DEMO_GRADE, ditherAt, gradeColor, gradeData } from '../engine/grade';
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

/** the largest difference in 8 bit levels between a readback and what the mirror says */
function worstAgainst(back: Uint8ClampedArray, colors: [number, number, number][], grade: ClipGrade): number {
  const d = gradeData(grade)!;
  let worst = 0;
  for (let i = 0; i < colors.length; i++) {
    const [r, g, b] = colors[i]!;
    const out = gradeColor([r / 255, g / 255, b / 255], d);
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

/** the clip look and the grade effect against the typescript mirror, on a 9 x 9 x 9 grid of 8 bit colors. ok when none is more than 1 level off */
export async function gradeParity(): Promise<{ ok: boolean; worst: number; grades: { name: string; look: number; effect: number }[] }> {
  const { canvas, colors } = gridPicture();
  const def = getEffect('grade');
  if (!def) throw new Error('the grade effect is not registered');
  const grades: { name: string; look: number; effect: number }[] = [];
  let worst = 0;
  try {
    for (const { name, grade } of FIXED) {
      const lit = clipLookTexture(canvas, SIDE, SIDE, { grade } as VisualClip, 'export');
      const look = lit === canvas ? 255 : worstAgainst(readBack(lit), colors, grade);
      const pass = { def, time: 0, duration: 1, amount: 1, seed: 1, params: {}, grade: gradeData(grade) ?? undefined };
      const out = renderEffects(canvas, SIDE, SIDE, [pass], { channel: CHANNEL, projectWidth: SIDE, projectHeight: SIDE });
      const effect = out ? worstAgainst(readBack(out), colors, grade) : 255;
      grades.push({ name, look, effect });
      worst = Math.max(worst, look, effect);
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
