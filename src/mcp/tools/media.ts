/** media tools (docs/MCP.md): bring files into the project, put media on the timeline, swap media */
import { skyCandidates, skyUses } from '../../engine/scene3d/sky';
import { usedAssetIds } from '../../features/media/mediaList';
import { applyMatch } from '../../features/preview/sourceKeys';
import { runEdit } from '../../features/timeline/editActions';
import { busyFor } from '../../lib/busy';
import { editSpan, inOutSpan } from '../../lib/inOut';
import { marksOf } from '../../lib/marks';
import { matchFrameAt, planMatchFrame } from '../../lib/matchFrame';
import { deleteAsset, importFiles, useImporting } from '../../media/importer';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { importProjectFile } from '../../store/session';
import { useUi } from '../../store/ui';
import type { ClipParts, InOutRange, MediaAsset } from '../../types';
import { isMediaClip, MIN_CLIP_DURATION } from '../../types';
import { clipBrief, needAsset, needClip, needProject, needTrack, needUnlocked, ok, optNumber, round, ToolError } from '../helpers';
import type { ToolDef } from '../types';
import { MAX_TIME } from './editPatch';

const DESKTOP_ONLY = 'this tool only works in the ncut desktop app: the app reads the files from disk. in a browser there is no way to hand it a path';

/** the messages unpackProject throws for a file that is not a readable project (storage/projectFile.ts) */
const BAD_FILE = ['not an ncut project file', 'the project file is damaged', 'this project file was made by a newer version of ncut'];

function assetBrief(a: MediaAsset): Record<string, unknown> {
  return { id: a.id, name: a.name, kind: a.kind, duration: round(a.duration), width: a.width, height: a.height, hasAudio: a.hasAudio };
}

const PART_MIN = MIN_CLIP_DURATION - 1e-9;

/** the in and out of a part, as the answers show them: only the keys that are set */
function marksOut(m: InOutRange | null): Record<string, number> | null {
  if (!m) return null;
  return { ...(m.in !== undefined ? { in: round(m.in) } : {}), ...(m.out !== undefined ? { out: round(m.out) } : {}) };
}

function pictureText(a: MediaAsset): string {
  return `the media ${a.id} is a picture: pictures have no in or out, their length is set on the timeline`;
}

/**
 * the one check of a part of a file: set_media_marks, add_media_clip and edit_media. next = the marks as they would be (before cleanRange,
 * which drops a crossed out). kept names a side that comes from the media's own marks: it is not checked against the end, and the error says it
 */
function checkPart(a: MediaAsset, next: InOutRange, kept?: 'in' | 'out'): void {
  for (const key of ['in', 'out'] as const) {
    const v = next[key];
    if (v !== undefined && kept !== key && v > a.duration + 1e-6) throw new ToolError(`${key} ${round(v)} is after the end of the media (${round(a.duration)} s)`);
  }
  if (next.in !== undefined && next.out !== undefined && next.out <= next.in) {
    const side = kept === 'out' ? ` (the kept out is ${round(next.out)} s)` : kept === 'in' ? ` (the kept in is ${round(next.in)} s)` : '';
    throw new ToolError(`in has to be before out${side}`);
  }
  const d = a.duration;
  const len = Math.min(next.out ?? d, d) - Math.min(next.in ?? 0, d);
  if (len < PART_MIN) throw new ToolError('the marked part has to be at least 0.05 s long');
}

/** the in and out of the arguments, only the given keys */
function givenPart(args: Record<string, unknown>): InOutRange {
  const i = optNumber(args.in);
  const o = optNumber(args.out);
  return { ...(i !== undefined ? { in: i } : {}), ...(o !== undefined ? { out: o } : {}) };
}

/** parts of the media that it does not have */
function checkParts(a: MediaAsset, parts: unknown): void {
  if (parts === 'picture' && a.kind === 'audio') throw new ToolError(`the media ${a.id} is audio: it has no picture`);
  if (parts === 'sound' && (a.kind === 'image' || (a.kind === 'video' && !a.hasAudio))) throw new ToolError(`the media ${a.id} has no sound`);
}

