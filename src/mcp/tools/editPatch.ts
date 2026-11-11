/**
 * the shared patch code of update_clip and the `fields` of the add tools. one place decides which store action
 * gets which field, so the two never disagree. every call here writes with the given opts (oneStep's skipHistory).
 */
import { getEffect } from '../../engine/effects/registry';
import { useEditor, type ActionOpts, type ClipPatch } from '../../store/editorStore';
import type { Clip, Transform } from '../../types';
import { isTimedClip, isVisualClip, MAX_SCALE, MAX_SPEED, MIN_SCALE, MIN_SPEED } from '../../types';
import { needClip, needProject, needTrack, needUnlocked, oneStep, ToolError } from '../helpers';
import { checkField, checkNumber, knowsField } from './editCheck';

/** the longest time a tool takes: a day. a bigger one would make a timeline nobody can use */
export const MAX_TIME = 86400;

/** fields that have a tool of their own: update_clip refuses them and names the tool */
const OTHER_TOOL: Record<string, string> = {
  id: 'a clip id never changes',
  type: 'a clip never changes its type',
  trackId: 'move_clip (its track argument)',
  start: 'move_clip',
  duration: 'trim_clip (the end edge)',
  trimStart: 'trim_clip (the start edge)',
  keyframes: 'set_keyframe / set_keyframes / clear_keyframes',
  faces: 'set_sides',
  assetId: 'replace_media (it checks the kind and fixes the length)',
  group: 'group_clips / ungroup_clips',
  effect: 'add_effect (the effect of a clip cannot change: make a new effect clip)',
};

/** transform fields with a range (the store clamps these, so a value outside is refused instead of changed). the rest: any finite number */
const TRANSFORM_RANGE: Record<string, [number, number]> = {
  scale: [MIN_SCALE, MAX_SCALE],
  scaleX: [MIN_SCALE, MAX_SCALE],
  scaleY: [MIN_SCALE, MAX_SCALE],
  scaleZ: [MIN_SCALE, MAX_SCALE],
  opacity: [0, 1],
};

const TRANSFORM_KEYS = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'scaleZ', 'rotation', 'opacity', 'z', 'rotX', 'rotY'] as const;

