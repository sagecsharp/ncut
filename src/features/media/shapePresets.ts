/** shape cards of the shapes tab. pure data: no react, no canvas. */
import type { ShapeClip } from '../../types';

export interface ShapePreset {
  id: string;
  label: string;
  hint: string;
  /** the clip fields the card applies. canvas = the project size when the card is used. */
  build(canvasW: number, canvasH: number): Partial<ShapeClip>;
}

/** two soft grays used by the "background" card when it is built. they are real colors of the clip. */
export const BG_GRADIENT_TOP = '#3a3a3a';
export const BG_GRADIENT_BOTTOM = '#141414';
export const BG_SOLID = '#202020';

const OUTLINE = { color: '#ffffff', width: 12 };

function named(label: string, fields: Partial<ShapeClip>): Partial<ShapeClip> {
  return { name: label, ...fields };
}

export const SHAPE_PRESETS: readonly ShapePreset[] = [
  {
    id: 'rectangle',
    label: 'rectangle',
    hint: 'plain box',
    build: () => named('rectangle', { kind: 'rect', width: 600, height: 380 }),
  },
  {
    id: 'rounded',
    label: 'rounded',
    hint: 'rectangle with soft corners',
    build: () => named('rounded', { kind: 'rect', width: 600, height: 380, radius: 0.25 }),
  },
  {
    id: 'circle',
    label: 'circle',
    hint: 'equal sides',
    build: () => named('circle', { kind: 'ellipse', width: 400, height: 400 }),
  },
  {
    id: 'ellipse',
    label: 'ellipse',
    hint: 'wide oval',
    build: () => named('ellipse', { kind: 'ellipse', width: 600, height: 360 }),
  },
  {
    id: 'triangle',
    label: 'triangle',
    hint: 'points up',
    build: () => named('triangle', { kind: 'triangle', width: 440, height: 400 }),
  },
  {
    id: 'hexagon',
    label: 'hexagon',
    hint: 'six corners',
    build: () => named('hexagon', { kind: 'polygon', points: 6, width: 440, height: 400 }),
  },
  {
    id: 'star',
    label: 'star',
    hint: 'five points',
    build: () => named('star', { kind: 'star', points: 5, width: 420, height: 400 }),
  },
  {
    id: 'heart',
    label: 'heart',
    hint: 'a heart',
    build: () => named('heart', { kind: 'heart', width: 420, height: 380 }),
  },
  {
    id: 'arrow',
    label: 'arrow',
    hint: 'points right',
    build: () => named('arrow', { kind: 'arrow', width: 600, height: 260 }),
  },
  {
    id: 'line',
    label: 'line',
    hint: 'thin bar',
    build: () => named('line', { kind: 'line', width: 600, height: 12 }),
  },
  {
    id: 'outline',
    label: 'outline',
    hint: 'square with only a border',
    build: () => named('outline', { kind: 'rect', width: 400, height: 400, filled: false, stroke: { ...OUTLINE } }),
  },
  {
    id: 'background',
    label: 'background',
    hint: 'full frame, soft two color gradient',
    build: (w, h) =>
      named('background', {
        kind: 'rect',
        width: Math.max(1, Math.round(w)),
        height: Math.max(1, Math.round(h)),
        color: BG_GRADIENT_TOP,
        color2: BG_GRADIENT_BOTTOM,
        gradientAngle: 90,
        gradientRadial: false,
      }),
  },
  {
    id: 'solid-background',
    label: 'solid background',
    hint: 'full frame, one color',
    build: (w, h) =>
      named('solid background', {
        kind: 'rect',
        width: Math.max(1, Math.round(w)),
        height: Math.max(1, Math.round(h)),
        color: BG_SOLID,
      }),
  },
];

export interface PreviewBox {
  /** size of the shape inside the preview canvas, css px */
  w: number;
  h: number;
}

/** fit a shape of ratio w:h into a box, keeping the ratio. thin shapes keep at least `minSide` css px. */
export function fitPreview(w: number, h: number, boxW: number, boxH: number, minSide = 3): PreviewBox {
  const sw = Math.max(1, w);
  const sh = Math.max(1, h);
  const k = Math.min(boxW / sw, boxH / sh);
  return { w: Math.max(minSide, sw * k), h: Math.max(minSide, sh * k) };
}

/** background cards use the real frame ratio (the project size when the card is used, not at load) */
export function isFullFrame(preset: Partial<ShapeClip>, canvasW: number, canvasH: number): boolean {
  return preset.kind === 'rect' && preset.width === Math.round(canvasW) && preset.height === Math.round(canvasH);
}
