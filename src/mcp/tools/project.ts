/** project and view tools (docs/MCP.md): what is open, making and opening projects, tracks, markers, undo, the playhead */
import { animProps } from '../../lib/anim';
import { busyReason } from '../../lib/busy';
import { CANVAS_PRESETS, MAX_FPS } from '../../lib/factory';
import { shell } from '../../lib/shell';
import { projectDuration } from '../../lib/timelineOps';
import { faceNames } from '../../engine/scene3d/faces';
import { getEffect } from '../../engine/effects/registry';
import { listProjects } from '../../storage/db';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { closeProject, createAndOpenProject, openProjectById, useSaveState } from '../../store/session';
import type { Project } from '../../types';
import { changedSince, clipBrief, needClip, needProject, needTrack, ok, oneStep, optNumber, optString, round, ToolError } from '../helpers';
import type { ToolDef } from '../types';

const MAX_UNDO_STEPS = 50;
const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** the project in a few numbers, no clips and no media rows */
function projectBrief(p: Project): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    width: p.width,
    height: p.height,
    fps: p.fps,
    duration: round(projectDuration(p)),
    background: p.background,
    tracks: p.tracks.length,
    clips: p.clips.length,
    media: p.assets.length,
    markers: p.markers?.length ?? 0,
  };
}

/** an export in progress would break when the project under it changes */
function refuseWhileBusy(what: string): void {
  const busy = busyReason();
  if (busy) throw new ToolError(`cannot ${what} while ${busy}. wait for it (export_status) or stop it (export_cancel)`);
}

function cleanName(v: unknown, what: string): string | undefined {
  const name = optString(v);
  if (name === undefined) return undefined;
  const clean = name.trim();
  if (!clean) throw new ToolError(`${what} cannot be empty`);
  return clean;
}

