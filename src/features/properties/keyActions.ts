import { animProps, evalKeys, valueAt } from '../../lib/anim';
import { shiftGrid } from '../../lib/tempo';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { Clip, Keyframe, Keyframes } from '../../types';
import { beatSources } from '../timeline/tempoActions';
import { type BeatKeysError, fitKeysToBeats, loopKeysOnBeats, sameKeys, snapKeysToGrid } from './beatKeys';
import { captureKeys, getKeyClip, placeKeys, setKeyClip } from './keyClipboard';
import { fitKeys, repeatKeys, repeatTooBig, reverseKeys, wiggleKeys, wiggleOnto } from './keyTools';

const toast = (msg: string, kind?: 'info' | 'error') => useUi.getState().toast(msg, kind);

/** the clip when it exists and its track is unlocked, else null (with a toast that says why) */
function editable(id: string): Clip | null {
  const p = useEditor.getState().project;
  const clip = p?.clips.find((c) => c.id === id);
  if (!p || !clip) return null;
  if (p.tracks.find((t) => t.id === clip.trackId)?.locked) {
    toast('this track is locked', 'info');
    return null;
  }
  return clip;
}

function same(a: Keyframe[] | undefined, b: Keyframe[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i]!.t !== y[i]!.t || x[i]!.v !== y[i]!.v || x[i]!.ease !== y[i]!.ease) return false;
  return true;
}

/** true when the two keyframes records differ in any key */
function differs(a: Keyframes | undefined, b: Keyframes): boolean {
  const old = a ?? {};
  const props = new Set([...Object.keys(old), ...Object.keys(b)]);
  for (const p of props) if (!same(old[p], b[p])) return true;
  return false;
}

/**
 * write the keys of some properties as ONE store call (setClipKeyframes) and so one undo step.
 * `next` holds the properties to replace, the others keep their keys. returns false when nothing changed.
 */
function writeKeys(clip: Clip, next: Keyframes): boolean {
  const props = Object.keys(next).filter((p) => !same(clip.keyframes?.[p], next[p]));
  if (props.length === 0) return false;
  const now = clamp(usePlayback.getState().time, clip.start, clip.start + clip.duration);
  useEditor.getState().setClipKeyframes(clip.id, { ...clip.keyframes, ...next }, { time: now });
  return true;
}

/** replace ALL keys of the clip with `next` (properties missing from `next` lose their keys and keep their value at the playhead) */
function replaceAll(clip: Clip, next: Keyframes): boolean {
  const old = clip.keyframes ?? {};
  const gone = Object.keys(old).some((p) => old[p]!.length > 0 && !(p in next));
  if (!gone && !differs(clip.keyframes, next)) return false;
  const now = clamp(usePlayback.getState().time, clip.start, clip.start + clip.duration);
  useEditor.getState().setClipKeyframes(clip.id, next, { time: now });
  return true;
}

export function hasKeys(clip: Clip): boolean {
  return !!clip.keyframes && Object.values(clip.keyframes).some((k) => k.length > 0);
}

function transform(id: string, label: string, fn: (kf: Keyframes, clip: Clip) => Keyframes): void {
  const clip = editable(id);
  if (!clip) return;
  if (!hasKeys(clip)) {
    toast('no keyframes to change', 'info');
    return;
  }
  const next = fn(clip.keyframes!, clip);
  if (replaceAll(clip, next)) toast(label);
  else toast('nothing changed', 'info');
}

export function reverseKeysAction(id: string): void {
  transform(id, 'keyframes reversed', (kf, clip) => reverseKeys(kf, clip.duration));
}

export function fitKeysAction(id: string): void {
  transform(id, 'keyframes fit to the clip', (kf, clip) => fitKeys(kf, 0, clip.duration));
}

export function repeatKeysAction(id: string, pingPong: boolean): void {
  const kf = useEditor.getState().project?.clips.find((c) => c.id === id)?.keyframes;
  if (kf && repeatTooBig(kf, 2)) {
    toast('too many keyframes to repeat again', 'info');
    return;
  }
  transform(id, pingPong ? 'keyframes repeated, ping pong' : 'keyframes repeated x2', (kf) => repeatKeys(kf, 2, pingPong));
}

