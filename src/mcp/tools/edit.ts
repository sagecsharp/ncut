import { BEND_ANGLE_MAX } from '../../engine/scene3d/bend';
import { faceClipId, faceFill, faceNames, hasSides, withFace, FACE_ALL } from '../../engine/scene3d/faces';
import { bendEach, bendTargets, skippedOf, bendTogether, flattenBends } from '../../features/properties/bendActions';
import { runRangeEdit } from '../../features/timeline/rangeActions';
import type { RangeEditKind } from '../../features/timeline/rangeActions';
import { groupPool, planMoveEdit, planRipple, planSlide, planSlip, planStretch, touchingAfter, touchingBefore } from '../../features/timeline/trimModes';
import type { TrimPlan } from '../../features/timeline/trimModes';
import { planNudge } from '../../features/timeline/timeNudge';
import { trimStopText } from '../../features/timeline/trimText';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { clipEnd, rangesOverlap } from '../../lib/timelineOps';
import type { Clip, FaceFill, FaceFit, Project, VisualClip } from '../../types';
import { isTimedClip, isVisualClip, trackKindForClip } from '../../types';
import { changedSince, clipBrief, idList, needClip, needProject, needTrack, needUnlocked, ok, optNumber, round, ToolError } from '../helpers';
import type { ToolDef, ToolResult } from '../types';
import { applyPatch, MAX_TIME, step, type KeepPlace } from './editPatch';
import { rangeOf } from './project';

const ids = (what: string): { type: 'array'; items: { type: 'string' }; minItems: number; maxItems: number; description: string } => ({
  type: 'array',
  items: { type: 'string' },
  minItems: 1,
  maxItems: 500,
  description: what,
});

/** every id has to be a clip of the open project */
function needClips(list: string[]): Clip[] {
  return list.map((id) => needClip(id));
}

const updateClip: ToolDef = {
  name: 'update_clip',
  title: 'edit a clip',
  description:
    'change any stored field of one clip in one undo step. patch is an object of field: value, the same names get_clip shows (list_options with kind "fields" lists what each clip type takes, with units and ranges). ' +
    '"transform" is a partial transform ({ "x": 120, "scale": 1.5, "rotation": 10, "opacity": 0.8 }, pixels from the canvas middle, degrees, opacity 0..1; z / rotX / rotY / scaleX / scaleY / scaleZ for 3d) and goes through the same limits as the inspector. ' +
    '"pivot" is the point the clip rotates and scales around: { "x", "y" } in fractions of its own box from its middle (-0.5 = left or top edge, 0.5 = right or bottom edge, each -10..10), a spot name (top-left, top, top-right, left, middle, right, bottom-left, bottom, bottom-right) or null for the middle. transform x / y / z then say where the pivot is, and attached clips count from it. ' +
    '"pivot" and "parent" keep the clip, and the clips attached to it, where they are on screen at the playhead (x / y / z or their keys move) unless the same patch sends "transform": then they are written as given. a clip that looks at something looks from its pivot, so a new pivot can turn a big picture a little; a motion is not counted in the place that is kept. ' +
    '"bend" { angle, along?, center?, span? } rolls a picture round a tube (planes only), keyable as bend.angle; bend_clips bends several clips as one. ' +
    'on an effect clip "params" is an object of numbers ({ "radius": 12 }, an unknown key is an error that lists the keys) and "amount" is 0..1. "speed" (video and audio clips, 0.25 to 4) re-times the clip and its length follows. ' +
    'null takes an optional field away (for example "mask": null). a field the clip type does not have is an error, not ignored. ' +
    'refused here: start (use move_clip), duration and trimStart (use trim_clip), trackId (move_clip), keyframes (set_keyframe, set_keyframes, clear_keyframes), faces (set_sides). ' +
    'answers { clip: short brief of the clip, changed: [names of the fields that changed], moved?: [ids of attached clips that were moved so they stay in place] }. a patch that changes nothing is an error.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the clip id (get_project lists them)' },
      patch: { type: 'object', description: 'fields to change, for example { "transform": { "x": 100 }, "color": "#ff0000" }' },
    },
    required: ['id', 'patch'],
  },
  run(args) {
    const id = String(args.id);
    const patch = args.patch as Record<string, unknown>;
    if (Object.keys(patch).length === 0) throw new ToolError('patch is empty: say which fields to change');
    const keep: KeepPlace = { moved: [] };
    const changed = step((opts) => applyPatch(id, patch, opts, keep));
    if (changed.length === 0) {
      useEditor.getState().rollback();
      throw new ToolError('nothing changed: every value was already set, or was limited to what it already is (get_clip shows the stored values)');
    }
    return ok({ clip: clipBrief(needClip(id)), changed, ...(keep.moved.length > 0 ? { moved: keep.moved } : {}) });
  },
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const FITS = ['fill', 'fit', 'stretch'];

