import { describe, expect, it, vi } from 'vitest';
import { mcpExportJob } from '../exportJob';
import { callTool } from '../registry';
import { addVideoClip, call, ed, fresh, proj, refused } from './editKit';
import { outputTools, statusResult } from './output';

vi.mock('../../features/export/deliveryProbe', () => ({
  probeVideoCodecs: async () => ({ avc: { ok: true, bitrate: 8e6, gpu: false } }),
  probeAudio: async () => ({ codecs: { aac: { ok: true } }, kbps: {}, rates: { 48000: { ok: true } } }),
}));

function text(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.map((c) => c.text ?? '').join('');
}

describe('the output tools', () => {
  it('are the five output tools', () => {
    expect(outputTools.map((t) => t.name)).toEqual(['render_frame', 'measure_loudness', 'export_video', 'export_status', 'export_cancel']);
  });

  it('refuse without an open project', async () => {
    for (const name of ['render_frame', 'export_video']) {
      const r = await callTool(name, {});
      expect('isError' in r && r.isError).toBe(true);
    }
  });

  it('check their arguments', async () => {
    const bad = await callTool('export_video', { format: 'avi' });
    expect('isError' in bad && bad.isError).toBe(true);
    const typo = await callTool('render_frame', { size: 100 });
    expect('isError' in typo && typo.isError).toBe(true);
  });

  it('render_frame refuses an unknown scope and a non boolean levels', async () => {
    const scope = await callTool('render_frame', { scope: 'rgbparade' });
    expect('isError' in scope && scope.isError).toBe(true);
    expect(text(scope as { content: Array<{ type: string; text?: string }> })).toMatch(/waveform, parade, vectorscope, histogram/);
    const levels = await callTool('render_frame', { levels: 'yes' });
    expect('isError' in levels && levels.isError).toBe(true);
    expect(text(levels as { content: Array<{ type: string; text?: string }> })).toMatch(/levels/);
  });

  it('export_video refuses an unknown range', async () => {
    const r = await callTool('export_video', { range: 'selection' });
    expect('isError' in r && r.isError).toBe(true);
    expect(text(r as { content: Array<{ type: string; text?: string }> })).toMatch(/all, inout/);
  });

  it('a picture of an in point past the end names the in point', async () => {
    const { video } = fresh();
    addVideoClip(video, 0);
    await call('set_range', { in: 20 });
    await refused('export_video', { range: 'inout', format: 'png' }, /the in point 20 s is not inside the project .*set_range an earlier in point/);
  });

  it('export_cancel says it is too late while the file is saved', async () => {
    const spy = vi.spyOn(mcpExportJob, 'saving').mockReturnValue(true);
    const r = await callTool('export_cancel', {});
    spy.mockRestore();
    expect('isError' in r && r.isError).toBe(true);
    expect(text(r as { content: Array<{ type: string; text?: string }> })).toMatch(/too late/);
  });

  it('export_cancel with nothing running says so', async () => {
    const r = await callTool('export_cancel', {});
    expect('isError' in r && r.isError).toBe(true);
  });
});

describe('statusResult', () => {
  it('says none, running, failed and cancelled', () => {
    expect(JSON.parse(text(statusResult({ state: 'none' }))).state).toBe('none');
    const run = JSON.parse(text(statusResult({ state: 'running', fileName: 'a.mp4', phase: 'video', progress: 0.33333, frame: 3, totalFrames: 9, seconds: 1.5 })));
    expect(run).toMatchObject({ state: 'running', progress: 0.333, frame: 3, total_frames: 9, phase: 'video' });
    expect(JSON.parse(text(statusResult({ state: 'failed', message: 'boom' })))).toEqual({ state: 'failed', message: 'boom' });
    expect(JSON.parse(text(statusResult({ state: 'cancelled' }))).state).toBe('cancelled');
  });
  it('done carries the ticket only when the shell saved the file', () => {
    const base = { state: 'done' as const, fileName: 'a.mp4', bytes: 10, seconds: 2, note: 'n', warnings: [], loudness: null };
    expect(statusResult({ ...base, saved: 4 }).saved).toBe(4);
    expect(statusResult({ ...base, saved: null }).saved).toBeUndefined();
  });
});

describe('the round 2 export arguments', () => {
  it('the new properties are in the schemas', () => {
    const ev = outputTools.find((t) => t.name === 'export_video')!.inputSchema.properties as Record<string, unknown>;
    for (const k of ['preset', 'codec', 'bitrate_mbps', 'key_seconds', 'width', 'height', 'fit', 'audio_codec', 'audio_kbps', 'sample_rate', 'transparent', 'loudness_target', 'peak_limit', 'check']) expect(ev, k).toHaveProperty(k);
    const rf = outputTools.find((t) => t.name === 'render_frame')!.inputSchema.properties as Record<string, unknown>;
    expect(rf).toHaveProperty('transparent');
    const ml = outputTools.find((t) => t.name === 'measure_loudness')!;
    expect(ml.annotations).toBeDefined();
  });

  it('a bad range or sample rate is refused before anything starts', async () => {
    const { video } = fresh();
    addVideoClip(video, 0);
    await refused('export_video', { loudness_target: -40 }, /between -36 and -6 lufs/);
    await refused('export_video', { peak_limit: 3 }, /between -9 and 0 dbtp/);
    await refused('export_video', { sample_rate: 12345 }, /sample_rate/);
    await refused('export_video', { audio: false, loudness_target: -16 }, /loudness needs a format with sound/);
    await refused('export_video', { format: 'png', loudness_target: -16 }, /loudness needs a format with sound/);
    await refused('export_video', { transparent: true }, /transparent needs format webm or png/);
    await refused('export_video', { codec: 'h264', format: 'webm' }, /a webm holds vp9 or av1/);
    expect(mcpExportJob.running()).toBe(false);
  });

  it('check starts no job', async () => {
    const { video } = fresh();
    addVideoClip(video, 0);
    const r = await call('export_video', { check: true, format: 'png' });
    expect(r.ok, r.text).toBe(true);
    expect(r.data.status).not.toBe('started');
    expect(mcpExportJob.running()).toBe(false);
  });

  it('check on an mp4 says the size, the frames and the estimate', async () => {
    const { video } = fresh();
    addVideoClip(video, 0);
    const r = await call('export_video', { check: true, format: 'mp4' });
    expect(r.ok, r.text).toBe(true);
    expect(r.data.status).not.toBe('started');
    expect(r.data.width).toBe(proj().width);
    expect(r.data.height).toBe(proj().height);
    expect(r.data.frames).toBeGreaterThan(0);
    expect(r.data.estimate_bytes).toBeGreaterThan(0);
    expect(r.data.codec).not.toBeNull();
    expect(mcpExportJob.running()).toBe(false);
  });

  it('measure_loudness is refused without an open project, while an export runs and without sound', async () => {
    ed().closeProject();
    const none = await call('measure_loudness', {});
    expect(none.ok).toBe(false);
    expect(none.text).toMatch(/no project is open/);
    const { video } = fresh();
    addVideoClip(video, 0);
    // a project with only a picture clip has nothing to measure
    const running = vi.spyOn(mcpExportJob, 'running').mockReturnValue(true);
    await refused('measure_loudness', {}, /an export is running: measure when it ends/);
    running.mockRestore();
    ed().removeAsset('vid1');
    await refused('measure_loudness', {}, /no clip with sound to measure/);
  });
});
