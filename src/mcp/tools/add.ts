import { getEffect } from '../../engine/effects/registry';
import { effectHomeTrack } from '../../features/properties/clipEffects';
import { SHAPE_PRESETS, solidOf } from '../../features/media/shapePresets';
import { TEXT_PRESETS } from '../../features/media/textPresets';
import { createEffectClip } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import type { Clip, Shape3D, ShapeClip, ShapeKind, TextClip } from '../../types';
import { DEFAULT_TRANSFORM, isVisualClip, SHAPE_KINDS, SHAPES_3D } from '../../types';
import { clipBrief, needClip, needProject, ok, optNumber, optString, round, ToolError } from '../helpers';
import type { JsonSchema, ToolDef } from '../types';
import { applyPatch, MAX_TIME, step, videoTrackArg } from './editPatch';

const SOLIDS = SHAPES_3D.filter((s) => s !== 'plane');

/** arguments every new clip takes */
const PLACE: Record<string, JsonSchema> = {
  track: { type: 'string', description: 'id of a video track to put the clip on. default: a track with room at start (a new one when none has)' },
  start: { type: 'number', minimum: 0, maximum: MAX_TIME, description: 'start on the timeline in seconds. default: the playhead' },
  duration: { type: 'number', minimum: 0.05, maximum: MAX_TIME, description: 'length in seconds. default depends on the kind (text 4, shape 4, effect 3, camera 5)' },
};

const FIELDS: JsonSchema = {
  type: 'object',
  description: 'fields to set on the new clip in the same undo step: the same object update_clip takes as patch, for example { "color": "#ff0000", "transform": { "y": 300 } }',
};

function startOf(args: Record<string, unknown>): number {
  return optNumber(args.start) ?? usePlayback.getState().time;
}

/** a note when the clip did not land where it was asked to (the store moves it to free room and says nothing) */
function landing(clip: Clip, asked: number, track: string | undefined): { note: string } | Record<string, never> {
  const parts: string[] = [];
  if (track !== undefined && clip.trackId !== track) parts.push(`it went on the track ${clip.trackId} instead of ${track}`);
  if (Math.abs(clip.start - asked) > 1e-6) parts.push(`it starts at ${round(clip.start)} s instead of ${round(asked)} s`);
  return parts.length > 0 ? { note: `${parts.join(' and ')}: the spot asked for was taken by another clip` } : {};
}

/** the new clip, after the optional fields were applied. a failing field takes the whole add back (step) */
function finish(id: string, fields: unknown, opts: { skipHistory?: boolean }): Clip {
  if (fields && typeof fields === 'object' && Object.keys(fields).length > 0) applyPatch(id, fields as Record<string, unknown>, opts);
  return needClip(id);
}

const addText: ToolDef = {
  name: 'add_text',
  title: 'add a text clip',
  description:
    'add a text clip, in one undo step. preset is one of the text cards of the editor (list_options with kind "text_presets" lists them with what they look like); without one the clip is plain centered white 96 px text. text is the words (it replaces the preset\'s sample text). ' +
    'start is the timeline time in seconds (default the playhead), duration in seconds (default 4), track must be a video track. ' +
    'fields takes anything update_clip takes (fontSize, color, fontFamily, transform, ...) and is applied in the same step. ' +
    'answers the brief of the new clip (id, track, start, end). use update_clip to change it later.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', maxLength: 5000, description: 'the words to show' },
      preset: { type: 'string', enum: TEXT_PRESETS.map((p) => p.id), description: 'a text card' },
      ...PLACE,
      fields: FIELDS,
    },
  },
  run(args) {
    const p = needProject();
    const track = videoTrackArg(args.track);
    let base: Partial<TextClip> = {};
    if (args.preset !== undefined) {
      const preset = TEXT_PRESETS.find((x) => x.id === args.preset);
      if (!preset) throw new ToolError(`no text preset "${String(args.preset)}". list_options with kind "text_presets" lists them`);
      base = preset.build(p.width, p.height);
    }
    const text = optString(args.text);
    if (text !== undefined) base = { ...base, text };
    const start = startOf(args);
    const id = step((opts) => {
      const made = useEditor.getState().addText({ ...opts, trackId: track, start, duration: optNumber(args.duration), preset: base });
      if (!made) throw new ToolError('the text clip could not be added');
      finish(made, args.fields, opts);
      return made;
    });
    return ok({ ...clipBrief(needClip(id)), ...landing(needClip(id), start, track) });
  },
};

