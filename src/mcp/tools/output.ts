import { isExporting } from '../../engine/exportState';
import { usePlayback } from '../../store/playback';
import { exportHasSound, mcpExportJob, planMcpExport } from '../exportJob';
import type { ExportArgs, JobState } from '../exportJob';
import { alphaNotes } from '../../features/export/alphaNotes';
import { autoAudioBitrate, DEFAULT_DELIVERY, DELIVERY_LABEL, estimateBytes, formatBitrate } from '../../features/export/delivery';
import type { VideoCodecChoice } from '../../features/export/delivery';
import { probeAudio, probeVideoCodecs } from '../../features/export/deliveryProbe';
import type { CodecStatus } from '../../features/export/deliveryProbe';
import { isAudioContainer, videoBitrate } from '../../features/export/exporter';
import { measuredFor, measuringFor, measureMix } from '../../features/export/measureMix';
import { isStillContainer } from '../../features/export/still';
import type { ScopeKind } from '../../features/preview/scopesState';
import type { Project } from '../../types';
import { DEFAULT_MAX_SIZE, LIMIT_MAX_SIZE, renderFramePng } from '../frame';
import { needProject, ok, ToolError, optNumber, optString } from '../helpers';
import { loudnessAnswer, loudnessFromArgs, reportAnswer } from '../loudnessArgs';
import type { ToolDef, ToolResult } from '../types';

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** how long measure_loudness waits for a measure: the call limit of the client is 180 s */
export const MEASURE_WAIT_MS = 150_000;

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
        ...(s.loudness ? { loudness: reportAnswer(s.loudness) } : {}),
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

const CHECK_RUNNING = 'an export is running, this is what the next one would make';

/** export_video with check: true. what the export would make, nothing is started. the probes ask the encoders of this machine */
async function checkExport(project: Project, args: ExportArgs): Promise<ToolResult> {
  const planned = planMcpExport(project, args);
  const { options, container } = planned;
  const delivery = { ...DEFAULT_DELIVERY, ...(options.delivery ?? {}) };
  const notes = [...planned.notes];
  if (mcpExportJob.running() || isExporting()) notes.push(CHECK_RUNNING);
  const still = isStillContainer(container);
  const video = container === 'mp4' || container === 'webm';
  const out: Record<string, unknown> = { check: true, format: container };
  if (!isAudioContainer(container)) {
    out.width = planned.width;
    out.height = planned.height;
  }
  if (!still) {
    out.frames = planned.frames;
    out.fps = planned.fps;
  }
  // the video: the codecs this machine can make, the one the export would pick, its bitrate
  let codecs: Partial<Record<VideoCodecChoice, CodecStatus>> | null = null;
  let codec: VideoCodecChoice | null = null;
  let bitrate: number | null = null;
  if (video) {
    try {
      codecs = await probeVideoCodecs({ container, width: planned.width, height: planned.height, fps: planned.fps, quality: options.quality, bitrate: delivery.bitrate, transparent: delivery.transparent });
    } catch {
      codecs = null;
    }
    const order: VideoCodecChoice[] = container === 'mp4' ? ['avc', 'hevc', 'av1', 'vp9'] : ['vp9', 'av1'];
    codec = delivery.codec !== 'auto' ? delivery.codec : (order.find((c) => codecs?.[c]?.ok) ?? null);
    const status = codec ? codecs?.[codec] : undefined;
    bitrate = delivery.bitrate ?? (status?.ok ? status.bitrate : null) ?? (codec ? videoBitrate(planned.width, planned.height, planned.fps, options.quality, codec) : null);
  }
  out.codec = codec ? DELIVERY_LABEL[codec] : null;
  out.bitrate = bitrate !== null ? formatBitrate(bitrate) : null;
  // the sound
  const audioCodec = !options.includeAudio ? null : container === 'wav' ? 'pcm-s16' : delivery.audioCodec !== 'auto' ? delivery.audioCodec : container === 'mp4' ? 'aac' : 'opus';
  const kbps = audioCodec === null || audioCodec === 'pcm-s16' ? null : Math.round((delivery.audioBitrate ?? autoAudioBitrate(audioCodec)) / 1000);
  out.audio = audioCodec === null ? null : { codec: audioCodec === 'pcm-s16' ? 'pcm' : audioCodec, kbps, sample_rate: delivery.sampleRate };
  if (audioCodec === 'aac' || audioCodec === 'opus') {
    if (container === 'mp4' || container === 'webm' || container === 'ogg') {
      try {
        const probe = await probeAudio({ container, codec: audioCodec, sampleRate: delivery.sampleRate });
        const bad = [probe.codecs[audioCodec], kbps !== null ? probe.kbps[kbps] : undefined, probe.rates[delivery.sampleRate]];
        for (const b of bad) if (b && !b.ok && !notes.includes(b.reason)) notes.push(b.reason);
      } catch {
        // a probe that cannot run says nothing
      }
    }
  }
  // the size of the file
  if (container === 'mp4' || container === 'webm' || container === 'wav' || container === 'ogg') {
    const seconds = planned.range.end - planned.range.start;
    out.estimate_bytes = estimateBytes({
      container,
      seconds,
      frames: planned.frames,
      videoBitrate: bitrate ?? 0,
      alpha: delivery.transparent && video,
      audio: audioCodec === null ? null : { codec: audioCodec, bitrate: audioCodec === 'pcm-s16' ? null : (delivery.audioBitrate ?? null), sampleRate: delivery.sampleRate },
    }).total;
  } else out.estimate_bytes = null;
  if (codecs) {
    const names: Record<string, VideoCodecChoice> = { h264: 'avc', h265: 'hevc', av1: 'av1', vp9: 'vp9' };
    const answer: Record<string, string> = {};
    for (const [name, key] of Object.entries(names)) {
      const c = codecs[key];
      if (c) answer[name] = c.ok ? (c.gpu ? 'ok, graphics card' : 'ok, processor') : c.reason;
    }
    out.codecs = answer;
  }
  out.notes = notes;
  out.alpha_notes = delivery.transparent ? alphaNotes(project, still ? { start: planned.range.start, end: planned.range.start + 1 / Math.max(1, project.fps) } : planned.range).map((n) => n.text) : [];
  return ok(out);
}