/** does `from` show `target` on one of its sides, directly or through the clips it shows? */
function showsSolid(project: Project, from: Clip, target: string): boolean {
  const seen = new Set<string>();
  const walk = (c: Clip): boolean => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    if (!isVisualClip(c) || !c.faces || !hasSides(c)) return false;
    for (const name of faceNames(c.shape)) {
      const id = faceClipId(faceFill(c, name));
      if (!id) continue;
      if (id === target) return true;
      const next = project.clips.find((x) => x.id === id);
      if (next && walk(next)) return true;
    }
    return false;
  };
  return walk(from);
}

/** a side value from the argument, checked: a clip of another picture, a color, or null */
function parseFill(solid: VisualClip, key: string, v: unknown): FaceFill | null {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new ToolError(`sides.${key} must be { "clip": id }, { "color": "#rrggbb" } or null`);
  const o = v as Record<string, unknown>;
  const names = Object.keys(o);
  if ('color' in o) {
    if (names.length > 1) throw new ToolError(`sides.${key}: a color takes no other field`);
    if (typeof o.color !== 'string' || !HEX.test(o.color)) throw new ToolError(`sides.${key}.color must look like #rrggbb`);
    return { color: o.color.toLowerCase() };
  }
  if ('clip' in o) {
    for (const n of names) if (n !== 'clip' && n !== 'fit') throw new ToolError(`sides.${key}.${n} is not a field (a clip side takes clip and fit)`);
    if (typeof o.clip !== 'string' || !o.clip) throw new ToolError(`sides.${key}.clip must be a clip id`);
    if (o.clip === solid.id) throw new ToolError(`sides.${key}: a solid cannot show itself`);
    const src = needProject().clips.find((c) => c.id === o.clip);
    if (!src) throw new ToolError(`sides.${key}: no clip with the id ${o.clip}. get_project lists the clips`);
    if (!isVisualClip(src)) throw new ToolError(`sides.${key}: a ${src.type} clip has no picture. use a video, image, text or shape clip`);
    if (showsSolid(needProject(), src, solid.id)) {
      throw new ToolError(`sides.${key}: ${src.id} shows this solid on one of its own sides (directly or through other clips). a clip on a side is not painted on its own, so the two would hide each other`);
    }
    if (o.fit !== undefined && !FITS.includes(o.fit as string)) throw new ToolError(`sides.${key}.fit must be one of: ${FITS.join(', ')}`);
    return o.fit === undefined ? { clip: o.clip } : { clip: o.clip, fit: o.fit as FaceFit };
  }
  throw new ToolError(`sides.${key} must be { "clip": id }, { "color": "#rrggbb" } or null`);
}