const addShape: ToolDef = {
  name: 'add_shape',
  title: 'add a shape clip',
  description:
    'add a shape clip (a drawn figure or a 3d solid), in one undo step. give ONE of: preset (a shape card of the editor, list_options with kind "shape_presets": rectangle, circle, star, arrow, drawn circle, background, cone, ring ... ), ' +
    'or kind (a flat figure: rect, ellipse, triangle, polygon, star, heart, arrow, line), or shape3d (a solid: box, sphere, cylinder, cone, pyramid, torus, capsule, prism, hexagon, star, heart; it is made 3d and tilted a little so it reads as a solid, put pictures on its sides with set_sides). ' +
    'kind and shape3d may be given together (a star figure wrapped on a box). nothing given = a white square. ' +
    'start is the timeline time in seconds (default the playhead), duration in seconds (default 4), track must be a video track. position, size and color: fields (width, height, color, transform ... the same object update_clip takes). answers the brief of the new clip.',
  inputSchema: {
    type: 'object',
    properties: {
      preset: { type: 'string', enum: SHAPE_PRESETS.map((p) => p.id), description: 'a shape card' },
      kind: { type: 'string', enum: SHAPE_KINDS, description: 'a flat figure' },
      shape3d: { type: 'string', enum: SOLIDS, description: 'wrap the figure on this 3d solid' },
      ...PLACE,
      fields: FIELDS,
    },
  },
  run(args) {
    const p = needProject();
    const track = videoTrackArg(args.track);
    if (args.preset !== undefined && (args.kind !== undefined || args.shape3d !== undefined)) {
      throw new ToolError('give a preset, or kind and / or shape3d, not both');
    }
    let base: Partial<ShapeClip> = {};
    if (args.preset !== undefined) {
      const preset = SHAPE_PRESETS.find((x) => x.id === args.preset);
      if (!preset) throw new ToolError(`no shape preset "${String(args.preset)}". list_options with kind "shape_presets" lists them`);
      base = preset.build(p.width, p.height);
    } else {
      const shape = args.shape3d as Shape3D | undefined;
      if (shape) {
        // a card that makes this solid has the right size and depth; else a square tilted a little
        const card = SHAPE_PRESETS.find((c) => solidOf(c) === shape);
        base = card
          ? card.build(p.width, p.height)
          : { name: shape, kind: 'rect', width: 400, height: 400, threeD: true, shape, transform: { ...DEFAULT_TRANSFORM, rotX: 14, rotY: 28 } };
      }
      if (args.kind !== undefined) {
        const kind = args.kind as ShapeKind;
        base = { ...base, kind, name: shape ? `${kind} ${shape}` : kind };
        if (kind === 'line') base = { ...base, width: shape ? 400 : 600, height: 12 };
      }
    }
    const start = startOf(args);
    const id = step((opts) => {
      const made = useEditor.getState().addShape({ ...opts, trackId: track, start, duration: optNumber(args.duration), preset: base });
      if (!made) throw new ToolError('the shape could not be added');
      finish(made, args.fields, opts);
      return made;
    });
    return ok({ ...clipBrief(needClip(id)), ...landing(needClip(id), start, track) });
  },
};

