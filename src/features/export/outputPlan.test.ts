import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import type { LoudnessNumbers } from '../../lib/loudness';
import type { StageReport } from '../../lib/limiter';
import { LOUD_TEXT, NO_LOUDNESS } from './loudnessTypes';
import type { MixLoudness } from './loudnessTypes';
import { decideOutput } from './outputPlan';

const project = {} as Project;
const range = { start: 0, end: 10 };

function flat(lufs: number, tp: number, count = 100): MixLoudness {
  const p = 10 ** ((lufs + 0.691) / 10);
  const numbers: LoudnessNumbers = { integrated: lufs, lra: 0, truePeak: tp, samplePeak: tp, maxMomentary: lufs, maxShortTerm: lufs, seconds: count / 10 };
  return { numbers, trace: { blocks: new Float64Array(count).fill(p), shorts: new Float64Array(count).fill(p) }, sampleRate: 48000, span: range, warnings: ['measure warning'], silent: false };
}
const fake = (m: MixLoudness) => vi.fn(async () => m);
const stageAfter = (integrated: number, truePeak: number, m: MixLoudness): StageReport => ({ limitDb: 2, limitShare: 0.1, after: { ...m.numbers, integrated, truePeak } });

describe('decideOutput', () => {
  it('no choice gives null and never measures', async () => {
    const measure = fake(flat(-20, -3));
    expect(await decideOutput(project, range, 48000, undefined, {}, measure)).toBeNull();
    expect(await decideOutput(project, range, 48000, NO_LOUDNESS, {}, measure)).toBeNull();
    expect(measure).not.toHaveBeenCalled();
  });

  it('a choice that changes nothing makes no stage', async () => {
    const measure = fake(flat(-14.01, -5));
    const p = await decideOutput(project, range, 48000, { target: -14, ceiling: null }, {}, measure);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(p).not.toBeNull();
    expect(p!.makeStage()).toBeNull();
    const peaks = await decideOutput(project, range, 48000, { target: null, ceiling: -1 }, {}, fake(flat(-20, -6)));
    expect(peaks!.makeStage()).toBeNull();
  });

  it('each call makes a new stage', async () => {
    const p = await decideOutput(project, range, 48000, { target: -14, ceiling: -1 }, {}, fake(flat(-20, -3)));
    const a = p!.makeStage();
    const b = p!.makeStage();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('a miss over 0.5 lu warns, not after raiseCap', async () => {
    const m = flat(-20, -3);
    const p = await decideOutput(project, range, 48000, { target: -14, ceiling: -1 }, {}, fake(m));
    const { report, warnings } = p!.reportFor(stageAfter(-16, -1.2, m));
    expect(report.after.integrated).toBe(-16);
    expect(warnings).toEqual([LOUD_TEXT.missed(-16, -14)]);
    expect(p!.reportFor(stageAfter(-14.3, -1.2, m)).warnings).toEqual([]);
    const quiet = flat(-50, -40);
    const q = await decideOutput(project, range, 48000, { target: -14, ceiling: null }, {}, fake(quiet));
    const made = q!.reportFor(null);
    expect(made.report.gainDb).toBe(20);
    expect(made.warnings).toHaveLength(1);
    expect(made.warnings[0]).toContain('raised by 20 db');
  });

  it('a true peak past the limit warns', async () => {
    const m = flat(-20, -3);
    const p = await decideOutput(project, range, 48000, { target: -14, ceiling: -1 }, {}, fake(m));
    expect(p!.reportFor(stageAfter(-14, -0.5, m)).warnings).toEqual([LOUD_TEXT.overCeiling(-0.5, -1)]);
    expect(p!.reportFor(stageAfter(-14, -0.996, m)).warnings).toEqual([]);
  });

  it('without a limiter after comes from afterGain', async () => {
    const m = flat(-20, -30);
    const p = await decideOutput(project, range, 48000, { target: -14, ceiling: null }, {}, fake(m));
    const stage = p!.makeStage()!;
    const { report, warnings } = p!.reportFor(stage.report());
    expect(report.gainDb).toBeCloseTo(6, 6);
    expect(Math.abs(report.after.integrated - -14)).toBeLessThan(1e-6);
    expect(report.after.truePeak).toBeCloseTo(-24, 6);
    expect(report.before).toBe(m.numbers);
    expect(report.limitDb).toBe(0);
    expect(report.limitShare).toBe(0);
    expect(report.sampleRate).toBe(48000);
    expect(warnings).toEqual([]);
  });
});
