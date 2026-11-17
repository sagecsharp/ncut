/**
 * what an export does with the loudness choice: measure the mix, plan the gain and the limit, hand out a fresh output
 * stage for each pump and say what came out. no choice gives null and nothing is measured (the old path, untouched).
 */
import { createOutputStage } from '../../lib/limiter';
import type { OutputStage, StageReport } from '../../lib/limiter';
import { LOUD_TEXT, MAX_RAISE_DB, afterGain, planOutput, wantsLoudness } from './loudnessTypes';
import type { ExportLoudness, LoudnessReport, MixLoudness, OutputDecision } from './loudnessTypes';
import { measureMix } from './measureMix';
import type { MeasureOpts } from './measureMix';
import type { TimeRange } from './range';
import type { Project } from '../../types';

export interface OutputPlanned {
  measured: MixLoudness;
  decision: OutputDecision;
  /** a new stage for each call (null: the choice changes nothing, the plain pump runs) */
  makeStage(): OutputStage | null;
  reportFor(stage: StageReport | null): { report: LoudnessReport; warnings: string[] };
}

export async function decideOutput(
  project: Project,
  range: TimeRange,
  rate: number,
  l: ExportLoudness | undefined,
  opts: MeasureOpts,
  measure: typeof measureMix = measureMix,
): Promise<OutputPlanned | null> {
  if (!wantsLoudness(l)) return null;
  const measured = await measure(project, range, rate, opts);
  const decision = planOutput(measured, l);
  const gainDb = decision.gainDb;
  return {
    measured,
    decision,
    makeStage() {
      if (gainDb === 0 && !decision.limit) return null;
      return createOutputStage({ rate, gain: 10 ** (gainDb / 20), ceiling: decision.limit ? l.ceiling : null });
    },
    reportFor(stage) {
      const before = measured.numbers;
      const after = stage?.after ?? afterGain(before, measured.trace, gainDb);
      const report: LoudnessReport = {
        target: l.target,
        ceiling: l.ceiling,
        sampleRate: rate,
        before,
        after,
        gainDb,
        limitDb: stage?.limitDb ?? 0,
        limitShare: stage?.limitShare ?? 0,
      };
      const warnings = [...decision.warnings];
      if (l.target !== null && Number.isFinite(after.integrated) && Number.isFinite(before.integrated) && gainDb < MAX_RAISE_DB && Math.abs(after.integrated - l.target) > 0.5) {
        warnings.push(LOUD_TEXT.missed(after.integrated, l.target));
      }
      if (l.ceiling !== null && after.truePeak > l.ceiling + 0.005) warnings.push(LOUD_TEXT.overCeiling(after.truePeak, l.ceiling));
      return { report, warnings };
    },
  };
}
