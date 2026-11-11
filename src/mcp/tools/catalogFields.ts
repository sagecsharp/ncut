/**
 * what update_clip takes, per clip type (list_options kind 'fields'). the names are checked by the compiler against
 * the clip interfaces (keyof) and by catalog.test.ts against the real store, so this cannot drift quietly.
 * `example` is a value the store accepts; it is shown for fields that hold an object.
 */
import { BPM_MAX, BPM_MIN } from '../../lib/tempo';
import { MAX_SPEED, MIN_SPEED, type AudioClip, type CameraClip, type EffectClip, type ShapeClip, type TextClip, type VideoClip } from '../../types';

export interface FieldRow {
  field: string;
  type: string;
  note: string;
  example?: unknown;
}

function rows<T>(list: readonly (readonly [keyof T & string, string, string, unknown?])[]): FieldRow[] {
  return list.map(([field, type, note, example]) => {
    const sample = example ?? (type === 'boolean' ? true : undefined);
    return { field, type, note, ...(sample !== undefined ? { example: sample } : {}) };
  });
}

const TRANSFORM_NOTE =
  'send only the keys that change. x, y: px from the canvas middle (+x right, +y down). scale 0.01..100 (1 = fits the canvas for media, natural size for text). ' +
  'scaleX, scaleY, scaleZ 0.01..100: stretch on top of scale. rotation: deg clockwise. opacity 0..1. z (px, + away), rotX (tilt deg), rotY (turn deg): 3d clips only';

/** every clip */
export const COMMON_FIELDS: FieldRow[] = rows<TextClip>([
  ['name', 'string', 'label shown on the timeline'],
  ['fadeIn', 'number s, 0 or more', 'fade in at the head (picture opacity, sound gain). the store keeps it inside the clip length (fadeIn + fadeOut together at most the clip length)'],
  ['fadeOut', 'number s, 0 or more', 'fade out at the tail, kept inside the clip length like fadeIn'],
]);

/** video, image, text and shape clips (everything with a picture) */
export const PICTURE_FIELDS: FieldRow[] = rows<TextClip>([
  ['transform', 'object', TRANSFORM_NOTE, { x: 100, y: -50, scale: 1.2, rotation: 15, opacity: 0.8 }],
  ['threeD', 'boolean', 'true = a plane in 3d space seen through the camera clip (z, rotX, rotY, shape then apply)', true],
  ['lookAt', "'none' | 'camera' | 'cameraY' | 'clip'", "3d: face the camera (camera), face it but stay upright (cameraY), face another clip's centre (clip, needs lookTarget)", 'camera'],
  ['lookTarget', 'clip id | null', "lookAt 'clip': the visual clip to face", 'clp_id'],
  ['shape', 'enum', "3d: what the clip is wrapped on: plane, box, sphere, cylinder, cone, pyramid, torus, capsule, prism, hexagon, star, heart. list_options 'shapes' has the side names", 'box'],
  ['shapeDepth', 'number px 1..10000', '3d solids: thickness at scale 1. missing = as deep as wide', 120],
  ['transition', '{ id, duration } | null', 'transition into this clip from what comes before it on the track. id from list_options transitions, duration 0.1..5 s (an error outside), centred on the clip start', { id: 'cross-fade', duration: 0.6 }],
  ['blend', 'enum', 'how the picture mixes with what is under it: list_options enums blendModes', 'screen'],
  ['crop', '{ left, top, right, bottom } | null', 'cut off edges, each 0..0.95 of the picture width / height. the picture keeps its place', { left: 0.1, top: 0, right: 0.1, bottom: 0 }],
  ['radius', 'number 0..1', 'corner roundness of the picture (1 = fully round ends)', 0.2],
  ['motionIn', '{ id, duration } | null', "entrance motion, id from list_options motions (clip.in), duration in s 0.05..60 (default 0.5)", { id: 'fade', duration: 0.5 }],
  ['motionOut', '{ id, duration } | null', 'exit motion, same ids and duration range as motionIn', { id: 'fade', duration: 0.5 }],
  ['motionLoop', '{ id, duration } | null', 'motion while on screen, id from list_options motions (clip.loop), duration = seconds per cycle 0.05..60 (default 2)', { id: 'float', duration: 2 }],
  ['parent', 'clip id | null', "attach to a visual or camera clip: this clip's transform is then relative to it. a loop is ignored", 'clp_id'],
  ['motionBlur', '{ shutter, samples, style? } | null', "blurs the clip's own moves. shutter 0..2 frames (0.5 = classic), samples 2..32, style even | trail | ghost", { shutter: 0.5, samples: 8 }],
  ['adjust', '{ brightness, contrast, saturation, hue, temperature } | null', 'colour correction: brightness, contrast, saturation, temperature -1..1, hue -180..180 deg. all 0 = no change', { brightness: 0.1, contrast: 0.2, saturation: 0, hue: 0, temperature: 0 }],
  ['chromaKey', '{ color, tolerance, softness, spill } | null', 'green screen: color hex to remove, tolerance, softness, spill each 0..1', { color: '#00ff00', tolerance: 0.3, softness: 0.1, spill: 0.5 }],
  ['mask', '{ shape, x, y, width, height, rotation, feather, invert, radius? } | null', 'show part of the picture. shape rect | ellipse | split | band | star | heart. x, y -1..1 and width, height 0..3 are fractions of the picture, rotation -360..360 deg, feather 0..1, invert boolean, radius 0..1 (rect)', { shape: 'ellipse', x: 0, y: 0, width: 0.8, height: 0.8, rotation: 0, feather: 0.1, invert: false }],
]);

