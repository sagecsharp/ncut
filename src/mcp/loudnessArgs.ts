/**
 * the loudness arguments of the export tools and the answers about loudness (export_video, export_status, measure_loudness). pure:
 * the texts of the errors are here, the tools throw them.
 */
import { CEILING_MAX, CEILING_MIN, DEFAULT_CEILING, TARGET_MAX, TARGET_MIN } from '../features/export/loudnessTypes';
import type { ExportLoudness, LoudnessReport, MixLoudness } from '../features/export/loudnessTypes';
import { ToolError } from './helpers';

/** what is left of a number: nothing to measure (minus infinity, not a number) is null */
const num = (n: number, places = 2): number | null => {
  if (!Number.isFinite(n)) return null;
  const k = 10 ** places;
  return Math.round(n * k) / k + 0;
};

/**
 * the loudness choice of export_video: loudness_target alone gives the peak limit -1, peak_limit alone limits only, neither is off (the
 * dialog's saved choice is never used). out of range is an error, so is a choice for a file without sound (sound = false).
 */
export function loudnessFromArgs(args: { loudness_target?: unknown; peak_limit?: unknown }, sound: boolean): ExportLoudness | null {
  const t = args.loudness_target;
  const c = args.peak_limit;
  if (t === undefined && c === undefined) return null;
  if (t !== undefined && !(typeof t === 'number' && Number.isFinite(t) && t >= TARGET_MIN && t <= TARGET_MAX)) {
    throw new ToolError(`loudness_target must be between ${TARGET_MIN} and ${TARGET_MAX} lufs, got ${String(t)}`);
  }
  if (c !== undefined && !(typeof c === 'number' && Number.isFinite(c) && c >= CEILING_MIN && c <= CEILING_MAX)) {
    throw new ToolError(`peak_limit must be between ${CEILING_MIN} and ${CEILING_MAX} dbtp, got ${String(c)}`);
  }
  if (!sound) throw new ToolError('loudness needs a format with sound');
  const target = typeof t === 'number' ? t : null;
  const ceiling = typeof c === 'number' ? c : target !== null ? DEFAULT_CEILING : null;
  return { target, ceiling };
}

/** measure_loudness: what was measured. cached = no work was needed, the same sound had been measured before */
export function loudnessAnswer(m: MixLoudness, cached: boolean): Record<string, unknown> {
  const n = m.numbers;
  return {
    integrated_lufs: num(n.integrated),
    range_lu: num(n.lra),
    true_peak_dbtp: num(n.truePeak),
    sample_peak_dbfs: num(n.samplePeak),
    max_momentary_lufs: num(n.maxMomentary),
    max_short_term_lufs: num(n.maxShortTerm),
    seconds: num(m.span.end - m.span.start, 3),
    sample_rate: m.sampleRate,
    start: num(m.span.start, 3),
    end: num(m.span.end, 3),
    cached,
  };
}

/** export_status done: what came out of a loudness choice, and what it was before the export changed it */
export function reportAnswer(r: LoudnessReport): Record<string, unknown> {
  const a = r.after;
  const b = r.before;
  const out: Record<string, unknown> = {
    integrated_lufs: num(a.integrated),
    true_peak_dbtp: num(a.truePeak),
    range_lu: num(a.lra),
    gain_db: num(r.gainDb),
    limited_db: num(r.limitDb),
    limited_share: num(r.limitShare, 4),
    target_lufs: r.target,
    peak_limit_dbtp: r.ceiling,
    before: { integrated_lufs: num(b.integrated), true_peak_dbtp: num(b.truePeak), range_lu: num(b.lra) },
  };
  const nothing = [a.integrated, a.truePeak, a.lra, b.integrated, b.truePeak, b.lra].some((v) => !Number.isFinite(v));
  if (nothing) out.note = 'null means nothing to measure';
  return out;
}