const setSides: ToolDef = {
  name: 'set_sides',
  title: 'put pictures on the sides of a solid',
  description:
    'set what the sides of a 3d solid show, in one undo step. the clip must be a 3d clip with a solid shape (a box, cylinder, cone, pyramid, prism, hexagon, star, heart, sphere, torus or capsule; make one with add_shape shape3d, or set threeD and shape with update_clip). a flat clip or a plane has no sides. ' +
    'sides is an object: the key is a side name or "all" (list_options with kind "shapes" and get_clip give the names, a box has front, back, right, left, top, bottom) and the value is { "clip": id, "fit"?: "fill" | "fit" | "stretch" } (that video, image, text or shape clip is shown on the side, and stops being painted on its own), { "color": "#rrggbb" }, or null (the side shows the solid\'s own picture again). ' +
    'what you give is merged into the sides the solid already has. "all" is applied first, so { "all": {...}, "back": null } means every side but the back. ' +
    'a sphere, torus or capsule has one side: it is stored under "all" (its own name, "surface", is taken as the same). a clip that shows this solid on one of its sides (directly or through other clips) cannot be a source. a call that changes nothing is an error. answers { sides: what is stored now, names: the side names to give ("all" for a one sided shape), note?: when a source is a solid itself }.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the id of the 3d solid' },
      sides: { type: 'object', description: 'for example { "front": { "clip": "clp_x" }, "top": { "color": "#ff8800" }, "back": null }' },
    },
    required: ['id', 'sides'],
  },
  run(args) {
    const clip = needClip(args.id);
    if (!isVisualClip(clip)) throw new ToolError(`a ${clip.type} clip has no sides. only a 3d solid has`);
    if (!hasSides(clip)) {
      throw new ToolError(
        clip.threeD
          ? 'this clip is 3d but flat (a plane): it has no sides. give it a solid shape first, for example update_clip with { "shape": "box" }'
          : 'this clip is a flat 2d layer: it has no sides. make it a solid first, for example update_clip with { "threeD": true, "shape": "box" }, or use add_shape with shape3d',
      );
    }
    needUnlocked(clip);
    const sides = args.sides as Record<string, unknown>;
    const own = faceNames(clip.shape);
    // a one sided shape (sphere, torus, capsule) keeps its single side under 'all', like the inspector: its own name is an alias
    const single = own.length === 1 ? own[0]! : null;
    const names = single ? [FACE_ALL] : own;
    if (single && single in sides && FACE_ALL in sides) throw new ToolError(`"${single}" and "all" are the same side of a ${clip.shape}: give one of them`);
    const given: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sides)) given[k === single ? FACE_ALL : k] = v;
    const keys = Object.keys(given);
    if (keys.length === 0) throw new ToolError(`sides is empty. give a side name (${own.join(', ')}) or "all"`);
    for (const k of keys) {
      if (k !== FACE_ALL && !own.includes(k)) throw new ToolError(`a ${clip.shape} has no side "${k}". its sides: ${own.join(', ')}, or "all" for every side`);
    }
    // "all" first: a null under a side's name only means something while "all" has a fill
    keys.sort((a, b) => (a === FACE_ALL ? -1 : b === FACE_ALL ? 1 : 0));
    const fills = new Map(keys.map((k) => [k, parseFill(clip, k, given[k])] as const));
    let faces = clip.faces;
    // an old entry under the shape's own name would win over 'all' in the renderer and hide the inspector's edits
    if (single) faces = withFace(faces, single, undefined);
    for (const k of keys) faces = withFace(faces, k, fills.get(k));
    if (JSON.stringify(clip.faces ?? {}) === JSON.stringify(faces ?? {})) throw new ToolError('nothing changed: the sides already show that');
    step((opts) => useEditor.getState().updateClip(clip.id, { faces: faces ?? {} }, opts));
    const now = needClip(clip.id) as VisualClip;
    const warnings: string[] = [];
    const notes: string[] = [];
    for (const [k, f] of fills) {
      if (f && 'clip' in f) {
        const src = needProject().clips.find((c) => c.id === f.clip);
        if (src && isVisualClip(src) && hasSides(src)) notes.push(`the clip on ${k} (${src.id}) is a solid with sides itself: only its picture is shown on the side, its own sides are not`);
        const track = src && needProject().tracks.find((t) => t.id === src.trackId);
        if (track?.hidden) warnings.push(`the clip on ${k} is on a hidden track: the side shows the solid's own picture until the track is shown`);
      }
    }
    return ok({ id: clip.id, sides: now.faces ?? {}, names, ...(warnings.length ? { warnings } : {}), ...(notes.length ? { note: notes.join('; ') } : {}) });
  },
};

const moveClip: ToolDef = {
  name: 'move_clip',
  title: 'move a clip',
  description:
    'move one clip on the timeline: start is the new start in seconds, track is the id of the track to put it on (a video clip needs a video track, audio an audio track). give at least one; the other stays as it is. ' +
    'the clip keeps its length and must not overlap another clip on the target track (nothing is pushed aside). one undo step. answers the clip brief. ' +
    'to change where a clip begins or ends without moving it use trim_clip.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the clip id' },
      start: { type: 'number', minimum: 0, maximum: MAX_TIME, description: 'new start on the timeline, seconds' },
      track: { type: 'string', description: 'id of the track to move the clip to' },
    },
    required: ['id'],
  },
  run(args) {
    const clip = needClip(args.id);
    const start = optNumber(args.start);
    if (start === undefined && args.track === undefined) throw new ToolError('give start, track or both');
    const trackId = args.track === undefined ? clip.trackId : needTrack(args.track).id;
    const to = start ?? clip.start;
    needUnlocked(clip);
    if (trackId === clip.trackId && to === clip.start) throw new ToolError('nothing changed: the clip is already there');
    const p = needProject();
    const target = p.tracks.find((t) => t.id === trackId)!;
    if (target.locked) throw new ToolError(`the track ${target.id} (${target.name}) is locked. unlock it with update_track first`);
    if (target.kind !== trackKindForClip(clip.type)) {
      throw new ToolError(`a ${clip.type} clip cannot go on the ${target.kind} track ${target.id} (${target.name})`);
    }
    const clash = p.clips.find((c) => c.id !== clip.id && c.trackId === trackId && rangesOverlap(to, to + clip.duration, c.start, clipEnd(c)));
    if (clash) {
      throw new ToolError(
        `the clip would overlap ${clash.id} (${round(clash.start)} to ${round(clipEnd(clash))} s) on the track ${target.id}. pick a free spot or another track (add_track makes one)`,
      );
    }
    const moved = step((opts) => useEditor.getState().moveClips([{ id: clip.id, trackId, start: to }], opts));
    if (!moved) throw new ToolError('the clip could not be moved there (locked track, a wrong kind of track or an overlap)');
    return ok(clipBrief(needClip(clip.id)));
  },
};