const SOUND_FIELDS = [
  ['volume', 'number 0..2', 'linear gain, 1 = as recorded (an error outside the range)'],
  ['muted', 'boolean', 'silence this clip'],
  ['speed', `number ${MIN_SPEED}..${MAX_SPEED}`, 'playback rate, 1 = normal. outside the range the store clamps it (10 gives 4) and the answer still says speed changed. the clip gets shorter or longer to match (clamped to the next clip on the track)'],
  ['bpm', `number ${BPM_MIN}..${BPM_MAX} | null`, 'tempo of the sound, for effects that follow the beat. null = unknown, and a number outside the range is stored as null', 120],
  ['beatOffset', 'number s | null', 'source seconds where a beat falls', 0.2],
] as const;

export const VIDEO_FIELDS: FieldRow[] = rows<VideoClip>(SOUND_FIELDS);
export const AUDIO_FIELDS: FieldRow[] = rows<AudioClip>(SOUND_FIELDS);

export const TEXT_FIELDS: FieldRow[] = rows<TextClip>([
  ['text', 'string', 'the words. line breaks (\\n) make lines'],
  ['fontFamily', 'string', "a family name: list_options fonts shows the bundled ones, an installed system font works by its name too (e.g. 'Arial')"],
  ['fontSize', 'number px 4..1000', 'at scale 1'],
  ['fontWeight', '400 | 700', 'normal or bold'],
  ['italic', 'boolean', ''],
  ['color', 'css colour', 'fill, e.g. #ffffff'],
  ['background', 'css colour | null', 'a box behind the text'],
  ['align', "'left' | 'center' | 'right'", 'line alignment'],
  ['letterSpacing', 'number -0.5..2', 'extra space between letters as a fraction of the font size', 0.05],
  ['lineHeight', 'number 0.5..3', 'multiple of the font size (default 1.25)', 1.4],
  ['uppercase', 'boolean', 'draw in capitals'],
  ['stroke', '{ color, width } | null', 'outline. width 0..0.5 of the font size', { color: '#000000', width: 0.08 }],
  ['stroke2', '{ color, width } | null', 'second outline around the first (sticker look), width 0..0.5 of the font size', { color: '#ffffff', width: 0.08 }],
  ['shadow', '{ color, opacity, blur, distance, angle } | null', 'drop shadow. opacity, blur, distance 0..1 (fractions of the font size), angle -360..360 deg (0 right, 90 down)', { color: '#000000', opacity: 0.5, blur: 0.1, distance: 0.05, angle: 45 }],
  ['backgroundRadius', 'number 0..1', 'corner roundness of the background box (1 = pill)', 0.3],
  ['backgroundPadding', 'number 0..2', 'space between text and box edge, fraction of the font size (default 0.3)', 0.4],
  ['backgroundPerLine', 'boolean', 'one box per line hugging its width (caption look)'],
  ['gradient', '{ from, to, angle } | null', 'gradient fill instead of color. angle -360..360 deg, 0 = left to right', { from: '#ff0080', to: '#ffd000', angle: 90 }],
  ['curve', 'number -360..360 deg', 'bend along a circle: + arch, - smile, 360 = ring', 30],
  ['wrapWidth', 'number px 0..20000', 'wrap lines longer than this. 0 = only break at line breaks', 800],
  ['highlight', "{ color, mode, background? } | null", "karaoke: words light up one after another over the clip. mode 'word' | 'fill'", { color: '#ffe14d', mode: 'word' }],
  ['extrude', '{ depth, angle, color } | null', 'block letters / long shadow. depth 0.01..1 of the font size, angle 0..360 deg clockwise from right (3d text: real depth)', { depth: 0.2, angle: 45, color: '#888888' }],
  ['counter', '{ from, to, decimals, separator?, ease?, hold?, format?, fixedWidth? } | null', "a running number: every {n} in text is replaced (no {n} = only the number). decimals 0..4, ease linear | out | in-out, hold = seconds the end value stays, format 'number' | 'time' (m:ss)", { from: 0, to: 100, decimals: 0 }],
  ['underline', 'boolean', 'line under every line of text'],
  ['strike', 'boolean', 'line through the text'],
  ['hollow', 'boolean', 'only the outline shows (needs stroke, else a thin one is drawn)'],
  ['animIn', '{ id, duration } | null', 'per letter / word entrance, id from list_options motions (text.in), duration s (default 0.6)', { id: 'fade', duration: 0.6 }],
  ['animOut', '{ id, duration } | null', 'exit, same ids as animIn', { id: 'fade', duration: 0.6 }],
  ['animLoop', '{ id, duration } | null', 'loop while on screen, id from list_options motions (text.loop), duration = seconds per cycle (default 1.5)', { id: 'wave', duration: 1.5 }],
]);