/** several store actions as ONE undo step. when `run` throws, what it wrote so far is taken back */
export function step<T>(run: (opts: ActionOpts) => T): T {
  try {
    return oneStep(run);
  } catch (e) {
    useEditor.getState().rollback();
    throw e;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function same(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** a value that cannot be what the clip stores there (a string where a number lives): the client gets told before anything is written */
function checkKind(key: string, current: unknown, value: unknown): void {
  if (value === null || current === undefined || current === null) return;
  if (Array.isArray(current)) {
    if (!Array.isArray(value)) throw new ToolError(`${key} must be an array`);
    return;
  }
  if (typeof current === 'object') {
    if (!isObject(value)) throw new ToolError(`${key} must be an object (or null to take it away)`);
    return;
  }
  if (typeof value !== typeof current) throw new ToolError(`${key} must be a ${typeof current}, got ${Array.isArray(value) ? 'array' : typeof value}`);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new ToolError(`${key} must be a finite number`);
}

/** a clip id chain that loops back to the clip would make a parent loop: the store drops it silently */
function checkParent(clip: Clip, value: unknown): void {
  if (value === null) return;
  if (typeof value !== 'string') throw new ToolError('parent must be a clip id or null');
  const clips = needProject().clips;
  const target = clips.find((c) => c.id === value);
  if (!target) throw new ToolError(`parent: no clip with the id ${value}. get_project lists the clips`);
  if (!isVisualClip(target) && target.type !== 'camera') throw new ToolError('parent must be a video, image, text, shape or camera clip');
  for (let cur: Clip | undefined = target, guard = 0; cur && guard < 1000; guard++) {
    if (cur.id === clip.id) throw new ToolError(`parent: ${value} is this clip or hangs on it, that would make a loop`);
    const next: unknown = (cur as { parent?: unknown }).parent;
    cur = typeof next === 'string' ? clips.find((c) => c.id === next) : undefined;
  }
}

/** the keyframe names a plain field stands for: itself, or parent.key for every key of an object the patch gives (null: the whole object, so every keyed prop under it) */
function touchedBy(out: string[], key: string, value: unknown): void {
  if (isObject(value)) for (const k of Object.keys(value)) out.push(`${key}.${k}`);
  else if (value === null) out.push(`${key}.*`);
  else out.push(key);
}

/**
 * apply a patch to one clip. returns the names of the fields that changed (it can be empty: every value was
 * already what it is, or was clamped to it). throws a ToolError for anything that cannot be done, BEFORE the
 * first write wherever that can be told in advance; a caller inside step() takes back the rest.
 */
export function applyPatch(id: string, patch: Record<string, unknown>, opts: ActionOpts): string[] {
  const before = needClip(id);
  needUnlocked(before);
  const st = useEditor.getState();

  const rest: Record<string, unknown> = {};
  let transform: Record<string, unknown> | undefined;
  let params: Record<string, unknown> | undefined;
  let speed: unknown;
  // the keyframe names of every property this patch sets
  const touched: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key in OTHER_TOOL) throw new ToolError(`${key} cannot be set here: use ${OTHER_TOOL[key]}`);
    if (key === 'transform') {
      if (!isVisualClip(before)) throw new ToolError(`a ${before.type} clip has no transform (only video, image, text and shape clips do)`);
      if (!isObject(value)) throw new ToolError('transform must be an object like { "x": 100, "scale": 1.5 }');
      for (const [k, v] of Object.entries(value)) {
        if (!(TRANSFORM_KEYS as readonly string[]).includes(k)) throw new ToolError(`transform.${k} is not a transform field (known: ${TRANSFORM_KEYS.join(', ')})`);
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolError(`transform.${k} must be a number`);
        const range = TRANSFORM_RANGE[k];
        if (range) checkNumber(v, `transform.${k}`, range[0], range[1]);
        touched.push(k);
      }
      transform = value;
      continue;
    }
    if (key === 'params') {
      if (before.type !== 'effect') throw new ToolError('params only exist on effect clips');
      if (!isObject(value)) throw new ToolError('params must be an object of numbers like { "radius": 12 }');
      const def = getEffect(before.effect);
      if (!def) throw new ToolError(`the effect ${before.effect} is not known to this version of the app`);
      const keys = def.params.map((p) => p.key);
      for (const [k, v] of Object.entries(value)) {
        if (!keys.includes(k)) throw new ToolError(`the effect ${def.id} has no param ${k} (it has: ${keys.join(', ') || 'none'})`);
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolError(`params.${k} must be a number`);
        // the store would clamp it without a word
        const p = def.params.find((x) => x.key === k)!;
        if (v < p.min || v > p.max) throw new ToolError(`params.${k} must be between ${p.min} and ${p.max}${p.unit ? ` ${p.unit}` : ''}, got ${v}`);
        touched.push(`p.${k}`);
      }
      params = value;
      continue;
    }
    if (key === 'speed') {
      if (!isTimedClip(before)) throw new ToolError('speed only exists on video and audio clips');
      speed = checkNumber(value, 'speed', MIN_SPEED, MAX_SPEED);
      continue;
    }
    if (key === 'parent') checkParent(before, value);
    // a field this file knows the shape of is checked (and a partial object completed) before it is stored
    if (knowsField(before.type, key)) {
      rest[key] = checkField(before, key, value);
      touchedBy(touched, key, value);
      continue;
    }
    checkKind(key, (before as unknown as Record<string, unknown>)[key], value);
    rest[key] = value;
    touchedBy(touched, key, value);
  }
  // a keyed property takes its value from the keys: a static value set here would change nothing on screen
  const keyed = before.keyframes ?? {};
  for (const t of touched) {
    const prop = t.endsWith('.*') ? Object.keys(keyed).find((k) => k.startsWith(t.slice(0, -1)) && (keyed[k]?.length ?? 0) > 0) : (keyed[t]?.length ?? 0) > 0 ? t : undefined;
    if (prop) {
      throw new ToolError(`${prop} is keyed on this clip, the keys decide its value. use set_keyframe to change a key or clear_keyframes to drop them`);
    }
  }

  if (transform) st.updateTransform(id, transform as Partial<Transform>, opts);
  if (params) for (const [k, v] of Object.entries(params)) useEditor.getState().setEffectParam(id, k, v as number, opts);
  if (typeof speed === 'number') useEditor.getState().setClipSpeed(id, speed, opts);
  if (Object.keys(rest).length > 0) useEditor.getState().updateClip(id, rest as ClipPatch, opts);

  const after = needClip(id);
  // updateClip ignores a key the clip type does not have (it is not stored, so it is not in the clip afterwards)
  const ignored = Object.keys(rest).filter((k) => {
    if (k in after) return false;
    const v = rest[k];
    // an empty value on a clip that never had the field is the same as nothing, not a mistake
    if (k === 'faces' || k === 'beat') return !(v === null || (isObject(v) && Object.keys(v).length === 0));
    return true;
  });
  if (ignored.length > 0) {
    throw new ToolError(
      `a ${before.type} clip has no ${ignored.join(', ')} field${ignored.length > 1 ? 's' : ''}. get_clip shows the fields of a clip, list_options with kind fields lists what each clip type takes`,
    );
  }

  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  const changed: string[] = [];
  if (transform && !same(b.transform, a.transform)) changed.push('transform');
  if (params && !same(b.params, a.params)) changed.push('params');
  if (speed !== undefined && b.speed !== a.speed) changed.push('speed');
  for (const k of Object.keys(rest)) if (!same(b[k], a[k])) changed.push(k);
  return changed;
}

/** a track argument for a new visual clip: a video track that is not locked */
export function videoTrackArg(id: unknown): string | undefined {
  if (id === undefined) return undefined;
  const t = needTrack(id);
  if (t.kind !== 'video') throw new ToolError(`the track ${t.id} (${t.name}) is an audio track: this clip needs a video track`);
  if (t.locked) throw new ToolError(`the track ${t.id} (${t.name}) is locked. unlock it with update_track first`);
  return t.id;
}