const nudgeClips: ToolDef = {
  name: 'nudge_clips',
  title: 'nudge clips by frames',
  description:
    'move clips by a whole number of frames, like alt+left / alt+right: all by the same amount, effects on them come along when they have room. ' +
    'all or nothing: a clip that would start before 0 or run into another stops the move and the error says which. locked tracks are refused. one undo step. ' +
    'group mates are not added: list every clip. answers { moved, followers (effects that came along), frames, seconds, clips }.',
  inputSchema: {
    type: 'object',
    properties: {
      ids: ids('the clips to move'),
      frames: { type: 'integer', description: 'how many frames, + = later, - = earlier' },
    },
    required: ['ids', 'frames'],
  },
  run(args) {
    const list = [...new Set(idList(args.ids))];
    for (const id of list) needUnlocked(needClip(id));
    const frames = args.frames as number;
    if (frames === 0) throw new ToolError('nothing changed: frames is 0');
    const p = needProject();
    if (Math.abs(frames) / p.fps > MAX_TIME) throw new ToolError('frames is more than a day');
    const plan = planNudge(p, list, frames);
    if (plan.stop) throw new ToolError(`nothing moved: ${trimStopText(plan.stop, p)}`);
    if (plan.moves.length === 0) throw new ToolError('nothing moved: no clip can move');
    const moved = step((opts) => useEditor.getState().moveClips(plan.moves, opts));
    if (!moved) {
      useEditor.getState().rollback();
      throw new ToolError('the clips could not be moved');
    }
    const mine = new Set(plan.ids);
    const now = needProject();
    return ok({
      moved: plan.ids,
      followers: plan.moves.filter((m) => !mine.has(m.id)).map((m) => m.id),
      frames,
      seconds: round(frames / p.fps),
      clips: plan.ids.map((id) => clipBrief(now.clips.find((c) => c.id === id)!)),
    });
  },
};

/** the names of tracks, in the order given */
function trackNames(p: Project, trackIds: readonly string[]): string[] {
  return trackIds.map((id) => p.tracks.find((t) => t.id === id)?.name).filter((n): n is string => n !== undefined);
}

/** runs a trim plan as one undo step. a plan with no ops is an error (the stop, or `idle`), and so is a refused one: nothing is left behind */
function applyPlan(plan: TrimPlan, p: Project, idle: string): void {
  if (plan.ops.length === 0) throw new ToolError(`nothing changed: ${plan.stop ? trimStopText(plan.stop, p) : idle}`);
  const before = needProject();
  const done = step((opts) => useEditor.getState().applyTrimPlan(plan.ops, opts));
  if (!done || !changedSince(before)) {
    useEditor.getState().rollback();
    throw new ToolError('nothing changed: something is in the way');
  }
}

const trimClip: ToolDef = {
  name: 'trim_clip',
  title: 'trim a clip edge',
  description:
    'drag one edge of a clip to a timeline time (seconds), in one undo step. edge "start" cuts or extends the head (the picture of a video / audio clip stays in sync with the timeline), edge "end" the tail. ' +
    'the edge is limited like a drag in the editor: the clip stays at least 0.05 s long, does not run into its neighbours on the track, does not start before 0 and a video / audio clip cannot run past its media. ' +
    'answers the clip brief; when the edge stopped short of the time asked for, "note" says where it ended. to move the whole clip use move_clip, to cut it in two use split_clips. ' +
    'with a mode, grouped clips with the same edge, edit, or span and speed come along unless alone. locked tracks never move. answers then also have mode, moved, speed, locked_tracks and note.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the clip id' },
      edge: { type: 'string', enum: ['start', 'end'], description: 'which edge to move' },
      time: { type: 'number', minimum: 0, maximum: MAX_TIME, description: 'timeline time in seconds the edge should go to' },
      mode: {
        type: 'string',
        enum: ['trim', 'ripple', 'move-edit', 'stretch'],
        description:
          '"trim" (default) moves only this edge, a gap stays. "ripple" also moves everything after the edit on unlocked tracks, so no gap opens. "move-edit" moves the edit between this clip and the one touching this edge: one gets longer, the other shorter. "stretch" changes the speed so the same media fills the new length (0.25x to 4x)',
      },
      alone: { type: 'boolean', description: 'only this clip (move-edit: the two clips at the edit), not its group mates. default false' },
    },
    required: ['id', 'edge', 'time'],
  },
  run(args) {
    const clip = needClip(args.id);
    needUnlocked(clip);
    const edge = args.edge as 'start' | 'end';
    const time = args.time as number;
    const mode = args.mode as 'trim' | 'ripple' | 'move-edit' | 'stretch' | undefined;
    if (mode !== undefined && mode !== 'trim') {
      const p = needProject();
      const pool = args.alone === true ? [clip.id] : groupPool(p, clip.id);
      const asked = time - (edge === 'start' ? clip.start : clipEnd(clip));
      let plan: TrimPlan;
      if (mode === 'move-edit') {
        if (edge === 'end') {
          const right = touchingAfter(p, clip);
          if (!right) throw new ToolError(`the ${edge} of ${clip.id} does not touch another clip: use mode "ripple" or "trim"`);
          plan = planMoveEdit(p, clip.id, right.id, time - right.start, pool);
        } else {
          const left = touchingBefore(p, clip);
          if (!left) throw new ToolError(`the ${edge} of ${clip.id} does not touch another clip: use mode "ripple" or "trim"`);
          plan = planMoveEdit(p, left.id, clip.id, time - clip.start, pool);
        }
      } else if (mode === 'ripple') plan = planRipple(p, clip.id, edge, asked, pool);
      else plan = planStretch(p, clip.id, edge, asked, pool);
      applyPlan(plan, p, 'the edge is already there');
      const now = needClip(clip.id);
      const got = (edge === 'start' ? clip.start : clipEnd(clip)) + plan.delta;
      const out: Record<string, unknown> = { ...clipBrief(now), mode };
      if (plan.moved.length > 0) out.moved = plan.moved;
      if (mode === 'stretch' && plan.speed !== undefined) out.speed = round(plan.speed);
      if (plan.lockedBehind.length > 0) out.locked_tracks = trackNames(p, plan.lockedBehind);
      if (plan.stop) out.note = `the ${edge} edge stopped at ${round(got)} s, not ${round(time)} s: ${trimStopText(plan.stop, p)}`;
      return ok(out);
    }
    const before = needProject();
    step((opts) => useEditor.getState().trimClip(clip.id, edge, time, opts));
    if (!changedSince(before)) {
      useEditor.getState().rollback();
      throw new ToolError(
        `nothing changed: the ${edge} edge cannot go to ${round(time)} s from ${round(edge === 'start' ? clip.start : clipEnd(clip))} s (the clip stays at least 0.05 s long, cannot run into its neighbours, start before 0 or past its media)`,
      );
    }
    const now = needClip(clip.id);
    const got = edge === 'start' ? now.start : clipEnd(now);
    const out: Record<string, unknown> = { ...clipBrief(now) };
    if (Math.abs(got - time) > 1e-3) out.note = `the ${edge} edge stopped at ${round(got)} s, not ${round(time)} s (the limits of the clip)`;
    return ok(out);
  },
};

