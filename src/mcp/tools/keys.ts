import { getEffect } from '../../engine/effects/registry';
import { ALL_EASES, animProps, canKey, evalKeys, keyIndexAt, keyRange, valueAt } from '../../lib/anim';
import { INFLUENCE_MIN, SPEED_MAX, speedAt, withHandles, sameHandles, type EaseKind } from '../../lib/keyBezier';
import { usePlayback } from '../../store/playback';
import { useEditor } from '../../store/editorStore';
import type { KeyframesWrite } from '../../store/editorStore';
import type { KeyRef } from '../../store/ui';
import type { Clip, Easing, KeyHandle, Keyframe, Keyframes } from '../../types';
import { hasSoundApart, mateOf, soundsOf } from '../../lib/soundPair';
import { planEase, planJoin } from '../../features/timeline/graphPlan';
import { keyMoveRange, planKeyEase, planKeyMove, planKeyPaste, planKeyScale, type KeyPlan, type KeyStop } from '../../features/timeline/keyPlan';
import { KEY_REF_EPS } from '../../features/timeline/keySelection';
import { captureKeyCopy } from '../../features/properties/keyClipboard';
import { changedSince, idList, needClip, needProject, needUnlocked, ok, optNumber, optString, round, ToolError } from '../helpers';
import type { ToolDef } from '../types';
import { MAX_TIME, step } from './editPatch';

const EASE_IDS: readonly Easing[] = ALL_EASES;

/** the properties of a clip that can carry keys: the built-in ones, and p.<key> for the params of an effect */
function keyable(clip: Clip): string[] {
  const out = animProps(clip).map((a) => a.prop);
  if (clip.type === 'effect') for (const p of getEffect(clip.effect)?.params ?? []) out.push(`p.${p.key}`);
  return out;
}

function needProp(clip: Clip, prop: string): void {
  const list = keyable(clip);
  if (!list.includes(prop)) throw new ToolError(`a ${clip.type} clip has no animatable property "${prop}". it has: ${list.join(', ')}`);
}

type KeyRow = { t: number; time: number; v: number; ease: Easing; in?: KeyHandle; out?: KeyHandle };

/** the keys of one property as a client reads them: local seconds, timeline seconds, value, ease, and the handles when there are any */
function keysOf(clip: Clip, prop: string): KeyRow[] {
  return (clip.keyframes?.[prop] ?? []).map((k) => ({
    t: round(k.t),
    time: round(clip.start + k.t),
    v: round(k.v),
    ease: k.ease,
    ...(k.in ? { in: { speed: k.in.speed, influence: k.in.influence } } : null),
    ...(k.out ? { out: { speed: k.out.speed, influence: k.out.influence } } : null),
  }));
}

function allKeys(clip: Clip): Record<string, ReturnType<typeof keysOf>> {
  const out: Record<string, ReturnType<typeof keysOf>> = {};
  for (const prop of Object.keys(clip.keyframes ?? {})) out[prop] = keysOf(clip, prop);
  return out;
}

const EPS = 1e-6;

/** the picture of a separated sound is muted: its volume and pan keys are never heard, so they are set on the sound clip */
function needNotApart(clip: Clip, prop: string): void {
  if (clip.type !== 'video' || (prop !== 'volume' && prop !== 'pan')) return;
  const clips = needProject().clips;
  if (!hasSoundApart(clips, clip.id)) return;
  const soundId = mateOf(clips, clip.id)?.id ?? soundsOf(clips, clip)[0]?.id;
  throw new ToolError(`the sound of ${clip.id} is the clip ${soundId}: set ${prop} there (or join_sound)`);
}

/** the same keys, to a thousandth, so a record read back from get_clip counts as unchanged */
function sameKeys(a: readonly Keyframe[], b: readonly Keyframe[]): boolean {
  return a.length === b.length && a.every((k, i) => Math.abs(k.t - b[i]!.t) < 1e-3 && Math.abs(k.v - b[i]!.v) < 1e-3 && k.ease === b[i]!.ease && sameHandles(k, b[i]!));
}