export interface WiggleChoice {
  prop: string;
  label: string;
}

/** the properties wiggle offers for a clip */
export function wiggleProps(clip: Clip): WiggleChoice[] {
  const all = animProps(clip);
  if (clip.type === 'video' || clip.type === 'image' || clip.type === 'text' || clip.type === 'shape') {
    const want = ['x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY'];
    if (clip.threeD) want.push('z', 'rotX', 'rotY');
    return want.map((p) => all.find((a) => a.prop === p)).filter((a) => !!a).map((a) => ({ prop: a!.prop, label: a!.label }));
  }
  return all.map((a) => ({ prop: a.prop, label: a.label }));
}

/** a sensible starting amount for a property (in its own unit) */
export function wiggleDefault(clip: Clip, prop: string): number {
  const info = animProps(clip).find((a) => a.prop === prop);
  // scale is a factor around 1: a tenth is a visible shake, more would collapse the clip
  if (prop === 'scale' || prop === 'scaleX' || prop === 'scaleY' || prop === 'scaleZ') return 0.1;
  if (info?.unit === 'px') return 20;
  if (info?.unit === 'deg') return 5;
  if (info && info.max !== undefined && info.min !== undefined) return Math.round((info.max - info.min) * 10) / 100;
  return 1;
}

export function wiggleAction(id: string, prop: string, amount: number, perSecond: number): void {
  const clip = editable(id);
  if (!clip) return;
  if (!animProps(clip).some((a) => a.prop === prop)) {
    toast('this clip cannot animate that', 'info');
    return;
  }
  const at = clamp(usePlayback.getState().time, clip.start, clip.start + clip.duration);
  const base = valueAt(clip, prop, at);
  if (base === undefined || !Number.isFinite(amount) || !Number.isFinite(perSecond)) {
    toast('cannot wiggle that', 'info');
    return;
  }
  const old = clip.keyframes?.[prop];
  const animated = !!old && old.length > 0;
  // an animation that is already there is kept: the shake rides on top of it (each wiggle key = the curve there + the shake)
  let keys = wiggleKeys(animated ? 0 : base, { amount, perSecond: clamp(perSecond, 1, 12), from: 0, to: clip.duration, seed: Math.floor(Math.random() * 1e9) });
  if (animated) {
    const onto = wiggleOnto(old, keys, clip.duration);
    if (!onto) {
      toast('too many keyframes here to add a wiggle', 'info');
      return;
    }
    keys = onto;
  }
  if (writeKeys(clip, { [prop]: keys })) toast(animated ? `wiggle added on top of the animation, ${keys.length} keys` : `wiggle added, ${keys.length} keys`);
}

export function copyKeysAction(id: string): void {
  const clip = useEditor.getState().project?.clips.find((c) => c.id === id);
  const data = clip ? captureKeys(clip.keyframes) : null;
  if (!data) {
    toast('no keyframes to copy', 'info');
    return;
  }
  setKeyClip(data);
  toast('keys copied');
}

export function pasteKeysAction(id: string): void {
  const copied = getKeyClip();
  const clip = editable(id);
  if (!clip) return;
  if (!copied) {
    toast('nothing to paste here', 'info');
    return;
  }
  const at = usePlayback.getState().time - clip.start;
  if (at < -1e-6 || at > clip.duration + 1e-6) {
    toast('move the playhead onto the clip first: the keys start there', 'info');
    return;
  }
  const placed = placeKeys(copied, clip, at);
  const n = Object.values(placed).reduce((s, k) => s + k.length, 0);
  if (n === 0) {
    toast('nothing to paste here', 'info');
    return;
  }
  // the pasted keys replace what lay in their own time span, older keys before and after it stay
  const merged: Keyframes = {};
  for (const prop of Object.keys(placed)) {
    const fresh = placed[prop]!;
    const lo = fresh[0]!.t;
    const hi = fresh[fresh.length - 1]!.t;
    const old = (clip.keyframes?.[prop] ?? []).filter((k) => k.t < lo - 1e-6 || k.t > hi + 1e-6);
    merged[prop] = [...old, ...fresh].sort((a, b) => a.t - b.t);
  }
  if (!writeKeys(clip, merged)) {
    toast('these keys are already here', 'info');
    return;
  }
  const written = Object.keys(placed).reduce((s, prop) => s + placed[prop]!.length, 0);
  toast(`${written} key${written === 1 ? '' : 's'} pasted`);
}

