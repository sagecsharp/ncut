/** what the loudness strip and the measure bar show, as plain functions. no dom, no web audio */
import { dbtpText, fix1, luText, lufsText } from '../../../lib/loudness';
import { LOUDNESS_TARGETS, planLine } from '../../export/loudnessTypes';
import type { ExportLoudness, MixLoudness } from '../../export/loudnessTypes';

/** the bar runs from -50 to -5 lufs, a tick every 10 */
export const LOUD_MIN = -50;
export const LOUD_MAX = -5;
export const LOUD_TICKS: readonly number[] = [-50, -40, -30, -20, -10];

/** a loudness on the bar, 0..1. nothing (-inf, nan) sits at 0 */
export function loudPos(lufs: number): number {
  if (!Number.isFinite(lufs)) return 0;
  return Math.min(1, Math.max(0, (lufs - LOUD_MIN) / (LOUD_MAX - LOUD_MIN)));
}

export type LoudName = 'm' | 's' | 'i' | 'lra' | 'tp';

/** 'm -18.2', '-inf' when nothing */
export function meterText(name: LoudName, v: number): string {
  return `${name} ${Number.isFinite(v) ? fix1(v) : '-inf'}`;
}

/** the true peak is over the peak limit, or over 0 when there is none */
export function tpOver(tp: number, ceiling: number | null): boolean {
  return tp > (ceiling ?? 0);
}

export interface LoudView { momentary: number; shortTerm: number; integrated: number; lra: number; truePeak: number; playing: boolean }
export const NO_VIEW: Readonly<LoudView> = { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, lra: 0, truePeak: -Infinity, playing: false };

/** equal numbers (-inf equals -inf) */
export function sameView(a: LoudView, b: LoudView): boolean {
  return a.momentary === b.momentary && a.shortTerm === b.shortTerm && a.integrated === b.integrated && a.lra === b.lra && a.truePeak === b.truePeak && a.playing === b.playing;
}

/** the result of a measure, one line */
export function measuredLine(m: MixLoudness, whole: boolean, stale: boolean): string {
  const n = m.numbers;
  const line = m.silent
    ? 'no sound in this range'
    : `measured: ${lufsText(n.integrated)}, range ${luText(n.lra)}, peak ${dbtpText(n.truePeak)} (${whole ? 'whole timeline' : 'in to out'})`;
  return stale ? line + ' (the mix changed: measure again)' : line;
}

/** the result line, then what the export would do with it, one string per line */
export function measureLines(m: MixLoudness, l: ExportLoudness, whole: boolean, stale: boolean): string[] {
  const head = measuredLine(m, whole, stale);
  return m.silent ? [head] : [head, ...planLine(m, l).split('\n')];
}

export function measureTip(m: MixLoudness): string {
  return `max momentary ${lufsText(m.numbers.maxMomentary)}, max short term ${lufsText(m.numbers.maxShortTerm)}`;
}

export function measuringText(f: number): string {
  return `measuring ${Math.round(f * 100)}%`;
}

export interface TargetOption { value: string; label: string }

/** off, the four targets, and the saved custom value when it is none of them */
export function targetOptions(l: ExportLoudness): TargetOption[] {
  const out: TargetOption[] = [{ value: 'off', label: 'off' }, ...LOUDNESS_TARGETS.map((t) => ({ value: String(t.lufs), label: t.label }))];
  const t = l.target;
  if (t !== null && !LOUDNESS_TARGETS.some((x) => x.lufs === t)) out.push({ value: String(t), label: `custom ${fix1(t)}` });
  return out;
}

export function targetValue(l: ExportLoudness): string {
  return l.target === null ? 'off' : String(l.target);
}

export function targetFromValue(v: string): number | null {
  if (v === 'off') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