/** a handle argument: { speed, influence }, null (takes it off) or missing. the texts say which part is wrong */
function readHandle(v: unknown, where: string): KeyHandle | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const shape = `${where} must be { speed, influence } or null`;
  if (typeof v !== 'object' || Array.isArray(v)) throw new ToolError(shape);
  const o = v as Record<string, unknown>;
  for (const n of Object.keys(o)) if (n !== 'speed' && n !== 'influence') throw new ToolError(shape);
  if (typeof o.speed !== 'number' || !Number.isFinite(o.speed) || Math.abs(o.speed) > SPEED_MAX) throw new ToolError(`${where}.speed must be a number between ${-SPEED_MAX} and ${SPEED_MAX}`);
  if (typeof o.influence !== 'number' || !(o.influence >= INFLUENCE_MIN && o.influence <= 1)) throw new ToolError(`${where}.influence must be between ${INFLUENCE_MIN} and 1`);
  return { speed: o.speed, influence: o.influence };
}

const HANDLE_SCHEMA = { description: '{ speed, influence } or null. speed: value units per second at the key, influence: 0.001 to 1' } as const;

function inside(clip: Clip, time: number): boolean {
  return time >= clip.start - EPS && time <= clip.start + clip.duration + EPS;
}

const setKeyframe: ToolDef = {
  name: 'set_keyframe',
  title: 'set a keyframe',
  description:
    'add or update one keyframe on one property of a clip, in one undo step. time is on the TIMELINE in seconds and has to be inside the clip. ' +
    'prop is an animatable property of that clip: x y scale rotation opacity (and z rotX rotY for 3d, look values like blur, volume and pan for sound, amount and p.<param> for effects, pan tilt roll fov for a camera; get_clip lists them with ranges). an unknown prop is an error that lists them. ' +
    'value defaults to what the property is at that time; it is limited to the property\'s range. ease says how the value travels to the NEXT key: linear, ease, ease-in, ease-out, back, bounce, elastic, hold or bezier (default ease). ' +
    'ease bezier (custom) shapes the part after the key with handles: out on this key, in on the next. speed is value units per second right at the key, influence 0.001 to 1 is how far the handle reaches as a share of the time to the neighbour key. a handle on a part that is not bezier turns it into one with the same shape first. ' +
    'once a property has keys its static value is ignored. answers { id, prop, keys: [{ t: seconds from clip start, time: timeline seconds, v, ease }] }. to set many keys at once use set_keyframes, to remove one remove_keyframe.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the clip id' },
      prop: { type: 'string', description: 'the property, for example "x", "opacity", "p.radius"' },
      time: { type: 'number', minimum: 0, maximum: MAX_TIME, description: 'timeline time in seconds, inside the clip' },
      value: { type: 'number', description: 'the value at that time (default: the current value there)' },
      ease: { type: 'string', enum: [...EASE_IDS], description: 'how the value moves on to the next key' },
      in: { ...HANDLE_SCHEMA, description: 'the handle arriving at this key: { speed, influence } or null to take it off' },
      out: { ...HANDLE_SCHEMA, description: 'the handle leaving this key: { speed, influence } or null to take it off' },
    },
    required: ['id', 'prop', 'time'],
  },
  run(args) {
    const clip = needClip(args.id);
    const prop = String(args.prop);
    const time = args.time as number;
    needUnlocked(clip);
    needProp(clip, prop);
    const handleIn = readHandle(args.in, 'in');
    const handleOut = readHandle(args.out, 'out');
    needNotApart(clip, prop);
    if (!canKey(clip, prop)) {
      throw new ToolError(`"${prop}" cannot be keyed yet: the clip has no ${prop.split('.')[0]} set. set it first with update_clip (for example a mask or an outline), then key it`);
    }
    if (!inside(clip, time)) {
      throw new ToolError(`time ${round(time)} s is outside the clip (${round(clip.start)} to ${round(clip.start + clip.duration)} s). time is on the timeline`);
    }
    const value = optNumber(args.value);
    const was = JSON.stringify(clip.keyframes?.[prop] ?? null);
    step((opts) => {
      useEditor.getState().setKeyframe(clip.id, prop, time, value, optString(args.ease) as Easing | undefined, opts);
      if (handleIn === undefined && handleOut === undefined) return;
      // the handles go on the key that is there now, in the same step
      const now = needClip(clip.id);
      const keys = now.keyframes?.[prop] ?? [];
      const i = keyIndexAt(keys, time - now.start, 0.5 / needProject().fps);
      if (i < 0) return;
      if (handleIn && i === 0) throw new ToolError('the first key has no in handle');
      if (handleOut && i === keys.length - 1) throw new ToolError('the last key has no out handle');
      useEditor.getState().setClipKeyframes(clip.id, { ...now.keyframes, [prop]: withHandles(keys, i, { in: handleIn, out: handleOut }) }, opts);
    });
    if (JSON.stringify(needClip(clip.id).keyframes?.[prop] ?? null) === was) {
      useEditor.getState().rollback();
      // no value given and none to take: the store wrote nothing, which is not the same as a key that already exists
      if (value === undefined && valueAt(needClip(clip.id), prop, time) === undefined) throw new ToolError(`give a value: ${prop} has no value on this clip yet`);
      throw new ToolError('nothing changed: that key already exists with that value and ease');
    }
    return ok({ id: clip.id, prop, keys: keysOf(needClip(clip.id), prop) });
  },
};

