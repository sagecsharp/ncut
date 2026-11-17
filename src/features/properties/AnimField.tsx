import { createContext, memo, useContext, useRef } from 'react';
import { ChevronLeft, ChevronRight, Diamond } from 'lucide-react';
import { SliderField, type SliderSource } from '../../components/ui/SliderField';
import { roundShown } from '../../components/ui/numberFormat';
import { EASINGS, KEY_EPS, baseValue, evalKeys, isSeedable, keyIndexAt, valueAt } from '../../lib/anim';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import type { Clip, Easing, Keyframe } from '../../types';
import { tip } from '../shell/tip';
import { beginEdit, cancelEdit, endEdit, liveOpts } from './edit';
import { useFeelCtx } from './feelContext';
import { FEEL, resolveFeel, type Feel, type FeelEntry, type FeelKey, type FeelOverride } from './fieldFeel';

const actions = () => useEditor.getState();

/**
 * the clip the inspector is showing. an AnimField of that clip reads it from here instead of running its own
 * clips.find on every store update (a few dozen fields on screen, each on a project with hundreds of clips).
 * the inspector already subscribes to the same clip, so the fields re-render exactly when they did before.
 * a field of another clip, or one outside an inspector, still looks its clip up itself.
 */
export const InspectedClip = createContext<Clip | null>(null);

export interface AnimFieldProps extends FeelOverride {
  /** clip id */
  id: string;
  /** animatable property name, see lib/anim.ts (x, scale, volume, amount, p.<key> ...) */
  prop: string;
  label: string;
  title: string;
  /** a key of the feel table, or an entry */
  feel: FeelKey | FeelEntry;
  /** wider label column for long labels */
  wide?: boolean;
  /** stored value to show when the clip has none (effect params fall back to the effect default) */
  fallback?: number;
}

/** clip-local time of the playhead, held inside the clip */
function localTime(time: number, start: number, duration: number): number {
  return clamp(time, start, start + duration) - start;
}

/** keys outside the clip (kept by a trim / split for an unbroken motion) are not listed or jumped to */
export function inClip(k: Keyframe, duration: number): boolean {
  return k.t >= -KEY_EPS && k.t <= duration + KEY_EPS;
}

/** the key the easing select edits: the last key at or before the playhead, else the first key */
export function easeKeyIndex(keys: readonly Keyframe[], local: number, tol: number): number {
  let at = 0;
  for (let i = 0; i < keys.length; i++) if (keys[i]!.t <= local + tol) at = i;
  return at;
}

/** the shared row markup, also used by the bend topic's GroupBendField */
export interface ViewProps {
  label: string;
  title: string;
  wide?: boolean;
  /** resolved */
  feel: Feel;
  /** shown units, null = mixed */
  value: number | null;
  animated: boolean;
  keyHere: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  ease: Easing;
  onPress(): void;
  onStart(): void;
  onValue(v: number, source: SliderSource): number | void;
  onToggle(): void;
  onJump(dir: -1 | 1): void;
  onEase(e: Easing): void;
  mixedFrom?: number;
  dragText?: string | null;
}

