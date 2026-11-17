/** the picture and sound tools (docs/MCP.md, "sound"): separate a video's sound into a clip of its own, join it back, line the two up */
import { setCrossfades, type CrossRequest } from '../../features/timeline/crossfadeActions';
import type { CrossChange } from '../../features/timeline/crossfadePlan';
import { joinSound, separateSound, syncSound } from '../../features/timeline/soundActions';
import type { SyncHow } from '../../features/timeline/soundPlan';
import { useEditor } from '../../store/editorStore';
import type { Clip, FadeShape } from '../../types';
import { FADE_SHAPES } from '../../types';
import { idList, needClip, needTrack, ok, oneStep, optNumber, ToolError } from '../helpers';
import type { ToolDef } from '../types';

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

/** a string is why nothing was done: whatever was written is taken back (nothing, when the plan said no) and the reason goes to the client */
function done<T>(r: T | string): T {
  if (typeof r === 'string') {
    useEditor.getState().rollback();
    throw new ToolError(r);
  }
  return r;
}

const separateSoundTool: ToolDef = {
  name: 'separate_sound',
  title: 'separate sound',
  description:
    'the sound of video clips becomes a clip of its own on an audio track (same file, part, time, speed, volume, mute, fades, volume keys, tempo), the video clip is muted, both share a group. ' +
    'track: the audio track to use (it must not be locked, and needs room and the video track\'s mute, volume and pan, else the sound goes to another track and the answer has a note). one undo step, the exported sound stays the same. ' +
    'answers { pairs: [{ picture, sound, track }], skipped: [{ id, why }], note? }. an error says why nothing was separated.',
  inputSchema: {
    type: 'object',
    properties: {
      ids: ids('video clips with sound (get_project lists the clips)'),
      track: { type: 'string', description: 'the audio track for the sound clips. default: a track that fits, or a new one' },
    },
    required: ['ids'],
  },
  run(args) {
    const list = idList(args.ids);
    needClips(list);
    let prefer: string | undefined;
    if (args.track !== undefined) {
      const t = needTrack(args.track);
      if (t.kind === 'video') throw new ToolError(`the track ${t.id} (${t.name}) is a video track: the sound needs an audio track`);
      if (t.locked) throw new ToolError(`the track ${t.id} (${t.name}) is locked. unlock it with update_track first`);
      prefer = t.id;
    }
    const r = done(oneStep((opts) => separateSound(list, { ...opts, prefer })));
    // the asked track is the first try only: say so when a sound went somewhere else
    const elsewhere = prefer === undefined ? [] : r.pairs.filter((p) => p.track !== prefer);
    if (elsewhere.length === 0) return ok(r);
    return ok({ ...r, note: `the sound of ${elsewhere.map((p) => p.picture).join(', ')} went to another track than ${prefer}: the asked track had no room there or its mute, volume or pan differ from the video track` });
  },
};

const joinSoundTool: ToolDef = {
  name: 'join_sound',
  title: 'join sound back',
  description:
    'picture or sound ids. the sound clip goes, the picture plays its own sound again. only pairs in sync, at one speed, of one length, with the same fades and track sound; the rest is in skipped. one undo step. ' +
    'answers { joined, removed, skipped }. an error says why nothing was joined.',
  inputSchema: {
    type: 'object',
    properties: { ids: ids('the pictures or the sound clips of separated pairs') },
    required: ['ids'],
  },
  run(args) {
    const list = idList(args.ids);
    needClips(list);
    const r = done(oneStep((opts) => joinSound(list, opts)));
    return ok(r);
  },
};

const syncSoundTool: ToolDef = {
  name: 'sync_sound',
  title: 'line up picture and sound',
  description:
    'lines picture and sound up again, in one undo step. how: "move" (default) moves the clip, "slip" slides its media, "speed" changes its speed so both play the same moment of the file. ' +
    'with both sides named the sound clip changes. answers { synced, skipped: [{ id, why }] }. an error says why nothing was lined up.',
  inputSchema: {
    type: 'object',
    properties: {
      ids: ids('the pictures or the sound clips of separated pairs'),
      how: { type: 'string', enum: ['move', 'slip', 'speed'], description: 'move the clip (default), slip its media, or change its speed' },
    },
    required: ['ids'],
  },
  run(args) {
    const list = idList(args.ids);
    needClips(list);
    const how = (args.how ?? 'move') as SyncHow;
    const r = done(oneStep((opts) => syncSound(list, how, opts)));
    return ok(r);
  },
};