/* ---------- on the beat ---------- */

const BEAT_ERRORS: Record<BeatKeysError, string> = {
  'no keys': 'no keyframes to change',
  'one moment': 'that needs keyframes at two different times',
  'no beat': 'no beat falls inside this clip',
  'too many': 'too many keyframes: loop over more beats',
};

/** the beat grid of `sourceId` in the clip's own time, null (with a toast) when that clip has no tempo any more */
function localGrid(clip: Clip, sourceId: string) {
  const p = useEditor.getState().project;
  const source = p ? beatSources(p, clip).find((s) => s.id === sourceId) : undefined;
  if (!source) {
    toast('set a bpm on a clip with sound first', 'info');
    return null;
  }
  return shiftGrid(source.grid, clip.start);
}

const beatWord = (n: number) => (n === 0.5 ? 'half a beat' : n === 1 ? 'beat' : `${n} beats`);

/** every keyframe of the clip moves to the nearest beat line (perBeat 1 = beats, 2 = half beats, 4 = quarter beats) */
export function snapKeysToBeatAction(id: string, sourceId: string, perBeat: number): void {
  const clip = editable(id);
  if (!clip) return;
  if (!hasKeys(clip)) {
    toast('no keyframes to change', 'info');
    return;
  }
  const grid = localGrid(clip, sourceId);
  if (!grid) return;
  const r = snapKeysToGrid(clip.keyframes!, grid, perBeat, clip.duration);
  if (r.moved === 0 || !replaceAll(clip, r.keys)) {
    toast('the keyframes are on the beat already', 'info');
    return;
  }
  toast(`${r.moved} ${r.moved === 1 ? 'keyframe' : 'keyframes'} moved onto the beat`);
}

/** the whole animation starts on a beat and lasts exactly `beats` beats */
export function fitKeysToBeatAction(id: string, sourceId: string, beats: number): void {
  const clip = editable(id);
  if (!clip) return;
  const grid = localGrid(clip, sourceId);
  if (!grid) return;
  const r = fitKeysToBeats(clip.keyframes ?? {}, grid, beats, clip.duration);
  if (typeof r === 'string') {
    toast(BEAT_ERRORS[r], 'info');
    return;
  }
  if (replaceAll(clip, r.keys)) toast(`keyframes fit to ${beatWord(beats)}`);
  else toast('nothing changed', 'info');
}

/** the animation starts on a beat and its first `beats` beats repeat until the clip ends */
export function loopKeysOnBeatAction(id: string, sourceId: string, beats: number, pingPong: boolean): void {
  const clip = editable(id);
  if (!clip) return;
  const grid = localGrid(clip, sourceId);
  if (!grid) return;
  const r = loopKeysOnBeats(clip.keyframes ?? {}, grid, beats, clip.duration, pingPong);
  if (typeof r === 'string') {
    toast(BEAT_ERRORS[r], 'info');
    return;
  }
  // pressed again on its own result: nothing to write (the times only differ in their last bits)
  if (!sameKeys(clip.keyframes ?? {}, r.keys) && replaceAll(clip, r.keys)) toast(`looping every ${beatWord(beats)}${pingPong ? ', ping pong' : ''}: ${r.rounds} ${r.rounds === 1 ? 'round' : 'rounds'}`);
  else toast('it loops like that already', 'info');
}