/** the shared markup. pure: all state comes in as props. */
export function FieldView(p: ViewProps) {
  const { label, title, wide, feel, value, animated, keyHere } = p;
  const diamond = keyHere ? 'remove keyframe' : 'add keyframe';
  return (
    <div className="props-anim">
      <div className="props-row" title={title}>
        <span className={`field-label props-label${wide ? ' props-label-wide' : ''}`}>{label}</span>
        <div className="props-control">
          <SliderField
            className="props-grow"
            ariaLabel={label}
            title={title}
            value={value}
            min={feel.min}
            max={feel.max}
            soft={feel.soft}
            step={feel.step}
            precision={feel.precision}
            snap={feel.snap}
            perPx={feel.perPx}
            origin={feel.origin}
            rest={feel.rest}
            suffix={feel.unit || undefined}
            mixedFrom={p.mixedFrom}
            dragText={p.dragText}
            onPress={p.onPress}
            onStart={p.onStart}
            onChange={p.onValue}
            onEnd={endEdit}
            onCancel={cancelEdit}
          />
          <button
            type="button"
            className={`icon-btn icon-btn-sm props-diamond${animated ? ' is-animated' : ''}${keyHere ? ' is-key' : ''}`}
            {...tip('keyframe', { does: keyHere ? 'remove the keyframe at the playhead' : 'add a keyframe at the playhead' })}
            aria-label={`${diamond} for ${label}`}
            aria-pressed={keyHere}
            onClick={p.onToggle}
          >
            <Diamond size={12} fill={keyHere ? 'currentColor' : 'none'} />
          </button>
        </div>
      </div>
      {animated ? (
        <div className={`props-anim-extra${wide ? ' props-anim-extra-wide' : ''}`}>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            {...tip('previous keyframe', { does: 'of this value', off: p.hasPrev ? false : 'no keyframe before the playhead' })}
            aria-label={`previous keyframe of ${label}`}
            disabled={!p.hasPrev}
            onClick={() => p.onJump(-1)}
          >
            <ChevronLeft size={12} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            {...tip('next keyframe', { does: 'of this value', off: p.hasNext ? false : 'no keyframe after the playhead' })}
            aria-label={`next keyframe of ${label}`}
            disabled={!p.hasNext}
            onClick={() => p.onJump(1)}
          >
            <ChevronRight size={12} />
          </button>
          <select
            className="select props-ease"
            {...tip('easing', { does: 'how the value moves from this keyframe to the next' })}
            aria-label={`easing of ${label}`}
            value={p.ease}
            onChange={(e) => p.onEase(e.target.value as Easing)}
          >
            {EASINGS.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}

interface BodyProps {
  id: string;
  prop: string;
  label: string;
  title: string;
  wide?: boolean;
  fallback?: number;
  feel: Feel;
  start: number;
  duration: number;
  fps: number;
}

/** write one shown value at the gesture time and answer the value the clip really holds there (shown units) */
function writeValue(p: BodyProps, time: number, v: number): number {
  const { id, prop, feel } = p;
  actions().setClipValue(id, prop, time, v / feel.scale, liveOpts());
  const clip = useEditor.getState().project?.clips.find((c) => c.id === id);
  return ((clip ? valueAt(clip, prop, time) : undefined) ?? p.fallback ?? 0) * feel.scale;
}

/** no keys: nothing here listens to the playhead */
function StaticBody(p: BodyProps & { stored: number; seed: boolean }) {
  const { id, prop, start, duration, feel } = p;
  const t0 = useRef(0);
  const time = () => clamp(usePlayback.getState().time, start, start + duration);
  const jump = () => undefined;
  // a static field never has keys, so a press never pauses
  const onPress = () => undefined;
  return (
    <FieldView
      {...p}
      value={roundShown(p.stored * feel.scale, feel.precision)}
      animated={false}
      keyHere={false}
      hasPrev={false}
      hasNext={false}
      ease="ease"
      onPress={onPress}
      onStart={() => {
        onPress();
        t0.current = time();
        beginEdit();
      }}
      onValue={(v) => writeValue(p, t0.current, v)}
      // a value that is not stored yet (thickness) is keyed with the number the field shows
      onToggle={() => (p.seed ? actions().setKeyframe(id, prop, time(), p.stored) : actions().toggleKeyframe(id, prop, time()))}
      onJump={jump}
      onEase={jump}
    />
  );
}

/**
 * has keys: reads the playhead through selectors that return what is shown (rounded value, booleans,
 * a string) so react re-renders only when the display changes, not on every frame.
 */
function AnimatedBody(p: BodyProps & { keys: Keyframe[] }) {
  const { id, prop, keys, start, duration, fps, feel } = p;
  const tol = 0.5 / fps;
  const t0 = useRef(0);

  const value = usePlayback((s) => roundShown(evalKeys(keys, s.time - start) * feel.scale, feel.precision));
  const keyHere = usePlayback((s) => keyIndexAt(keys, localTime(s.time, start, duration), tol) >= 0);
  const hasPrev = usePlayback((s) => {
    const l = localTime(s.time, start, duration);
    return keys.some((k) => inClip(k, duration) && k.t < l - tol);
  });
  const hasNext = usePlayback((s) => {
    const l = localTime(s.time, start, duration);
    return keys.some((k) => inClip(k, duration) && k.t > l + tol);
  });
  const ease = usePlayback((s) => keys[easeKeyIndex(keys, localTime(s.time, start, duration), tol)]!.ease);

  const now = () => usePlayback.getState().time;
  // a press on a keyed field pauses playback: every write of the gesture goes to the time it stopped at
  const onPress = () => {
    const pb = usePlayback.getState();
    if (pb.playing) pb.pause();
  };
  return (
    <FieldView
      {...p}
      value={value}
      animated
      keyHere={keyHere}
      hasPrev={hasPrev}
      hasNext={hasNext}
      ease={ease}
      onPress={onPress}
      onStart={() => {
        onPress();
        t0.current = clamp(now(), start, start + duration);
        beginEdit();
      }}
      onValue={(v) => writeValue(p, t0.current, v)}
      onToggle={() => actions().toggleKeyframe(id, prop, clamp(now(), start, start + duration))}
      onJump={(dir) => {
        const l = localTime(now(), start, duration);
        const target = dir < 0 ? [...keys].reverse().find((k) => inClip(k, duration) && k.t < l - tol)
          : keys.find((k) => inClip(k, duration) && k.t > l + tol);
        if (target) usePlayback.getState().seek(start + target.t);
      }}
      onEase={(e) => {
        const key = keys[easeKeyIndex(keys, localTime(now(), start, duration), tol)];
        if (key) actions().setKeyframe(id, prop, start + key.t, undefined, e);
      }}
    />
  );
}

/**
 * one animatable number: value at the playhead, keyframe diamond, previous / next key and easing.
 * edits go through setClipValue, so they write a key when the property is animated.
 */
export const AnimField = memo(function AnimField(props: AnimFieldProps) {
  const shared = useContext(InspectedClip);
  const inherited = shared !== null && shared.id === props.id;
  const own = useEditor((s) => (inherited ? undefined : s.project?.clips.find((c) => c.id === props.id)));
  const clip = inherited ? shared : own;
  const fps = useEditor((s) => s.project?.fps ?? 30);
  const ctx = useFeelCtx();
  if (!clip) return null;
  const entry = typeof props.feel === 'string' ? FEEL[props.feel] : props.feel;
  const feel = resolveFeel(entry, ctx, props);
  const { id, prop, label, title, wide, fallback } = props;
  const body: BodyProps = { id, prop, label, title, wide, fallback, feel, start: clip.start, duration: clip.duration, fps };
  const keys = clip.keyframes?.[props.prop];
  if (keys && keys.length > 0) return <AnimatedBody key={props.prop} {...body} keys={keys} />;
  const base = baseValue(clip, props.prop);
  const seed = base === undefined && props.fallback !== undefined && isSeedable(clip, props.prop);
  return <StaticBody key={props.prop} {...body} stored={base ?? props.fallback ?? 0} seed={seed} />;
});
