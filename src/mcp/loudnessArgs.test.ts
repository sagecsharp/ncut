import { describe, expect, it } from 'vitest';
import type { LoudnessReport, MixLoudness } from '../features/export/loudnessTypes';
import { ToolError } from './helpers';
import { loudnessAnswer, loudnessFromArgs, reportAnswer } from './loudnessArgs';

const nums = (over: Record<string, number> = {}) => ({ integrated: -14.123, lra: 5.555, truePeak: -1.234, samplePeak: -2, maxMomentary: -10, maxShortTerm: -12, seconds: 10, ...over });

describe('loudnessFromArgs', () => {
  it('nothing given is off', () => {
    expect(loudnessFromArgs({}, true)).toBeNull();
    expect(loudnessFromArgs({}, false)).toBeNull();
  });

  it('a target alone gets the default peak limit of -1', () => {
    expect(loudnessFromArgs({ loudness_target: -16 }, true)).toEqual({ target: -16, ceiling: -1 });
  });

  it('both are kept, a limit alone limits only', () => {
    expect(loudnessFromArgs({ loudness_target: -23, peak_limit: -2 }, true)).toEqual({ target: -23, ceiling: -2 });
    expect(loudnessFromArgs({ peak_limit: -3 }, true)).toEqual({ target: null, ceiling: -3 });
  });

  it('out of range is an error naming the range', () => {
    expect(() => loudnessFromArgs({ loudness_target: -40 }, true)).toThrow(/between -36 and -6 lufs/);
    expect(() => loudnessFromArgs({ loudness_target: -5 }, true)).toThrow(ToolError);
    expect(() => loudnessFromArgs({ peak_limit: 1 }, true)).toThrow(/between -9 and 0 dbtp/);
    expect(() => loudnessFromArgs({ peak_limit: -10 }, true)).toThrow(/peak_limit/);
    expect(() => loudnessFromArgs({ loudness_target: Number.NaN }, true)).toThrow(/loudness_target/);
  });

  it('a format without sound refuses a choice', () => {
    expect(() => loudnessFromArgs({ loudness_target: -16 }, false)).toThrow(/needs a format with sound/);
    expect(() => loudnessFromArgs({ peak_limit: -1 }, false)).toThrow(/needs a format with sound/);
  });
});

describe('loudnessAnswer and reportAnswer', () => {
  const mix = (n = nums()): MixLoudness => ({ numbers: n, trace: {} as never, sampleRate: 48000, span: { start: 1, end: 11.5 }, warnings: [], silent: false });

  it('rounds the numbers and says whether it was cached', () => {
    const a = loudnessAnswer(mix(), true);
    expect(a).toMatchObject({ integrated_lufs: -14.12, range_lu: 5.56, true_peak_dbtp: -1.23, seconds: 10.5, sample_rate: 48000, start: 1, end: 11.5, cached: true });
  });

  it('minus infinity is null, not a string', () => {
    const a = loudnessAnswer(mix(nums({ integrated: -Infinity, truePeak: -Infinity })), false);
    expect(a.integrated_lufs).toBeNull();
    expect(a.true_peak_dbtp).toBeNull();
    expect(JSON.parse(JSON.stringify(a)).integrated_lufs).toBeNull();
  });

  it('the report has before and after, and a note when there is nothing to measure', () => {
    const r: LoudnessReport = { target: -16, ceiling: -1, sampleRate: 48000, before: nums(), after: nums({ integrated: -16 }), gainDb: -1.876, limitDb: 0, limitShare: 0.01234 };
    const a = reportAnswer(r);
    expect(a).toMatchObject({ integrated_lufs: -16, gain_db: -1.88, limited_db: 0, limited_share: 0.0123, target_lufs: -16, peak_limit_dbtp: -1 });
    expect(a.before).toMatchObject({ integrated_lufs: -14.12 });
    expect(a.note).toBeUndefined();
    const q = reportAnswer({ ...r, before: nums({ integrated: -Infinity }) });
    expect(q.note).toBe('null means nothing to measure');
    expect((q.before as Record<string, unknown>).integrated_lufs).toBeNull();
  });
});
