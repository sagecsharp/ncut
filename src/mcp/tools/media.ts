/** media tools (docs/MCP.md): bring files into the project, put media on the timeline, swap media */
import { skyCandidates, skyUses } from '../../engine/scene3d/sky';
import { usedAssetIds } from '../../features/media/mediaList';
import { busyFor } from '../../lib/busy';
import { deleteAsset, importFiles, useImporting } from '../../media/importer';
import { useEditor } from '../../store/editorStore';
import { importProjectFile } from '../../store/session';
import { useUi } from '../../store/ui';
import type { MediaAsset } from '../../types';
import { clipBrief, needAsset, needClip, needProject, needTrack, needUnlocked, ok, optNumber, round, ToolError } from '../helpers';
import type { ToolDef } from '../types';

const DESKTOP_ONLY = 'this tool only works in the ncut desktop app: the app reads the files from disk. in a browser there is no way to hand it a path';

/** the messages unpackProject throws for a file that is not a readable project (storage/projectFile.ts) */
const BAD_FILE = ['not an ncut project file', 'the project file is damaged', 'this project file was made by a newer version of ncut'];

function assetBrief(a: MediaAsset): Record<string, unknown> {
  return { id: a.id, name: a.name, kind: a.kind, duration: round(a.duration), width: a.width, height: a.height, hasAudio: a.hasAudio };
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
    name: 'add_media_clip',
    title: 'put media on the timeline',
    description:
      'makes a clip of a media item (id from get_project or import_media) on the timeline, as one undo step. video and images go on a video track, audio on an audio track. ' +
      'track: the track to use (it has to be the right kind and unlocked); without it the first fitting track is used, and a new one is made when none fits at start. ' +
      'start: timeline seconds; without it the clip goes after the last clip of the track. a clip never overlaps another, so it can land later than start: the answer shows where it went. ' +
      'a video clip is as long as the media, an image 5 s, change it with trim_clip.',
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string', description: 'media id' },
        track: { type: 'string', description: 'track id' },
        start: { type: 'number', minimum: 0, description: 'timeline seconds' },
      },
      required: ['asset'],
    },
    run(args) {
      const asset = needAsset(args.asset);
      if (args.track !== undefined) {
        const track = needTrack(args.track);
        const want = asset.kind === 'audio' ? 'audio' : 'video';
        if (track.kind !== want) throw new ToolError(`the track ${track.id} is an ${track.kind} track, ${asset.kind} media goes on ${want === 'audio' ? 'an audio' : 'a video'} track`);
        if (track.locked) throw new ToolError(`the track ${track.id} (${track.name}) is locked. unlock it with update_track first`);
      }
      const start = optNumber(args.start);
      const id = useEditor.getState().insertAsset(asset.id, {
        ...(typeof args.track === 'string' ? { trackId: args.track } : {}),
        ...(start !== undefined ? { start } : {}),
      });
      if (!id) throw new ToolError(`the media ${asset.id} could not be put on the timeline`);
      return ok(clipBrief(needClip(id)));
    },
  },
  {
    name: 'replace_media',
    title: 'swap the media of a clip',
    description:
      'a video, image or audio clip shows other media instead, keeping its place, look and animation (one undo step). the media has to be of the same kind as the clip. ' +
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
      if (asset.kind !== clip.type) throw new ToolError(`the clip ${clip.id} is a ${clip.type} clip but the media ${asset.id} is ${asset.kind}. pick media of the same kind`);
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
