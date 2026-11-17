import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool } from '../registry';
import type { ToolCtx, ToolResult } from '../types';
import { addVideoClip, ed, fresh } from './editKit';

const mocks = vi.hoisted(() => ({ save: vi.fn(), download: vi.fn() }));
vi.mock('../../lib/shell', async (orig) => {
  const real = await orig<typeof import('../../lib/shell')>();
  return { ...real, shell: { ...real.shell, mcp: { ...real.shell.mcp, save: mocks.save } } };
});
vi.mock('../../features/properties/lutSave', async (orig) => {
  const real = await orig<typeof import('../../features/properties/lutSave')>();
  return { ...real, downloadText: mocks.download };
});

async function run(args: Record<string, unknown>, ctx?: ToolCtx) {
  const r = (await callTool('save_grade_lut', args, ctx)) as ToolResult;
  const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
  return { error: r.isError === true, text, json: r.isError ? null : (JSON.parse(text) as Record<string, any>), saved: (r as { saved?: number }).saved };
}

let video = '';
beforeEach(() => {
  mocks.save.mockReset();
  mocks.download.mockReset();
  video = fresh().video;
});

const graded = (): string => {
  const id = addVideoClip(video, 0);
  ed().updateClip(id, { adjust: { brightness: 0.2, contrast: 0.1, saturation: 0.3, hue: 10, temperature: 0.2 } });
  return id;
};

describe('save_grade_lut', () => {
  it('without a shell nothing is written and the answer gives size, rows and a hash', async () => {
    const id = graded();
    const r = await run({ clip: id, size: 17 });
    expect(r.error, r.text).toBe(false);
    expect(r.json).toMatchObject({ clip: id, size: 17, rows: 17 * 17 * 17, saved: false });
    expect(r.json!.sha).toMatch(/^[0-9a-f]{24}$/);
    expect(r.json!.file).toMatch(/\.cube$/);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(r.saved).toBeUndefined();
  });

  it('size 33 is the default and the same grade gives the same hash', async () => {
    const id = graded();
    const a = await run({ clip: id });
    const b = await run({ clip: id });
    expect(a.json!.size).toBe(33);
    expect(a.json!.rows).toBe(33 ** 3);
    expect(a.json!.sha).toBe(b.json!.sha);
    expect((await run({ clip: id, size: 17 })).json!.sha).not.toBe(a.json!.sha);
  });

  it('with a ticket the shell is armed first, the file is named by the ticket and saved carries it', async () => {
    const id = graded();
    const order: string[] = [];
    mocks.save.mockImplementation(() => {
      order.push('arm');
      return Promise.resolve({ ok: true, name: 'x.cube' });
    });
    mocks.download.mockImplementation((name: string) => order.push('download ' + name));
    const r = await run({ clip: id, size: 17 }, { ticket: 7 } as ToolCtx);
    expect(r.error, r.text).toBe(false);
    expect(order[0]).toBe('arm');
    expect(order[1]).toMatch(/^download ncut-mcp-7-.*\.cube$/);
    expect(mocks.save).toHaveBeenCalledWith(7);
    expect(r.json!.saved).toBe(true);
    expect(r.saved).toBe(7);
  });

  it('a shell that could not save says so and gives no ticket', async () => {
    const id = graded();
    mocks.save.mockResolvedValue({ ok: false, name: null });
    const r = await run({ clip: id, size: 17 }, { ticket: 3 } as ToolCtx);
    expect(r.json!.saved).toBe(false);
    expect(r.json!.note).toMatch(/nothing was written/);
    expect(r.saved).toBeUndefined();
  });

  it('refuses a clip without a grade, audio, an unknown clip and a bad size', async () => {
    const plain = addVideoClip(video, 10);
    expect((await run({ clip: plain })).text).toMatch(/no color or grade to save/);
    const audio = ed().addTrack('audio');
    ed().addAsset({ id: 'au', name: 'au', kind: 'audio', mime: '', size: 1, duration: 5, width: 0, height: 0, hasAudio: true, createdAt: 0 });
    const a = ed().insertAsset('au', { trackId: audio, start: 0 })!;
    expect((await run({ clip: a })).text).toMatch(/no picture to grade/);
    expect((await run({ clip: 'ghost' })).error).toBe(true);
    expect((await run({ clip: plain, size: 20 })).error).toBe(true);
  });
});
