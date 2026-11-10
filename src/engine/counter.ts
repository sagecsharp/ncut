/**
 * the running number of a text clip (TextClip.counter). pure: no dom, no canvas.
 * the frame renderer asks counterText(clip, time) for the string to draw.
 */
import type { TextClip, TextCounter } from '../types';

/** the placeholder in a clip's text that the number replaces */
export const COUNTER_TOKEN = '{n}';

export const DEFAULT_COUNTER: TextCounter = { from: 0, to: 100, decimals: 0, separator: false, ease: 'out', hold: 0 };

/** true when the clip has a counter */
export function hasCounter(clip: Pick<TextClip, 'counter'>): boolean {
  return !!clip.counter;
}

/**
 * the number at a time. local = seconds since the clip's start, duration = the clip's length.
 * before the start it is `from`, from (duration - hold) on it is exactly `to`.
 */
export function counterValue(counter: TextCounter, local: number, duration: number): number {
  const span = Math.max(1e-6, duration - Math.max(0, counter.hold ?? 0));
  const p = Number.isFinite(local) ? Math.min(1, Math.max(0, local / span)) : 0;
  const ease = counter.ease ?? 'out';
  const e = ease === 'linear' ? p : ease === 'out' ? 1 - (1 - p) * (1 - p) * (1 - p) : p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  if (p >= 1) return counter.to;
  return counter.from + (counter.to - counter.from) * e;
}

/** a [start, end) range of letters (code points) of a resolved text that is the counter's number */
export type DigitRange = [number, number];

/**
 * the small marker resolveCounter leaves on the resolved copy of a clip with fixedWidth: where the number sits in
 * the text, so the layout can give its digits equal cells. never stored in a project (the copy is only drawn).
 */
export interface CounterMark {
  digitRanges?: DigitRange[];
}

const DAY_GUARD = 1e9;

/** whole seconds + a fraction to hh:mm:ss form. `q` is the value in units of 10^-decimals, already on the grid. */
function timeString(q: number, decimals: number): string {
  const neg = q < 0;
  const a = Math.abs(q);
  const unit = Math.pow(10, decimals);
  const total = Math.floor(a / unit);
  const frac = a - total * unit;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const two = (n: number) => (n < 10 ? '0' + n : String(n));
  let s = h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
  if (decimals > 0) s += '.' + String(frac).padStart(decimals, '0');
  return neg && a > 0 ? '-' + s : s;
}

/**
 * a time (seconds) as the counter shows it. counting up it is floored to the shown precision (a stopwatch shows
 * 0:09 until ten seconds are really there), counting down (from > to) it is rounded up (a countdown shows 0:10
 * until the first second has passed and reaches 0:00 exactly when the value reaches 0, not early). the 1e-9 slack
 * keeps float noise (8.999999999 for 9) from tipping a whole second.
 */
function formatTime(value: number, decimals: number, down: boolean): string {
  const unit = Math.pow(10, decimals);
  const v = Math.max(-DAY_GUARD, Math.min(DAY_GUARD, value));
  const q = down ? Math.ceil(v * unit - 1e-9) : Math.floor(v * unit + 1e-9);
  return timeString(q === 0 ? 0 : q, decimals);
}

/**
 * a number as the counter shows it: fixed decimals (0..4), optional groups of three, no "-0".
 * format 'time' writes the value as seconds (m:ss, h:mm:ss) and ignores the separator. from / to (optional) tell
 * a count down from a count up for the rounding of a time.
 */
export function formatCounter(
  value: number,
  counter: Pick<TextCounter, 'decimals' | 'separator'> & Partial<Pick<TextCounter, 'format' | 'from' | 'to'>>,
): string {
  const decimals = Math.min(4, Math.max(0, Math.round(counter.decimals || 0)));
  const val = Number.isFinite(value) ? value : 0;
  if (counter.format === 'time') return formatTime(val, decimals, counter.from !== undefined && counter.to !== undefined && counter.from > counter.to);
  let s = val.toFixed(decimals);
  if (/^-0(\.0*)?$/.test(s)) s = s.slice(1);
  if (!counter.separator) return s;
  const neg = s.startsWith('-');
  const [whole, frac] = (neg ? s.slice(1) : s).split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + grouped + (frac !== undefined ? '.' + frac : '');
}

function cpLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** where the number `n` sits in the resolved text (code points): at every "{n}" of the template, or the whole text */
export function digitRangesOf(template: string, n: string): DigitRange[] {
  const len = cpLength(n);
  if (!template.includes(COUNTER_TOKEN)) return [[0, len]];
  const out: DigitRange[] = [];
  let pos = 0;
  for (const [i, part] of template.split(COUNTER_TOKEN).entries()) {
    if (i > 0) {
      out.push([pos, pos + len]);
      pos += len;
    }
    pos += cpLength(part);
  }
  return out;
}

/**
 * the text a clip shows at a time (seconds on the timeline). without a counter: clip.text untouched.
 * with one: every "{n}" becomes the number; a text without "{n}" is just the number.
 */
export function counterText(clip: Pick<TextClip, 'text' | 'counter' | 'start' | 'duration'>, time: number): string {
  const counter = clip.counter;
  if (!counter) return clip.text;
  const n = formatCounter(counterValue(counter, time - clip.start + (counter.offset ?? 0), counter.fullDuration ?? clip.duration), counter);
  return clip.text.includes(COUNTER_TOKEN) ? clip.text.split(COUNTER_TOKEN).join(n) : n;
}

/**
 * the clip as it is drawn at a time: the counter's number written into `text` and the counter taken off,
 * so everything after this (layout, caches, signatures, overlays) just sees a plain text clip.
 * a clip without a counter is returned as it is (the same object, no copy).
 */
export function resolveCounter<T extends Pick<TextClip, 'text' | 'counter' | 'start' | 'duration'>>(clip: T, time: number): T {
  if (!clip.counter) return clip;
  const counter = clip.counter;
  const n = formatCounter(counterValue(counter, time - clip.start + (counter.offset ?? 0), counter.fullDuration ?? clip.duration), counter);
  const text = clip.text.includes(COUNTER_TOKEN) ? clip.text.split(COUNTER_TOKEN).join(n) : n;
  const out = { ...clip, text, counter: null } as T & CounterMark;
  // steady digits: leave where the number sits for the layout (a copy-only field, never stored)
  if (counter.fixedWidth) out.digitRanges = digitRangesOf(clip.text, n);
  return out;
}
