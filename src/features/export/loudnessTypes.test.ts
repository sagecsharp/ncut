import { describe, expect, it } from 'vitest';
import { lufsText } from '../../lib/loudness';
import type { LoudnessNumbers, LoudnessTrace } from '../../lib/loudness';
import { CEILING_MAX, DEFAULT_CEILING, LOUD_TEXT, LOUDNESS_TARGETS, NO_LOUDNESS, afterGain, cleanLoudness, loudnessLine, pickTarget, planLine, planOutput } from './loudnessTypes';
import type { LoudnessReport, MixLoudness } from './loudnessTypes';

/** a mix of equal blocks: every block holds the power of `lufs`, the peaks are `tp` */
function flat(lufs: number, tp: number, count = 100): MixLoudness {
  const p = 10 ** ((lufs + 0.691) / 10);
  const blocks = new Float64Array(count).fill(p);
  const shorts = new Float64Array(count).fill(p);
  const numbers: LoudnessNumbers = { integrated: lufs, lra: 0, truePeak: tp, samplePeak: tp, maxMomentary: lufs, maxShortTerm: lufs, seconds: count / 10 };
  return { numbers, trace: { blocks, shorts }, sampleRate: 48000, span: { start: 0, end: count / 10 }, warnings: [], silent: false };
}

describe('loudness types', () => {
  it('planOutput gains to the target and limits past the ceiling', () => {
    const d = planOutput(flat(-20, -3), { target: -14, ceiling: -1 });
    expect(d.gainDb).toBeCloseTo(6, 6);
    expect(d.limit).toBe(true);
    expect(d.warnings).toEqual([]);
  });

  it('a gain under 0.05 db is not applied', () => {
    const d = planOutput(flat(-14.03, -5), { target: -14, ceiling: null });
    expect(d.gainDb).toBe(0);
    expect(d.limit).toBe(false);
    expect(d.warnings).toEqual([]);
  });

  it('too quiet skips the target', () => {
    const m = flat(-20, -3);
    m.numbers = { ...m.numbers, integrated: -Infinity };
    const d = planOutput(m, { target: -14, ceiling: -1 });
    expect(d.gainDb).toBe(0);
    expect(d.warnings).toEqual([LOUD_TEXT.tooQuiet]);
  });

  it('the raise stops at 20 db and tells the shortfall', () => {
    const quiet = planOutput(flat(-50, -40), { target: -14, ceiling: null });
    expect(quiet.gainDb).toBe(20);
    expect(quiet.warnings).toHaveLength(1);
    expect(quiet.warnings[0]).toContain('16.0 lu short');
    // one loud block in a near silent recording: the blocks under the gate count once raised
    const blocks = new Float64Array(1000).fill(10 ** ((-71 + 0.691) / 10));
    blocks[0] = 10 ** ((-40 + 0.691) / 10);
    const m = flat(-40, -30, 1000);
    const sparse: MixLoudness = { ...m, trace: { blocks, shorts: new Float64Array(0) } };
    const d = planOutput(sparse, { target: -36, ceiling: null });
    expect(d.gainDb).toBe(20);
    expect(d.warnings[0]).toContain('11.5 lu short');
  });

  it('a peak limit alone', () => {
    const at = (tp: number) => planOutput(flat(-20, tp), { target: null, ceiling: -1 });
    expect(at(-0.5).limit).toBe(true);
    expect(at(-1.02).limit).toBe(false);
    expect(at(-1.005).limit).toBe(true);
    expect(at(-0.5).gainDb).toBe(0);
  });

  it('a target without a limit warns it can clip', () => {
    const d = planOutput(flat(-20, -3), { target: -14, ceiling: null });
    expect(d.limit).toBe(false);
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toBe(LOUD_TEXT.clips(d.gainDb - 3));
    expect(d.warnings[0]).toContain('3.0 dbtp');
  });

  it('afterGain moves the numbers', () => {
    const m = flat(-20, -3);
    const a = afterGain(m.numbers, m.trace, 6);
    expect(Math.abs(a.integrated - -14)).toBeLessThan(1e-9);
    expect(a.truePeak).toBe(3);
    expect(a.samplePeak).toBe(3);
    expect(a.maxMomentary).toBeCloseTo(-14, 9);
    expect(a.seconds).toBe(m.numbers.seconds);
    expect(afterGain(m.numbers, m.trace, 0)).toBe(m.numbers);
    const silent: LoudnessNumbers = { ...m.numbers, truePeak: -Infinity, samplePeak: -Infinity };
    const trace: LoudnessTrace = m.trace;
    expect(afterGain(silent, trace, 6).truePeak).toBe(-Infinity);
  });

  it('cleanLoudness clamps and rounds', () => {
    expect(cleanLoudness({ target: -40, ceiling: 0.5 })).toEqual({ target: -36, ceiling: CEILING_MAX });
    expect(cleanLoudness({ target: -3, ceiling: -12 })).toEqual({ target: -6, ceiling: -9 });
    expect(cleanLoudness({ target: 'x', ceiling: null })).toEqual(NO_LOUDNESS);
    expect(cleanLoudness({ target: -14.04, ceiling: -1.26 })).toEqual({ target: -14, ceiling: -1.3 });
    expect(cleanLoudness(5)).toEqual(NO_LOUDNESS);
    expect(cleanLoudness(null)).toEqual(NO_LOUDNESS);
  });

  it('pickTarget follows d4', () => {
    expect(pickTarget(NO_LOUDNESS, -14)).toEqual({ target: -14, ceiling: DEFAULT_CEILING });
    expect(pickTarget({ target: -14, ceiling: -2 }, null)).toEqual(NO_LOUDNESS);
    expect(pickTarget({ target: null, ceiling: -2 }, -16)).toEqual({ target: -16, ceiling: -2 });
  });

  it('the texts', () => {
    expect(LOUDNESS_TARGETS.map((t) => t.lufs)).toEqual([-14, -16, -23, -24]);
    const m = flat(-20, -3);
    expect(planLine(m, NO_LOUDNESS).split('\n').length).toBe(1);
    const first = planLine(m, { target: -14, ceiling: -1 }).split('\n')[0]!;
    expect(first).toContain('db to -14.0 lufs');
    const quiet = planLine(flat(-50, -40), { target: -14, ceiling: null }).split('\n');
    expect(quiet[0]).toContain('db to -14.0 lufs');
    expect(quiet[1]).toContain('lu short of the target');
    const base: LoudnessReport = { target: -14, ceiling: -1, sampleRate: 48000, before: m.numbers, after: afterGain(m.numbers, m.trace, 6), gainDb: 6, limitDb: 2.1, limitShare: 0.004 };
    expect(loudnessLine(base)).toContain(lufsText(base.after.integrated));
    expect(loudnessLine({ ...base, limitDb: 0, limitShare: 0 })).toContain(', no limiting)');
    expect(loudnessLine({ ...base, limitShare: 0.0001 })).toContain('under 0.1%');
  });
});
