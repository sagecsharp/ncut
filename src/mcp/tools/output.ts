import { isExporting } from '../../engine/exportState';
import { usePlayback } from '../../store/playback';
import { mcpExportJob } from '../exportJob';
import type { ExportArgs, JobState } from '../exportJob';
import { DEFAULT_MAX_SIZE, LIMIT_MAX_SIZE, renderFramePng } from '../frame';
import { needProject, ok, ToolError, optNumber, optString } from '../helpers';
import type { ToolDef, ToolResult } from '../types';

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** export_status as data: what the client reads to know how far the export is */
export function statusResult(s: JobState): ToolResult {
  switch (s.state) {
    case 'none':
      return ok({ state: 'none', note: 'no export was started since ncut opened. export_video starts one' });
    case 'running':
      return ok({
        state: 'running',
        file: s.fileName,
        phase: s.phase,
        progress: round3(s.progress),
        frame: s.frame,
        total_frames: s.totalFrames,
        seconds: round3(s.seconds),
      });
    case 'done': {
      const out = ok({
        state: 'done',
        file: s.fileName,
        bytes: s.bytes,
        seconds: round3(s.seconds),
        note: s.note,
        ...(s.warnings.length > 0 ? { warnings: s.warnings } : {}),
      });
      // the shell adds the full path of the saved file to this answer
      if (s.saved !== null) out.saved = s.saved;
      return out;
    }
    case 'failed':
      return ok({ state: 'failed', message: s.message });
    case 'cancelled':
      return ok({ state: 'cancelled' });
  }
}

export const outputTools: ToolDef[] = [
  {
    name: 'render_frame',
    title: 'Render a frame',
    description:
      'the picture of the open project at a timeline time as a png image (what an export would show at that moment, not what the preview shows). ' +
      `time is in seconds, default the playhead. max_size is the longest side in pixels, default ${DEFAULT_MAX_SIZE}, at most ${LIMIT_MAX_SIZE}; a smaller project is not blown up. ` +
      'answers the image and a text line with the time and the size. not possible while an export runs. use it to check your work after edits.',
    inputSchema: {
      type: 'object',
      properties: {
        time: { type: 'number', description: 'timeline time in seconds, default the playhead. clamped into the project', minimum: 0 },
        max_size: { type: 'integer', description: `longest side in pixels, default ${DEFAULT_MAX_SIZE}`, minimum: 16, maximum: LIMIT_MAX_SIZE },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run(args) {
      const project = needProject();
      if (mcpExportJob.running() || isExporting()) {
        throw new ToolError('an export is running, a frame cannot be drawn until it ends. export_status tells how far it is, export_cancel stops it');
      }
      const time = optNumber(args.time) ?? usePlayback.getState().time;
      const png = await renderFramePng(project, time, optNumber(args.max_size) ?? DEFAULT_MAX_SIZE);
      const info: Record<string, unknown> = { time: round3(png.time), width: png.width, height: png.height };
      if (png.warnings.length > 0) info.warnings = png.warnings;
      return {
        content: [
          { type: 'image', data: png.data, mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify(info) },
        ],
      };
    },
  },
  {
    name: 'export_video',
    title: 'Export the project',
    description:
      'starts exporting the open project to a file and answers at once with the file name, size and frame count. the export runs in the background: ' +
      'poll export_status until it says done (then the answer holds the full path of the file), export_cancel stops it. one export at a time. ' +
      'format mp4 (default), webm, gif (no sound, at most 50 fps), wav or ogg (sound only). quality low | medium | high (default high). ' +
      'scale 1 | 0.75 | 0.5 of the project size (default 1). fps defaults to the project fps. start / end in timeline seconds pick a part (default the whole project). ' +
      'audio false leaves the sound out of a video. name is the file name without the extension (default the project name).',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['mp4', 'webm', 'gif', 'wav', 'ogg'], description: 'default mp4' },
        quality: { type: 'string', enum: ['low', 'medium', 'high'], description: 'default high' },
        scale: { type: 'number', enum: [1, 0.75, 0.5], description: 'share of the project size, default 1' },
        fps: { type: 'number', description: 'frames per second, default the project fps', minimum: 1, maximum: 240 },
        start: { type: 'number', description: 'timeline second to start at, default 0', minimum: 0 },
        end: { type: 'number', description: 'timeline second to stop at, default the end of the project', minimum: 0 },
        audio: { type: 'boolean', description: 'false = no sound in a video, default true' },
        name: { type: 'string', description: 'file name without the extension', maxLength: 120 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run(args, ctx) {
      const project = needProject();
      const exportArgs: ExportArgs = {
        format: optString(args.format) as ExportArgs['format'],
        quality: optString(args.quality) as ExportArgs['quality'],
        scale: optNumber(args.scale),
        fps: optNumber(args.fps),
        start: optNumber(args.start),
        end: optNumber(args.end),
        audio: typeof args.audio === 'boolean' ? args.audio : undefined,
        name: optString(args.name),
      };
      const info = mcpExportJob.start(project, exportArgs, ctx.ticket);
      return ok({
        ...info,
        next: ctx.ticket !== null ? 'export_status tells how far it is and, when done, where the file was saved' : 'export_status tells how far it is. there is no desktop shell here, the file will stay in memory',
      });
    },
  },
  {
    name: 'export_status',
    title: 'Export status',
    description:
      'how the last export_video is doing: none (nothing started), running (phase, progress 0..1, frame, total_frames), done (file name, bytes, seconds; the full path of the saved file is added), failed (why) or cancelled.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
    run() {
      return statusResult(mcpExportJob.status());
    },
  },
  {
    name: 'export_cancel',
    title: 'Cancel the export',
    description: 'stops the running export. nothing is saved. answers an error when no export from export_video runs.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run() {
      if (!mcpExportJob.cancel()) {
        throw new ToolError(isExporting() ? 'the running export was started in the export dialog, only its user can stop it' : 'no export is running');
      }
      return ok({ state: 'cancelling', note: 'export_status says cancelled in a moment' });
    },
  },
];