/** is there a clip that can have sound in the project? (a muted one is found by the measure itself) */
function hasSoundClips(project: Project): boolean {
  return project.clips.some((c) => c.type === 'audio' || (c.type === 'video' && project.assets.find((a) => a.id === c.assetId)?.hasAudio === true));
}

export const outputTools: ToolDef[] = [
  {
    name: 'render_frame',
    title: 'Render a frame',
    description:
      'the picture of the open project at a timeline time as a png image (what an export would show at that moment, not what the preview shows). ' +
      `time is in seconds, default the playhead. max_size is the longest side in pixels, default ${DEFAULT_MAX_SIZE}, at most ${LIMIT_MAX_SIZE}; a smaller project is not blown up. ` +
      'answers the image and a text line with the time and the size. not possible while an export runs. use it to check your work after edits. ' +
      'levels: true adds the levels to the text, scope adds a second image with that scope (both measured on the answered picture: max_size 1920 is closest to the export). ' +
      'transparent: true leaves the background out: the png is see-through where nothing is drawn, as a transparent export makes it.',
    inputSchema: {
      type: 'object',
      properties: {
        time: { type: 'number', description: 'timeline time in seconds, default the playhead. clamped into the project, a time at or after the end shows the last frame', minimum: 0 },
        max_size: { type: 'integer', description: `longest side in pixels, default ${DEFAULT_MAX_SIZE}`, minimum: 16, maximum: LIMIT_MAX_SIZE },
        levels: { type: 'boolean', description: 'also answer the levels of the picture: luma min, max and mean on 0..100, the share of pixels at 0 (black) and at 100 (white), and the mean of r, g and b' },
        scope: { type: 'string', enum: ['waveform', 'parade', 'vectorscope', 'histogram'], description: 'also answer a second image: that scope of the picture, as the scopes next to the preview draw it' },
        transparent: { type: 'boolean', description: 'true = no background: the png is see-through where nothing is drawn, as a transparent export makes it. levels and scopes count see-through pixels as black' },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run(args) {
      const project = needProject();
      if (mcpExportJob.running() || isExporting()) {
        throw new ToolError('an export is running, a frame cannot be drawn until it ends. export_status tells how far it is, export_cancel stops it');
      }
      const time = optNumber(args.time) ?? usePlayback.getState().time;
      const scope = optString(args.scope) as ScopeKind | undefined;
      const png = await renderFramePng(project, time, optNumber(args.max_size) ?? DEFAULT_MAX_SIZE, { levels: args.levels === true, scope, transparent: args.transparent === true });
      const info: Record<string, unknown> = { time: round3(png.time), width: png.width, height: png.height };
      if (png.levels) info.levels = png.levels;
      if (png.scope) info.scope = png.scope.kind;
      if (png.warnings.length > 0) info.warnings = png.warnings;
      return {
        content: [
          { type: 'image', data: png.data, mimeType: 'image/png' },
          ...(png.scope ? [{ type: 'image' as const, data: png.scope.data, mimeType: 'image/png' }] : []),
          { type: 'text', text: JSON.stringify(info) },
        ],
      };
    },
  },
  {
    name: 'measure_loudness',
    title: 'Measure the loudness',
    description:
      'measures the loudness of the sound the export would make, offline, like the loudness meter of the mixer: integrated loudness (lufs), loudness range (lu), true peak (dbtp), sample peak (dbfs), the loudest 400 ms and 3 s. ' +
      'start / end in timeline seconds pick a part (default the whole project), range "inout" measures in to out (set_range). sample_rate 44100 or 48000, default 48000. a number that is null means nothing to measure. ' +
      'the same sound is measured once: cached says the answer was ready. a long project can take a while: after 150 s the answer is { state: "measuring", progress } and the measure goes on, call again with the same arguments. ' +
      'refused while an export runs and for a project without sound.',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'number', minimum: 0, description: 'timeline second to start at, default 0' },
        end: { type: 'number', minimum: 0, description: 'timeline second to stop at, default the end of the project' },
        range: { type: 'string', enum: ['all', 'inout'], description: '"all" (default) or "inout" = in point to out point (set_range). not with start / end' },
        sample_rate: { type: 'number', enum: [44100, 48000], description: 'the rate the sound is measured at, default 48000' },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run(args) {
      const project = needProject();
      if (mcpExportJob.running() || isExporting()) throw new ToolError('an export is running: measure when it ends');
      if (!hasSoundClips(project)) throw new ToolError('no clip with sound to measure');
      // the range is the export's: wav is a format that is only sound
      const { range } = planMcpExport(project, { format: 'wav', start: optNumber(args.start), end: optNumber(args.end), range: optString(args.range) as ExportArgs['range'] });
      const rate = optNumber(args.sample_rate) ?? 48000;
      const hit = measuredFor(project, range, rate);
      if (hit) {
        if (hit.silent) throw new ToolError('no clip with sound to measure');
        return ok(loudnessAnswer(hit, true));
      }
      // no signal: when the wait ends the measure goes on into the cache
      const run = measureMix(project, range, rate);
      run.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = new Promise<'wait'>((resolve) => {
        timer = setTimeout(() => resolve('wait'), MEASURE_WAIT_MS);
      });
      try {
        const done = await Promise.race([run, wait]);
        if (done === 'wait') {
          return ok({ state: 'measuring', progress: round3(measuringFor(project, range, rate) ?? 0), note: 'still measuring. call measure_loudness again with the same arguments' });
        }
        if (done.silent) throw new ToolError('no clip with sound to measure');
        return ok(loudnessAnswer(done, false));
      } finally {
        clearTimeout(timer);
      }
    },
  },
  {
    name: 'export_video',
    title: 'Export the project',
    description:
      'starts exporting the open project to a file and answers at once with the file name, size and frame count. the export runs in the background: ' +
      'poll export_status until it says done (then the answer holds the full path of the file), export_cancel stops it. one export at a time. ' +
      'format mp4 (default), webm, gif (no sound, at most 50 fps), wav or ogg (sound only), png or jpg (one picture at the project size times scale: the frame at start, ' +
      'default the first frame; end, fps and audio do not apply). quality low | medium | high (default high; a png has no loss). ' +
      'scale 1 | 0.75 | 0.5 of the project size (default 1). fps defaults to the project fps. start / end in timeline seconds pick a part (default the whole project). ' +
      'range "inout" exports only in to out (set_range marks them), not with start / end; a png / jpg takes the frame at the in point. ' +
      'audio false leaves the sound out of a video. name is the file name without the extension (default the project name). ' +
      'advanced: preset, codec, bitrate_mbps, key_seconds, width and height with fit, audio_codec, audio_kbps, sample_rate and transparent (see each); an argument that a format cannot use is ignored and the answer says so in notes. ' +
      'loudness_target gains the mix to that loudness (-14 streaming, -16 podcast, -23 ebu r128, -24 atsc), peak_limit keeps the true peak under it (-1 with a target). ' +
      'check: true exports nothing and answers what the export would make: size, frames, codec, bitrate, estimate_bytes, which codecs this machine can encode, the sound, notes.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['mp4', 'webm', 'gif', 'wav', 'ogg', 'png', 'jpg'], description: 'default mp4' },
        quality: { type: 'string', enum: ['low', 'medium', 'high'], description: 'default high' },
        scale: { type: 'number', enum: [1, 0.75, 0.5], description: 'share of the project size, default 1' },
        fps: { type: 'number', description: 'frames per second, default the project fps', minimum: 1, maximum: 240 },
        start: { type: 'number', description: 'timeline second to start at, default 0. png / jpg: the frame that is saved', minimum: 0 },
        end: { type: 'number', description: 'timeline second to stop at, default the end of the project', minimum: 0 },
        range: { type: 'string', enum: ['all', 'inout'], description: 'which part: "all" (default) or "inout" = in point to out point (set_range). not with start / end. a png / jpg takes the frame at the in point' },
        audio: { type: 'boolean', description: 'false = no sound in a video, default true' },
        name: { type: 'string', description: 'file name without the extension', maxLength: 120 },
        codec: { type: 'string', enum: ['auto', 'h264', 'h265', 'av1', 'vp9'], description: 'default auto: the first this machine can encode. a webm holds vp9 or av1' },
        bitrate_mbps: { type: 'number', minimum: 0.5, maximum: 240, description: 'megabits per second of picture, instead of quality' },
        key_seconds: { type: 'number', enum: [0.5, 1, 2, 4, 5, 10], description: 'seconds between whole pictures in the file, default 2' },
        width: { type: 'integer', minimum: 16, maximum: 8192, description: 'width of the file in pixels. give both width and height or neither. a video rounds them to even' },
        height: { type: 'integer', minimum: 16, maximum: 8192, description: 'height of the file in pixels. give both width and height or neither. a video rounds them to even' },
        fit: { type: 'string', enum: ['fit', 'fill'], description: 'fit = the whole picture with bars (default), fill = the edges are cut' },
        audio_codec: { type: 'string', enum: ['auto', 'aac', 'opus'], description: 'default aac in an mp4, opus in a webm and an ogg' },
        audio_kbps: { type: 'number', enum: [128, 160, 192, 256, 320], description: 'sound bitrate in kilobits per second, default aac 128, opus 69' },
        sample_rate: { type: 'number', enum: [44100, 48000], description: 'sound rate, default 48000. opus is always 48000' },
        transparent: { type: 'boolean', description: 'webm or png only: see-through where nothing is drawn' },
        preset: { type: 'string', enum: ['youtube-1080', 'youtube-4k', 'vimeo', 'reels', 'master'], description: 'fills format, quality, frame rate, size and sound: given arguments win' },
        loudness_target: { type: 'number', description: 'lufs to gain the sound to, -36 to -6 (-14 streaming, -16 podcast, -23 ebu r128, -24 atsc). with it the peak limit is -1 unless peak_limit is given' },
        peak_limit: { type: 'number', description: 'dbtp the true peak is kept under, -9 to 0. alone it only limits peaks' },
        check: { type: 'boolean', description: 'true = export nothing, answer what the export would make' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(args, ctx) {
      const project = needProject();
      const exportArgs: ExportArgs = {
        format: optString(args.format) as ExportArgs['format'],
        quality: optString(args.quality) as ExportArgs['quality'],
        scale: optNumber(args.scale),
        fps: optNumber(args.fps),
        start: optNumber(args.start),
        end: optNumber(args.end),
        range: optString(args.range) as ExportArgs['range'],
        audio: typeof args.audio === 'boolean' ? args.audio : undefined,
        name: optString(args.name),
        codec: optString(args.codec) as ExportArgs['codec'],
        bitrate_mbps: optNumber(args.bitrate_mbps),
        key_seconds: optNumber(args.key_seconds),
        width: optNumber(args.width),
        height: optNumber(args.height),
        fit: optString(args.fit) as ExportArgs['fit'],
        audio_codec: optString(args.audio_codec) as ExportArgs['audio_codec'],
        audio_kbps: optNumber(args.audio_kbps),
        sample_rate: optNumber(args.sample_rate),
        transparent: typeof args.transparent === 'boolean' ? args.transparent : undefined,
        preset: optString(args.preset) as ExportArgs['preset'],
        // the loudness arguments are checked here, before anything runs
        loudness: loudnessFromArgs({ loudness_target: args.loudness_target, peak_limit: args.peak_limit }, exportHasSound({ format: optString(args.format) as ExportArgs['format'], preset: optString(args.preset) as ExportArgs['preset'], audio: typeof args.audio === 'boolean' ? args.audio : undefined })),
      };
      if (args.check === true) return checkExport(project, exportArgs);
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
      'how the last export_video is doing: none (nothing started), running (phase, progress 0..1, frame, total_frames), done (file name, bytes, seconds; the full path of the saved file is added; warnings, and loudness when a loudness choice was made), failed (why) or cancelled.',
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
      if (mcpExportJob.saving()) {
        throw new ToolError('too late to cancel: the export is done and the file is being saved. export_status tells where it went');
      }
      if (!mcpExportJob.cancel()) {
        throw new ToolError(isExporting() ? 'the running export was started in the export dialog, only its user can stop it' : 'no export is running');
      }
      return ok({ state: 'cancelling', note: 'export_status says cancelled in a moment' });
    },
  },
];