const slipClip: ToolDef = {
  name: 'slip_clip',
  title: 'slip a clip',
  description:
    'slips a video or audio clip in one undo step: same place and length, another part of its media. by is media seconds (+ shows later media), trim_start is where in its media it starts; give exactly one. ' +
    'a separated sound of the same media slips too unless alone. the slip is limited by the media (it cannot start before its first frame or run past its last). ' +
    'answers the clip brief with trim_start, and "note" when it slipped less than asked.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the clip id' },
      by: { type: 'number', minimum: -MAX_TIME, maximum: MAX_TIME, description: 'media seconds to slip by: + shows later media, - earlier' },
      trim_start: { type: 'number', minimum: 0, maximum: MAX_TIME, description: 'where in its media the clip should start, seconds' },
      alone: { type: 'boolean', description: 'only this clip, not the sound or picture of the same media. default false' },
    },
    required: ['id'],
  },
  run(args) {
    const clip = needClip(args.id);
    const by = optNumber(args.by);
    const to = optNumber(args.trim_start);
    if (by !== undefined && to !== undefined) throw new ToolError('give by or trim_start, not both');
    if (by === undefined && to === undefined) throw new ToolError('give by or trim_start');
    if (!isTimedClip(clip)) throw new ToolError('slip needs a video or audio clip');
    needUnlocked(clip);
    const p = needProject();
    const pool = args.alone === true ? [clip.id] : groupPool(p, clip.id);
    const asked = by ?? to! - clip.trimStart;
    const plan = planSlip(p, clip.id, asked, pool);
    applyPlan(plan, p, 'the clip already shows that part of its media');
    const out: Record<string, unknown> = { ...clipBrief(needClip(clip.id)), trim_start: round(plan.trimStart ?? clip.trimStart) };
    if (plan.stop) out.note = `slipped ${round(plan.delta)} s of media, not ${round(asked)} s: ${trimStopText(plan.stop, p)}`;
    return ok(out);
  },
};

