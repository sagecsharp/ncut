/** a typed time turned into one plan: go there, step the playhead, move clips or trim the selected edge. pure: no store, no dom */
import type { Project } from '../../types';
import { formatAmount, formatTimeAs, parseTimeEntry } from '../../lib/time';
import type { TimeDisplay } from '../../lib/time';
import { projectDuration } from '../../lib/timelineOps';
import type { TrimEdge } from '../../store/ui';
import { liveEdge } from '../timeline/timeNudge';
import type { NudgePlan, planNudge } from '../timeline/timeNudge';
import { clipLabel, trimStopText } from '../timeline/trimText';
import { REASON_TEXT } from '../shell/reasons';
import { fillEditText } from '../timeline/editText';
import type { edgePlan } from '../timeline/trimModes';
import type { EntryFrom } from './timeEntry';

export type EntryProject = Pick<Project, 'clips' | 'tracks' | 'assets' | 'fps'>;
export interface EntryState {
  project: EntryProject;
  selection: readonly string[];
  edge: TrimEdge | null;
  time: number;
  from: EntryFrom;
  mode: TimeDisplay;
}
/** injected: tests and the parallel package need no real planner */
export interface EntryDeps {
  edgePlan: typeof edgePlan;
  planNudge: typeof planNudge;
}
export type EntryPlan =
  | { kind: 'none'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'seek'; time: number; clamped: boolean; text: string }
  | { kind: 'step'; frames: number; text: string }
  | { kind: 'move'; frames: number; plan: NudgePlan; text: string; blocked: boolean }
  | { kind: 'trim'; frames: number; edge: TrimEdge; text: string; blocked: boolean };

export const ENTRY_TEXT = {
  hint: 'type a time: 1:30:00, 90f or 12.5s. a + or - moves by it',
  hintBy: 'type how much: 15 is 15 frames, 1:00 is one second',
  bad: 'not a time. try 1:30:00, 90f, 12.5s, or +15 to move',
  'frames-whole': 'frames are whole numbers: 12f, not 12.5f',
  'too-far': 'that is more than 24 hours',
  zero: 'less than a frame: nothing would move',
  goTo: 'go to {t}',
  goToEnd: 'go to {t}, the end of the project',
  stepBy: 'move the playhead {amt}',
  stepStart: 'move the playhead {amt}, it stops at the start',
  stepEnd: 'move the playhead {amt}, it stops at the end',
  moveOne: 'move {clip} {amt}',
  moveMany: 'move {n} clips {amt}',
  lockedSuffix: ', locked tracks stay',
  moveBlocked: 'cannot move {amt}: {why}',
  trimEdit: 'move the edit {amt}',
  trimEnd: 'ripple trim the end of {clip} {amt}',
  trimStart: 'ripple trim the start of {clip} {amt}',
  trimBlocked: 'cannot trim {amt}: {why}',
  clamped: 'the project ends at {t}: the playhead went there',
  noField: 'show the preview to type a time',
} as const;

/** replaces each {name} with its value. a name that is not in vars stays as it is */
export const fill = fillEditText;

/** the plan for a typed time. the planners come in as deps, the texts from ENTRY_TEXT */
export function planTimeEntry(text: string, s: EntryState, deps: EntryDeps): EntryPlan {
  const p = s.project;
  const fps = p.fps;
  const parsed = parseTimeEntry(text, fps);
  if (parsed.kind === 'empty') return { kind: 'none', text: parsed.relative ? ENTRY_TEXT.hintBy : ENTRY_TEXT.hint };
  if (parsed.kind === 'error') return { kind: 'error', text: ENTRY_TEXT[parsed.why] };
  const duration = projectDuration(p);
  if (parsed.kind === 'at') {
    const t = parsed.frame / fps;
    if (t > duration + 1e-9) return { kind: 'seek', time: duration, clamped: true, text: fill(ENTRY_TEXT.goToEnd, { t: formatTimeAs(duration, fps, s.mode) }) };
    return { kind: 'seek', time: t, clamped: false, text: fill(ENTRY_TEXT.goTo, { t: formatTimeAs(t, fps, s.mode) }) };
  }
  const frames = parsed.frames;
  const amt = formatAmount(frames, fps, s.mode);
  if (s.from === 'timeline') {
    const e = liveEdge(p, s.edge);
    if (e) {
      const tp = deps.edgePlan(p, e, frames / fps, e.alone ? [e.clipId] : s.selection);
      const clip = clipLabel(p, e.clipId);
      if (!tp || tp.stop || tp.ops.length === 0) {
        const why = tp?.stop ? trimStopText(tp.stop, p) : REASON_TEXT.pickEdge;
        return { kind: 'trim', frames, edge: e, text: fill(ENTRY_TEXT.trimBlocked, { amt, why }), blocked: true };
      }
      const msg = e.both ? ENTRY_TEXT.trimEdit : e.edge === 'end' ? ENTRY_TEXT.trimEnd : ENTRY_TEXT.trimStart;
      const said = fill(msg, { amt, clip });
      return { kind: 'trim', frames, edge: e, text: tp.lockedBehind.length > 0 ? said + ENTRY_TEXT.lockedSuffix : said, blocked: false };
    }
    if (s.selection.length > 0) {
      const plan = deps.planNudge(p, s.selection, frames);
      if (plan.stop || plan.moves.length === 0) {
        const why = plan.stop ? trimStopText(plan.stop, p) : REASON_TEXT.selectClip;
        return { kind: 'move', frames, plan, text: fill(ENTRY_TEXT.moveBlocked, { amt, why }), blocked: true };
      }
      const base = plan.ids.length === 1 ? fill(ENTRY_TEXT.moveOne, { clip: clipLabel(p, plan.ids[0]!), amt }) : fill(ENTRY_TEXT.moveMany, { n: plan.ids.length, amt });
      return { kind: 'move', frames, plan, text: plan.lockedStay.length > 0 ? base + ENTRY_TEXT.lockedSuffix : base, blocked: false };
    }
  }
  const k = Math.round(s.time * fps) + frames;
  const msg = k < 0 ? ENTRY_TEXT.stepStart : k / fps > duration + 1e-9 ? ENTRY_TEXT.stepEnd : ENTRY_TEXT.stepBy;
  return { kind: 'step', frames, text: fill(msg, { amt }) };
}