export const mediaTools: ToolDef[] = [
  {
    name: 'import_media',
    title: 'import media files',
    description:
      'adds video, audio and image files from disk to the open project\'s media (not to the timeline: add_media_clip does that). ' +
      'paths is required: 1 to 16 absolute paths with a drive letter, like C:/clips/a.mp4. ' +
      'video: mp4 m4v mov webm mkv ogv avi ts mts 3gp. audio: mp3 wav ogg oga m4a aac flac opus weba aiff aif. image: png jpg jpeg gif webp bmp avif svg. ' +
      'answers the new media (id, name, kind, duration in seconds, size in pixels, hasAudio). files that cannot be read are left out and listed in "skipped" (name and why). when the new files look like a skybox, looksLikeSky holds their ids: update_project { sky: { media: looksLikeSky } } makes it the sky. desktop app only.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string', maxLength: 1024 },
          minItems: 1,
          maxItems: 16,
          description: 'absolute file paths with a drive letter. required (the desktop app reads the files and checks the paths)',
        },
      },
    },
    async run(_args, ctx) {
      if (ctx.files.length === 0) throw new ToolError(DESKTOP_ONLY);
      needProject();
      // the type stays empty: the importer tells the kind from the extension
      const files = ctx.files.map((f) => new File([f.bytes], f.name));
      // quiet: the answer names the skipped files, a toast would say it twice
      const skipped: { name: string; why: string }[] = [];
      const added = await importFiles(files, { quiet: true, onSkip: (name, why) => skipped.push({ name, why }) });
      if (added.length === 0) {
        const named = skipped.map((s) => `${s.name} (${s.why})`).join(', ');
        throw new ToolError(`none of the files could be imported${named ? `: ${named}` : ''}. see the list of formats in this tool's description`);
      }
      const sets = skyCandidates(added);
      return ok({ media: added.map(assetBrief), ...(skipped.length > 0 ? { skipped } : {}), ...(sets.length > 0 ? { looksLikeSky: sets[0] } : {}) });
    },
  },
  {
    name: 'import_project',
    title: 'import a project file',
    description:
      'adds a .ncut project file from disk to the stored projects as a new project (new ids, so the same file twice gives two projects). ' +
      'path is required: an absolute path with a drive letter to one .ncut file. it is not opened: answer the id to open_project. desktop app only.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', maxLength: 1024, description: 'absolute path of a .ncut file. required (the desktop app reads the file and checks the path)' },
      },
    },
    async run(_args, ctx) {
      const file = ctx.files[0];
      if (!file) throw new ToolError(DESKTOP_ONLY);
      let id: string;
      try {
        id = await importProjectFile(new Blob([file.bytes]));
      } catch (e) {
        const why = e instanceof Error ? e.message : '';
        // only what unpackProject throws is about the file, anything else (quota, db) is about storing it
        const unreadable = BAD_FILE.includes(why) ? '. the file is not a project ncut can read' : '';
        throw new ToolError(`could not import ${file.name}${why ? `: ${why}` : ''}${unreadable}`);
      }
      // the projects screen shows the new project
      useUi.getState().projectsChanged();
      return ok({ id, note: 'stored as a new project, not opened. open_project opens it' });
    },
  },
  {
    name: 'set_media_marks',
    title: 'mark a part of media',
    description:
      'marks the part of a video or audio media that a drag, a double click or add_media_clip takes, like i and o in the source view. ' +
      'seconds into the file, out is where the part ends. one alone keeps the other mark. clear: true takes both away. not an undo step. ' +
      'answers { asset, marks (in, out) or null, length (the marked part, else the whole media, in seconds) }.',
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string', description: 'media id' },
        in: { type: 'number', minimum: 0, description: 'where the part starts, seconds into the file' },
        out: { type: 'number', minimum: 0, description: 'where the part ends, seconds into the file' },
        clear: { type: 'boolean', description: 'true: take both marks away' },
      },
      required: ['asset'],
    },
    run(args) {
      const asset = needAsset(args.asset);
      if (asset.kind === 'image') throw new ToolError(pictureText(asset));
      const given = givenPart(args);
      const clear = args.clear === true;
      const has = given.in !== undefined || given.out !== undefined;
      if (clear && has) throw new ToolError('clear does not go with in or out');
      if (!clear && !has) throw new ToolError('nothing to set: give in, out or clear: true');
      let next: InOutRange | null = null;
      if (!clear) {
        const cur = marksOf(asset);
        const inT = given.in ?? cur?.in;
        const outT = given.out ?? cur?.out;
        next = { ...(inT !== undefined ? { in: inT } : {}), ...(outT !== undefined ? { out: outT } : {}) };
        const kept = given.in === undefined && cur?.in !== undefined ? 'in' : given.out === undefined && cur?.out !== undefined ? 'out' : undefined;
        checkPart(asset, next, kept);
      }
      if (!useEditor.getState().setMediaMarks(asset.id, next)) throw new ToolError('the media already has these marks, nothing changed');
      const marks = marksOf(needAsset(asset.id));
      const span = marks ? inOutSpan(marks, asset.duration) : null;
      return ok({ asset: asset.id, marks: marksOut(marks), length: round(span ? span.end - span.start : asset.duration) });
    },
  },
  {
    name: 'add_media_clip',
    title: 'put media on the timeline',
    description:
      'makes a clip of a media item (id from get_project or import_media) on the timeline, as one undo step. video and images go on a video track, audio on an audio track. ' +
      'track: the track to use (it has to be the right kind and unlocked); without it the first fitting track is used, and a new one is made when none fits at start. ' +
      'start: timeline seconds; without it the clip goes after the last clip of the track. a clip never overlaps another, so it can land later than start: the answer shows where it went. ' +
      'a video clip is as long as the media, an image 5 s, change it with trim_clip. ' +
      'in / out: only that part of the file (seconds); one alone takes the start or the end for the other. without both, the media\'s marks are used (usedMarks: true). ' +
      'parts: picture leaves the sound out (muted), sound is an audio clip of the file\'s sound on an audio track. ' +
      'answers the clip, source (in and out in the file, video and audio) and usedMarks.',
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string', description: 'media id' },
        track: { type: 'string', description: 'track id' },
        start: { type: 'number', minimum: 0, description: 'timeline seconds' },
        in: { type: 'number', minimum: 0, description: 'where the part starts, seconds into the file' },
        out: { type: 'number', minimum: 0, description: 'where the part ends, seconds into the file' },
        parts: { type: 'string', enum: ['both', 'picture', 'sound'], description: 'both (default), picture only or sound only' },
      },
      required: ['asset'],
    },
    run(args) {
      const asset = needAsset(args.asset);
      const given = givenPart(args);
      const hasPart = given.in !== undefined || given.out !== undefined;
      if (hasPart) {
        if (asset.kind === 'image') throw new ToolError(pictureText(asset));
        checkPart(asset, given);
      }
      checkParts(asset, args.parts);
      const parts = args.parts as ClipParts | undefined;
      if (args.track !== undefined) {
        const track = needTrack(args.track);
        const want = parts === 'sound' || asset.kind === 'audio' ? 'audio' : 'video';
        const words = parts === 'sound' && asset.kind === 'video' ? 'the sound of a video' : `${asset.kind} media`;
        if (track.kind !== want) throw new ToolError(`the track ${track.id} is ${track.kind === 'audio' ? 'an' : 'a'} ${track.kind} track, ${words} goes on ${want === 'audio' ? 'an audio' : 'a video'} track`);
        if (track.locked) throw new ToolError(`the track ${track.id} (${track.name}) is locked. unlock it with update_track first`);
      }
      const marks = hasPart ? null : marksOf(asset);
      const range = hasPart ? given : marks;
      const start = optNumber(args.start);
      const id = useEditor.getState().insertAsset(asset.id, {
        ...(typeof args.track === 'string' ? { trackId: args.track } : {}),
        ...(start !== undefined ? { start } : {}),
        ...(range ? { range } : {}),
        ...(parts && parts !== 'both' ? { parts } : {}),
      });
      if (!id) throw new ToolError(`the media ${asset.id} could not be put on the timeline`);
      const clip = needClip(id);
      const source = clip.type === 'video' || clip.type === 'audio' ? { source: { in: round(clip.trimStart), out: round(clip.trimStart + clip.duration * clip.speed) } } : {};
      return ok({ ...clipBrief(clip), ...source, usedMarks: marks !== null });
    },
  },
  {
    name: 'match_frame',
    title: 'match frame',
    description:
      'shows the media of a clip in the source view at the frame the clip shows at time (timeline seconds, default the playhead), marks the part the clip uses (replacing its marks). ' +
      'without clip: the clip under time, picked like the f key. the playhead does not move, but playback pauses. not an undo step. ' +
      'answers { clip, asset, sourceTime (seconds into the file), marks (in, out) or null, replaced (other marks were overwritten) }.',
    inputSchema: {
      type: 'object',
      properties: {
        clip: { type: 'string', description: 'clip id. default: the clip under time' },
        time: { type: 'number', minimum: 0, maximum: MAX_TIME, description: 'timeline seconds. default: the playhead' },
      },
    },
    run(args) {
      const p = needProject();
      const t = optNumber(args.time) ?? usePlayback.getState().time;
      let target;
      if (args.clip !== undefined) {
        const clip = needClip(args.clip);
        if (!isMediaClip(clip)) throw new ToolError(`the clip ${clip.id} is a ${clip.type} clip: only video, audio and image clips have media`);
        const asset = needAsset(clip.assetId);
        const end = clip.start + clip.duration;
        if (!(clip.start <= t + 1e-6 && t < end - 1e-6)) throw new ToolError(`time ${round(t)} s is outside the clip ${clip.id} (${round(clip.start)} s to ${round(end)} s)`);
        target = planMatchFrame(clip, asset, t);
      } else {
        target = matchFrameAt(p, t, useEditor.getState().selection);
        if (!target) throw new ToolError(`no video, audio or image clip at ${round(t)} s`);
      }
      const r = applyMatch(target);
      return ok({ clip: target.clip.id, asset: target.asset.id, sourceTime: round(target.time), marks: marksOut(target.marks), replaced: r.replaced });
    },
  },
  {
    name: 'edit_media',
    title: 'three point edit',
    description:
      'edits media into the timeline like f9 / f10, one undo step. insert: the clips after the edit point move later on every unlocked track (a clip over it is split). ' +
      'overwrite: covers the target tracks, nothing moves. fit: overwrite at the speed that fills at to until. replace: the clip under at shows the media, frame matched (source_time lands at at), same length. ' +
      'append: after the last clip of the target tracks. place: at / until (timeline s), else the project in and out (cleared after use), else the playhead. ' +
      'part: in / out (media s), else its marks, else all. track / sound_track: default the lowest unlocked video and top unlocked audio track. parts picture / sound: one half. ' +
      'sound_apart: a video with sound arrives as a grouped pair, else its sound stays in the video clip. the playhead goes to the end of the new clip. ' +
      'answers { mode, clips, start, length, sourceIn, speed, split, moved, removed, trimmed, playhead } and, when they apply, slivers, kept, soundsKept, lockedTracks, newTracks, rangeCleared.',
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string', description: 'media id' },
        mode: { type: 'string', enum: ['insert', 'overwrite', 'replace', 'fit', 'append'], description: 'insert, overwrite, replace, fit or append' },
        track: { type: 'string', description: 'video track id for the picture' },
        sound_track: { type: 'string', description: 'audio track id for the sound' },
        at: { type: 'number', minimum: 0, description: 'where it goes on the timeline, seconds. default: the project in point, else the playhead' },
        until: { type: 'number', minimum: 0, description: 'where it ends on the timeline, seconds. default: the project out point' },
        in: { type: 'number', minimum: 0, description: 'where the part starts, seconds into the file' },
        out: { type: 'number', minimum: 0, description: 'where the part ends, seconds into the file' },
        parts: { type: 'string', enum: ['both', 'picture', 'sound'], description: 'both (default), picture only or sound only' },
        sound_apart: { type: 'boolean', description: 'a video with sound arrives as a grouped pair of clips' },
        clip: { type: 'string', description: 'replace: the clip to change. default: the clip under at' },
        source_time: { type: 'number', minimum: 0, description: 'replace: the moment of the media that lands at at, seconds into the file' },
      },
      required: ['asset', 'mode'],
    },
    run(args) {
      const p = needProject();
      const asset = needAsset(args.asset);
      const mode = args.mode as 'insert' | 'overwrite' | 'replace' | 'fit' | 'append';
      const parts = args.parts as ClipParts | undefined;
      const checkTrack = (key: 'track' | 'sound_track'): void => {
        if (args[key] === undefined) return;
        const track = needTrack(args[key]);
        if (key === 'track' && track.kind === 'audio') throw new ToolError(`the track ${track.id} is an audio track: track is the video track for the picture, sound_track the audio track`);
        if (key === 'sound_track' && track.kind === 'video') throw new ToolError(`the track ${track.id} is a video track: sound_track is the audio track for the sound, track the video track`);
        if (track.locked) throw new ToolError(`the track ${track.id} (${track.name}) is locked. unlock it with update_track first`);
        if (key === 'track' && (asset.kind === 'audio' || parts === 'sound')) throw new ToolError('track is for the picture: give the audio track as sound_track');
      };
      checkTrack('track');
      checkTrack('sound_track');
      checkParts(asset, parts);
      const marks = givenPart(args);
      const hasMarks = marks.in !== undefined || marks.out !== undefined;
      if (hasMarks) {
        if (asset.kind === 'image') throw new ToolError(pictureText(asset));
        checkPart(asset, marks);
      }
      const at = optNumber(args.at);
      const until = optNumber(args.until);
      if (until !== undefined) {
        if (at === undefined && until <= 0) throw new ToolError('until has to be after 0');
        if (at !== undefined && until <= at) throw new ToolError('until has to be after at');
        if (at !== undefined && until - at < PART_MIN) throw new ToolError('the range has to be at least 0.05 s long');
      }
      if (mode === 'append' && (at !== undefined || until !== undefined)) throw new ToolError('append goes after the last clip of the target tracks: leave at and until out');
      if (mode === 'replace' && until !== undefined) throw new ToolError('replace keeps the clip length: leave until out');
      if (mode !== 'replace') {
        for (const key of ['clip', 'source_time'] as const) if (args[key] !== undefined) throw new ToolError(`${key} only goes with mode replace`);
      }
      if (args.clip !== undefined) needClip(args.clip);
      const sourceTime = optNumber(args.source_time);
      if (sourceTime !== undefined && asset.kind !== 'image' && sourceTime > asset.duration + 1e-6) {
        throw new ToolError(`source_time ${round(sourceTime)} is after the end of the media (${round(asset.duration)} s)`);
      }
      if (mode === 'fit' && !((at !== undefined && until !== undefined) || (at === undefined && until === undefined && editSpan(p.range)))) {
        throw new ToolError('fit needs at and until, or both in and out points of the project (set_range)');
      }
      const r = runEdit({
        mode,
        assetId: asset.id,
        ...(hasMarks ? { marks } : {}),
        ...(at !== undefined || until !== undefined ? { range: { ...(at !== undefined ? { in: at } : {}), ...(until !== undefined ? { out: until } : {}) } } : {}),
        playhead: at ?? usePlayback.getState().time,
        ...(sourceTime !== undefined ? { sourceTime } : {}),
        targets: {
          picture: parts === 'sound' ? false : typeof args.track === 'string' ? args.track : null,
          sound: parts === 'picture' ? false : typeof args.sound_track === 'string' ? args.sound_track : null,
        },
        apart: args.sound_apart === true,
        selection: [],
        ...(typeof args.clip === 'string' ? { clipId: args.clip } : {}),
      });
      if (!r.ok) throw new ToolError(r.reason ?? 'the edit could not be done');
      const now = needProject();
      const briefs = r.clips.flatMap((id) => {
        const c = now.clips.find((x) => x.id === id);
        return c ? [clipBrief(c)] : [];
      });
      return ok({
        mode: r.mode,
        clips: briefs,
        start: round(r.start),
        length: round(r.length),
        sourceIn: round(r.from),
        speed: round(r.speed),
        split: r.split,
        moved: r.moved,
        removed: r.removed,
        trimmed: r.trimmed,
        playhead: round(usePlayback.getState().time),
        ...(r.slivers > 0 ? { slivers: r.slivers } : {}),
        ...(r.kept > 0 ? { kept: r.kept } : {}),
        ...(r.soundsKept > 0 ? { soundsKept: r.soundsKept } : {}),
        ...(r.lockedTracks.length > 0 ? { lockedTracks: r.lockedTracks } : {}),
        ...(r.newTracks.length > 0 ? { newTracks: r.newTracks } : {}),
        ...(r.rangeCleared ? { rangeCleared: marksOut(r.rangeCleared) } : {}),
      });
    },
  },
  {
    name: 'replace_media',
    title: 'swap the media of a clip',
    description:
      'a video, image or audio clip shows other media instead, keeping its place, look and animation (one undo step). the media has to be of the same kind as the clip (an audio clip also takes a video with sound). a picture whose sound is a clip of its own swaps that sound clip too. ' +
      'a video or audio clip keeps its trim when the new media is long enough, otherwise the trim moves back and then the clip gets shorter. answers the clip.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'clip id' },
        asset: { type: 'string', description: 'media id of the new media' },
      },
      required: ['id', 'asset'],
    },
    run(args) {
      const clip = needClip(args.id);
      const asset = needAsset(args.asset);
      if (clip.type !== 'video' && clip.type !== 'image' && clip.type !== 'audio') {
        throw new ToolError(`the clip ${clip.id} is a ${clip.type} clip: only video, image and audio clips have media to replace`);
      }
      if (asset.kind !== clip.type && !(clip.type === 'audio' && asset.kind === 'video' && asset.hasAudio)) {
        throw new ToolError(`the clip ${clip.id} is a ${clip.type} clip but the media ${asset.id} is ${asset.kind}. pick media of the same kind (an audio clip also takes a video with sound)`);
      }
      if (clip.assetId === asset.id) throw new ToolError(`the clip ${clip.id} already shows the media ${asset.id}`);
      needUnlocked(clip);
      if (!useEditor.getState().replaceClipAsset(clip.id, asset.id)) {
        throw new ToolError(`the media of the clip ${clip.id} could not be replaced (the clip or media is gone, the kinds differ or the track is locked)`);
      }
      return ok(clipBrief(needClip(clip.id)));
    },
  },
  {
    name: 'remove_media',
    title: 'remove media from the project',
    description:
      'removes media from the open project and deletes its stored file from the app for good (the file on disk it was imported from is not touched). it cannot be undone: media is not part of the undo history. ' +
      'ids: media ids from get_project or import_media (1 to 200). unused: true removes every media item no clip uses, instead of ids. send one of the two. ' +
      'media that clips use is refused unless with_clips: true, which deletes those clips too and clears the whole undo history. it is refused when one of those clips is on a locked track. ' +
      'pictures of the sky are refused (take the sky off first with update_project sky: null) and unused: true leaves them. unused: true is refused while files are being imported. removing unused media can also clear the undo history when an undo step still holds a clip of it: the answer says so in undoCleared. refused while an export runs. ' +
      'answers what was removed (id, name), how many clips went with it, undoCleared and how many media are left.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 200, description: 'media ids' },
        unused: { type: 'boolean', description: 'true: every media item no clip uses' },
        with_clips: { type: 'boolean', description: 'also delete the clips that use the media. default false' },
      },
    },
    annotations: { destructiveHint: true },
    async run(args) {
      const p = needProject();
      const byIds = Array.isArray(args.ids);
      const unused = args.unused === true;
      if (byIds === unused) throw new ToolError('send ids (media ids from get_project) or unused: true, one of the two');
      if (unused && args.with_clips === true) throw new ToolError('with_clips does not go with unused: true, unused media has no clips');
      if (unused && useImporting.getState().count > 0) {
        throw new ToolError('cannot remove unused media while files are being imported (a drop onto the timeline places its clips only when every file is in). try again when the import is done, or name the media in ids');
      }
      const used = usedAssetIds(p.clips, p.sky);
      // duplicates count once
      const ids = byIds ? [...new Set((args.ids as unknown[]).map(String))] : p.assets.filter((a) => !used.has(a.id)).map((a) => a.id);
      if (unused && ids.length === 0) throw new ToolError('no unused media, nothing changed');
      const list = ids.map((id) => needAsset(id));
      const busy = busyFor(['export', 'mcp-export']);
      if (busy) throw new ToolError(`cannot remove media while ${busy}. wait for it (export_status) or stop it (export_cancel)`);
      for (const a of list) {
        if (skyUses(p.sky, a.id)) throw new ToolError(`the media ${a.id} ("${a.name}") is part of the sky. take the sky off first (update_project sky: null)`);
      }
      const using = list
        .map((a) => ({ a, clips: p.clips.filter((c) => 'assetId' in c && c.assetId === a.id) }))
        .filter((u) => u.clips.length > 0);
      if (using.length > 0 && args.with_clips !== true) {
        const named = using.map((u) => `${u.a.id} ("${u.a.name}") is used by ${u.clips.length} ${u.clips.length === 1 ? 'clip' : 'clips'}`).join(', ');
        throw new ToolError(
          `the media ${named}. delete_clips them first, or send with_clips: true to delete them too (that clears the undo history)`,
        );
      }
      for (const u of using) for (const c of u.clips) needUnlocked(c);
      const steps = () => useEditor.getState().past.length + useEditor.getState().future.length;
      const stepsBefore = steps();
      const clipsBefore = p.clips.length;
      // every deleteAsset takes its media out of the store before its first await, so all of them leave right after the checks,
      // before a stored copy is waited on (nothing can put a clip of a later one on the timeline in between)
      const pending = list.map((a) => deleteAsset(a.id));
      // every deleteAsset has dropped its media by now (before its first await): count here, the user can edit while the blobs go
      const cut = clipsBefore - (useEditor.getState().project?.clips.length ?? clipsBefore);
      const cleared = stepsBefore > 0 && steps() === 0;
      const results = await Promise.allSettled(pending);
      const removed: { id: string; name: string }[] = [];
      const failed: string[] = [];
      results.forEach((r, i) => {
        const a = list[i]!;
        if (r.status === 'fulfilled') removed.push({ id: a.id, name: a.name });
        else failed.push(`${a.id} (${r.reason instanceof Error ? r.reason.message : String(r.reason)})`);
      });
      const gone = removed.length > 0 ? removed.map((r) => r.id).join(', ') : 'none';
      if (failed.length > 0) throw new ToolError(`removing the media ${failed.join(', ')} failed. removed: ${gone}`);
      if (useEditor.getState().project?.id !== p.id) {
        throw new ToolError(`the project was closed or switched while media was being removed. removed: ${gone}`);
      }
      const after = needProject();
      return ok({ removed, clips: cut, undoCleared: cleared, media: after.assets.length });
    },
  },
];
