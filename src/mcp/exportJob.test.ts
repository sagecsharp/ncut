import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import type { ExportHooks, ExportOptions } from '../features/export/exporter';
import { cleanFileName, createExportJob, EXPORT_BUSY, planMcpExport } from './exportJob';
import type { JobDeps } from './exportJob';

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'my: film',
    createdAt: 0,
    updatedAt: 0,
    width: 1920,
    height: 1080,
    fps: 30,
    background: '#000',
    assets: [],
    tracks: [],
    clips: [{ id: 'c', type: 'effect', start: 0, duration: 10, trackId: 't' }] as unknown as Project['clips'],
    ...over,
  };
}

describe('cleanFileName', () => {
  it('drops what a file system refuses and falls back when nothing is left', () => {
    expect(cleanFileName('a/b:c?.mp4', 'x')).toBe('abc.mp4');
    expect(cleanFileName('  ..  ', 'fb')).toBe('fb');
    expect(cleanFileName('x'.repeat(200), 'fb')).toHaveLength(80);
  });
});

describe('planMcpExport', () => {
  it('uses the defaults: mp4, high, scale 1, project fps, whole project', () => {
    const p = planMcpExport(project(), {});
    expect(p.options).toMatchObject({ container: 'mp4', quality: 'high', scale: 1, fps: 30, includeAudio: true });
    expect(p.range).toEqual({ start: 0, end: 10 });
    expect(p.frames).toBe(300);
    expect(p.width).toBe(1920);
    expect(p.fileName).toBe('my film.mp4');
  });
  it('takes a part, a scale, a name and a frame rate', () => {
    const p = planMcpExport(project(), { start: 2, end: 4, scale: 0.5, fps: 60, name: 'cut', format: 'webm', audio: false });
    expect(p.range).toEqual({ start: 2, end: 4 });
    expect(p.frames).toBe(120);
    expect(p.height).toBe(540);
    expect(p.fileName).toBe('cut.webm');
    expect(p.options.includeAudio).toBe(false);
  });
  it('caps a gif at 50 fps and drops its sound, and keeps the sound of an audio file', () => {
    const g = planMcpExport(project(), { format: 'gif', fps: 120, audio: true });
    expect(g.fps).toBeLessThanOrEqual(50);
    expect(g.options.includeAudio).toBe(false);
    expect(g.notes.length).toBe(2);
    const w = planMcpExport(project(), { format: 'wav', audio: false });
    expect(w.options.includeAudio).toBe(true);
  });
  it('notes a start or end cut to the project, and says nothing when they fit', () => {
    expect(planMcpExport(project(), { end: 25 }).notes.join(' ')).toMatch(/cut to the project.*0 to 10 s/);
    expect(planMcpExport(project(), { start: 1, end: 10 }).notes).toEqual([]);
  });
  it('a picture is the one frame at start: full size, no fps, no sound, no length', () => {
    const p = planMcpExport(project({ width: 1081, height: 607 }), { format: 'png', name: 'thumb' });
    expect(p.options).toMatchObject({ container: 'png', scale: 1, includeAudio: false });
    expect(p.range.start).toBe(0);
    expect(p.frames).toBe(1);
    // not rounded to even sides like a video
    expect([p.width, p.height]).toEqual([1081, 607]);
    expect(p.fileName).toBe('thumb.png');
    expect(p.notes).toEqual([]);
    const j = planMcpExport(project(), { format: 'jpg', start: 4, scale: 0.5, quality: 'low' });
    expect(j.range.start).toBe(4);
    expect([j.width, j.height]).toEqual([960, 540]);
    expect(j.options.quality).toBe('low');
    expect(j.fileName).toBe('my film.jpg');
    expect(j.notes).toEqual([]);
  });
  it('a picture says what it ignored, and an end before start does not make it empty', () => {
    const p = planMcpExport(project(), { format: 'png', start: 6, end: 2, fps: 60, audio: true, quality: 'low' });
    expect(p.range.start).toBe(6);
    expect(p.frames).toBe(1);
    expect(p.notes.join(' ')).toMatch(/end, fps, audio were ignored/);
    expect(p.notes.join(' ')).toMatch(/png has no loss/);
    expect(planMcpExport(project(), { format: 'jpg', end: 3 }).notes.join(' ')).toMatch(/end was ignored/);
    // audio false is what a picture is anyway
    expect(planMcpExport(project(), { format: 'jpg', audio: false }).notes).toEqual([]);
  });
  it('a picture needs a start inside the project', () => {
    expect(() => planMcpExport(project(), { format: 'png', start: 10 })).toThrow(/not inside the project/);
    expect(() => planMcpExport(project(), { format: 'png', start: 99 })).toThrow(/not inside the project/);
    expect(planMcpExport(project(), { format: 'png', start: 9.99 }).range.start).toBe(9.99);
  });
  it('refuses an empty project and an empty range', () => {
    expect(() => planMcpExport(project({ clips: [] }), {})).toThrow(/empty/);
    expect(() => planMcpExport(project(), { start: 5, end: 5 })).toThrow(/holds nothing/);
    expect(() => planMcpExport(project(), { start: 20 })).toThrow(/holds nothing/);
  });
});

