/** the fader law and the meter math of the mixer. pure: no react, no dom */
import { dbToGain, gainToDb, OFF_DB } from './mix';
import type { TapLevels } from '../features/preview/meterTaps';

/** [fader position 0..1, db], top to bottom. straight lines in db between the points, linear in gain below the last */
export const FADER_POINTS: readonly (readonly [number, number])[] = [[1, 12], [0.875, 6], [0.75, 0], [0.625, -6], [0.5, -12], [0.375, -20], [0.25, -30], [0.15, -40], [0.05, -60]];

const LOW_POS = 0.05;
const LOW_DB = -60;

/** fader position (0 = bottom, 1 = top) to db. 0 and below is -inf, 1 and above is +12 */
export function faderDb(pos: number): number {
  if (!(pos > 0)) return -Infinity;
  if (pos >= 1) return 12;
  if (pos < LOW_POS) return gainToDb((dbToGain(LOW_DB) * pos) / LOW_POS);
  for (let i = 1; i < FADER_POINTS.length; i++) {
    const [p1, d1] = FADER_POINTS[i - 1]!;
    const [p0, d0] = FADER_POINTS[i]!;
    if (pos >= p0) return d0 + ((d1 - d0) * (pos - p0)) / (p1 - p0);
  }
  return LOW_DB;
}

/** db to fader position, clamped to 0..1: the inverse of faderDb */
export function faderPos(db: number): number {
  if (!(db > -Infinity)) return 0;
  if (db >= 12) return 1;
  if (db < LOW_DB) {
    const g = dbToGain(db);
    return Math.min(LOW_POS, (g / dbToGain(LOW_DB)) * LOW_POS);
  }
  for (let i = 1; i < FADER_POINTS.length; i++) {
    const [p1, d1] = FADER_POINTS[i - 1]!;
    const [p0, d0] = FADER_POINTS[i]!;
    if (db >= d0) return p0 + ((p1 - p0) * (db - d0)) / (d1 - d0);
  }
  return LOW_POS;
}

/** 0.1 db steps above -60 (never -0), anything else as it is */
export function roundFaderDb(db: number): number {
  if (!(db > LOW_DB)) return db;
  const r = Math.round(db * 10) / 10;
  return r === 0 ? 0 : r;
}

export interface MeterState {
  peak: [number, number];
  rms: [number, number];
  hold: [number, number];
  /** seconds since the hold line was last raised */
  holdAge: [number, number];
  over: boolean;
}

/** below this a level reads 0 */
export const METER_FLOOR_DB = OFF_DB;
const FLOOR = 10 ** (METER_FLOOR_DB / 20);
const FALL_DB_PER_S = 20 / 1.5;
const RMS_TAU = 0.3;
const HOLD_S = 2;
const MAX_DT = 0.1;

const floored = (v: number): number => (v < FLOOR ? 0 : v);

export function newMeter(): MeterState {
  return { peak: [0, 0], rms: [0, 0], hold: [0, 0], holdAge: [0, 0], over: false };
}

/** peak falls 20 db per 1.5 s, rms with a 0.3 s time constant, hold 2 s, over latches above 1.0, dt capped at 0.1 s. never mutates s */
export function stepMeter(s: MeterState, l: TapLevels, dt: number): MeterState {
  const d = Math.min(MAX_DT, Math.max(0, Number.isFinite(dt) ? dt : 0));
  const fall = 10 ** (-(FALL_DB_PER_S * d) / 20);
  const k = 1 - Math.exp(-d / RMS_TAU);
  const inPeak = [floored(l.peakL), floored(l.peakR)];
  const inRms = [floored(l.rmsL), floored(l.rmsR)];
  const next = newMeter();
  for (let i = 0; i < 2; i++) {
    const peak = floored(Math.max(inPeak[i]!, s.peak[i]! * fall));
    const rms = floored(s.rms[i]! + (inRms[i]! - s.rms[i]!) * k);
    let hold = s.hold[i]!;
    let age = s.holdAge[i]!;
    if (peak >= hold) {
      hold = peak;
      age = 0;
    } else {
      age += d;
      if (age >= HOLD_S) hold = peak;
    }
    next.peak[i] = peak;
    next.rms[i] = rms;
    next.hold[i] = floored(hold);
    next.holdAge[i] = age;
  }
  next.over = s.over || l.peakL > 1 || l.peakR > 1;
  return next;
}

/** every bar and hold line is at zero (the over light does not count) */
export function meterAtFloor(s: MeterState): boolean {
  return s.peak[0] === 0 && s.peak[1] === 0 && s.rms[0] === 0 && s.rms[1] === 0 && s.hold[0] === 0 && s.hold[1] === 0;
}

export function clearOver(s: MeterState): MeterState {
  return s.over ? { ...s, over: false } : s;
}
