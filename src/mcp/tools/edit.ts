import { faceClipId, faceFill, faceNames, hasSides, withFace, FACE_ALL } from '../../engine/scene3d/faces';
import { useEditor } from '../../store/editorStore';
import { clipEnd, rangesOverlap } from '../../lib/timelineOps';
import type { Clip, FaceFill, FaceFit, Project, VisualClip } from '../../types';
import { isVisualClip, trackKindForClip } from '../../types';
import { changedSince, clipBrief, idList, needClip, needProject, needTrack, needUnlocked, ok, optNumber, round, ToolError } from '../helpers';
import type { ToolDef } from '../types';
import { applyPatch, MAX_TIME, step } from './editPatch';

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
    'on an effect clip "params" is an object of numbers ({ "radius": 12 }, an unknown key is an error that lists the keys) and "amount" is 0..1. "speed" (video and audio clips, 0.25 to 4) re-times the clip and its length follows. ' +
    'null takes an optional field away (for example "mask": null). a field the clip type does not have is an error, not ignored. ' +
    'refused here: start (use move_clip), duration and trimStart (use trim_clip), trackId (move_clip), keyframes (set_keyframe, set_keyframes, clear_keyframes), faces (set_sides). ' +
    'answers { clip: short brief of the clip, changed: [names of the fields that changed] }. a patch that changes nothing is an error.',
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
    const changed = step((opts) => applyPatch(id, patch, opts));
    if (changed.length === 0) {
      useEditor.getState().rollback();
      throw new ToolError('nothing changed: every value was already set, or was limited to what it already is (get_clip shows the stored values)');
    }
    return ok({ clip: clipBrief(needClip(id)), changed });
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

const trimClip: ToolDef = {
  name: 'trim_clip',
  title: 'trim a clip edge',
  description:
    'drag one edge of a clip to a timeline time (seconds), in one undo step. edge "start" cuts or extends the head (the picture of a video / audio clip stays in sync with the timeline), edge "end" the tail. ' +
    'the edge is limited like a drag in the editor: the clip stays at least 0.05 s long, does not run into its neighbours on the track, does not start before 0 and a video / audio clip cannot run past its media. ' +
    'answers the clip brief; when the edge stopped short of the time asked for, "note" says where it ended. to move the whole clip use move_clip, to cut it in two use split_clips.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the clip id' },
      edge: { type: 'string', enum: ['start', 'end'], description: 'which edge to move' },
      time: { type: 'number', minimum: 0, maximum: MAX_TIME, description: 'timeline time in seconds the edge should go to' },
    },
    required: ['id', 'edge', 'time'],
  },
  run(args) {
    const clip = needClip(args.id);
    needUnlocked(clip);
    const edge = args.edge as 'start' | 'end';
    const time = args.time as number;
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

export const editTools: ToolDef[] = [updateClip, setSides, moveClip, trimClip, splitClips, deleteClips, duplicateClips, groupClips, ungroupClips];