const crossfadeEditsTool: ToolDef = {
  name: 'crossfade_edits',
  title: 'crossfade edits',
  description:
    'adds, changes or removes the sound crossfade at edits: ids (clips with sound, at "start", "end" or "both") or a track (every edit there but inside one take). new: 0.25 s, equal power, centered. ' +
    'length: the whole crossfade in seconds. place: center (default), start (the crossfade starts at the edit) or end (it ends there). before / after: seconds each side of the edit, instead of length. ' +
    'shape: power (equal power, default), linear or smooth. withTransition: true takes the length from the picture transition at the edit. remove: true takes crossfades away. ' +
    'the answer says what fits: { set: [{ clip, edit, before, after, shape, short? }], removed, skipped: [{ id, why }] }. one undo step. an error says why nothing was changed.',
  inputSchema: {
    type: 'object',
    properties: {
      ids: ids('clips with sound: the edit at their start and / or end (get_project lists the clips)'),
      at: { type: 'string', enum: ['start', 'end', 'both'], description: 'with ids: which edit of each clip. default both' },
      track: { type: 'string', description: 'instead of ids: every edit between two clips with sound on this track' },
      length: { type: 'number', minimum: 0.001, maximum: 20, description: 'the whole crossfade in seconds, 0.001 to 20 (each side up to 10). default 0.25' },
      before: { type: 'number', minimum: 0, maximum: 10, description: 'seconds before the edit, 0 to 10, from the media past the edit of the clip' },
      after: { type: 'number', minimum: 0, maximum: 10, description: 'seconds after the edit, 0 to 10, from the media past the edit of the clip before' },
      place: { type: 'string', enum: ['center', 'start', 'end'], description: 'where the crossfade sits at the edit: center, start (it starts at the edit) or end (it ends there). default center' },
      shape: { type: 'string', enum: [...FADE_SHAPES], description: 'power (equal power, default), linear or smooth' },
      withTransition: { type: 'boolean', description: 'true: the crossfade follows the picture transition at the edit. false: it stops following it' },
      remove: { type: 'boolean', description: 'true: takes the crossfades away' },
    },
  },
  run(args) {
    const list = args.ids === undefined ? undefined : idList(args.ids);
    const track = typeof args.track === 'string' ? args.track : undefined;
    if (list === undefined && track === undefined) throw new ToolError('give ids or a track');
    if (list !== undefined && track !== undefined) throw new ToolError('give ids or a track, not both');
    const length = optNumber(args.length);
    const before = optNumber(args.before);
    const after = optNumber(args.after);
    if (length !== undefined && (before !== undefined || after !== undefined)) throw new ToolError('give length, or before and after, not both');
    if (list) needClips(list);
    if (track !== undefined) needTrack(track);
    const change: CrossChange = {};
    if (length !== undefined) change.length = length;
    if (before !== undefined) change.before = before;
    if (after !== undefined) change.after = after;
    if (args.place !== undefined) change.place = args.place as Exclude<NonNullable<CrossChange['place']>, 'custom'>;
    if (args.shape !== undefined) change.shape = args.shape as FadeShape;
    if (typeof args.withTransition === 'boolean') change.withTransition = args.withTransition;
    if (args.remove === true) change.remove = true;
    const req: CrossRequest = { ...(list ? { ids: list } : {}), ...(args.at !== undefined ? { at: args.at as 'start' | 'end' | 'both' } : {}), ...(track !== undefined ? { track } : {}), change };
    const r = done(oneStep((opts) => setCrossfades(req, opts)));
    return ok(r);
  },
};

export const soundTools: ToolDef[] = [separateSoundTool, joinSoundTool, syncSoundTool, crossfadeEditsTool];