const removeKeyframe: ToolDef = {
  name: 'remove_keyframe',
  title: 'remove a keyframe',
  description:
    'remove the keyframe of a property at a timeline time (it has to be within half a frame of an existing key), in one undo step. when it was the last key the property keeps the value it had. ' +
    'answers { id, prop, keys: the keys that are left }. an error lists the existing key times when there is no key there. clear_keyframes removes all keys of a property.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the clip id' },
      prop: { type: 'string', description: 'the property' },
      time: { type: 'number', minimum: 0, maximum: MAX_TIME, description: 'timeline time of the key, seconds' },
    },
    required: ['id', 'prop', 'time'],
  },
  run(args) {
    const clip = needClip(args.id);
    const prop = String(args.prop);
    const time = args.time as number;
    needUnlocked(clip);
    const p = needProject();
    const have = clip.keyframes?.[prop] ?? [];
    if (have.length === 0) {
      const keyed = Object.keys(clip.keyframes ?? {});
      throw new ToolError(`"${prop}" has no keys on this clip${keyed.length ? ` (keyed: ${keyed.join(', ')})` : ''}`);
    }
    if (keyIndexAt(have, time - clip.start, 0.5 / p.fps) < 0) {
      throw new ToolError(`no key at ${round(time)} s. "${prop}" has keys at: ${have.map((k) => round(clip.start + k.t)).join(', ')} s (timeline)`);
    }
    step((opts) => useEditor.getState().removeKeyframe(clip.id, prop, time, undefined, opts));
    return ok({ id: clip.id, prop, keys: keysOf(needClip(clip.id), prop) });
  },
};