interface Fake {
  deps: JobDeps;
  log: string[];
  finish(blob?: Blob): void;
  fail(e: unknown): void;
  hooks(): ExportHooks;
  options(): ExportOptions;
  saveDone(r: { ok: boolean; name: string | null }): void;
  other: { runs: boolean };
  open: { id: string | null };
}

function fake(): Fake {
  const log: string[] = [];
  let resolve: (b: Blob) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  let hooks: ExportHooks = {};
  let options!: ExportOptions;
  let saveResolve: (r: { ok: boolean; name: string | null }) => void = () => {};
  let clock = 0;
  const other = { runs: false };
  const open = { id: 'p1' as string | null };
  const deps: JobDeps = {
    exportFn: (_p, o, h) => {
      options = o;
      hooks = h;
      h.signal?.addEventListener('abort', () => reject(new DOMException('export cancelled', 'AbortError')));
      return new Promise<Blob>((res, rej) => {
        resolve = res;
        reject = rej;
      });
    },
    save: (t) => {
      log.push(`save ${t}`);
      return new Promise((res) => {
        saveResolve = res;
      });
    },
    download: (_b, name) => {
      log.push(`download ${name}`);
    },
    otherExportRuns: () => other.runs,
    projectId: () => open.id,
    working: (on) => {
      log.push(on ? 'work on' : 'work off');
    },
    progress: (p) => {
      log.push(`progress ${p}`);
    },
    attention: () => {
      log.push('attention');
    },
    now: () => (clock += 1000),
  };
  return {
    deps,
    log,
    finish: (b = new Blob(['abcd'])) => resolve(b),
    fail: (e) => reject(e),
    hooks: () => hooks,
    options: () => options,
    saveDone: (r) => saveResolve(r),
    other,
    open,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('planMcpExport range inout', () => {
  const marked = (range: Project['range']) => project({ range });
  it('inout gives the same options and frames as start / end', () => {
    const a = planMcpExport(marked({ in: 2, out: 4 }), { range: 'inout' });
    const b = planMcpExport(project(), { start: 2, end: 4 });
    expect(a.range).toEqual({ start: 2, end: 4 });
    expect(a.options).toEqual(b.options);
    expect(a.frames).toBe(b.frames);
    expect(a.notes).toEqual([]);
    // only an in point runs to the end, only an out point from the start
    expect(planMcpExport(marked({ in: 3 }), { range: 'inout' }).range).toEqual({ start: 3, end: 10 });
    expect(planMcpExport(marked({ out: 5 }), { range: 'inout' }).range).toEqual({ start: 0, end: 5 });
  });
  it('inout refuses start or end', () => {
    expect(() => planMcpExport(marked({ in: 2, out: 4 }), { range: 'inout', start: 1 })).toThrow('range "inout" takes no start / end: give one or the other');
    expect(() => planMcpExport(marked({ in: 2, out: 4 }), { range: 'inout', end: 3 })).toThrow('range "inout" takes no start / end');
  });
  it('a picture takes the frame at the in point and needs an in', () => {
    const p = planMcpExport(marked({ in: 2, out: 4 }), { range: 'inout', format: 'png' });
    expect(p.range.start).toBe(2);
    expect(p.frames).toBe(1);
    expect(() => planMcpExport(marked({ out: 4 }), { range: 'inout', format: 'jpg' })).toThrow('a picture is the frame at the in point: set_range an in point first');
    expect(() => planMcpExport(project(), { range: 'inout', format: 'png' })).toThrow('set_range an in point first');
  });
  it('inout without a span inside the project is refused', () => {
    expect(() => planMcpExport(project(), { range: 'inout' })).toThrow('there is no in or out point inside the project. set_range marks them');
    expect(() => planMcpExport(marked({ in: 12 }), { range: 'inout' })).toThrow('there is no in or out point inside the project');
  });
  it('a range and no range argument adds the note', () => {
    const note = 'the project has in and out points: range "inout" exports only that part';
    expect(planMcpExport(marked({ in: 2, out: 4 }), {}).notes).toContain(note);
    expect(planMcpExport(marked({ in: 2 }), { format: 'png' }).notes).toContain(note);
    expect(planMcpExport(project(), {}).notes).not.toContain(note);
  });
  it('all and start / end add no note', () => {
    expect(planMcpExport(marked({ in: 2, out: 4 }), { range: 'all' }).notes).toEqual([]);
    expect(planMcpExport(marked({ in: 2, out: 4 }), { range: 'all' }).range).toEqual({ start: 0, end: 10 });
    expect(planMcpExport(marked({ in: 2, out: 4 }), { start: 1 }).notes).toEqual([]);
    expect(planMcpExport(marked({ in: 2, out: 4 }), { end: 5 }).notes).toEqual([]);
  });
});

describe('the export job', () => {
  it('starts at once and reports progress', async () => {
    const f = fake();
    const job = createExportJob(f.deps);
    expect(job.status()).toEqual({ state: 'none' });
    const info = job.start(project(), { name: 'x' }, null);
    expect(info).toMatchObject({ status: 'started', file: 'x.mp4', frames: 300, width: 1920, height: 1080 });
    expect(job.running()).toBe(true);
    expect(f.options().container).toBe('mp4');
    f.hooks().onProgress?.({ phase: 'video', progress: 0.4, frame: 120, totalFrames: 300 });
    expect(job.status()).toMatchObject({ state: 'running', phase: 'video', progress: 0.4, frame: 120, totalFrames: 300 });
    f.finish();
    await job.settled();
  });

  it('with a ticket: arms the save first, then downloads under the marked name, then reports saved', async () => {
    const f = fake();
    const job = createExportJob(f.deps);
    job.start(project(), { name: 'x' }, 7);
    f.finish(new Blob(['12345']));
    await tick();
    expect(f.log.indexOf('save 7')).toBeGreaterThanOrEqual(0);
    expect(f.log.indexOf('save 7')).toBeLessThan(f.log.indexOf('download ncut-mcp-7-x.mp4'));
    expect(job.status().state).toBe('running');
    f.saveDone({ ok: true, name: 'x (2).mp4' });
    await job.settled();
    expect(job.status()).toMatchObject({ state: 'done', fileName: 'x (2).mp4', bytes: 5, saved: 7 });
    expect(job.running()).toBe(false);
    expect(f.log.slice(-2)).toEqual(['work off', 'progress null']);
  });

  it('with a ticket and a save that fails: the file is downloaded plainly, done without a ticket', async () => {
    const f = fake();
    const job = createExportJob(f.deps);
    job.start(project(), { name: 'x' }, 3);
    f.finish(new Blob(['abc']));
    await tick();
    f.saveDone({ ok: false, name: null });
    await job.settled();
    const s = job.status();
    expect(s).toMatchObject({ state: 'done', fileName: 'x.mp4', bytes: 3, saved: null });
    expect(s.state === 'done' && s.note).toMatch(/asked the user/);
    expect(f.log).toContain('download x.mp4');
    expect(job.lastFile()?.name).toBe('x.mp4');
  });

  it('cancel while the file is saved is too late and the job still ends done', async () => {
    const f = fake();
    const job = createExportJob(f.deps);
    job.start(project(), {}, 5);
    expect(job.saving()).toBe(false);
    f.finish();
    await tick();
    expect(job.saving()).toBe(true);
    expect(job.cancel()).toBe(false);
    f.saveDone({ ok: true, name: 'a.mp4' });
    await job.settled();
    expect(job.status().state).toBe('done');
    expect(job.saving()).toBe(false);
  });

  it('a sound file start answer has no picture fields, a cut range is noted', () => {
    const f = fake();
    const job = createExportJob(f.deps);
    const info = job.start(project(), { format: 'wav', end: 99 }, null);
    expect(info).not.toHaveProperty('width');
    expect(info).not.toHaveProperty('frames');
    expect(info.notes.join(' ')).toMatch(/0 to 10 s/);
  });

  it('a picture start answer has its size and time, no fps and no length', () => {
    const f = fake();
    const job = createExportJob(f.deps);
    const info = job.start(project(), { format: 'png', start: 2.5 }, null);
    expect(info).toMatchObject({ file: 'my film.png', format: 'png', width: 1920, height: 1080, frames: 1, time: 2.5, seconds: 0 });
    expect(info).not.toHaveProperty('fps');
    expect(f.options()).toMatchObject({ container: 'png', includeAudio: false });
  });

  it('without a ticket: keeps the blob in memory and says it was not written', async () => {
    const f = fake();
    const job = createExportJob(f.deps);
    job.start(project(), { name: 'y' }, null);
    f.finish(new Blob(['xyz']));
    await job.settled();
    const s = job.status();
    expect(s).toMatchObject({ state: 'done', fileName: 'y.mp4', bytes: 3, saved: null });
    expect(s.state === 'done' && s.note).toMatch(/not written/);
    expect(job.lastFile()?.name).toBe('y.mp4');
    expect(f.log.some((l) => l.startsWith('save') || l.startsWith('download'))).toBe(false);
  });

  it('a failing export is failed with its message and the job is free again', async () => {
    const f = fake();
    const job = createExportJob(f.deps);
    job.start(project(), {}, null);
    f.fail(new Error('no encoder'));
    await job.settled();
    expect(job.status()).toEqual({ state: 'failed', message: 'no encoder' });
    expect(job.running()).toBe(false);
    expect(f.log).toContain('work off');
    expect(() => job.start(project(), {}, null)).not.toThrow();
  });

  it('cancel aborts through the signal and ends cancelled', async () => {
    const f = fake();
    const job = createExportJob(f.deps);
    expect(job.cancel()).toBe(false);
    job.start(project(), {}, 1);
    expect(job.cancel()).toBe(true);
    await job.settled();
    expect(job.status()).toEqual({ state: 'cancelled' });
    expect(job.running()).toBe(false);
  });

  it('refuses a second start while one runs, and while the dialog exports', async () => {
    const f = fake();
    const job = createExportJob(f.deps);
    job.start(project(), {}, null);
    expect(() => job.start(project(), {}, null)).toThrow(EXPORT_BUSY);
    f.finish();
    await job.settled();
    f.other.runs = true;
    expect(() => job.start(project(), {}, null)).toThrow(EXPORT_BUSY);
  });

  it('a start that cannot plan leaves nothing running', () => {
    const f = fake();
    const job = createExportJob(f.deps);
    expect(() => job.start(project({ clips: [] }), {}, null)).toThrow(/empty/);
    expect(job.running()).toBe(false);
    expect(f.log).toEqual([]);
  });

  it('another project opened mid export stops it', async () => {
    const f = fake();
    const job = createExportJob(f.deps);
    job.start(project(), {}, null);
    f.open.id = 'p2';
    f.hooks().onProgress?.({ phase: 'video', progress: 0.1, frame: 1, totalFrames: 300 });
    await job.settled();
    expect(job.status()).toEqual({ state: 'cancelled' });
  });
});

describe('planMcpExport delivery and loudness', () => {
  it('no new argument leaves the options as they were', () => {
    const p = planMcpExport(project(), {});
    expect(p.options.delivery).toBeUndefined();
    expect(p.options.loudness ?? null).toBeNull();
  });

  it('the delivery arguments reach the options', () => {
    const p = planMcpExport(project(), { codec: 'h265', bitrate_mbps: 12, key_seconds: 4, audio_codec: 'aac', audio_kbps: 192, sample_rate: 44100 });
    expect(p.options.delivery).toMatchObject({ codec: 'hevc', audioCodec: 'aac', sampleRate: 44100 });
    expect(p.options.delivery!.bitrate).toBe(12e6);
    expect(p.options.delivery!.keySeconds).toBe(4);
    expect(p.options.delivery!.audioBitrate).toBe(192000);
  });

  it('width and height give the planned size', () => {
    const p = planMcpExport(project(), { width: 1280, height: 720 });
    expect(p.width).toBe(1280);
    expect(p.height).toBe(720);
  });

  it('a preset fills format, fps and size, and an explicit argument wins', () => {
    const y = planMcpExport(project(), { preset: 'youtube-1080' });
    expect(y.container).toBe('mp4');
    expect(y.width).toBe(1920);
    const r = planMcpExport(project(), { preset: 'reels' });
    expect(r.width).toBe(1080);
    expect(r.height).toBe(1920);
    expect(planMcpExport(project(), { preset: 'youtube-1080', fps: 24 }).options.fps).toBe(24);
  });

  it('a given scale or fps wins over the preset', () => {
    const a = planMcpExport(project(), { preset: 'youtube-1080', scale: 0.5 });
    expect(a.width).toBe(project().width * 0.5);
    expect(a.notes.join(' ')).toMatch(/size was dropped/);
    expect(planMcpExport(project(), { preset: 'master', fps: 60 }).options.fps).toBe(60);
  });

  it('a bad combination is an error naming the argument', () => {
    expect(() => planMcpExport(project(), { transparent: true })).toThrow(/transparent needs format webm or png/);
    expect(() => planMcpExport(project(), { format: 'webm', codec: 'h264' })).toThrow(/a webm holds vp9 or av1/);
  });

  it('loudness goes into the options, off without it', () => {
    expect(planMcpExport(project(), { loudness: { target: -16, ceiling: -1 } }).options.loudness).toEqual({ target: -16, ceiling: -1 });
  });

  it('the start answer names the choices that are set', async () => {
    const f = fake();
    const job = createExportJob(f.deps);
    const info = job.start(project(), { codec: 'h265', loudness: { target: -16, ceiling: -1 } }, null);
    expect(info.delivery).toMatchObject({ codec: 'h265' });
    expect(info.loudness).toEqual({ target_lufs: -16, peak_limit_dbtp: -1 });
    f.finish();
    await job.settled();
    const plain = createExportJob(fake().deps).start(project(), {}, null);
    expect(plain.delivery).toBeUndefined();
    expect(plain.loudness).toBeUndefined();
  });

  it('done carries what the loudness hook reported', async () => {
    const f = fake();
    const job = createExportJob(f.deps);
    job.start(project(), { loudness: { target: -16, ceiling: -1 } }, null);
    const n = { integrated: -16, lra: 3, truePeak: -1.5, samplePeak: -2, maxMomentary: -10, maxShortTerm: -12, seconds: 10 };
    f.hooks().onLoudness?.({ target: -16, ceiling: -1, sampleRate: 48000, before: n, after: n, gainDb: 0, limitDb: 0, limitShare: 0 });
    f.finish();
    await job.settled();
    const s = job.status();
    expect(s.state).toBe('done');
    if (s.state === 'done') expect(s.loudness).toMatchObject({ target: -16, ceiling: -1 });
  });

  it('done has no loudness when nothing was measured', async () => {
    const f = fake();
    const job = createExportJob(f.deps);
    job.start(project(), {}, null);
    f.finish();
    await job.settled();
    const s = job.status();
    if (s.state === 'done') expect(s.loudness).toBeNull();
    else throw new Error('not done');
  });
});
