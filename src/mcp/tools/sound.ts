/** the picture and sound tools (docs/MCP.md, "sound"): separate a video's sound into a clip of its own, join it back, line the two up */
import { joinSound, separateSound, syncSound } from '../../features/timeline/soundActions';
import type { SyncHow } from '../../features/timeline/soundPlan';
import { useEditor } from '../../store/editorStore';
import type { Clip } from '../../types';
import { idList, needClip, needTrack, ok, oneStep, ToolError } from '../helpers';
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

export const soundTools: ToolDef[] = [separateSoundTool, joinSoundTool, syncSoundTool];
