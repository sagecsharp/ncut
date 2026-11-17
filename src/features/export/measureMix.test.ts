import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import { NO_NUMBERS, NO_TRACE } from '../../lib/loudness';
import { createMeasurer } from './measureMix';
import type { MeasureRun } from './measureMix';
import type { MixLoudness } from './loudnessTypes';
import type { TimeRange } from './range';

const project = {} as Project;
const sign = (_p: Project, r: TimeRange, rate: number): string => `${r.start}-${r.end}-${rate}`;
const at = (n: number): TimeRange => ({ start: n, end: n + 1 });

const result = (warnings: string[] = []): MixLoudness => ({ numbers: { ...NO_NUMBERS }, trace: NO_TRACE, sampleRate: 48000, span: { start: 0, end: 1 }, warnings, silent: false });

interface Call { range: TimeRange; signal: AbortSignal; progress: (f: number) => void; done: (m: MixLoudness) => void; fail: (e: unknown) => void }

function fake() {
  const calls: Call[] = [];
  const run: MeasureRun = (_p, range, _rate, signal, progress) =>
    new Promise<MixLoudness>((done, fail) => {
      calls.push({ range, signal, progress, done, fail });
    });
  return { calls, measurer: createMeasurer(run, sign) };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('measurer', () => {
  it('two calls run once', async () => {
    const { calls, measurer } = fake();
    const a = measurer.measure(project, at(0), 48000);
    const b = measurer.measure(project, at(0), 48000);
    expect(calls.length).toBe(1);
    const m = result();
    calls[0]!.done(m);
    expect(await a).toBe(m);
    expect(await b).toBe(m);
    measurer.measure(project, at(1), 48000);
    expect(calls.length).toBe(2);
  });

  it('a hit never runs', async () => {
    const { calls, measurer } = fake();
    const p = measurer.measure(project, at(0), 48000);
    calls[0]!.done(result());
    const m = await p;
    expect(measurer.measured(project, at(0), 48000)).toBe(m);
    expect(measurer.measuring(project, at(0), 48000)).toBeNull();
    expect(await measurer.measure(project, at(0), 48000)).toBe(m);
    expect(calls.length).toBe(1);
  });

  it('one waiter aborting keeps the run, the last aborts it', async () => {
    const { calls, measurer } = fake();
    const ca = new AbortController();
    const cb = new AbortController();
    const a = measurer.measure(project, at(0), 48000, { signal: ca.signal });
    const b = measurer.measure(project, at(0), 48000, { signal: cb.signal });
    ca.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError', message: 'measure cancelled' });
    expect(calls[0]!.signal.aborted).toBe(false);
    cb.abort();
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls[0]!.signal.aborted).toBe(true);
    // an aborted signal at once: rejected, nothing joined, nothing started
    const dead = new AbortController();
    dead.abort();
    await expect(measurer.measure(project, at(5), 48000, { signal: dead.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.length).toBe(1);
    // the same sound again starts a new run
    measurer.measure(project, at(0), 48000);
    expect(calls.length).toBe(2);
    expect(calls[1]!.signal.aborted).toBe(false);
  });

  it('a waiter without a signal keeps it', async () => {
    const { calls, measurer } = fake();
    const ca = new AbortController();
    const a = measurer.measure(project, at(0), 48000, { signal: ca.signal });
    const b = measurer.measure(project, at(0), 48000);
    ca.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls[0]!.signal.aborted).toBe(false);
    const m = result();
    calls[0]!.done(m);
    expect(await b).toBe(m);
  });

  it('failures and warnings are not cached', async () => {
    const { calls, measurer } = fake();
    const a = measurer.measure(project, at(0), 48000);
    const b = measurer.measure(project, at(0), 48000);
    const boom = new Error('boom');
    calls[0]!.fail(boom);
    await expect(a).rejects.toBe(boom);
    await expect(b).rejects.toBe(boom);
    expect(measurer.measured(project, at(0), 48000)).toBeNull();
    expect(measurer.measuring(project, at(0), 48000)).toBeNull();
    const c = measurer.measure(project, at(0), 48000);
    expect(calls.length).toBe(2);
    const warned = result(['the browser cannot mix']);
    calls[1]!.done(warned);
    expect(await c).toBe(warned);
    expect(measurer.measured(project, at(0), 48000)).toBeNull();
    measurer.measure(project, at(0), 48000);
    expect(calls.length).toBe(3);
  });

  it('eight kept, a hit moves to the end', async () => {
    const { calls, measurer } = fake();
    for (let i = 0; i < 8; i++) {
      const p = measurer.measure(project, at(i), 48000);
      calls[i]!.done(result());
      await p;
    }
    // reading does not move anything
    for (let i = 0; i < 8; i++) expect(measurer.measured(project, at(i), 48000)).not.toBeNull();
    await measurer.measure(project, at(0), 48000);
    expect(calls.length).toBe(8);
    const nine = measurer.measure(project, at(8), 48000);
    calls[8]!.done(result());
    await nine;
    expect(measurer.measured(project, at(0), 48000)).not.toBeNull();
    expect(measurer.measured(project, at(1), 48000)).toBeNull();
    expect(measurer.measured(project, at(8), 48000)).not.toBeNull();
  });

  it('progress reaches every waiter', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { calls, measurer } = fake();
    const seenA: number[] = [];
    const seenB: number[] = [];
    let changes = 0;
    const off = measurer.onChange(() => changes++);
    const a = measurer.measure(project, at(0), 48000, { onProgress: (f) => seenA.push(f) });
    const b = measurer.measure(project, at(0), 48000, { onProgress: (f) => seenB.push(f) });
    expect(changes).toBe(1);
    expect(measurer.measuring(project, at(0), 48000)).toBe(0);
    calls[0]!.progress(0.1);
    calls[0]!.progress(0.2);
    expect(changes).toBe(1);
    vi.setSystemTime(Date.now() + 150);
    calls[0]!.progress(0.5);
    expect(changes).toBe(2);
    expect(measurer.measuring(project, at(0), 48000)).toBe(0.5);
    expect(seenA).toEqual([0.1, 0.2, 0.5]);
    expect(seenB).toEqual([0.1, 0.2, 0.5]);
    calls[0]!.done(result());
    await Promise.all([a, b]);
    await settle();
    expect(changes).toBe(3);
    off();
    measurer.measure(project, at(3), 48000);
    expect(changes).toBe(3);
  });
});