const setKeyframes: ToolDef = {
  name: 'set_keyframes',
  title: 'set all keyframes of a clip',
  description:
    'replace the WHOLE keyframes record of a clip at once, in one undo step: { "x": [{ "t": 0, "v": -300 }, { "t": 1.5, "v": 300, "ease": "ease-out" }], "opacity": [...] }. ' +
    't is seconds from the START OF THE CLIP (not the timeline) and has to be between 0 and the clip\'s duration, v is the value (limited to the property\'s range), ease (default ease) says how the value travels to the next key. ' +
    'in and out are the handles { speed, influence } of a bezier (custom) part: out on a key, in on the next (see set_keyframe). ' +
    'properties you leave out lose their keys (and keep the value they have at the start of the clip); {} removes all keys. a property the clip cannot animate is an error that lists the ones it can (see set_keyframe for the names). ' +
    'answers { id, keyframes: { prop: [{ t, time, v, ease, in?, out? }] } } as stored. use set_keyframe to change one key without touching the rest.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the clip id' },
      keyframes: { type: 'object', description: '{ prop: [{ t, v, ease?, in?, out? }] }, t in seconds from the clip start' },
    },
    required: ['id', 'keyframes'],
  },
  run(args) {
    const clip = needClip(args.id);
    needUnlocked(clip);
    const input = args.keyframes as Record<string, unknown>;
    const list = keyable(clip);
    const out: Keyframes = {};
    const bad: string[] = [];
    for (const [prop, keys] of Object.entries(input)) {
      if (!list.includes(prop)) {
        bad.push(prop);
        continue;
      }
      if (!Array.isArray(keys)) throw new ToolError(`keyframes.${prop} must be an array of { t, v, ease? }`);
      out[prop] = keys.map((k, i) => {
        const where = `keyframes.${prop}[${i}]`;
        if (typeof k !== 'object' || k === null || Array.isArray(k)) throw new ToolError(`${where} must be { "t": seconds, "v": value, "ease"?: ... }`);
        const o = k as Record<string, unknown>;
        for (const n of Object.keys(o)) if (n !== 't' && n !== 'v' && n !== 'ease' && n !== 'in' && n !== 'out') throw new ToolError(`${where}.${n} is not a field (t, v, ease, in, out)`);
        if (typeof o.t !== 'number' || !Number.isFinite(o.t)) throw new ToolError(`${where}.t must be a number (seconds from the clip start)`);
        if (typeof o.v !== 'number' || !Number.isFinite(o.v)) throw new ToolError(`${where}.v must be a number`);
        if (o.t < -EPS || o.t > clip.duration + EPS) throw new ToolError(`${where}.t is ${o.t}: keys live between 0 and ${round(clip.duration)} s (seconds from the clip start, not the timeline)`);
        if (o.ease !== undefined && !EASE_IDS.includes(o.ease as Easing)) throw new ToolError(`${where}.ease must be one of: ${EASE_IDS.join(', ')}`);
        const hin = readHandle(o.in, `${where}.in`);
        const hout = readHandle(o.out, `${where}.out`);
        return { t: Math.max(0, o.t), v: o.v, ease: (o.ease as Easing | undefined) ?? 'ease', ...(hin ? { in: hin } : null), ...(hout ? { out: hout } : null) };
      });
    }
    if (bad.length > 0) throw new ToolError(`a ${clip.type} clip cannot animate ${bad.map((b) => `"${b}"`).join(', ')}. it can: ${list.join(', ')}`);
    // a volume or pan that is sent back as it is stays fine, so a record from get_clip still works
    for (const prop of Object.keys(out)) if (!sameKeys(out[prop]!, clip.keyframes?.[prop] ?? [])) needNotApart(clip, prop);
    for (const prop of Object.keys(out)) {
      if (!canKey(clip, prop)) throw new ToolError(`"${prop}" cannot be keyed yet: set it first with update_clip (for example a mask or an outline), then key it`);
    }
    const before = needProject();
    step((opts) => useEditor.getState().setClipKeyframes(clip.id, out, opts));
    if (!changedSince(before)) {
      useEditor.getState().rollback();
      throw new ToolError('nothing changed: the clip already has exactly these keys');
    }
    return ok({ id: clip.id, keyframes: allKeys(needClip(clip.id)) });
  },
};

