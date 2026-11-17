import { describe, expect, it } from 'vitest';
import { clearOver, FADER_POINTS, faderDb, faderPos, meterAtFloor, METER_FLOOR_DB, newMeter, roundFaderDb, stepMeter } from './meter';
import type { MeterState } from './meter';
import { dbToGain, gainToDb } from './mix';

const lv = (peak: number, rms = 0) => ({ peakL: peak, peakR: peak, rmsL: rms, rmsR: rms });
const quiet = lv(0);

/** steps of dt seconds until total seconds have passed */
function run(s: MeterState, l: ReturnType<typeof lv>, total: number, dt = 0.05): MeterState {
  const n = Math.round(total / dt);
  for (let i = 0; i < n; i++) s = stepMeter(s, l, dt);
  return s;
}

describe('fader law', () => {
  it('faderDb hits every FADER_POINTS', () => {
    for (const [pos, db] of FADER_POINTS) expect(faderDb(pos)).toBeCloseTo(db, 9);
  });

  it('faderPos undoes faderDb', () => {
    for (let pos = 0.01; pos <= 1; pos += 0.01) expect(faderPos(faderDb(pos))).toBeCloseTo(pos, 9);
    expect(faderPos(12)).toBe(1);
    expect(faderPos(20)).toBe(1);
    expect(faderPos(-Infinity)).toBe(0);
    expect(faderPos(-90)).toBe(0);
    expect(faderPos(0)).toBeCloseTo(0.75, 12);
  });

  it('below .05 the fader is linear in gain', () => {
    const g = dbToGain(-60);
    expect(dbToGain(faderDb(0.025))).toBeCloseTo(g / 2, 12);
    expect(dbToGain(faderDb(0.01))).toBeCloseTo(g / 5, 12);
    expect(faderDb(0.05)).toBeCloseTo(-60, 9);
    expect(faderDb(0.05 - 1e-9)).toBeCloseTo(-60, 4);
  });

  it('faderDb(0) is -inf', () => {
    expect(faderDb(0)).toBe(-Infinity);
    expect(faderDb(-1)).toBe(-Infinity);
    expect(faderDb(1)).toBe(12);
    expect(faderDb(2)).toBe(12);
    expect(gainToDb(dbToGain(faderDb(0)))).toBe(-Infinity);
  });

  it('roundFaderDb keeps 0.1 db steps above -60', () => {
    expect(roundFaderDb(-2.04)).toBe(-2);
    expect(roundFaderDb(3.26)).toBe(3.3);
    expect(roundFaderDb(-0.04)).toBe(0);
    expect(Object.is(roundFaderDb(-0.04), -0)).toBe(false);
    expect(roundFaderDb(-61.234)).toBe(-61.234);
    expect(roundFaderDb(-Infinity)).toBe(-Infinity);
    expect(roundFaderDb(12)).toBe(12);
  });
});

describe('meter math', () => {
  it('the peak falls 20 db in 1.5 s', () => {
    const top = stepMeter(newMeter(), lv(1), 0.05);
    const s = run(top, quiet, 1.5);
    expect(gainToDb(s.peak[0])).toBeCloseTo(-20, 6);
    expect(gainToDb(s.peak[1])).toBeCloseTo(-20, 6);
  });

  it('rms settles with a 0.3 s time constant', () => {
    const s = run(newMeter(), lv(0.5, 0.5), 0.3, 0.05);
    expect(s.rms[0]).toBeCloseTo(0.5 * (1 - Math.exp(-1)), 6);
    const long = run(newMeter(), lv(0.5, 0.5), 3);
    expect(long.rms[0]).toBeCloseTo(0.5, 2);
  });

  it('the hold line stays 2 s', () => {
    let s = stepMeter(newMeter(), lv(1), 0.05);
    s = run(s, quiet, 1.8);
    expect(s.hold[0]).toBe(1);
    s = run(s, quiet, 0.4);
    expect(s.hold[0]).toBeLessThan(1);
    expect(s.hold[0]).toBe(s.peak[0]);
    // a louder peak raises it at once and restarts the wait
    const up = stepMeter(s, lv(0.9), 0.05);
    expect(up.hold[0]).toBe(0.9);
    expect(up.holdAge[0]).toBe(0);
  });

  it('over latches and clearOver clears it', () => {
    let s = stepMeter(newMeter(), lv(1), 0.05);
    expect(s.over).toBe(false);
    s = stepMeter(s, { peakL: 1.2, peakR: 0, rmsL: 0, rmsR: 0 }, 0.05);
    expect(s.over).toBe(true);
    s = run(s, quiet, 1);
    expect(s.over).toBe(true);
    const c = clearOver(s);
    expect(c.over).toBe(false);
    expect(c.peak).toEqual(s.peak);
    expect(clearOver(c)).toBe(c);
  });

  it('dt is capped at 0.1 s', () => {
    const top = stepMeter(newMeter(), lv(1), 0.05);
    const a = stepMeter(top, quiet, 5);
    const b = stepMeter(top, quiet, 0.1);
    expect(a).toEqual(b);
    expect(stepMeter(top, quiet, -1)).toEqual(stepMeter(top, quiet, 0));
    expect(stepMeter(top, quiet, NaN)).toEqual(stepMeter(top, quiet, 0));
  });

  it('never changes the state it is given', () => {
    const s = stepMeter(newMeter(), lv(0.8, 0.4), 0.05);
    const copy = structuredClone(s);
    stepMeter(s, lv(2, 1), 0.05);
    expect(s).toEqual(copy);
  });

  it('below the floor a level reads 0', () => {
    const tiny = 10 ** ((METER_FLOOR_DB - 1) / 20);
    const s = stepMeter(newMeter(), lv(tiny, tiny), 0.05);
    expect(s.peak).toEqual([0, 0]);
    expect(s.rms).toEqual([0, 0]);
    expect(s.hold).toEqual([0, 0]);
    const just = 10 ** ((METER_FLOOR_DB + 1) / 20);
    expect(stepMeter(newMeter(), lv(just), 0.05).peak[0]).toBe(just);
  });

  it('meterAtFloor', () => {
    expect(meterAtFloor(newMeter())).toBe(true);
    const loud = stepMeter(newMeter(), lv(1, 0.5), 0.05);
    expect(meterAtFloor(loud)).toBe(false);
    // a full scale peak is at the floor after 6.75 s
    expect(meterAtFloor(run(loud, quiet, 7.5))).toBe(true);
    // the over light is ignored
    expect(meterAtFloor({ ...newMeter(), over: true })).toBe(true);
  });
});