const slideClip: ToolDef = {
  name: 'slide_clip',
  title: 'slide a clip',
  description:
    'slides a clip in one undo step: it moves by "by" seconds or to start, and the clips touching it trim to stay touching. group mates with the same span slide too unless alone. ' +
    'answers the clip brief with trimmed (the neighbours that were trimmed), and "note" when it slid less than asked.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the clip id' },
      by: { type: 'number', minimum: -MAX_TIME, maximum: MAX_TIME, description: 'seconds to slide by: + later, - earlier' },
      start: { type: 'number', minimum: 0, maximum: MAX_TIME, description: 'the new start on the timeline, seconds' },
      alone: { type: 'boolean', description: 'only this clip, not its group mates. default false' },
    },
    required: ['id'],
  },
  run(args) {
    const clip = needClip(args.id);
    const by = optNumber(args.by);
    const to = optNumber(args.start);
    if (by !== undefined && to !== undefined) throw new ToolError('give by or start, not both');
    if (by === undefined && to === undefined) throw new ToolError('give by or start');
    needUnlocked(clip);
    const p = needProject();
    const pool = args.alone === true ? [clip.id] : groupPool(p, clip.id);
    const asked = by ?? to! - clip.start;
    const plan = planSlide(p, clip.id, asked, pool);
    applyPlan(plan, p, 'the clip is already there');
    const trimmed: string[] = [];
    for (const op of plan.ops) if (op.kind === 'trim' && !trimmed.includes(op.id)) trimmed.push(op.id);
    const out: Record<string, unknown> = { ...clipBrief(needClip(clip.id)), trimmed };
    if (plan.stop) out.note = `slid ${round(plan.delta)} s, not ${round(asked)} s: ${trimStopText(plan.stop, p)}`;
    return ok(out);
  },
};

const splitClips: ToolDef = {
  name: 'split_clips',
  title: 'split clips at a time',
  description:
    'cut clips in two at a timeline time (seconds), in one undo step. ids = the clips to cut; without ids every clip that is under that time is cut (not the selection). ' +
    'the time has to be inside the clip and more than 0.05 s from its ends; clips on locked tracks are skipped; effects, cameras and clips attached to a cut clip are cut with it. ' +
    'answers { created: ids of the new right halves, clips: their briefs }. the left half keeps the old id. an error when nothing could be cut.',
  inputSchema: {
    type: 'object',
    properties: {
      time: { type: 'number', minimum: 0, maximum: MAX_TIME, description: 'timeline time in seconds' },
      ids: ids('clips to cut. default: every clip under the time'),
    },
    required: ['time'],
  },
  run(args) {
    const p = needProject();
    const time = args.time as number;
    const wanted = args.ids === undefined ? p.clips.map((c) => c.id) : idList(args.ids);
    if (args.ids !== undefined) needClips(wanted);
    const created = step((opts) => useEditor.getState().splitClips(time, wanted, opts));
    if (created.length === 0) {
      useEditor.getState().rollback();
      throw new ToolError(
        `nothing was cut: ${round(time)} s has to be inside a clip, more than 0.05 s from its start and end, and the clip must not be on a locked track. get_project shows where the clips are`,
      );
    }
    const now = needProject();
    return ok({ created, clips: created.map((id) => now.clips.find((c) => c.id === id)).filter((c): c is Clip => !!c).map(clipBrief) });
  },
};

const deleteClips: ToolDef = {
  name: 'delete_clips',
  title: 'delete clips',
  description:
    'delete clips, in one undo step (undo brings them back). effects put on a deleted clip go with it, clips attached to it keep their place on screen. clips on locked tracks are not deleted. ' +
    'ripple true closes the gap by moving later clips on the same track left. answers { deleted: how many clips went, ids: which, skipped?: ids that were left (locked track) }. an error when nothing was deleted.',
  annotations: { destructiveHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      ids: ids('the clips to delete'),
      ripple: { type: 'boolean', description: 'close the gap on the track (default false)' },
    },
    required: ['ids'],
  },
  run(args) {
    const wanted = idList(args.ids);
    needClips(wanted);
    const before = needProject();
    step((opts) => useEditor.getState().deleteClips(wanted, { ...opts, ripple: args.ripple === true }));
    const now = needProject();
    const left = new Set(now.clips.map((c) => c.id));
    const gone = before.clips.filter((c) => !left.has(c.id)).map((c) => c.id);
    if (gone.length === 0) {
      useEditor.getState().rollback();
      throw new ToolError('nothing was deleted: the clips are on locked tracks. unlock them with update_track first');
    }
    const skipped = wanted.filter((id) => left.has(id));
    return ok({ deleted: gone.length, ids: gone, ...(skipped.length ? { skipped } : {}) });
  },
};

/** lift_range and extract_range: runRangeEdit owns its undo step and its rollback */
function rangeRun(kind: RangeEditKind): ToolResult {
  needProject();
  const r = runRangeEdit(kind);
  if (!r.ok) throw new ToolError(`${r.reason ?? 'nothing changed'}. set_range marks the range, get_project shows it`);
  const out: Record<string, unknown> = { in: round(r.in), out: round(r.out) };
  if (kind === 'extract') out.seconds = round(r.out - r.in);
  out.removed = r.removed;
  out.split = r.splits;
  out.trimmed = r.trimmed;
  if (kind === 'extract') out.moved = r.moved;
  if (r.slivers > 0) out.slivers = r.slivers;
  if (r.lockedTracks > 0) out.lockedTracks = r.lockedTracks;
  if (kind === 'extract') out.range = rangeOf(needProject().range);
  return ok(out);
}