export const SHAPE_FIELDS: FieldRow[] = rows<ShapeClip>([
  ['kind', 'enum', "rect, ellipse, triangle, polygon, star, heart, arrow, line (list_options 'shapes')"],
  ['width', 'number px 1..20000', "the shape's box at scale 1"],
  ['height', 'number px 1..20000', ''],
  ['color', 'css colour', 'fill, also the first gradient colour'],
  ['color2', 'css colour | null', 'second gradient colour. null = flat fill', '#ff0080'],
  ['gradientAngle', 'number -360..360 deg', '0 = left to right, 90 = top to bottom (default)', 45],
  ['gradientRadial', 'boolean', 'gradient runs from the centre outwards', true],
  ['filled', 'boolean', 'false = outline only'],
  ['stroke', '{ color, width } | null', 'outline. width 0..500 px', { color: '#ffffff', width: 6 }],
  ['points', 'integer 3..12', 'polygon corners (default 6) or star points (default 5)', 7],
  ['inner', 'number 0.1..0.95', 'star: inner radius as a share of the outer (default 0.45)', 0.5],
  ['drawStart', 'number 0..1', 'draw on: where the drawn part of the outline begins. keyframe it to wipe off', 0.1],
  ['drawEnd', 'number 0..1', 'where it ends. keyframe 0 to 1 to draw a line on', 0.9],
]);

export const EFFECT_FIELDS: FieldRow[] = rows<EffectClip>([
  ['amount', 'number 0..1', 'overall strength (also scaled by fadeIn / fadeOut)'],
  ['params', '{ key: number }', "the effect's own numbers by key (list_options effects). values are clamped to each param's range", { amount: 0.5 }],
  ['seed', 'number', 'varies the random parts between clips'],
  ['target', 'clip id | null', 'a visual clip this effect works on alone, wherever the tracks are. null = everything under the effect track', 'clp_id'],
  ['timeOffset', 'number s', 'seconds added to the animation time', 0.5],
  ['fullDuration', 'number s, 0 or more', 'length the effect spreads its move over (set by splits and trims)', 3],
  ['beat', '{ source?, every, pulse, lock } | null', 'follow a tempo: source = clip id with a bpm (default the sound under it), every = beats per cycle 0.0625..64, pulse 0..1, lock boolean', { every: 1, pulse: 0.5, lock: false }],
]);

export const CAMERA_FIELDS: FieldRow[] = rows<CameraClip>([
  ['x', 'number px', 'offset from the home pose, +x right'],
  ['y', 'number px', '+y down'],
  ['z', 'number px', '+z forward, toward the scene'],
  ['pan', 'number deg', '+ looks right'],
  ['tilt', 'number deg', '+ looks up'],
  ['roll', 'number deg', '+ turns clockwise'],
  ['fov', 'number deg 5..150', 'vertical field of view (home 50). smaller zooms in'],
  ['target', 'clip id | null', 'a visual clip the camera keeps looking at; pan / tilt are added on top', 'clp_id'],
  ['focusStrength', 'number 0..1', 'depth of field for 3d clips. 0 = everything sharp', 0.5],
  ['focusDistance', 'number px, 1 or more', 'distance from the camera that is sharp (default the home distance)', 800],
  ['focusRange', 'number px, 0 or more', 'depth around the focus distance that stays sharp', 100],
  ['focusOnTarget', 'boolean', 'focus follows the target clip', true],
]);

/** what the tool answers for kind 'fields' */
export function fieldsReference(): Record<string, unknown> {
  const out = (list: FieldRow[]) =>
    list.map((r) => ({
      field: r.field,
      type: r.type,
      ...(r.note ? { note: r.note } : {}),
      ...(r.example !== undefined && typeof r.example === 'object' ? { example: r.example } : {}),
    }));
  return {
    notes: [
      'update_clip { id, patch }: patch holds any of the fields below for the clip type. a field the type does not have is an error. null removes an optional object field.',
      'not in patch: start (move_clip), duration and trimStart (trim_clip), the track (move_clip), keyframes (set_keyframe / set_keyframes), the sides of a solid (set_sides), the effect id (make a new effect clip).',
      'colours are css hex strings like #ff8800. times are seconds, sizes and positions project pixels.',
      'every picture clip (video, image, text, shape) takes the fields in "picture" as well as its own.',
    ],
    all: out(COMMON_FIELDS),
    picture: out(PICTURE_FIELDS),
    video: out(VIDEO_FIELDS),
    image: [],
    audio: out(AUDIO_FIELDS),
    text: out(TEXT_FIELDS),
    shape: out(SHAPE_FIELDS),
    effect: out(EFFECT_FIELDS),
    camera: out(CAMERA_FIELDS),
  };
}
