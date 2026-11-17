import { dbtpText, fix1, gatedLoudness, loudnessRange, luText, lufsText } from '../../lib/loudness';
import type { LoudnessNumbers, LoudnessTrace } from '../../lib/loudness';
import type { TimeRange } from './range';

/** null = off. saved per browser, never in the project */
export interface ExportLoudness { target: number | null; ceiling: number | null }
export const NO_LOUDNESS: Readonly<ExportLoudness> = { target: null, ceiling: null };
export const TARGET_MIN = -36;
export const TARGET_MAX = -6;
export const CEILING_MIN = -9;
export const CEILING_MAX = 0;
export const DEFAULT_CEILING = -1;
export const GAIN_EPS_DB = 0.05; // a smaller gain is not applied
export const MAX_RAISE_DB = 20;
export const PEAK_EPS_DB = 0.01; // the limiter runs above ceiling - this
export const LOUDNESS_TARGETS: readonly { lufs: number; label: string }[] = [
  { lufs: -14, label: '-14 lufs, streaming' },
  { lufs: -16, label: '-16 lufs, podcast' },
  { lufs: -23, label: '-23 lufs, ebu r128' },
  { lufs: -24, label: '-24 lufs, atsc a/85' },
];
export interface MixLoudness { numbers: LoudnessNumbers; trace: LoudnessTrace; sampleRate: number; span: TimeRange; warnings: string[]; silent: boolean }
/** after = into the encoder. limitDb = the most the limiter took off (0 = never), limitShare = the share of time it acted */
export interface LoudnessReport { target: number | null; ceiling: number | null; sampleRate: number; before: LoudnessNumbers; after: LoudnessNumbers; gainDb: number; limitDb: number; limitShare: number }
export interface OutputDecision { gainDb: number; limit: boolean; ceiling: number | null; warnings: string[] }

export const LOUD_TEXT = {
  tooQuiet: 'the mix is too quiet or too short to measure, the loudness target was skipped',
  raiseCap: (short: number): string => `the mix is very quiet: raised by 20 db, ${short.toFixed(1)} lu short of the target`,
  missed: (after: number, target: number): string => `the file came out at ${after.toFixed(1)} lufs, ${Math.abs(after - target).toFixed(1)} lu ${after < target ? 'under' : 'over'} the target: the peak limit took that much off. a lower target or a higher peak limit gets closer`,
  overCeiling: (tp: number, c: number): string => `the true peak came out at ${tp.toFixed(2)} dbtp, over the peak limit of ${c.toFixed(1)} dbtp`,
  clips: (tp: number): string => `with no peak limit the true peak comes to ${tp.toFixed(1)} dbtp: the file can clip. tick peak limit to keep it under`,
  beforeCodec: 'measured before the encoder: aac and opus can add a little',
};

export function wantsLoudness(l: ExportLoudness | null | undefined): l is ExportLoudness {
  return !!l && (l.target !== null || l.ceiling !== null);
}

/** the numbers after a plain gain: the gates run again on the trace */
export function afterGain(m: LoudnessNumbers, trace: LoudnessTrace, gainDb: number): LoudnessNumbers {
  if (gainDb === 0) return m;
  const g = 10 ** (gainDb / 10);
  const up = (v: number): number => (Number.isFinite(v) ? v + gainDb : v);
  return { integrated: gatedLoudness(trace.blocks, g), lra: loudnessRange(trace.shorts, g), truePeak: up(m.truePeak), samplePeak: up(m.samplePeak), maxMomentary: up(m.maxMomentary), maxShortTerm: up(m.maxShortTerm), seconds: m.seconds };
}

export function planOutput(m: MixLoudness, l: ExportLoudness): OutputDecision {
  const warnings: string[] = [];
  const n = m.numbers;
  const at = (db: number): number => gatedLoudness(m.trace.blocks, 10 ** (db / 10));
  let gainDb = 0;
  if (l.target !== null) {
    if (!Number.isFinite(n.integrated)) warnings.push(LOUD_TEXT.tooQuiet);
    else {
      gainDb = l.target - n.integrated;
      for (let k = 0; k < 4; k++) {
        const g = Math.min(gainDb, MAX_RAISE_DB);
        const miss = l.target - at(g);
        if (!Number.isFinite(miss) || Math.abs(miss) < 0.01) break;
        gainDb = g + miss;
      }
      if (gainDb > MAX_RAISE_DB) {
        gainDb = MAX_RAISE_DB;
        warnings.push(LOUD_TEXT.raiseCap(l.target - at(MAX_RAISE_DB)));
      }
      if (Math.abs(gainDb) < GAIN_EPS_DB) gainDb = 0;
    }
  }
  const tp = Number.isFinite(n.truePeak) ? n.truePeak + gainDb : -Infinity;
  const limit = l.ceiling !== null && tp > l.ceiling - PEAK_EPS_DB;
  if (l.ceiling === null && tp > 0) warnings.push(LOUD_TEXT.clips(tp));
  return { gainDb, limit, ceiling: l.ceiling, warnings };
}

const clampTo = (v: unknown, lo: number, hi: number): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(Math.min(hi, Math.max(lo, v)) * 10) / 10 + 0;
};

/** a saved or typed choice made safe: ranges clamped, one decimal. not an object = off */
export function cleanLoudness(v: unknown): ExportLoudness {
  if (typeof v !== 'object' || v === null) return { target: null, ceiling: null };
  const o = v as Record<string, unknown>;
  return { target: clampTo(o.target, TARGET_MIN, TARGET_MAX), ceiling: clampTo(o.ceiling, CEILING_MIN, CEILING_MAX) };
}

/** picking a target turns the limit on at the old ceiling (or -1), target off turns both off */
export function pickTarget(prev: ExportLoudness, target: number | null): ExportLoudness {
  if (target === null) return { ...NO_LOUDNESS };
  return { target, ceiling: prev.ceiling ?? DEFAULT_CEILING };
}

/** what came out, one line: loudness, peak, range, and what the export did */
export function loudnessLine(r: LoudnessReport): string {
  const a = r.after;
  const head = `loudness ${lufsText(a.integrated)}, peak ${dbtpText(a.truePeak)}, range ${luText(a.lra)}`;
  const did = r.gainDb > 0 ? ` (raised ${fix1(r.gainDb)} db` : r.gainDb < 0 ? ` (lowered ${fix1(Math.abs(r.gainDb))} db` : ' (level kept';
  const share = r.limitShare < 0.001 ? 'under 0.1%' : `${(r.limitShare * 100).toFixed(1)}%`;
  const limit = r.limitDb > 0 ? `, the limiter took up to ${fix1(r.limitDb)} db on ${share} of the time)` : ', no limiting)';
  return head + did + limit;
}

/** what the export will do with this mix and choice, in plain words, warnings on their own lines */
export function planLine(m: MixLoudness, l: ExportLoudness): string {
  if (!wantsLoudness(l)) return 'no loudness target: the export keeps it as it is';
  const d = planOutput(m, l);
  const c = fix1(d.ceiling ?? 0);
  let line: string;
  if (d.gainDb !== 0) {
    line = `the export ${d.gainDb > 0 ? 'raises' : 'lowers'} it ${Math.abs(d.gainDb).toFixed(1)} db to ${fix1(l.target ?? 0)} lufs`;
    if (d.limit) line += ` and limits peaks to ${c} dbtp`;
  } else if (d.limit) line = `the export only limits peaks to ${c} dbtp`;
  else if (l.target === null) line = `the peaks are under ${c} dbtp: the export keeps it as it is`;
  else line = 'the export keeps it as it is';
  return [line, ...d.warnings].join('\n');
}