const clearKeyframes: ToolDef = {
  name: 'clear_keyframes',
  title: 'clear keyframes',
  description:
    'remove every keyframe of one property (prop) or of the whole clip (no prop), in one undo step. the property keeps a static value: the value it has at the playhead (kept inside the clip). ' +
    'answers { id, cleared: [props], keyframes: the keys left (none when prop is not given) }. an error when there was nothing to clear. remove_keyframe removes a single key.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the clip id' },
      prop: { type: 'string', description: 'one property to clear. default: all of them' },
    },
    required: ['id'],
  },
  run(args) {
    const clip = needClip(args.id);
    needUnlocked(clip);
    const prop = optString(args.prop);
    const keyed = Object.keys(clip.keyframes ?? {}).filter((k) => (clip.keyframes?.[k]?.length ?? 0) > 0);
    if (keyed.length === 0) throw new ToolError('nothing to clear: this clip has no keyframes');
    if (prop !== undefined && !keyed.includes(prop)) throw new ToolError(`"${prop}" has no keys on this clip. keyed: ${keyed.join(', ')}`);
    const time = Math.min(clip.start + clip.duration, Math.max(clip.start, usePlayback.getState().time));
    step((opts) => useEditor.getState().clearKeyframes(clip.id, time, prop, opts));
    return ok({ id: clip.id, cleared: prop ? [prop] : keyed, keyframes: allKeys(needClip(clip.id)) });
  },
};

// ---------- retime, ease, copy, sample ----------

const KEYS_ARG = {
  type: 'array',
  minItems: 1,
  maxItems: 200,
  items: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the clip id' },
      prop: { type: 'string', description: 'one property. default: every property with keys' },
      times: { type: 'array', items: { type: 'number', minimum: 0, maximum: MAX_TIME }, maxItems: 200, description: 'timeline times of the keys (within half a frame of a key). default: every key inside the clip' },
    },
    required: ['id'],
  },
  description: 'the keys to work on: [{ id, prop?, times? }]',
} as const;

/** the keys inside the clip (a split leaves one a hair outside: it is carried, never picked) */
const insideKeys = (clip: Clip, prop: string): readonly Keyframe[] => (clip.keyframes?.[prop] ?? []).filter((k) => k.t >= -KEY_REF_EPS && k.t <= clip.duration + KEY_REF_EPS);

const keyedProps = (clip: Clip): string[] => Object.keys(clip.keyframes ?? {}).filter((p) => insideKeys(clip, p).length > 0);