const liftRange: ToolDef = {
  name: 'lift_range',
  title: 'lift the range',
  description:
    'takes out what is between the in and out points on unlocked tracks in one undo step, the gap stays. clips over a mark are split there. both marks are needed (set_range). the playhead goes to the in point. ' +
    'answers { in, out, removed, split, trimmed, slivers?, lockedTracks? }. an error says why nothing would change, or names the clip that stopped it.',
  annotations: { destructiveHint: true },
  inputSchema: { type: 'object', properties: {} },
  run: () => rangeRun('lift'),
};

const extractRange: ToolDef = {
  name: 'extract_range',
  title: 'extract the range',
  description:
    'like lift_range, then every clip on every unlocked track after the out point moves left by out minus in, so the tracks stay in sync. locked tracks stay. the out point is cleared after it, the in point stays. the playhead goes to the in point. ' +
    'answers { in, out, seconds, removed, split, trimmed, moved, slivers?, lockedTracks?, range }.',
  annotations: { destructiveHint: true },
  inputSchema: { type: 'object', properties: {} },
  run: () => rangeRun('extract'),
};

const duplicateClips: ToolDef = {
  name: 'duplicate_clips',
  title: 'duplicate clips',
  description:
    'copy clips, in one undo step. by default the copies go right after the originals on their tracks (keeping their timing against each other). same_time true puts every copy at the same time as its original on a track above it (a new track when none is free). effects put on a copied clip come along. ' +
    'answers { copies: briefs of the new clips, each with "from": the id it was copied from when known }. an error when nothing was copied (locked tracks).',
  inputSchema: {
    type: 'object',
    properties: {
      ids: ids('the clips to copy'),
      same_time: { type: 'boolean', description: 'put the copies over the originals in time (default false: after them)' },
    },
    required: ['ids'],
  },
  run(args) {
    const wanted = idList(args.ids);
    needClips(wanted);
    const copies = new Map<string, string>();
    const created = step((opts) => useEditor.getState().duplicateClips(wanted, { ...opts, sameTime: args.same_time === true, copies }));
    if (created.length === 0) {
      useEditor.getState().rollback();
      throw new ToolError('nothing was copied');
    }
    const from = new Map([...copies].map(([orig, copy]) => [copy, orig]));
    const p = needProject();
    const out = created
      .map((id) => p.clips.find((c) => c.id === id))
      .filter((c): c is Clip => !!c)
      .map((c) => ({ ...clipBrief(c), ...(from.has(c.id) ? { from: from.get(c.id) } : {}) }));
    return ok({ copies: out });
  },
};

const groupClips: ToolDef = {
  name: 'group_clips',
  title: 'group clips',
  description:
    'put two or more clips into one group, in one undo step: clicking one selects them all and they move, copy and delete as one. a clip leaves its old group. clips on locked tracks are not grouped. ' +
    'answers { group: the group id, clips: the ids in it }. an error when fewer than two clips could be grouped or they already are one group. ungroup_clips undoes it.',
  inputSchema: { type: 'object', properties: { ids: ids('two or more clips') }, required: ['ids'] },
  run(args) {
    const wanted = idList(args.ids);
    if (wanted.length < 2) throw new ToolError('a group needs at least two clips');
    needClips(wanted);
    const group = step((opts) => useEditor.getState().groupClips(wanted, opts));
    if (!group) {
      useEditor.getState().rollback();
      throw new ToolError('nothing was grouped: fewer than two of the clips are on unlocked tracks, or they already form exactly one group');
    }
    return ok({ group, clips: needProject().clips.filter((c) => c.group === group).map((c) => c.id) });
  },
};

const ungroupClips: ToolDef = {
  name: 'ungroup_clips',
  title: 'ungroup clips',
  description:
    'dissolve every group that one of these clips belongs to, in one undo step (all members of those groups become single clips again). answers { ungrouped: ids of the clips that were in a group }. an error when none of the clips is in a group.',
  inputSchema: { type: 'object', properties: { ids: ids('clips of the groups to dissolve') }, required: ['ids'] },
  run(args) {
    const wanted = idList(args.ids);
    needClips(wanted);
    const before = needProject();
    step((opts) => useEditor.getState().ungroupClips(wanted, opts));
    if (!changedSince(before)) {
      useEditor.getState().rollback();
      throw new ToolError('nothing changed: none of these clips is in a group');
    }
    const was = before.clips.filter((c) => c.group && !needProject().clips.find((x) => x.id === c.id)?.group).map((c) => c.id);
    return ok({ ungrouped: was });
  },
};

/** why each clip that cannot bend was left out, for the error text */
function whyNotBent(wanted: string[]): string {
  return skippedOf(needProject(), wanted, bendTargets(needProject(), wanted).clips.map((c) => c.id))
    .map((s) => `${s.id}: ${s.why}`)
    .join('; ');
}

