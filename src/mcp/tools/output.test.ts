import { describe, expect, it, vi } from 'vitest';
import { mcpExportJob } from '../exportJob';
import { callTool } from '../registry';
import { addVideoClip, call, fresh, refused } from './editKit';
import { outputTools, statusResult } from './output';

function text(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.map((c) => c.text ?? '').join('');
}

describe('the output tools', () => {
  it('are the four of docs/MCP.md', () => {
    expect(outputTools.map((t) => t.name)).toEqual(['render_frame', 'export_video', 'export_status', 'export_cancel']);
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
    const base = { state: 'done' as const, fileName: 'a.mp4', bytes: 10, seconds: 2, note: 'n', warnings: [] };
    expect(statusResult({ ...base, saved: 4 }).saved).toBe(4);
    expect(statusResult({ ...base, saved: null }).saved).toBeUndefined();
  });
});
