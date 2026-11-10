import { memo } from 'react';
import { ChevronLeft, ChevronRight, Diamond } from 'lucide-react';
import { NumberField } from '../../components/ui/NumberField';
import { EASINGS, baseValue, evalKeys, keyIndexAt } from '../../lib/anim';
import { clamp } from '../../lib/time';
import { useClip, useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import type { Easing, Keyframe } from '../../types';
import { beginEdit, liveOpts } from './edit';

const actions = () => useEditor.getState();

export interface AnimFieldProps {
  /** clip id */
  id: string;
  /** animatable property name, see lib/anim.ts (x, scale, volume, amount, p.<key> ...) */
  prop: string;
  label: string;
  title: string;
  /** shown value = stored value * scale (100 shows a 0..1 value as percent) */
  scale?: number;
  /** limits in SHOWN units */
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  suffix?: string;
  /** range slider next to the number */
  slider?: boolean;
  /** wider label column for long labels */
  wide?: boolean;
  /** stored value to show when the clip has none (effect params fall back to the effect default) */
  fallback?: number;
}

/** clip-local time of the playhead, held inside the clip */
function localTime(time: number, start: number, duration: number): number {
  return clamp(time, start, start + duration) - start;
}

/** the key the easing select edits: the last key at or before the playhead, else the first key */
function easeKeyIndex(keys: readonly Keyframe[], local: number, tol: number): number {
  let at = 0;
  for (let i = 0; i < keys.length; i++) if (keys[i]!.t <= local + tol) at = i;
  return at;
}

interface ViewProps extends AnimFieldProps {
  value: number;
  animated: boolean;
  keyHere: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  ease: Easing;
  onValue(v: number): void;
  onToggle(): void;
  onJump(dir: -1 | 1): void;
  onEase(e: Easing): void;
}

/** the shared markup. pure: all state comes in as props. */
function FieldView(p: ViewProps) {
  const { label, title, min, max, step = 1, precision = 0, suffix, slider, wide, value, animated, keyHere } = p;
  const hasRange = slider && min !== undefined && max !== undefined;
  const diamondTitle = keyHere ? 'remove keyframe' : 'add keyframe';
  return (
    <div className="props-anim">
      <div className="props-row" title={title}>
        <span className={`field-label props-label${wide ? ' props-label-wide' : ''}`}>{label}</span>
        <div className="props-control">
          {hasRange ? (
            <input
              type="range"
              className="range props-range"
              title={title}
              aria-label={title}
              min={min}
              max={max}
              step={step}
              value={clamp(value, min, max)}
              onPointerDown={beginEdit}
              onKeyDown={(e) => {
                if (!e.repeat) beginEdit();
              }}
              onChange={(e) => p.onValue(Number(e.target.value))}
            />
          ) : null}
          <NumberField
            className={hasRange ? 'props-num' : 'props-grow'}
            title={title}
            value={value}
            min={min}
            max={max}
            step={step}
            precision={precision}
            suffix={suffix}
            onStart={beginEdit}
            onChange={p.onValue}
          />
          <button
            type="button"
            className={`icon-btn icon-btn-sm props-diamond${animated ? ' is-animated' : ''}${keyHere ? ' is-key' : ''}`}
            title={diamondTitle}
            aria-label={`${diamondTitle} for ${label}`}
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
            title="previous keyframe"
            aria-label={`previous keyframe of ${label}`}
            disabled={!p.hasPrev}
            onClick={() => p.onJump(-1)}
          >
            <ChevronLeft size={12} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            title="next keyframe"
            aria-label={`next keyframe of ${label}`}
            disabled={!p.hasNext}
            onClick={() => p.onJump(1)}
          >
            <ChevronRight size={12} />
          </button>
          <select
            className="select props-ease"
            title="how the value moves from this keyframe to the next one"
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

interface BodyProps extends AnimFieldProps {
  start: number;
  duration: number;
  fps: number;
}

/** no keys: nothing here listens to the playhead */
function StaticBody(p: BodyProps & { stored: number }) {
  const { id, prop, start, duration } = p;
  const scale = p.scale ?? 1;
  const precision = p.precision ?? 0;
  const time = () => clamp(usePlayback.getState().time, start, start + duration);
  const jump = () => undefined;
  return (
    <FieldView
      {...p}
      value={Number((p.stored * scale).toFixed(precision))}
      animated={false}
      keyHere={false}
      hasPrev={false}
      hasNext={false}
      ease="ease"
      onValue={(v) => actions().setClipValue(id, prop, time(), v / scale, liveOpts())}
      onToggle={() => actions().toggleKeyframe(id, prop, time())}
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
  const { id, prop, keys, start, duration, fps } = p;
  const scale = p.scale ?? 1;
  const precision = p.precision ?? 0;
  const tol = 0.5 / fps;
  const f = 10 ** precision;

  const value = usePlayback((s) => Math.round(evalKeys(keys, s.time - start) * scale * f) / f);
  const keyHere = usePlayback((s) => keyIndexAt(keys, localTime(s.time, start, duration), tol) >= 0);
  const hasPrev = usePlayback((s) => {
    const l = localTime(s.time, start, duration);
    return keys.some((k) => k.t < l - tol);
  });
  const hasNext = usePlayback((s) => {
    const l = localTime(s.time, start, duration);
    return keys.some((k) => k.t > l + tol);
  });
  const ease = usePlayback((s) => keys[easeKeyIndex(keys, localTime(s.time, start, duration), tol)]!.ease);

  const now = () => usePlayback.getState().time;
  return (
    <FieldView
      {...p}
      value={value}
      animated
      keyHere={keyHere}
      hasPrev={hasPrev}
      hasNext={hasNext}
      ease={ease}
      onValue={(v) => actions().setClipValue(id, prop, clamp(now(), start, start + duration), v / scale, liveOpts())}
      onToggle={() => actions().toggleKeyframe(id, prop, clamp(now(), start, start + duration))}
      onJump={(dir) => {
        const l = localTime(now(), start, duration);
        const target = dir < 0 ? [...keys].reverse().find((k) => k.t < l - tol) : keys.find((k) => k.t > l + tol);
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
  const clip = useClip(props.id);
  const fps = useEditor((s) => s.project?.fps ?? 30);
  if (!clip) return null;
  const keys = clip.keyframes?.[props.prop];
  const body: BodyProps = { ...props, start: clip.start, duration: clip.duration, fps };
  if (keys && keys.length > 0) return <AnimatedBody key={props.prop} {...body} keys={keys} />;
  const stored = baseValue(clip, props.prop) ?? props.fallback ?? 0;
  return <StaticBody key={props.prop} {...body} stored={stored} />;
});
