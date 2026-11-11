import { describe, expect, it, vi } from 'vitest';
import { mcpExportJob } from '../exportJob';
import { callTool } from '../registry';
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
