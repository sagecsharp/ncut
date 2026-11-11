import { getEffect } from '../../engine/effects/registry';
import { animProps, canKey, EASINGS, keyIndexAt, valueAt } from '../../lib/anim';
import { usePlayback } from '../../store/playback';
import { useEditor } from '../../store/editorStore';
import type { Clip, Easing, Keyframes } from '../../types';
import { changedSince, needClip, needProject, needUnlocked, ok, optNumber, optString, round, ToolError } from '../helpers';
import type { ToolDef } from '../types';
import { MAX_TIME, step } from './editPatch';

const EASE_IDS = EASINGS.map((e) => e.id);

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

/** the keys of one property as a client reads them: local seconds, timeline seconds, value, ease */
function keysOf(clip: Clip, prop: string): { t: number; time: number; v: number; ease: Easing }[] {
  return (clip.keyframes?.[prop] ?? []).map((k) => ({ t: round(k.t), time: round(clip.start + k.t), v: round(k.v), ease: k.ease }));
}

function allKeys(clip: Clip): Record<string, ReturnType<typeof keysOf>> {
  const out: Record<string, ReturnType<typeof keysOf>> = {};
  for (const prop of Object.keys(clip.keyframes ?? {})) out[prop] = keysOf(clip, prop);
  return out;
}

const EPS = 1e-6;

function inside(clip: Clip, time: number): boolean {
  return time >= clip.start - EPS && time <= clip.start + clip.duration + EPS;
}

const setKeyframe: ToolDef = {
  name: 'set_keyframe',
  title: 'set a keyframe',
  description:
    'add or update one keyframe on one property of a clip, in one undo step. time is on the TIMELINE in seconds and has to be inside the clip. ' +
    'prop is an animatable property of that clip: x y scale rotation opacity (and z rotX rotY for 3d, look values like blur, volume for sound, amount and p.<param> for effects, pan tilt roll fov for a camera; get_clip lists them with ranges). an unknown prop is an error that lists them. ' +
    'value defaults to what the property is at that time; it is limited to the property\'s range. ease says how the value travels to the NEXT key: linear, ease, ease-in, ease-out, back, bounce, elastic or hold (default ease). ' +
    'once a property has keys its static value is ignored. answers { id, prop, keys: [{ t: seconds from clip start, time: timeline seconds, v, ease }] }. to set many keys at once use set_keyframes, to remove one remove_keyframe.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the clip id' },
      prop: { type: 'string', description: 'the property, for example "x", "opacity", "p.radius"' },
      time: { type: 'number', minimum: 0, maximum: MAX_TIME, description: 'timeline time in seconds, inside the clip' },
      value: { type: 'number', description: 'the value at that time (default: the current value there)' },
      ease: { type: 'string', enum: EASE_IDS, description: 'how the value moves on to the next key' },
    },
    required: ['id', 'prop', 'time'],
  },
  run(args) {
    const clip = needClip(args.id);
    const prop = String(args.prop);
    const time = args.time as number;
    needUnlocked(clip);
    needProp(clip, prop);
    if (!canKey(clip, prop)) {
      throw new ToolError(`"${prop}" cannot be keyed yet: the clip has no ${prop.split('.')[0]} set. set it first with update_clip (for example a mask or an outline), then key it`);
    }
    if (!inside(clip, time)) {
      throw new ToolError(`time ${round(time)} s is outside the clip (${round(clip.start)} to ${round(clip.start + clip.duration)} s). time is on the timeline`);
    }
    const value = optNumber(args.value);
    const was = JSON.stringify(clip.keyframes?.[prop] ?? null);
    step((opts) => useEditor.getState().setKeyframe(clip.id, prop, time, value, optString(args.ease) as Easing | undefined, opts));
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
    'properties you leave out lose their keys (and keep the value they have at the start of the clip); {} removes all keys. a property the clip cannot animate is an error that lists the ones it can (see set_keyframe for the names). ' +
    'answers { id, keyframes: { prop: [{ t, time, v, ease }] } } as stored. use set_keyframe to change one key without touching the rest.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the clip id' },
      keyframes: { type: 'object', description: '{ prop: [{ t, v, ease? }] }, t in seconds from the clip start' },
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
        for (const n of Object.keys(o)) if (n !== 't' && n !== 'v' && n !== 'ease') throw new ToolError(`${where}.${n} is not a field (t, v, ease)`);
        if (typeof o.t !== 'number' || !Number.isFinite(o.t)) throw new ToolError(`${where}.t must be a number (seconds from the clip start)`);
        if (typeof o.v !== 'number' || !Number.isFinite(o.v)) throw new ToolError(`${where}.v must be a number`);
        if (o.t < -EPS || o.t > clip.duration + EPS) throw new ToolError(`${where}.t is ${o.t}: keys live between 0 and ${round(clip.duration)} s (seconds from the clip start, not the timeline)`);
        if (o.ease !== undefined && !EASE_IDS.includes(o.ease as Easing)) throw new ToolError(`${where}.ease must be one of: ${EASE_IDS.join(', ')}`);
        return { t: Math.max(0, o.t), v: o.v, ease: (o.ease as Easing | undefined) ?? 'ease' };
      });
    }
    if (bad.length > 0) throw new ToolError(`a ${clip.type} clip cannot animate ${bad.map((b) => `"${b}"`).join(', ')}. it can: ${list.join(', ')}`);
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

export const keyTools: ToolDef[] = [setKeyframe, removeKeyframe, setKeyframes, clearKeyframes];