export const projectTools: ToolDef[] = [
  {
    name: 'get_state',
    title: 'get the editor state',
    description:
      'a small snapshot of ncut: the app version, the open project (id, name, size, fps, duration, counts) or null, the playhead time in seconds, ' +
      'the selected clip ids, the save state, whether an export or another long job runs, and how many undo and redo steps there are. ' +
      'call it first to see whether a project is open. it holds no clips: get_project lists those.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run() {
      const s = useEditor.getState();
      const busy = busyReason();
      return ok({
        app: shell.version || 'browser',
        project: s.project ? projectBrief(s.project) : null,
        time: round(usePlayback.getState().time),
        playing: usePlayback.getState().playing,
        selection: s.selection,
        save: useSaveState.getState().state,
        exporting: busy !== null,
        busy,
        undoSteps: s.past.length,
        redoSteps: s.future.length,
      });
    },
  },
  {
    name: 'list_projects',
    title: 'list stored projects',
    description:
      'the projects stored in this app, newest first: id, name, size, fps, duration in seconds, clip count, last change as a unix time in milliseconds, ' +
      'and whether it is the open one. use open_project with an id to work in one, create_project to make a new one.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async run() {
      const openId = useEditor.getState().project?.id ?? null;
      const list = await listProjects();
      return ok({
        projects: list.map((p) => ({
          id: p.id,
          name: p.name,
          width: p.width,
          height: p.height,
          fps: p.fps,
          duration: round(p.duration),
          clips: p.clipCount,
          updated: p.updatedAt,
          open: p.id === openId,
        })),
      });
    },
  },
  {
    name: 'open_project',
    title: 'open a project',
    description:
      'opens a stored project in the editor window (the open one is saved first). undo history starts empty. the id of the project that is already open changes nothing: it answers the summary with a note. ' +
      'ids come from list_projects. refused while an export runs. answers a short summary of the project; get_project has the contents.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'project id from list_projects' } },
      required: ['id'],
    },
    annotations: { idempotentHint: true },
    async run(args) {
      refuseWhileBusy('open another project');
      const id = String(args.id);
      // reopening the open project would throw its undo history away for nothing
      const open = useEditor.getState().project;
      if (open && open.id === id) return ok({ ...projectBrief(open), note: 'this project is already open, so nothing was reopened and the undo history stays' });
      if (!(await openProjectById(id))) throw new ToolError(`no stored project with the id ${id}. list_projects lists them`);
      return ok(projectBrief(needProject()));
    },
  },
  {
    name: 'create_project',
    title: 'create and open a project',
    description:
      'makes a new empty project (one video track, one audio track) and opens it. the open project is saved first. ' +
      'preset picks the canvas ratio (default 16:9 = 1920x1080); width and height (pixels, 16..7680) and fps override it. ' +
      'answers the final size, so check it. undo history starts empty.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 200, description: 'project name, default "untitled project"' },
        preset: { type: 'string', enum: CANVAS_PRESETS.map((p) => p.id), description: 'canvas ratio, default 16:9' },
        width: { type: 'integer', minimum: 16, maximum: 7680, description: 'canvas width in pixels, replaces the preset width' },
        height: { type: 'integer', minimum: 16, maximum: 7680, description: 'canvas height in pixels, replaces the preset height' },
        fps: { type: 'number', minimum: 1, maximum: MAX_FPS, description: 'frames per second, default 30' },
      },
    },
    async run(args) {
      refuseWhileBusy('create a project');
      const name = cleanName(args.name, 'name');
      const preset = CANVAS_PRESETS.find((p) => p.id === args.preset);
      const made = await createAndOpenProject(name, preset, optNumber(args.fps));
      let open = useEditor.getState().project;
      if (!open || open.id !== made.id) throw new ToolError('the project was made but could not be opened');
      const width = optNumber(args.width);
      const height = optNumber(args.height);
      if (width !== undefined || height !== undefined) {
        // no undo step: a new project starts with an empty history
        useEditor.getState().updateProject({ ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) }, { skipHistory: true });
        open = needProject();
      }
      return ok(projectBrief(open));
    },
  },
  {
    name: 'close_project',
    title: 'close the project',
    description: 'saves the open project and goes back to the projects screen. nothing is lost. after it, tools that need a project fail until open_project or create_project. refused while an export runs.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const p = needProject();
      refuseWhileBusy('close the project');
      await closeProject();
      return ok({ closed: p.id });
    },
  },
  {
    name: 'update_project',
    title: 'change project settings',
    description:
      'changes the name, canvas size (pixels, 16..7680), frame rate (1..240) or background color (hex like #101010) of the open project, as one undo step. ' +
      'clips keep their pixel positions when the canvas size changes. send only what changes; a call that changes nothing is an error. answers the project summary.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 200 },
        width: { type: 'integer', minimum: 16, maximum: 7680 },
        height: { type: 'integer', minimum: 16, maximum: 7680 },
        fps: { type: 'number', minimum: 1, maximum: MAX_FPS },
        background: { type: 'string', maxLength: 9, description: 'hex color: #rgb, #rrggbb or #rrggbbaa' },
      },
    },
    run(args) {
      const before = needProject();
      const patch: Parameters<ReturnType<typeof useEditor.getState>['updateProject']>[0] = {};
      const name = cleanName(args.name, 'name');
      if (name !== undefined) patch.name = name;
      if (typeof args.width === 'number') patch.width = args.width;
      if (typeof args.height === 'number') patch.height = args.height;
      if (typeof args.fps === 'number') patch.fps = args.fps;
      if (typeof args.background === 'string') {
        if (!COLOR.test(args.background)) throw new ToolError('background must be a hex color like #101010');
        patch.background = args.background;
      }
      if (Object.keys(patch).length === 0) throw new ToolError('nothing to change: send name, width, height, fps or background');
      useEditor.getState().updateProject(patch);
      if (!changedSince(before)) throw new ToolError('the project already has those settings, nothing changed');
      return ok(projectBrief(needProject()));
    },
  },
  {
    name: 'get_project',
    title: 'read the project',
    description:
      'the contents of the open project: tracks top to bottom (id, kind, name, muted, hidden, locked), every clip as one short line (id, type, track, start, end, name, ' +
      'and what picks it out: media id, text, shape kind, effect), the media (id, name, kind, duration, size), markers and the duration, all in seconds and project pixels. ' +
      'it holds no keyframe values and no styling: get_clip gives one whole clip. the first track listed is the top layer.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run() {
      const p = needProject();
      return ok({
        ...projectBrief(p),
        trackList: p.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, muted: t.muted, hidden: t.hidden, locked: t.locked })),
        clipList: p.clips.map(clipBrief),
        mediaList: p.assets.map((a) => ({ id: a.id, name: a.name, kind: a.kind, duration: round(a.duration), width: a.width, height: a.height, hasAudio: a.hasAudio })),
        markerList: (p.markers ?? []).map((m) => ({ id: m.id, time: round(m.time), name: m.name })),
      });
    },
  },
  {
    name: 'get_clip',
    title: 'read one clip',
    description:
      'one clip exactly as stored (every field, keyframes included), plus "animatable": the properties set_keyframe and update_clip can animate (prop, label, min, max, unit), ' +
      'and for a 3d solid "sides": the side names set_sides takes. for what the fields mean see list_options with kind "fields". ids come from get_project.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'clip id' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: true },
    run(args) {
      const clip = needClip(args.id);
      const animatable: Record<string, unknown>[] = animProps(clip).map((a) => ({ ...a }));
      if (clip.type === 'effect') {
        // the effect's own numbers are keyed as p.<key>
        for (const prm of getEffect(clip.effect)?.params ?? []) {
          animatable.push({ prop: `p.${prm.key}`, label: prm.label, min: prm.min, max: prm.max, ...(prm.unit ? { unit: prm.unit } : {}) });
        }
      }
      const out: Record<string, unknown> = { clip: structuredClone(clip), animatable };
      if ('threeD' in clip && clip.threeD) {
        const names = faceNames(clip.shape);
        if (names.length > 0) out.sides = [...names];
      }
      return ok(out);
    },
  },
  {
    name: 'select_clips',
    title: 'select clips',
    description:
      'makes these clips the selection (replacing the old one); an empty list clears it. ids come from get_project. ' +
      'unknown ids and clips on locked tracks are errors and leave the selection as it was. several tools take the selection as their default target.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, maxItems: 1000, description: 'clip ids' } },
      required: ['ids'],
    },
    run(args) {
      const p = needProject();
      const ids = (args.ids as string[]).filter((x, i, all) => all.indexOf(x) === i);
      const unknown = ids.filter((id) => !p.clips.some((c) => c.id === id));
      if (unknown.length > 0) throw new ToolError(`no clip with the id ${unknown.join(', ')}. get_project lists the clips`);
      const locked = ids.filter((id) => p.tracks.find((t) => t.id === p.clips.find((c) => c.id === id)?.trackId)?.locked);
      if (locked.length > 0) throw new ToolError(`these clips are on a locked track and cannot be selected: ${locked.join(', ')}. unlock the track with update_track`);
      useEditor.getState().select(ids);
      return ok({ selection: useEditor.getState().selection });
    },
  },
  {
    name: 'seek',
    title: 'move the playhead',
    description:
      'moves the playhead to a timeline time in seconds. it is clamped to 0..project length (the end of the last clip); playback keeps running if it was. ' +
      'answers the time it landed on. render_frame can take a time of its own, seek is for what the user sees in the window.',
    inputSchema: {
      type: 'object',
      properties: { time: { type: 'number', minimum: 0, maximum: 86400, description: 'timeline seconds' } },
      required: ['time'],
    },
    run(args) {
      const p = needProject();
      const want = args.time as number;
      usePlayback.getState().seek(want);
      const time = usePlayback.getState().time;
      return ok({ time: round(time), duration: round(projectDuration(p)), ...(time < want ? { clamped: true } : {}) });
    },
  },
  {
    name: 'undo',
    title: 'undo edits',
    description:
      'takes back the last edits, one step each (a tool that edits is one step). steps 1..50, default 1. answers how many were undone and how many are left; ' +
      'it is an error when there is nothing to undo. redo brings steps back. media imports are not part of history.',
    inputSchema: {
      type: 'object',
      properties: { steps: { type: 'integer', minimum: 1, maximum: MAX_UNDO_STEPS, description: 'default 1' } },
    },
    run(args) {
      needProject();
      const want = optNumber(args.steps) ?? 1;
      let done = 0;
      for (let i = 0; i < want; i++) {
        const before = useEditor.getState().project;
        useEditor.getState().undo();
        if (useEditor.getState().project === before) break;
        done++;
      }
      if (done === 0) throw new ToolError('nothing to undo');
      const s = useEditor.getState();
      return ok({ done, requested: want, undoSteps: s.past.length, redoSteps: s.future.length });
    },
  },
  {
    name: 'redo',
    title: 'redo edits',
    description:
      'brings back edits that undo took away, one step each. steps 1..50, default 1. answers how many were redone and how many are left; ' +
      'an error when there is nothing to redo (a new edit empties the redo list).',
    inputSchema: {
      type: 'object',
      properties: { steps: { type: 'integer', minimum: 1, maximum: MAX_UNDO_STEPS, description: 'default 1' } },
    },
    run(args) {
      needProject();
      const want = optNumber(args.steps) ?? 1;
      let done = 0;
      for (let i = 0; i < want; i++) {
        const before = useEditor.getState().project;
        useEditor.getState().redo();
        if (useEditor.getState().project === before) break;
        done++;
      }
      if (done === 0) throw new ToolError('nothing to redo');
      const s = useEditor.getState();
      return ok({ done, requested: want, undoSteps: s.past.length, redoSteps: s.future.length });
    },
  },
  {
    name: 'add_track',
    title: 'add a track',
    description:
      'adds an empty track. video tracks hold pictures, text, shapes, effects and cameras and are added on top (the top track is the top layer); audio tracks hold sounds and are added at the bottom. ' +
      'index is the position in the track list from get_project (0 = top) and is clamped inside the video or audio group. answers the new track id and its position.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['video', 'audio'] },
        index: { type: 'integer', minimum: 0, maximum: 200, description: 'position in the track list, 0 = top' },
        name: { type: 'string', maxLength: 100 },
      },
      required: ['kind'],
    },
    run(args) {
      needProject();
      const name = cleanName(args.name, 'name');
      const index = optNumber(args.index);
      const id = oneStep((opts) => {
        const made = useEditor.getState().addTrack(args.kind as 'video' | 'audio', { ...opts, ...(index !== undefined ? { index } : {}) });
        if (made && name) useEditor.getState().updateTrack(made, { name }, opts);
        return made;
      });
      if (!id) throw new ToolError('the track could not be added');
      const p = needProject();
      const track = needTrack(id);
      return ok({ id, kind: track.kind, name: track.name, index: p.tracks.findIndex((t) => t.id === id) });
    },
  },
  {
    name: 'update_track',
    title: 'change a track',
    description:
      'renames a track or sets muted (silences its audio), hidden (video tracks only: its pictures are not drawn) or locked (its clips cannot be edited or selected). ' +
      'one undo step. send only what changes; a call that changes nothing is an error. ids come from get_project.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'track id' },
        name: { type: 'string', maxLength: 100 },
        muted: { type: 'boolean' },
        hidden: { type: 'boolean' },
        locked: { type: 'boolean' },
      },
      required: ['id'],
    },
    run(args) {
      const before = needProject();
      const track = needTrack(args.id);
      const patch: Parameters<ReturnType<typeof useEditor.getState>['updateTrack']>[1] = {};
      const name = cleanName(args.name, 'name');
      if (name !== undefined) patch.name = name;
      if (typeof args.muted === 'boolean') patch.muted = args.muted;
      if (typeof args.hidden === 'boolean') {
        if (track.kind === 'audio') throw new ToolError('hidden only applies to video tracks. use muted for an audio track');
        patch.hidden = args.hidden;
      }
      if (typeof args.locked === 'boolean') patch.locked = args.locked;
      if (Object.keys(patch).length === 0) throw new ToolError('nothing to change: send name, muted, hidden or locked');
      // the store writes a step even for equal values, so compare here
      const same = (Object.keys(patch) as (keyof typeof patch)[]).every((k) => track[k] === patch[k]);
      if (same) throw new ToolError(`the track ${track.id} already has those settings, nothing changed`);
      useEditor.getState().updateTrack(track.id, patch);
      if (!changedSince(before)) throw new ToolError(`the track ${track.id} could not be changed`);
      const now = needTrack(track.id);
      return ok({ id: now.id, kind: now.kind, name: now.name, muted: now.muted, hidden: now.hidden, locked: now.locked });
    },
  },
  {
    name: 'remove_track',
    title: 'remove a track',
    description:
      'removes a track and every clip on it (also effects aimed at those clips). one undo step, so undo brings it back. ' +
      'answers how many clips went with it. to keep the clips, move_clip them to another track first. a locked track is refused: unlock it with update_track first.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'track id' } },
      required: ['id'],
    },
    annotations: { destructiveHint: true },
    run(args) {
      const before = needProject();
      const track = needTrack(args.id);
      if (track.locked) throw new ToolError(`the track ${track.id} (${track.name}) is locked. unlock it with update_track first`);
      useEditor.getState().removeTrack(track.id);
      if (!changedSince(before)) throw new ToolError(`the track ${track.id} could not be removed`);
      return ok({ removed: track.id, name: track.name, clipsRemoved: before.clips.length - needProject().clips.length });
    },
  },
  {
    name: 'add_marker',
    title: 'add a marker',
    description:
      'puts a named marker on the timeline at a time in seconds (markers help with snapping and jumping). one undo step. ' +
      'an error when a marker already sits within a millisecond of that time. answers the marker id.',
    inputSchema: {
      type: 'object',
      properties: {
        time: { type: 'number', minimum: 0, maximum: 86400, description: 'timeline seconds' },
        name: { type: 'string', maxLength: 200 },
      },
      required: ['time'],
    },
    run(args) {
      const before = needProject();
      const time = args.time as number;
      const near = before.markers?.find((m) => Math.abs(m.time - time) <= 1e-3);
      if (near) throw new ToolError(`the marker ${near.id} already sits at ${round(near.time)}. remove_marker it first or pick another time`);
      const id = useEditor.getState().addMarker(time, optString(args.name) ?? '');
      const made = needProject().markers?.find((m) => m.id === id);
      if (!made) throw new ToolError('the marker could not be added');
      return ok({ id: made.id, time: round(made.time), name: made.name });
    },
  },
  {
    name: 'remove_marker',
    title: 'remove a marker',
    description: 'removes a marker by id (get_project lists them). one undo step.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'marker id' } },
      required: ['id'],
    },
    annotations: { destructiveHint: true },
    run(args) {
      const p = needProject();
      if (!p.markers?.some((m) => m.id === args.id)) throw new ToolError(`no marker with the id ${String(args.id)}. get_project lists the markers`);
      useEditor.getState().removeMarker(String(args.id));
      return ok({ removed: args.id });
    },
  },
];

