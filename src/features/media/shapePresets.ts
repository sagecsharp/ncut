/** shape cards of the shapes tab. pure data: no react, no canvas. */
import { DEFAULT_TRANSFORM } from '../../types';
import type { Shape3D, ShapeClip } from '../../types';
import { isOutlineShape, outlineFor } from '../../engine/scene3d/outline2d';

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

/** id of the card that makes an invisible clip to attach others to */
export const HANDLE_ID = 'handle';

/** draw on: the outline grows from nothing to whole over the first second of the clip (keys are clip-local) */
function drawOn(): Pick<ShapeClip, 'keyframes'> {
  return {
    keyframes: {
      drawEnd: [
        { t: 0, v: 0, ease: 'ease' },
        { t: 1, v: 1, ease: 'ease' },
      ],
    },
  };
}

function named(label: string, fields: Partial<ShapeClip>): Partial<ShapeClip> {
  return { name: label, ...fields };
}

/** a little tilt so a solid reads as a solid instead of a flat figure (degrees) */
const SOLID_TILT = { rotX: 14, rotY: 28 };

/** a ready-made 3d solid: a flat colored figure wrapped on the given 3d shape */
function solid(id: string, label: string, hint: string, shape: Shape3D, size?: { w: number; h: number; depth: number }): ShapePreset {
  return {
    id,
    label,
    hint,
    build: () =>
      named(label, {
        kind: 'rect',
        width: size?.w ?? 400,
        height: size?.h ?? 400,
        ...(size ? { shapeDepth: size.depth } : {}),
        threeD: true,
        shape,
        transform: { ...DEFAULT_TRANSFORM, ...SOLID_TILT },
      }),
  };
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
    id: 'drawn-circle',
    label: 'drawn circle',
    hint: 'a circle that draws itself on',
    build: () => named('drawn circle', { kind: 'ellipse', width: 400, height: 400, filled: false, stroke: { ...OUTLINE }, ...drawOn() }),
  },
  {
    id: 'drawn-underline',
    label: 'drawn underline',
    hint: 'a line that draws on from left to right',
    build: () => named('drawn underline', { kind: 'line', width: 600, height: 12, ...drawOn() }),
  },
  {
    id: 'drawn-arrow',
    label: 'drawn arrow',
    hint: 'an arrow that draws on, head last',
    build: () => named('drawn arrow', { kind: 'arrow', width: 600, height: 260, ...drawOn() }),
  },
  {
    // like an empty object in a game engine: nothing to see, a place to hang other clips on
    id: HANDLE_ID,
    label: 'empty',
    hint: 'draws nothing. attach clips to it and move, turn or scale them as one',
    build: () => named('empty', { kind: 'rect', width: 200, height: 200, filled: false, stroke: null, threeD: true }),
  },
  solid('cone', 'cone', '3d, round base and a point', 'cone'),
  solid('pyramid', 'pyramid', '3d, square base and a point', 'pyramid'),
  solid('ring', 'ring', '3d, a donut', 'torus'),
  // sizes follow the natural ratio of each outline, so the figure is not stretched
  solid('capsule', 'capsule', '3d, a tube with round ends', 'capsule', { w: 240, h: 480, depth: 240 }),
  solid('prism', 'prism', '3d, a triangle pushed back', 'prism', { w: 400, h: 346, depth: 140 }),
  solid('hexagon-3d', '3d hexagon', '3d, six sides pushed back', 'hexagon', { w: 347, h: 400, depth: 140 }),
  solid('star-3d', '3d star', '3d, a five point star pushed back', 'star', { w: 400, h: 380, depth: 120 }),
  solid('heart-3d', '3d heart', '3d, a heart pushed back', 'heart', { w: 400, h: 360, depth: 140 }),
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

/** the 3d shape a card makes, or null for a flat figure */
export function solidOf(preset: ShapePreset): Shape3D | null {
  const b = preset.build(1920, 1080);
  return b.threeD && b.shape && b.shape !== 'plane' ? b.shape : null;
}

/** one piece of a flat silhouette in a box from -0.5 to 0.5 on both axes (y down) */
export type SolidPart =
  | { kind: 'poly'; pts: [number, number][] }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; hole?: boolean };

/** a simple flat silhouette of a 3d shape, for the card thumbnail. filled with one color; holes cut out. */
export function solidSilhouette(shape: Shape3D): SolidPart[] {
  switch (shape) {
    case 'cone':
      return [
        { kind: 'poly', pts: [[0, -0.5], [0.5, 0.36], [-0.5, 0.36]] },
        { kind: 'ellipse', cx: 0, cy: 0.36, rx: 0.5, ry: 0.14 },
      ];
    case 'pyramid':
      return [{ kind: 'poly', pts: [[0, -0.5], [0.5, 0.3], [0.05, 0.5], [-0.5, 0.3]] }];
    case 'torus':
      return [
        { kind: 'ellipse', cx: 0, cy: 0, rx: 0.5, ry: 0.36 },
        { kind: 'ellipse', cx: 0, cy: 0, rx: 0.2, ry: 0.12, hole: true },
      ];
    case 'box':
      return [{ kind: 'poly', pts: [[-0.4, -0.4], [0.2, -0.4], [0.5, -0.2], [0.5, 0.4], [-0.1, 0.4], [-0.4, 0.2]] }];
    case 'sphere':
      return [{ kind: 'ellipse', cx: 0, cy: 0, rx: 0.5, ry: 0.5 }];
    case 'capsule':
      return [
        { kind: 'poly', pts: [[-0.27, -0.24], [0.27, -0.24], [0.27, 0.24], [-0.27, 0.24]] },
        { kind: 'ellipse', cx: 0, cy: -0.24, rx: 0.27, ry: 0.26 },
        { kind: 'ellipse', cx: 0, cy: 0.24, rx: 0.27, ry: 0.26 },
      ];
    case 'cylinder':
      return [
        { kind: 'poly', pts: [[-0.4, -0.35], [0.4, -0.35], [0.4, 0.35], [-0.4, 0.35]] },
        { kind: 'ellipse', cx: 0, cy: -0.35, rx: 0.4, ry: 0.13 },
        { kind: 'ellipse', cx: 0, cy: 0.35, rx: 0.4, ry: 0.13 },
      ];
    default:
      if (isOutlineShape(shape)) {
        // the outline twice, the back copy up and to the right: one fill reads as a thick figure
        const o = outlineFor(shape);
        const copy = (dx: number, dy: number): SolidPart => {
          const pts: [number, number][] = [];
          for (let i = 0; i < o.points.length; i += 2) pts.push([o.points[i]! * 0.8 + dx, o.points[i + 1]! * 0.8 + dy]);
          return { kind: 'poly', pts };
        };
        return [copy(0.1, -0.1), copy(-0.1, 0.1)];
      }
      return [{ kind: 'poly', pts: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] }];
  }
}
