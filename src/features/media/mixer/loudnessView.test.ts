import { describe, expect, it } from 'vitest';
import { NO_NUMBERS, NO_TRACE } from '../../../lib/loudness';
import { planLine } from '../../export/loudnessTypes';
import type { ExportLoudness, MixLoudness } from '../../export/loudnessTypes';
import { LOUD_MAX, LOUD_MIN, NO_VIEW, loudPos, measureLines, measureTip, measuredLine, meterText, sameView, targetFromValue, targetOptions, targetValue, tpOver } from './loudnessView';

const mix = (silent = false): MixLoudness => ({
  numbers: { ...NO_NUMBERS, integrated: -20.4, lra: 6.2, truePeak: -0.8, maxMomentary: -15.2, maxShortTerm: -17.9, seconds: 30 },
  trace: NO_TRACE,
  sampleRate: 48000,
  span: { start: 0, end: 30 },
  warnings: [],
  silent,
});
const off: ExportLoudness = { target: null, ceiling: null };

describe('loudness view', () => {
  it('loudPos puts -50 at 0, -5 at 1, -27.5 in the middle', () => {
    expect(loudPos(LOUD_MIN)).toBe(0);
    expect(loudPos(LOUD_MAX)).toBe(1);
    expect(loudPos(-27.5)).toBe(0.5);
  });

  it('loudPos clamps and takes -inf to 0', () => {
    expect(loudPos(-80)).toBe(0);
    expect(loudPos(3)).toBe(1);
    expect(loudPos(-Infinity)).toBe(0);
    expect(loudPos(NaN)).toBe(0);
  });

  it('meter texts', () => {
    expect(meterText('m', -18.2)).toBe('m -18.2');
    expect(meterText('i', -Infinity)).toBe('i -inf');
    expect(meterText('lra', 6.2)).toBe('lra 6.2');
    expect(meterText('tp', -0.8)).toBe('tp -0.8');
  });

  it('tp is over the peak limit, or over 0 without one', () => {
    expect(tpOver(-0.5, -1)).toBe(true);
    expect(tpOver(-1.5, -1)).toBe(false);
    expect(tpOver(0.2, null)).toBe(true);
    expect(tpOver(-0.2, null)).toBe(false);
    expect(tpOver(-Infinity, null)).toBe(false);
  });

  it('views are the same by their numbers', () => {
    expect(sameView(NO_VIEW, { ...NO_VIEW })).toBe(true);
    expect(sameView(NO_VIEW, { ...NO_VIEW, playing: true })).toBe(false);
  });

  it('the result line', () => {
    expect(measuredLine(mix(), false, false)).toBe('measured: -20.4 lufs, range 6.2 lu, peak -0.8 dbtp (in to out)');
    expect(measuredLine(mix(), true, false)).toBe('measured: -20.4 lufs, range 6.2 lu, peak -0.8 dbtp (whole timeline)');
  });

  it('a silent mix has no sound in this range', () => {
    expect(measuredLine(mix(true), false, false)).toBe('no sound in this range');
    expect(measureLines(mix(true), { target: -14, ceiling: -1 }, false, false)).toEqual(['no sound in this range']);
  });

  it('a stale result asks to measure again', () => {
    expect(measuredLine(mix(), false, true)).toBe('measured: -20.4 lufs, range 6.2 lu, peak -0.8 dbtp (in to out) (the mix changed: measure again)');
  });

  it('the plan lines come from planLine', () => {
    const l = { target: -14, ceiling: -1 };
    const m = mix();
    expect(measureLines(m, l, false, false)).toEqual([measuredLine(m, false, false), ...planLine(m, l).split('\n')]);
    expect(measureLines(m, off, false, false)).toEqual([measuredLine(m, false, false), ...planLine(m, off).split('\n')]);
  });

  it('a plan with a warning is split into its lines', () => {
    const w = { target: -14, ceiling: null };
    const m = mix();
    const lines = measureLines(m, w, false, false);
    expect(lines).toEqual([measuredLine(m, false, false), ...planLine(m, w).split('\n')]);
    expect(lines).toHaveLength(3);
  });

  it('the tip has max momentary and short term', () => {
    expect(measureTip(mix())).toBe('max momentary -15.2 lufs, max short term -17.9 lufs');
  });

  it('the target options keep a custom value', () => {
    expect(targetOptions(off).map((o) => o.value)).toEqual(['off', '-14', '-16', '-23', '-24']);
    const c = targetOptions({ target: -18, ceiling: -1 });
    expect(c[c.length - 1]).toEqual({ value: '-18', label: 'custom -18.0' });
    expect(targetOptions({ target: -23, ceiling: -1 })).toHaveLength(5);
    expect(targetValue({ target: -18, ceiling: -1 })).toBe('-18');
    expect(targetValue(off)).toBe('off');
    expect(targetFromValue('off')).toBeNull();
    expect(targetFromValue('-16')).toBe(-16);
  });
});