const addEffect: ToolDef = {
  name: 'add_effect',
  title: 'add an effect clip',
  description:
    'add an effect clip, in one undo step. an effect is a layer that changes the picture of everything on the tracks below it, or only of one clip when target is given. effect is the id (list_options with kind "effects" lists ids, params with min, max and default). ' +
    'target: the id of a video, image, text or shape clip; then the effect covers that clip\'s time range unless start / duration are given, and sits on a track above it. ' +
    'without target: start (default the playhead) and duration (default 3 s) place it on the top track (a new top track when that has no room); track picks a video track instead. ' +
    'amount is the overall strength 0..1 (default 1), params an object of numbers by param key ({ "radius": 12 }; an unknown key is an error that lists the keys). answers the brief of the new clip. change it later with update_clip.',
  inputSchema: {
    type: 'object',
    properties: {
      effect: { type: 'string', description: 'the effect id, for example "blur"' },
      target: { type: 'string', description: 'id of the clip to put the effect on' },
      amount: { type: 'number', minimum: 0, maximum: 1, description: 'strength 0..1' },
      params: { type: 'object', description: 'numbers by param key' },
      ...PLACE,
    },
    required: ['effect'],
  },
  run(args) {
    const p = needProject();
    const def = getEffect(String(args.effect));
    if (!def) throw new ToolError(`no effect "${String(args.effect)}". list_options with kind "effects" lists the ids`);
    const track = videoTrackArg(args.track);
    const target = args.target === undefined ? undefined : needClip(args.target);
    if (target && !isVisualClip(target)) {
      throw new ToolError(`an effect can only be put on a video, image, text or shape clip, not on a ${target.type} clip. leave target out for a layer over everything below`);
    }
    const patch: Record<string, unknown> = {};
    if (args.amount !== undefined) patch.amount = args.amount;
    if (args.params !== undefined) patch.params = args.params;
    const duration = optNumber(args.duration);
    const asked = target ? (optNumber(args.start) ?? target.start) : startOf(args);
    const id = step((opts) => {
      const st = useEditor.getState();
      let made: string | null | undefined;
      if (target) {
        // the same placement as "add effect" in the inspector: over the clip in time, on a track above it
        const start = optNumber(args.start) ?? target.start;
        const len = duration ?? target.duration;
        const home = track ?? effectHomeTrack(p, { trackId: target.trackId, start, duration: len });
        const clip = createEffectClip(def.id, def.name, home ?? target.trackId, start, { duration: len, target: target.id });
        made = st.addClips([clip], { ...opts, newTrack: !home, trackName: 'effects' })[0];
      } else {
        made = st.addEffect(def.id, { ...opts, trackId: track, start: startOf(args), duration });
      }
      if (!made) throw new ToolError('the effect could not be added');
      if (Object.keys(patch).length > 0) applyPatch(made, patch, opts);
      return made;
    });
    const clip = needClip(id);
    return ok({ ...clipBrief(clip), ...landing(clip, asked, track), ...(clip.type === 'effect' ? { amount: clip.amount, params: clip.params } : {}) });
  },
};

const addCamera: ToolDef = {
  name: 'add_camera',
  title: 'add a camera clip',
  description:
    'add a 3d camera clip, in one undo step. it moves the view for every 3d clip under it for its time range (start default the playhead, duration default 5 s) and changes nothing until you move it: x y z (pixels), pan tilt roll (degrees), fov (degrees, home 50) are set with fields or later with update_clip, and can be keyed with set_keyframe. ' +
    'it goes on the top video track when that has room, else on a new top track; track picks a video track instead. fields is the same object update_clip takes. answers the brief of the new clip.',
  inputSchema: { type: 'object', properties: { ...PLACE, fields: FIELDS } },
  run(args) {
    needProject();
    const track = videoTrackArg(args.track);
    const start = startOf(args);
    const id = step((opts) => {
      const made = useEditor.getState().addCamera({ ...opts, trackId: track, start, duration: optNumber(args.duration) });
      if (!made) throw new ToolError('the camera could not be added');
      finish(made, args.fields, opts);
      return made;
    });
    return ok({ ...clipBrief(needClip(id)), ...landing(needClip(id), start, track) });
  },
};

export const addTools: ToolDef[] = [addText, addShape, addEffect, addCamera];
