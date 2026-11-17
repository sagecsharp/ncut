/**
 * the numbers of a trim drag (trim 4.4, S9): whole frames, snapping, the readout text and the plan a press asks for. pure.
 */
import { isTimedClip } from '../../types';
import { formatAmount, formatTimecode } from '../../lib/time';
import { planMoveEdit, planRipple, planSlide, planSlip, planStretch } from './trimModes';
import type { P, TrimPlan, TrimStop } from './trimModes';
import { trimStopText } from './trimText';
import type { TrimPress } from './trimPress';

/** an amount of seconds as frames, or timecode from a second on. always timecode style, in every display mode */
export function formatTrimDelta(s: number, fps: number): string {
  return formatAmount(Math.round(s * fps), fps, 'timecode');
}

/**
 * the pointer moved raw seconds: whole frames, unless an edge (at its place plus raw) lands within threshold of a point,
 * then the nearest point wins and the delta puts that edge on it.
 */
export function dragDelta(a: { raw: number; fps: number; edges: readonly number[]; points: readonly number[]; threshold: number }): { delta: number; snap: number | null } {
  let best = Infinity;
  let delta = 0;
  let snap: number | null = null;
  for (const e of a.edges) {
    const at = e + a.raw;
    for (const q of a.points) {
      const d = Math.abs(q - at);
      if (d <= a.threshold && d < best) {
        best = d;
        delta = q - e;
        snap = q;
      }
    }
  }
  if (snap !== null) return { delta: delta + 0, snap };
  return { delta: Math.round(a.raw * a.fps) / a.fps + 0, snap: null };
}

/** the text above the grabbed clip while it drags. stop and locked tracks end it */
export function readoutText(plan: TrimPlan, stop: TrimStop | null, p: P, clipId: string, fps: number): string {
  const fmt = formatTrimDelta(plan.delta, fps);
  const clip = p.clips.find((c) => c.id === clipId);
  const length = formatTimecode(clip ? clip.duration : 0, fps);
  const timed = clip && isTimedClip(clip) ? clip : null;
  let text: string;
  switch (plan.mode) {
    case 'ripple':
      text = `ripple ${fmt}, length ${length}`;
      break;
    case 'move-edit':
      text = `move the edit ${fmt}`;
      break;
    case 'slip':
      text = `slip ${fmt}, first frame at ${formatTimecode(plan.trimStart ?? (timed ? timed.trimStart : 0), fps)} of the media`;
      break;
    case 'slide':
      text = `slide ${fmt}`;
      break;
    case 'stretch':
      text = `stretch ${(plan.speed ?? (timed ? timed.speed : 1)).toFixed(2)}x, length ${length}`;
      break;
  }
  if (stop) text += `, stops: ${trimStopText(stop, p)}`;
  if (plan.lockedBehind.length > 0) text += ', locked tracks stay';
  return text;
}

/** the plan of the press for a pointer delta (timeline seconds, + = right). null for a plain move or a clip that is gone */
export function planFor(press: TrimPress, p: P, delta: number, pool: readonly string[]): TrimPlan | null {
  const clip = p.clips.find((c) => c.id === press.clipId);
  if (!clip) return null;
  switch (press.mode) {
    case 'ripple':
      return press.edge ? planRipple(p, press.clipId, press.edge, delta, pool) : null;
    case 'stretch':
      return press.edge ? planStretch(p, press.clipId, press.edge, delta, pool) : null;
    case 'move-edit': {
      const { leftId, rightId } = press;
      if (leftId === undefined || rightId === undefined) return null;
      if (!p.clips.some((c) => c.id === leftId) || !p.clips.some((c) => c.id === rightId)) return null;
      return planMoveEdit(p, leftId, rightId, delta, pool);
    }
    case 'slip':
      // the media moves with the pointer, so the first frame comes from earlier media
      return planSlip(p, press.clipId, -delta * (isTimedClip(clip) ? clip.speed : 1) + 0, pool);
    case 'slide':
      return planSlide(p, press.clipId, delta, pool);
    default:
      return null;
  }
}