/** the key refs the keys argument names. every id: a clip, unlocked. a time within half a frame of an inside key */
function keySelection(asks: unknown): KeyRef[] {
  const p = needProject();
  const tol = 0.5 / p.fps;
  const sel: KeyRef[] = [];
  const seen = new Set<string>();
  const add = (clipId: string, prop: string, t: number): void => {
    const key = `${clipId}\n${prop}\n${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    sel.push({ clipId, prop, t });
  };
  for (const raw of Array.isArray(asks) ? asks : []) {
    const ask = raw as { id: string; prop?: string; times?: number[] };
    const clip = needClip(ask.id);
    needUnlocked(clip);
    const keyed = keyedProps(clip);
    if (keyed.length === 0) throw new ToolError(`the clip ${clip.id} has no keyframes`);
    if (ask.prop !== undefined && !keyed.includes(ask.prop)) throw new ToolError(`"${ask.prop}" has no keys on this clip. keyed: ${keyed.join(', ')}`);
    const props = ask.prop !== undefined ? [ask.prop] : keyed;
    for (const prop of props) {
      if (ask.prop !== undefined) needNotApart(clip, prop);
      else if ((prop === 'volume' || prop === 'pan') && clip.type === 'video' && hasSoundApart(p.clips, clip.id)) continue;
      const keys = insideKeys(clip, prop);
      if (ask.times === undefined) {
        for (const k of keys) add(clip.id, prop, k.t);
        continue;
      }
      for (const time of ask.times) {
        const i = keyIndexAt(keys, time - clip.start, tol);
        if (i >= 0) add(clip.id, prop, keys[i]!.t);
        else if (ask.prop !== undefined) throw new ToolError(`no key of "${prop}" at ${round(time)} s. it has keys at: ${keys.map((k) => round(clip.start + k.t)).join(', ')} s`);
      }
    }
    if (ask.times !== undefined && ask.prop === undefined) {
      for (const time of ask.times) {
        if (!props.some((prop) => keyIndexAt(insideKeys(clip, prop), time - clip.start, tol) >= 0)) throw new ToolError(`no key at ${round(time)} s on any property of ${clip.id}. keyed: ${keyed.join(', ')}`);
      }
    }
  }
  return sel;
}

/** writes a plan in one undo step. false (and nothing left behind) when no key changes */
function writePlan(plan: KeyPlan): boolean {
  const before = needProject();
  step((opts) => useEditor.getState().setManyKeyframes(plan.writes, { ...opts, time: usePlayback.getState().time }));
  if (!changedSince(before)) {
    useEditor.getState().rollback();
    return false;
  }
  return true;
}

const clipName = (id: string): string => needProject().clips.find((c) => c.id === id)?.name ?? id;

/** what a refused plan says: where the keys would leave, or what is in the way */
function stopText(stop: KeyStop, how: string): string {
  if (stop.kind === 'inTheWay') return `a key of "${stop.prop}" at ${round(stop.t ?? 0)} s is in the way: name it too or move less`;
  if (stop.kind === 'locked') return `the clip ${stop.clipId} is on a locked track. unlock it with update_track first`;
  return `the keys would leave clip "${clipName(stop.clipId)}": ${how}`;
}

const retimeKeyframes: ToolDef = {
  name: 'retime_keyframes',
  title: 'retime keyframes',
  description:
    'moves or stretches keyframes in time, in one undo step. keys: [{ id, prop?, times? }] (no prop: every property with keys, no times: every key inside the clip, times are timeline seconds within half a frame of a key). ' +
    'give one of: by (seconds, negative goes back), frames (whole frames) or scale (a factor from 0.01 to 100 around a time: 2 doubles the distances). around: the timeline time that stays (default the playhead, only with scale). ' +
    'the keys keep their value, ease and handles. keys never leave their clip and never land on a key that stays: that is an error that says how far they can go. ' +
    'answers { moved: keys moved, clips: clips changed }.',
  inputSchema: {
    type: 'object',
    properties: {
      keys: KEYS_ARG,
      by: { type: 'number', minimum: -MAX_TIME, maximum: MAX_TIME, description: 'move by this many seconds' },
      frames: { type: 'integer', minimum: -100000, maximum: 100000, description: 'move by this many whole frames' },
      scale: { type: 'number', minimum: 0.01, maximum: 100, description: 'stretch the distances to the pivot by this factor' },
      around: { type: 'number', minimum: 0, maximum: MAX_TIME, description: 'with scale: the timeline time that stays. default the playhead' },
    },
    required: ['keys'],
  },
  run(args) {
    const by = optNumber(args.by);
    const frames = optNumber(args.frames);
    const scale = optNumber(args.scale);
    const around = optNumber(args.around);
    if ([by, frames, scale].filter((x) => x !== undefined).length !== 1) throw new ToolError('give one of by, frames or scale');
    if (around !== undefined && scale === undefined) throw new ToolError('around goes with scale');
    const sel = keySelection(args.keys);
    const p = needProject();
    let plan: KeyPlan;
    if (scale !== undefined) {
      const pivot = around ?? usePlayback.getState().time;
      plan = planKeyScale(p, sel, pivot, scale, 'refuse');
      if (plan.stop) {
        const lo = round(planKeyScale(p, sel, pivot, 0.01, 'clamp').amount);
        const hi = round(planKeyScale(p, sel, pivot, 100, 'clamp').amount);
        throw new ToolError(stopText(plan.stop, `scale can be ${lo} to ${hi} here`));
      }
    } else {
      plan = planKeyMove(p, sel, by ?? (frames ?? 0) / p.fps, 'refuse');
      if (plan.stop) {
        const r = keyMoveRange(p, sel);
        throw new ToolError(stopText(plan.stop, `they can move ${round(r.lo)} to ${round(r.hi)} s`));
      }
    }
    if (!writePlan(plan)) throw new ToolError('nothing changed');
    return ok({ moved: plan.sel.length, clips: plan.writes.length });
  },
};

const EASY_KIND: Record<string, EaseKind> = { both: 'easy', into: 'into', 'out-of': 'outOf' };

const easeKeyframes: ToolDef = {
  name: 'ease_keyframes',
  title: 'ease keyframes',
  description:
    'sets how the value travels on from keyframes, in one undo step. keys: [{ id, prop?, times? }] (see retime_keyframes). give exactly one of: ' +
    'ease (linear, ease, ease-in, ease-out, back, bounce, elastic, hold or bezier: the part after each key), ' +
    'easy (both = easy ease: the part into and out of each key slows down, into = ease into, out-of = ease out of: custom handles that meet the neighbours softly, holds are kept) ' +
    'or join (true: the two handles of each key get the same speed, so the line has no corner there). ' +
    'answers { changed: keys changed, clips: clips changed }, with easy also holds_kept. an error when nothing would change.',
  inputSchema: {
    type: 'object',
    properties: {
      keys: KEYS_ARG,
      ease: { type: 'string', enum: [...EASE_IDS], description: 'a named ease for the part after each key' },
      easy: { type: 'string', enum: ['both', 'into', 'out-of'], description: 'easy ease the part into, out of or both sides of each key' },
      join: { type: 'boolean', description: 'true: join the handles of each key into one speed' },
    },
    required: ['keys'],
  },
  run(args) {
    const ease = optString(args.ease) as Easing | undefined;
    const easy = optString(args.easy);
    const join = args.join === true;
    if ([ease !== undefined, easy !== undefined, join].filter(Boolean).length !== 1) throw new ToolError('give one of ease, easy or join');
    const sel = keySelection(args.keys);
    const p = needProject();
    let plan: KeyPlan & { holds?: number };
    if (ease !== undefined) plan = planKeyEase(p, sel, ease);
    else if (easy !== undefined) {
      plan = planEase(p, sel, EASY_KIND[easy]!);
      if (plan.amount === 0 && (plan.holds ?? 0) > 0) throw new ToolError('the keys sit next to holds: a hold has no handles');
    } else {
      plan = planJoin(p, sel);
      if (plan.stop?.kind === 'noHandles') throw new ToolError('the keys have no handles to join: a hold or an end key has none');
    }
    if (plan.amount === 0 || !writePlan(plan)) throw new ToolError('nothing changed');
    return ok({ changed: plan.amount, clips: plan.writes.length, ...(easy !== undefined ? { holds_kept: plan.holds ?? 0 } : null) });
  },
};

const copyKeyframes: ToolDef = {
  name: 'copy_keyframes',
  title: 'copy keyframes',
  description:
    'copies the keyframes of one clip onto other clips, in one undo step: from (the clip), props (default every property with keys), to (clips, 1 to 100). ' +
    'the first copied key lands at at (timeline seconds), default the same place in each clip (its start plus the key\'s offset in the source). the pasted keys replace the keys that lay in their own time span, the rest stay. ' +
    'what a clip cannot animate is left out and named in left_out. the keyframe panel\'s clipboard is not touched. copying a clip onto itself needs at. ' +
    'answers { pasted: keys written, clips: clips changed, left_out: [props] }.',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'the clip to copy the keys of' },
      props: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100, description: 'the properties to copy. default every property with keys' },
      to: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100, description: 'the clips to paste onto' },
      at: { type: 'number', minimum: 0, maximum: MAX_TIME, description: 'timeline time of the first copied key. default the same place in each clip' },
    },
    required: ['from', 'to'],
  },
  run(args) {
    const from = needClip(args.from);
    const targets = [...new Set(idList(args.to))].map((id) => needClip(id));
    for (const t of targets) needUnlocked(t);
    const at = optNumber(args.at);
    if (at === undefined && targets.some((t) => t.id === from.id)) throw new ToolError('copying a clip onto itself needs at');
    const keyed = keyedProps(from);
    if (keyed.length === 0) throw new ToolError(`the clip ${from.id} has no keyframes`);
    const props = Array.isArray(args.props) ? idList(args.props) : keyed;
    for (const prop of props) if (!keyed.includes(prop)) throw new ToolError(`"${prop}" has no keys on this clip. keyed: ${keyed.join(', ')}`);
    const sel: KeyRef[] = [];
    let first = Infinity;
    for (const prop of props) {
      for (const k of insideKeys(from, prop)) {
        sel.push({ clipId: from.id, prop, t: k.t });
        first = Math.min(first, k.t);
      }
    }
    const p = needProject();
    const copy = captureKeyCopy(p, sel);
    if (!copy) throw new ToolError('no keys to copy');
    const writes: KeyframesWrite[] = [];
    const leftOut: string[] = [];
    let pasted = 0;
    for (const t of targets) {
      const plan = planKeyPaste(p, copy, [t.id], at ?? t.start + first);
      if (plan.stop?.kind === 'locked') throw new ToolError(stopText(plan.stop, ''));
      writes.push(...plan.writes);
      pasted += plan.pasted;
      for (const prop of plan.leftOut) if (!leftOut.includes(prop)) leftOut.push(prop);
    }
    if (pasted === 0 || writes.length === 0) throw new ToolError('no keys land inside the targets: give at inside them');
    if (!writePlan({ writes, sel: [], stop: null, amount: pasted })) throw new ToolError('nothing changed');
    return ok({ pasted, clips: writes.length, left_out: leftOut });
  },
};

const MAX_SAMPLES = 2000;
const round8 = (n: number): number => Math.round(n * 1e8) / 1e8;

const sampleKeyframes: ToolDef = {
  name: 'sample_keyframes',
  title: 'sample keyframes',
  description:
    'reads the animated value of one property at many times, to see the curve: { id, prop, from?, to?, step? } in timeline seconds (default the whole clip and one frame, at most 2000 samples). ' +
    'answers { id, prop, unit, samples: [{ time, v, speed }] }: v is the value the preview and the export use, speed is how fast it changes then, in value units per second. a lookup: nothing changes.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the clip id' },
      prop: { type: 'string', description: 'the property, for example "x", "opacity", "p.radius"' },
      from: { type: 'number', minimum: 0, maximum: MAX_TIME, description: 'timeline time to start at. default the clip start' },
      to: { type: 'number', minimum: 0, maximum: MAX_TIME, description: 'timeline time to end at. default the clip end' },
      step: { type: 'number', minimum: 0.0001, maximum: MAX_TIME, description: 'seconds between samples. default one frame' },
    },
    required: ['id', 'prop'],
  },
  run(args) {
    const clip = needClip(args.id);
    const prop = String(args.prop);
    needProp(clip, prop);
    const keys = clip.keyframes?.[prop] ?? [];
    if (keys.length === 0) {
      const keyed = Object.keys(clip.keyframes ?? {});
      throw new ToolError(`"${prop}" has no keys on this clip${keyed.length ? ` (keyed: ${keyed.join(', ')})` : ''}`);
    }
    const end = clip.start + clip.duration;
    const from = optNumber(args.from) ?? clip.start;
    const to = optNumber(args.to) ?? end;
    if (from < clip.start - EPS || to > end + EPS) throw new ToolError(`from and to have to be inside the clip (${round(clip.start)} to ${round(end)} s). time is on the timeline`);
    if (to < from) throw new ToolError('to is before from');
    const dt = optNumber(args.step) ?? 1 / needProject().fps;
    const count = Math.floor((to - from) / dt + 1e-9) + 1;
    if (count > MAX_SAMPLES) throw new ToolError('too many samples: use a bigger step');
    const range = keyRange(clip, prop);
    const info = animProps(clip).find((a) => a.prop === prop);
    const samples: { time: number; v: number; speed: number }[] = [];
    for (let i = 0; i < count; i++) {
      const time = Math.min(end, from + i * dt);
      const local = time - clip.start;
      samples.push({ time: round8(time), v: round8(valueAt(clip, prop, time) ?? evalKeys(keys, local, clip, prop)), speed: round8(speedAt(keys, local, range)) });
    }
    return ok({ id: clip.id, prop, unit: info?.unit ?? null, samples });
  },
};

export const keyTools: ToolDef[] = [setKeyframe, removeKeyframe, setKeyframes, clearKeyframes, retimeKeyframes, easeKeyframes, copyKeyframes, sampleKeyframes];
