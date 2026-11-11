/** list_options: the choices a client can put into other tools, read from the same registries the editor uses */
import { CLIP_MOTIONS_IN, CLIP_MOTIONS_LOOP, CLIP_MOTIONS_OUT, DEFAULT_CLIP_MOTION_IN, DEFAULT_CLIP_MOTION_LOOP, DEFAULT_CLIP_MOTION_OUT } from '../../engine/clipAnim';
import { EFFECTS } from '../../engine/effects/registry';
import { EFFECT_CATEGORIES } from '../../engine/effects/types';
import { faceNames } from '../../engine/scene3d/faces';
import { TEXT_ANIMS_IN, TEXT_ANIMS_LOOP, TEXT_ANIMS_OUT, DEFAULT_TEXT_ANIM_IN, DEFAULT_TEXT_ANIM_LOOP, DEFAULT_TEXT_ANIM_OUT } from '../../engine/textAnim';
import {
  DEFAULT_TRANSITION_DURATION,
  MAX_TRANSITION_DURATION,
  MIN_TRANSITION_DURATION,
  TRANSITION_CATEGORIES,
  TRANSITIONS,
} from '../../engine/transitions/registry';
import { SHAPE_PRESETS, solidOf } from '../../features/media/shapePresets';
import { TEXT_PRESETS } from '../../features/media/textPresets';
import { EASINGS } from '../../lib/anim';
import { CANVAS_PRESETS, FPS_OPTIONS } from '../../lib/factory';
import { listFonts } from '../../lib/fonts';
import { BLEND_MODES, MASK_SHAPES, MOTION_BLUR_STYLES, SHAPE_KINDS, SHAPES_3D } from '../../types';
import type { FaceFit, LookAt, TextAlign } from '../../types';
import { ok, ToolError } from '../helpers';
import type { ToolDef } from '../types';
import { fieldsReference } from './catalogFields';

const KINDS = ['effects', 'transitions', 'text_presets', 'shape_presets', 'shapes', 'motions', 'fonts', 'enums', 'fields'] as const;
type Kind = (typeof KINDS)[number];

// typed records: a new value in the type is a compile error here until it is described
const LOOK_AT: Record<LookAt, string> = {
  none: 'no turning toward anything',
  camera: 'faces the camera position (billboard)',
  cameraY: 'faces the camera but stays upright (turns left / right only)',
  clip: 'faces the centre of another clip (set lookTarget)',
};
const FACE_FITS: Record<FaceFit, string> = {
  fill: 'covers the side, cut where the proportions differ (default for video and image)',
  fit: 'shows all of the picture, the solid\'s own picture around it (default for text and shapes)',
  stretch: 'squeezes the whole picture onto the side',
};
const TEXT_ALIGN: Record<TextAlign, string> = { left: 'left aligned lines', center: 'centered lines', right: 'right aligned lines' };

const CATEGORIES = [...new Set([...EFFECT_CATEGORIES.map((c) => c.id), ...TRANSITION_CATEGORIES.map((c) => c.id)])];

function effects(category: string | undefined): unknown {
  if (category && !EFFECT_CATEGORIES.some((c) => c.id === category)) {
    throw new ToolError(`no effect category "${category}". effect categories: ${EFFECT_CATEGORIES.map((c) => c.id).join(', ')}`);
  }
  return {
    categories: EFFECT_CATEGORIES.map((c) => c.id),
    effects: EFFECTS.filter((e) => !category || e.category === category).map((e) => ({
      id: e.id,
      name: e.name,
      category: e.category,
      description: e.description,
      params: e.params.map((p) => ({
        key: p.key,
        label: p.label,
        min: p.min,
        max: p.max,
        default: p.default,
        ...(p.unit ? { unit: p.unit } : {}),
        ...(p.options ? { options: p.options } : {}),
      })),
    })),
    note: 'add_effect takes the id. params go in as { key: number }; a param with options takes the index of the option (0 = the first)',
  };
}

function transitions(category: string | undefined): unknown {
  if (category && !TRANSITION_CATEGORIES.some((c) => c.id === category)) {
    throw new ToolError(`no transition category "${category}". transition categories: ${TRANSITION_CATEGORIES.map((c) => c.id).join(', ')}`);
  }
  return {
    categories: TRANSITION_CATEGORIES.map((c) => c.id),
    transitions: TRANSITIONS.filter((t) => !category || t.category === category).map((t) => ({ id: t.id, name: t.name, category: t.category })),
    duration: { default: DEFAULT_TRANSITION_DURATION, min: MIN_TRANSITION_DURATION, max: MAX_TRANSITION_DURATION },
    note: 'a transition goes on a picture clip (update_clip patch { transition: { id, duration } }) and plays into it from what comes before on its track',
  };
}

function motionList(list: readonly { id: string; name: string; threeD?: boolean }[]): unknown[] {
  return list.map((m) => ({ id: m.id, name: m.name, ...(m.threeD ? { threeD: true } : {}) }));
}

