/**
 * the keyframe panel's actions: open and close, delete, copy, cut, paste, select all, nudge and ease the selected keyframes.
 * the selection lives in the ui store (keySel). a key that cannot work says why in a toast. never imports nudgeActions
 * or graphActions: they import this file.
 */
import type { Easing } from '../../types';
import { useEditor } from '../../store/editorStore';
import type { ActionOpts } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { KeyRef } from '../../store/ui';
import { captureKeyCopy, getKeyCopy, setKeyCopy } from '../properties/keyClipboard';
import type { KeyCopy } from '../properties/keyClipboard';
import { REASON_TEXT } from '../shell/reasons';
import { useKeyPanel } from './keyPanelState';
import { allKeyRefs, keySelFor, liveKeySel, rememberKeySel, shownKeyClips } from './keySelection';
import { planKeyDelete, planKeyEase, planKeyNudge, planKeyPaste } from './keyPlan';
import type { KeyPlan, KeyStop } from './keyPlan';
import { interaction } from './view';

export { keyPanelHasKeys } from './keyPanelState';

/** set by the keyframe panel while it is mounted */
export const keyPanelCommands: { openMenu?: () => void } = {};

/** the graph sets this: select all keeps only the refs it shows (a hidden line has no selectable key) */
export const keyRefFilter: { shows?: (r: KeyRef) => boolean } = {};

/** true while applyKeyPlan writes: followKeySel leaves its own write alone */
let applying = false;
/** the project the last key nudge made: a repeat joins its step only while nothing else changed it */
let lastKeyNudged: unknown = null;
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

export function openKeyPanel(): void {
  useKeyPanel.getState().setOpen(true);
}

export function closeKeyPanel(): void {
  useKeyPanel.getState().setOpen(false);
  useUi.getState().setKeySel([]);
  useUi.getState().setKeyFocus(false);
}

export function toggleKeyPanel(): void {
  if (useKeyPanel.getState().open) closeKeyPanel();
  else openKeyPanel();
}

/** the ids of the shown clips (the selected ones on unlocked tracks), open or not */
export function shownKeyClipIds(): string[] {
  const st = useEditor.getState();
  return st.project ? shownKeyClips(st.project, st.selection).map((c) => c.id) : [];
}

/** writes the plan in one step and moves the key selection to the plan's. false when nothing changed */
export function applyKeyPlan(plan: KeyPlan, opts?: ActionOpts & { time?: number }): boolean {
  const st = useEditor.getState();
  const before = st.project;
  if (!before || plan.writes.length === 0) return false;
  rememberKeySel(before.clips, useUi.getState().keySel);
  let changed = false;
  applying = true;
  try {
    changed = st.setManyKeyframes(plan.writes, { skipHistory: opts?.skipHistory, time: opts?.time ?? usePlayback.getState().time });
  } finally {
    applying = false;
  }
  const after = useEditor.getState().project;
  if (changed && after) rememberKeySel(after.clips, plan.sel);
  if (useKeyPanel.getState().open) useUi.getState().setKeySel(plan.sel);
  return changed;
}

/** while the panel is open (KeyPanel mounts it): undo and redo bring back that state's key selection, any other change prunes it */
export function followKeySel(): () => void {
  return useEditor.subscribe((s, prev) => {
    if (applying) return;
    const ui = useUi.getState();
    if (!s.project) {
      ui.setKeySel([]);
      return;
    }
    const clipsChanged = s.project.clips !== prev.project?.clips;
    if (!clipsChanged && s.selection === prev.selection) return;
    const from = (clipsChanged ? keySelFor(s.project.clips) : undefined) ?? ui.keySel;
    ui.setKeySel(liveKeySel(s.project, from, new Set(shownKeyClipIds())));
  });
}

/** the live key selection of the shown clips */
function liveSel(): KeyRef[] {
  const p = useEditor.getState().project;
  return p ? liveKeySel(p, useUi.getState().keySel, new Set(shownKeyClipIds())) : [];
}

/** how many keys a copy holds */
function copiedCount(c: KeyCopy): number {
  let n = 0;
  for (const item of c.items) for (const prop in item.keys) n += item.keys[prop]!.length;
  return n;
}

export function deleteKeysNow(): void {
  const p = useEditor.getState().project;
  if (!p || interaction.gestureActive) return;
  const sel = liveSel();
  if (sel.length === 0) {
    toast(REASON_TEXT.selectKeys);
    return;
  }
  const plan = planKeyDelete(p, sel);
  if (applyKeyPlan(plan)) toast(`${plan.amount} ${keyframes(plan.amount)} deleted`);
}

