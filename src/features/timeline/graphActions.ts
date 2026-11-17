/**
 * the graph's actions: ease and join the selected keyframes, step their values, add a key on a line, switch the view and fit it.
 * the selection and the panel come from keyLaneActions (which never imports this file).
 */
import type { Project } from '../../types';
import type { EaseKind } from '../../lib/keyBezier';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { feelForProp } from '../properties/feelForProp';
import { REASON_TEXT } from '../shell/reasons';
import { applyKeyPlan, keyStopText, openKeyPanel, shownKeyClipIds } from './keyLaneActions';
import { useGraph } from './graphState';
import type { GraphKind } from './graphState';
import { planAddKey, planEase, planJoin, planValueStep } from './graphPlan';
import { useKeyPanel } from './keyPanelState';
import { laneId, liveKeySel } from './keySelection';
import { resolveKeySel } from './keyPlan';
import type { KeyRef } from '../../store/ui';
import { interaction } from './view';

/** set by the graph while it is mounted */
export const graphCommands: { frameAll?(): void; frameSelected?(): void } = {};

/** the project the last value step made: a repeat joins its step only while nothing else changed it */
let lastStepped: Project | null = null;
/** the toast shown last, and when */
let lastToast: { text: string; at: number } | null = null;

/** a toast's life, ms */
const TOAST_LIFE = 3000;

/** a held key toasts once: the same text again within 3000 ms is dropped */
function toastOnce(message: string): void {
  const now = Date.now();
  if (lastToast && lastToast.text === message && now - lastToast.at < TOAST_LIFE) return;
  lastToast = { text: message, at: now };
  useUi.getState().toast(message);
}

const toast = (message: string): void => useUi.getState().toast(message);
const keyframes = (n: number): string => `keyframe${n === 1 ? '' : 's'}`;

/** the project and the live key selection, or null after saying why not */
function target(say: (message: string) => void = toast): { p: Project; sel: KeyRef[] } | null {
  const p = useEditor.getState().project;
  if (!p || interaction.gestureActive) return null;
  if (!useKeyPanel.getState().open) {
    say(REASON_TEXT.openKeyPanel);
    return null;
  }
  const sel = liveKeySel(p, useUi.getState().keySel, new Set(shownKeyClipIds()));
  if (sel.length === 0) {
    say(REASON_TEXT.selectKeys);
    return null;
  }
  return { p, sel };
}

/** easy ease, ease into or ease out of the selected keyframes */
export function easeKeysNow(kind: EaseKind): void {
  const t = target();
  if (!t) return;
  const plan = planEase(t.p, t.sel, kind);
  if (plan.stop) {
    toast(keyStopText(plan.stop));
    return;
  }
  if (plan.amount === 0) {
    toast(plan.holds > 0 ? 'the selected keyframes sit next to holds: a hold has no handles' : REASON_TEXT.easeNothing);
    return;
  }
  if (!applyKeyPlan(plan)) return;
  toast(`${plan.amount} ${keyframes(plan.amount)} eased` + (plan.holds > 0 ? `. ${plan.holds} next to a hold kept as they are` : ''));
}

/** the two handles of each selected keyframe become one line */
export function joinHandlesNow(): void {
  const t = target();
  if (!t) return;
  const plan = planJoin(t.p, t.sel);
  if (plan.stop) {
    toast(keyStopText(plan.stop));
    return;
  }
  if (plan.amount === 0) {
    toast(REASON_TEXT.noHandles);
    return;
  }
  if (applyKeyPlan(plan)) toast(`${plan.amount} ${keyframes(plan.amount)} joined`);
}

/** alt + up and down: the selected keyframes go up or down by steps of their value's feel. a held key joins the step before */
export function stepKeyValuesBy(steps: number, repeat = false): void {
  const t = target(toastOnce);
  if (!t) return;
  const step = new Map<string, number>();
  for (const { clip, props } of resolveKeySel(t.p, t.sel).values()) {
    for (const prop of props.keys()) {
      const f = feelForProp(prop, clip);
      step.set(laneId(clip.id, prop), f.step / f.scale);
    }
  }
  const plan = planValueStep(t.p, t.sel, steps, step);
  if (plan.stop) {
    toastOnce(keyStopText(plan.stop));
    return;
  }
  if (plan.writes.length === 0) return;
  if (applyKeyPlan(plan, { skipHistory: repeat && lastStepped === t.p })) lastStepped = useEditor.getState().project;
}

/** a key on a line of the graph at clip time t */
export function addKeyOnLine(clipId: string, prop: string, t: number): void {
  const p = useEditor.getState().project;
  if (!p || interaction.gestureActive) return;
  if (!useKeyPanel.getState().open) {
    toast(REASON_TEXT.openKeyPanel);
    return;
  }
  const plan = planAddKey(p, clipId, prop, t);
  if (plan.stop) {
    toast(keyStopText(plan.stop));
    return;
  }
  applyKeyPlan(plan);
}

/** closed: opens in the graph. open: graph and rows swap */
export function toggleGraphView(): void {
  const kp = useKeyPanel.getState();
  if (!kp.open) {
    kp.setMode('graph');
    openKeyPanel();
    return;
  }
  kp.setMode(kp.mode === 'graph' ? 'keys' : 'graph');
}

/** the graph shows, the panel opens, and the kind changes when one is given */
export function showGraph(kind?: GraphKind): void {
  useKeyPanel.getState().setMode('graph');
  openKeyPanel();
  if (kind) useGraph.getState().setKind(kind);
}

/** every line fits the plot, and it keeps fitting */
export function fitGraphAll(): void {
  showGraph();
  const g = useGraph.getState();
  g.setAutoFit(true);
  if (graphCommands.frameAll) graphCommands.frameAll();
  else g.setPendingFit('all');
}

/** the plot frames the selected keyframes, none selected: every line. auto fit stays as it is */
export function fitGraphSelected(): void {
  showGraph();
  if (graphCommands.frameSelected) graphCommands.frameSelected();
  else useGraph.getState().setPendingFit('selected');
}

export function toggleAutoFit(): void {
  const g = useGraph.getState();
  g.setAutoFit(!g.autoFit);
}