const bendClips: ToolDef = {
  name: 'bend_clips',
  title: 'bend clips',
  description:
    'bend clips round a tube like a cinema screen, in one undo step. angle = degrees of arc over the whole bent length: + brings the ends toward the camera, - pushes them away, 360 closes a ring. ' +
    'together (default true, needs two or more clips) bends them as one surface: they are grouped, each bends by its share and the outer ones come forward or go back. together false bends every clip round its own middle. ' +
    'along width (default) bends the left and right edges round, height the top and bottom. middle -0.5..0.5 = where the row stays flat (0 = its middle, -0.5 / 0.5 = an end). ' +
    'key true writes a keyframe at time (default the playhead) instead of the plain value. angle 0 without key takes the bend off, keyframes too. 3d solids (a shape other than plane) are skipped. ' +
    'answers { bent, skipped: [{ id, why }], together, along, angle, onePlane, group }. onePlane false = the clips do not face the same way in one plane: they bend but do not join up.',
  inputSchema: {
    type: 'object',
    properties: {
      ids: ids('the clips to bend'),
      angle: { type: 'number', minimum: -BEND_ANGLE_MAX, maximum: BEND_ANGLE_MAX, description: 'degrees over the whole bent length' },
      along: { type: 'string', enum: ['width', 'height'], description: 'which edges bend round (default width, or what the clips have)' },
      together: { type: 'boolean', description: 'one surface through all the clips (default true)' },
      middle: { type: 'number', minimum: -0.5, maximum: 0.5, description: 'together: where the row stays flat, a share of its length from the middle (default 0, or what it was)' },
      key: { type: 'boolean', description: 'write a keyframe at time instead of the plain value' },
      time: { type: 'number', description: 'timeline seconds for the key and for measuring the clips (default the playhead)' },
    },
    required: ['ids', 'angle'],
  },
  run(args) {
    const wanted = idList(args.ids);
    needClips(wanted);
    const angle = args.angle;
    if (typeof angle !== 'number' || !Number.isFinite(angle) || angle < -BEND_ANGLE_MAX || angle > BEND_ANGLE_MAX) throw new ToolError(`angle must be a number from -${BEND_ANGLE_MAX} to ${BEND_ANGLE_MAX}`);
    const along = args.along;
    if (along !== undefined && along !== 'width' && along !== 'height') throw new ToolError('along must be width or height');
    const middle = args.middle;
    if (middle !== undefined && (typeof middle !== 'number' || !Number.isFinite(middle) || middle < -0.5 || middle > 0.5)) throw new ToolError('middle must be a number from -0.5 to 0.5');
    const time = optNumber(args.time) ?? usePlayback.getState().time;
    const together = args.together !== false && wanted.length > 1;
    const key = args.key === true;
    if (angle === 0 && !key) {
      const p = needProject();
      const bentNow = p.clips.filter((c) => wanted.includes(c.id) && isVisualClip(c) && (c.bend || (c.keyframes?.['bend.angle']?.length ?? 0) > 0));
      const lockedTrack = (trackId: string) => !!p.tracks.find((t) => t.id === trackId)?.locked;
      const was = bentNow.filter((c) => !lockedTrack(c.trackId)).map((c) => c.id);
      const skipped = bentNow.filter((c) => lockedTrack(c.trackId)).map((c) => ({ id: c.id, why: 'its track is locked' }));
      const n = step((opts) => flattenBends(wanted, opts));
      if (n === 0) {
        useEditor.getState().rollback();
        if (skipped.length > 0) throw new ToolError(`nothing to take off: ${skipped.map((s) => `${s.id}: ${s.why}`).join(', ')}`);
        throw new ToolError('nothing to take off: none of these clips is bent');
      }
      return ok({ bent: [], flat: was, skipped, together, along: 'width', angle: 0, onePlane: true, group: null });
    }
    const keyMode = key ? ('add' as const) : undefined;
    const result = step((opts) =>
      together
        ? bendTogether(wanted, { angle, along: along as 'width' | 'height' | undefined, middle: middle as number | undefined, fit: true, key: keyMode }, time, opts)
        : bendEach(wanted, { angle, along: along as 'width' | 'height' | undefined, key: keyMode }, time, opts),
    );
    if (!result || result.bent.length === 0) {
      useEditor.getState().rollback();
      const can = bendTargets(needProject(), wanted).clips.length;
      if (together && can === 1) {
        throw new ToolError('bending together needs two or more clips that can bend (or together false)');
      }
      throw new ToolError(`nothing was bent: ${whyNotBent(wanted)}`);
    }
    return ok({ ...result, together });
  },
};

export const editTools: ToolDef[] = [updateClip, setSides, moveClip, nudgeClips, trimClip, slipClip, slideClip, splitClips, deleteClips, liftRange, extractRange, duplicateClips, groupClips, ungroupClips, bendClips];