export function copyKeysNow(): void {
  const p = useEditor.getState().project;
  if (!p || interaction.gestureActive) return;
  const sel = liveSel();
  const copy = sel.length === 0 ? null : captureKeyCopy(p, sel);
  if (!copy) {
    toast(REASON_TEXT.selectKeys);
    return;
  }
  setKeyCopy(copy);
  const n = copiedCount(copy);
  toast(`${n} ${keyframes(n)} copied`);
}

export function cutKeysNow(): void {
  const p = useEditor.getState().project;
  if (!p || interaction.gestureActive) return;
  const sel = liveSel();
  const copy = sel.length === 0 ? null : captureKeyCopy(p, sel);
  if (!copy) {
    toast(REASON_TEXT.selectKeys);
    return;
  }
  setKeyCopy(copy);
  const n = copiedCount(copy);
  toast(applyKeyPlan(planKeyDelete(p, sel)) ? `${n} ${keyframes(n)} copied and deleted` : `${n} ${keyframes(n)} copied`);
}

export function pasteKeysNow(): void {
  const p = useEditor.getState().project;
  if (!p || interaction.gestureActive) return;
  const T = REASON_TEXT;
  const copy = getKeyCopy();
  if (!copy) {
    toast(T.copyKeysFirst);
    return;
  }
  const ids = shownKeyClipIds();
  if (ids.length === 0) {
    toast(T.selectClip);
    return;
  }
  const plan = planKeyPaste(p, copy, ids, usePlayback.getState().time);
  if (plan.outside) {
    toast(T.playheadOnClip);
    return;
  }
  if (plan.pasted === 0) {
    toast(T.keysNotHere);
    return;
  }
  if (!applyKeyPlan(plan)) return;
  let text = `${plan.pasted} ${keyframes(plan.pasted)} pasted`;
  if (plan.clips > 1) text += ` on ${plan.clips} clips`;
  if (plan.leftOut.length > 0) text += `. left out: ${plan.leftOut.join(', ')}, the clip cannot animate them`;
  if (plan.capped) text += '. only 240 keyframes fit in one value';
  toast(text);
}

export function selectAllKeysNow(): void {
  const p = useEditor.getState().project;
  if (!p || interaction.gestureActive) return;
  const ids = shownKeyClipIds();
  if (ids.length === 0) {
    toast(REASON_TEXT.selectClip);
    return;
  }
  const shows = keyRefFilter.shows;
  const refs = shows ? allKeyRefs(p, ids).filter(shows) : allKeyRefs(p, ids);
  if (refs.length === 0) {
    toast(REASON_TEXT.noKeys);
    return;
  }
  if (!useKeyPanel.getState().open) openKeyPanel();
  useUi.getState().setKeySel(refs);
}

/** false when nothing was selected, else the selection is gone */
export function clearKeySel(): boolean {
  if (useUi.getState().keySel.length === 0) return false;
  useUi.getState().setKeySel([]);
  return true;
}

/** the text of a plan that stopped short or was refused */
export function keyStopText(stop: KeyStop): string {
  const T = REASON_TEXT;
  switch (stop.kind) {
    case 'start':
      return T.keysAtStart;
    case 'end':
      return T.keysAtEnd;
    case 'inTheWay':
      return T.keyInTheWay;
    case 'locked':
      return T.trackLocked;
    case 'valueMin':
      return T.keysAtValueMin;
    case 'valueMax':
      return T.keysAtValueMax;
    case 'noHandles':
      return T.noHandles;
  }
}

/** alt + arrows in the keyframe panel: the selected keyframes go by frames. a held key joins the step of the press before */
export function nudgeKeysBy(frames: number, repeat = false): void {
  const p = useEditor.getState().project;
  if (!p || interaction.gestureActive) return;
  const sel = liveSel();
  if (sel.length === 0) {
    toastOnce(REASON_TEXT.selectKeys);
    return;
  }
  const plan = planKeyNudge(p, sel, frames);
  if (plan.stop) {
    toastOnce(keyStopText(plan.stop));
    return;
  }
  if (applyKeyPlan(plan, { skipHistory: repeat && lastKeyNudged === p })) lastKeyNudged = useEditor.getState().project;
}

/** the selected keyframes get this ease. nothing to change: nothing happens */
export function setKeysEaseNow(ease: Easing): void {
  const p = useEditor.getState().project;
  if (!p || interaction.gestureActive) return;
  const sel = liveSel();
  if (sel.length === 0) {
    toast(REASON_TEXT.selectKeys);
    return;
  }
  const plan = planKeyEase(p, sel, ease);
  if (plan.amount === 0) return;
  applyKeyPlan(plan);
}
