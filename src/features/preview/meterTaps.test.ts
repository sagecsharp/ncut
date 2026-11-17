import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeterSource, TapLevels } from './meterTaps';

const load = () => import('./meterTaps');

function source(): MeterSource & { opened: string[]; closed: string[] } {
  const s = {
    opened: [] as string[],
    closed: [] as string[],
    openTap(k: string) {
      s.opened.push(k);
    },
    closeTap(k: string) {
      s.closed.push(k);
    },
    readTap(_k: string, out: TapLevels) {
      out.peakL = 0.5;
      return true;
    },
  };
  return s;
}
const levels = (): TapLevels => ({ peakL: 0, peakR: 0, rmsL: 0, rmsR: 0 });

beforeEach(() => {
  vi.resetModules();
});

describe('meterTaps', () => {
  it('holds are counted', async () => {
    const m = await load();
    const s = source();
    m.setMeterSource(s);
    const a = m.holdTap('t1');
    const b = m.holdTap('t1');
    expect(s.opened).toEqual(['t1']);
    a();
    expect(s.closed).toEqual([]);
    expect(m.heldTaps()).toEqual(['t1']);
    b();
    expect(s.closed).toEqual(['t1']);
    expect(m.heldTaps()).toEqual([]);
  });

  it('a release twice is safe', async () => {
    const m = await load();
    const s = source();
    m.setMeterSource(s);
    const a = m.holdTap('t1');
    const b = m.holdTap('t1');
    a();
    a();
    expect(m.heldTaps()).toEqual(['t1']);
    expect(s.closed).toEqual([]);
    b();
    b();
    expect(s.closed).toEqual(['t1']);
  });

  it('setMeterSource replays the held keys', async () => {
    const m = await load();
    m.holdTap('t1');
    m.holdTap('output');
    const s = source();
    m.setMeterSource(s);
    expect(s.opened.sort()).toEqual(['output', 't1']);
  });

  it('clear of another source does nothing', async () => {
    const m = await load();
    const a = source();
    const b = source();
    m.setMeterSource(a);
    m.clearMeterSource(b);
    expect(m.readTap('x', levels())).toBe(true);
    m.clearMeterSource(a);
    expect(m.readTap('x', levels())).toBe(false);
  });

  it('readTap is false without a source', async () => {
    const m = await load();
    expect(m.readTap('x', levels())).toBe(false);
    const rel = m.holdTap('x');
    expect(m.readTap('x', levels())).toBe(false);
    rel();
  });

  it('blockLevels of a sine and of zeros', async () => {
    const m = await load();
    const n = m.METER_WINDOW;
    const sine = new Float32Array(n);
    // whole periods: 16 of them in the window
    for (let i = 0; i < n; i++) sine[i] = Math.sin((2 * Math.PI * 16 * i) / n);
    const r = m.blockLevels(sine);
    expect(r.peak).toBeCloseTo(1, 4);
    expect(r.rms).toBeCloseTo(0.7071, 3);
    expect(m.blockLevels(new Float32Array(n))).toEqual({ peak: 0, rms: 0 });
    expect(m.blockLevels(new Float32Array(0))).toEqual({ peak: 0, rms: 0 });
  });
});
