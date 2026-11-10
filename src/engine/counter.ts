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
  const p = Math.min(1, Math.max(0, local / span));
  const ease = counter.ease ?? 'out';
  const e = ease === 'linear' ? p : ease === 'out' ? 1 - (1 - p) * (1 - p) * (1 - p) : p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  if (p >= 1) return counter.to;
  return counter.from + (counter.to - counter.from) * e;
}

/** a number as the counter shows it: fixed decimals (0..4), optional groups of three, no "-0" */
export function formatCounter(value: number, counter: Pick<TextCounter, 'decimals' | 'separator'>): string {
  const decimals = Math.min(4, Math.max(0, Math.round(counter.decimals || 0)));
  let s = (Number.isFinite(value) ? value : 0).toFixed(decimals);
  if (/^-0(\.0*)?$/.test(s)) s = s.slice(1);
  if (!counter.separator) return s;
  const neg = s.startsWith('-');
  const [whole, frac] = (neg ? s.slice(1) : s).split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + grouped + (frac !== undefined ? '.' + frac : '');
}

/**
 * the text a clip shows at a time (seconds on the timeline). without a counter: clip.text untouched.
 * with one: every "{n}" becomes the number; a text without "{n}" is just the number.
 */
export function counterText(clip: Pick<TextClip, 'text' | 'counter' | 'start' | 'duration'>, time: number): string {
  const counter = clip.counter;
  if (!counter) return clip.text;
  const n = formatCounter(counterValue(counter, time - clip.start, clip.duration), counter);
  return clip.text.includes(COUNTER_TOKEN) ? clip.text.split(COUNTER_TOKEN).join(n) : n;
}

/**
 * the clip as it is drawn at a time: the counter's number written into \`text\` and the counter taken off,
 * so everything after this (layout, caches, signatures, overlays) just sees a plain text clip.
 * a clip without a counter is returned as it is (the same object, no copy).
 */
export function resolveCounter<T extends Pick<TextClip, 'text' | 'counter' | 'start' | 'duration'>>(clip: T, time: number): T {
  if (!clip.counter) return clip;
  return { ...clip, text: counterText(clip, time), counter: null };
}
