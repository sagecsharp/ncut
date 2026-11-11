/** media tools (docs/MCP.md): bring files into the project, put media on the timeline, swap media */
import { importFiles } from '../../media/importer';
import { useEditor } from '../../store/editorStore';
import { importProjectFile } from '../../store/session';
import type { MediaAsset } from '../../types';
import { clipBrief, needAsset, needClip, needProject, needTrack, needUnlocked, ok, optNumber, round, ToolError } from '../helpers';
import type { ToolDef } from '../types';

const DESKTOP_ONLY = 'this tool only works in the ncut desktop app: the app reads the files from disk. in a browser there is no way to hand it a path';

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
      'answers the new media (id, name, kind, duration in seconds, size in pixels, hasAudio). files that cannot be read are left out and counted in "skipped". desktop app only.',
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
      const added = await importFiles(files);
      if (added.length === 0) throw new ToolError('none of the files could be imported (unsupported or unreadable). see the list of formats in this tool\'s description');
      const skipped = files.length - added.length;
      return ok({ media: added.map(assetBrief), ...(skipped > 0 ? { skipped } : {}) });
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
        throw new ToolError(`${file.name} is not a project ncut can read${e instanceof Error && e.message ? ` (${e.message})` : ''}`);
      }
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
];