function fonts(): unknown {
  let list: ReturnType<typeof listFonts> = [];
  try {
    // only what ships with the app: system, local and imported fonts depend on the machine
    list = listFonts().filter((f) => f.category !== 'system' && f.category !== 'local' && f.category !== 'imported');
  } catch {
    list = [];
  }
  return {
    fonts: list.map((f) => ({ family: f.family, category: f.category, weights: f.weights, italic: f.italic })),
    note: 'these ship with ncut. a font installed on the computer (Arial, Georgia, ...) works by its family name too. text clips use weight 400 or 700',
  };
}

function enums(): unknown {
  return {
    blendModes: [...BLEND_MODES],
    maskShapes: [...MASK_SHAPES],
    easings: EASINGS.map((e) => ({ id: e.id, label: e.label })),
    lookAt: Object.entries(LOOK_AT).map(([id, meaning]) => ({ id, meaning })),
    faceFits: Object.entries(FACE_FITS).map(([id, meaning]) => ({ id, meaning })),
    canvasPresets: CANVAS_PRESETS.map((p) => ({ id: p.id, width: p.width, height: p.height })),
    fps: [...FPS_OPTIONS],
    motionBlurStyles: [...MOTION_BLUR_STYLES],
    textAlign: Object.entries(TEXT_ALIGN).map(([id, meaning]) => ({ id, meaning })),
  };
}

function run(args: Record<string, unknown>) {
  const kind = args.kind as Kind;
  const category = typeof args.category === 'string' ? args.category : undefined;
  if (category && kind !== 'effects' && kind !== 'transitions') {
    throw new ToolError(`category only filters effects and transitions, not ${kind}`);
  }
  switch (kind) {
    case 'effects':
      return ok(effects(category));
    case 'transitions':
      return ok(transitions(category));
    case 'text_presets':
      return ok({
        presets: TEXT_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint })),
        note: 'add_text takes the id as preset; fields then change single values on top',
      });
    case 'shape_presets':
      return ok({
        presets: SHAPE_PRESETS.map((p) => {
          const solid = solidOf(p);
          return { id: p.id, label: p.label, hint: p.hint, ...(solid ? { solid } : {}) };
        }),
        note: 'add_shape takes the id as preset. "solid" marks a 3d preset and names its shape',
      });
    case 'shapes':
      return ok({
        kinds: [...SHAPE_KINDS],
        shapes3d: SHAPES_3D.map((s) => ({ id: s, sides: [...faceNames(s)] })),
        note: 'kinds are the flat figures of add_shape. shapes3d is what a 3d clip can be wrapped on (shape field); sides are the names set_sides takes, "all" stands for every side without its own entry. a plane has no sides',
      });
    case 'motions':
      return ok({
        clip: {
          in: motionList(CLIP_MOTIONS_IN),
          out: motionList(CLIP_MOTIONS_OUT),
          loop: motionList(CLIP_MOTIONS_LOOP),
          defaultDuration: { in: DEFAULT_CLIP_MOTION_IN, out: DEFAULT_CLIP_MOTION_OUT, loop: DEFAULT_CLIP_MOTION_LOOP },
        },
        text: {
          in: motionList(TEXT_ANIMS_IN),
          out: motionList(TEXT_ANIMS_OUT),
          loop: motionList(TEXT_ANIMS_LOOP),
          defaultDuration: { in: DEFAULT_TEXT_ANIM_IN, out: DEFAULT_TEXT_ANIM_OUT, loop: DEFAULT_TEXT_ANIM_LOOP },
        },
        note: 'clip motions: update_clip patch motionIn / motionOut / motionLoop { id, duration } on any picture clip (threeD ones need a 3d clip). text animations: animIn / animOut / animLoop on a text clip. duration of in / out = seconds the move takes, of loop = seconds per cycle',
      });
    case 'fonts':
      return ok(fonts());
    case 'enums':
      return ok(enums());
    case 'fields':
      return ok(fieldsReference());
  }
}

export const catalogTools: ToolDef[] = [
  {
    name: 'list_options',
    title: 'list the choices',
    description:
      'what the editor offers, read from its own lists, so ids are always right. kind: ' +
      'effects (id, name, category, params with min / max / default / options, for add_effect), transitions, text_presets, shape_presets, ' +
      'shapes (flat kinds, 3d solids and the side names of each, for set_sides), motions (clip in / out / loop and text in / out / loop), fonts (the bundled ones), ' +
      'enums (blend modes, mask shapes, easings, look at, side fits, canvas presets, fps, motion blur styles, text align) and ' +
      'fields (every field update_clip takes per clip type, with units and ranges). ' +
      'category narrows effects (motion, blur, color, distort, stylize, overlay) or transitions (fade, move, wipe, stylize, 3d). effects is the long answer: filter it.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: KINDS },
        category: { type: 'string', enum: CATEGORIES, description: 'only for effects and transitions' },
      },
      required: ['kind'],
    },
    annotations: { readOnlyHint: true },
    run,
  },
];
