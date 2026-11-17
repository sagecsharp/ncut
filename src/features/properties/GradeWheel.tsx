import { memo, useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { Diamond, RotateCcw } from 'lucide-react';
import { valueAt } from '../../lib/anim';
import { puckOf } from '../../lib/gradeMath';
import type { Rgb3 } from '../../lib/gradeMath';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import type { EffectClip, VisualClip } from '../../types';
import { tip } from '../shell/tip';
import { AnimField } from './AnimField';
import { setValuesNow } from './animEdit';
import { beginEdit, cancelEdit, endEdit, liveOpts } from './edit';
import type { FeelKey } from './fieldFeel';
import { dragWheel, grabWheel, nudgeWheel, wheelAria, wheelKeyPlan, wheelKeyState, wheelRingCss, wheelText } from './gradeLogic';
import type { WheelGrab, WheelId } from './gradeLogic';
import type { GradeValues } from './useGradeValues';

/** the hue ring is the same for every wheel */
const RING = `radial-gradient(circle closest-side, var(--grade-mid), transparent), ${wheelRingCss()}`;

const WORD: Record<WheelId, string> = { lift: 'darks', gamma: 'mids', gain: 'lights', offset: 'all' };

const WHEEL_TIPS: Record<WheelId, string> = {
  lift: 'the dark parts move most, white stays. drag the dot toward a color to tint the shadows',
  gamma: 'the middle tones move, black and white stay',
  gain: 'the bright parts move most, black stays',
  offset: 'every tone moves the same, a quick fix for a color cast',
};

const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
const PARTS = ['R', 'G', 'B'] as const;

const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

interface GradeWheelProps {
  clip: VisualClip | EffectClip;
  wheel: WheelId;
  values: GradeValues;
  disabled: boolean;
}

/** one grade wheel: the face with its dot, the key diamond, the reset, the readout and the level */
export const GradeWheel = memo(function GradeWheel({ clip, wheel, values, disabled }: GradeWheelProps) {
  const id = clip.id;
  const face = useRef<HTMLDivElement>(null);
  const grab = useRef<WheelGrab | null>(null);
  const radius = useRef(48);
  const t0 = useRef(0);
  const mods = useRef({ shift: false, ctrl: false });

  const rgb: Rgb3 = [values[`${wheel}R`], values[`${wheel}G`], values[`${wheel}B`]];
  const level = values[`${wheel}Y`];
  const puck = puckOf(rgb);

  const fps = useEditor((s) => s.project?.fps ?? 30);
  const tol = 0.5 / fps;
  const end = clip.start + clip.duration;
  const hasKeys = PARTS.some((p) => (clip.keyframes?.[`grade.${wheel}${p}`]?.length ?? 0) > 0);
  // a string, so the diamond renders when its look changes and not on every frame
  const keyState = usePlayback((s) => (hasKeys ? wheelKeyState(clip.keyframes, wheel, clamp(s.time, clip.start, end) - clip.start, tol) : 'none'));

  /** the clip as the store has it now */
  const clipNow = () => useEditor.getState().project?.clips.find((c) => c.id === id);
  const timeNow = (): number => {
    const c = clipNow();
    const t = usePlayback.getState().time;
    return c ? clamp(t, c.start, c.start + c.duration) : t;
  };
  const rgbAt = (time: number): Rgb3 => {
    const c = clipNow();
    return PARTS.map((p) => (c ? (valueAt(c, `grade.${wheel}${p}`, time) ?? 0) : 0)) as Rgb3;
  };
  const write = (time: number, next: Rgb3): void => {
    useEditor.getState().setClipValues(PARTS.map((p, i) => ({ id, prop: `grade.${wheel}${p}`, time, value: next[i]! })), liveOpts());
  };
  /** the gesture is over: forget it, and arm the next one while the face keeps the focus */
  const finish = (): void => {
    if (!grab.current) return;
    grab.current = null;
    endEdit();
    if (face.current && document.activeElement === face.current) beginEdit();
  };

  const onDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (disabled) return;
    if (e.button === 2) {
      if (grab.current) {
        cancelEdit();
        grab.current = null;
        beginEdit();
      }
      return;
    }
    if (e.button !== 0) return;
    const c = clipNow();
    if (!c) return;
    const pb = usePlayback.getState();
    if (PARTS.some((p) => (c.keyframes?.[`grade.${wheel}${p}`]?.length ?? 0) > 0) && pb.playing) pb.pause();
    t0.current = timeNow();
    const r = e.currentTarget.getBoundingClientRect();
    radius.current = Math.max(1, Math.min(r.width, r.height) / 2);
    e.currentTarget.setPointerCapture(e.pointerId);
    beginEdit();
    mods.current = { shift: e.shiftKey, ctrl: e.ctrlKey };
    grab.current = grabWheel(wheel, rgbAt(t0.current), e.clientX, e.clientY, e.shiftKey);
  };

  const onMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!grab.current) return;
    if (e.button === 2) {
      // the right button during a left drag comes as a move
      e.preventDefault();
      cancelEdit();
      grab.current = null;
      beginEdit();
      return;
    }
    if (e.shiftKey !== mods.current.shift || e.ctrlKey !== mods.current.ctrl) {
      // a changed modifier starts a new relative drag from where the dot is now
      mods.current = { shift: e.shiftKey, ctrl: e.ctrlKey };
      grab.current = grabWheel(wheel, rgbAt(t0.current), e.clientX, e.clientY, e.shiftKey);
    }
    write(t0.current, dragWheel(grab.current, e.clientX, e.clientY, radius.current, e.ctrlKey));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    if (ARROWS.includes(e.key)) {
      e.preventDefault();
      const t = timeNow();
      write(t, nudgeWheel(rgbAt(t), e.key, e.shiftKey));
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      write(timeNow(), [0, 0, 0]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
      grab.current = null;
      beginEdit();
    }
  };

  const toggleKeys = (): void => {
    const c = clipNow();
    if (!c) return;
    const t = timeNow();
    const plan = wheelKeyPlan(c.keyframes, wheel, t - c.start, tol);
    if (plan.add.length + plan.remove.length === 0) return;
    const st = useEditor.getState();
    st.pushHistory();
    for (const prop of plan.add) st.setKeyframe(id, prop, t, undefined, undefined, { skipHistory: true });
    for (const prop of plan.remove) st.removeKeyframe(id, prop, t, tol, { skipHistory: true });
  };

  const levelProp = `grade.${wheel}Y`;
  return (
    <div className="grade-wheel">
      <div className="grade-wheel-head">
        <span className="grade-wheel-name">
          {wheel}
          <span className="grade-wheel-word">{WORD[wheel]}</span>
        </span>
        <button
          type="button"
          className={`icon-btn grade-mini props-diamond${keyState !== 'none' ? ' is-animated' : ''}${keyState === 'full' ? ' is-key' : ''}`}
          {...tip('keyframe', { does: "a key for this wheel's color at the playhead. click again to take it off" })}
          aria-label={`keyframe for the color of ${wheel}`}
          aria-pressed={keyState === 'full'}
          onClick={toggleKeys}
        >
          <Diamond size={12} fill={keyState === 'full' ? 'currentColor' : 'none'} />
        </button>
        <button
          type="button"
          className="icon-btn grade-mini"
          {...tip('reset', { does: 'color and level back to no change' })}
          aria-label={`reset ${wheel}`}
          onClick={() => setValuesNow(id, { [`grade.${wheel}R`]: 0, [`grade.${wheel}G`]: 0, [`grade.${wheel}B`]: 0, [levelProp]: 0 })}
        >
          <RotateCcw size={12} />
        </button>
      </div>
      <div
        ref={face}
        className={`grade-face${disabled ? ' is-disabled' : ''}`}
        style={{ backgroundImage: RING }}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-roledescription="color wheel"
        aria-label={`${wheel} color`}
        aria-disabled={disabled || undefined}
        aria-valuetext={wheelAria(wheel, rgb, level)}
        {...tip(wheel, {
          does: WHEEL_TIPS[wheel],
          keys: ['grade-wheel-drag', 'grade-wheel-fine', 'grade-wheel-hue', 'grade-wheel-reset', 'grade-wheel-keys'],
        })}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={finish}
        onLostPointerCapture={finish}
        onContextMenu={(e) => e.preventDefault()}
        onDoubleClick={() => {
          if (!disabled) setValuesNow(id, { [`grade.${wheel}R`]: 0, [`grade.${wheel}G`]: 0, [`grade.${wheel}B`]: 0 });
        }}
        onKeyDown={onKey}
        onFocus={() => {
          if (!disabled && !grab.current) beginEdit();
        }}
        onBlur={() => {
          grab.current = null;
          endEdit();
        }}
      >
        <svg className="grade-face-svg" viewBox="-1 -1 2 2" preserveAspectRatio="none" aria-hidden="true">
          <line className="grade-cross" x1="-1" y1="0" x2="1" y2="0" />
          <line className="grade-cross" x1="0" y1="-1" x2="0" y2="1" />
          <line className="grade-pull" x1="0" y1="0" x2={puck.x} y2={-puck.y} />
          {puck.beyond ? <line className="grade-tick" x1={puck.x * 0.86} y1={-puck.y * 0.86} x2={puck.x} y2={-puck.y} /> : null}
          <circle className="grade-dot" cx={puck.x} cy={-puck.y} r="0.1" />
        </svg>
      </div>
      <div className="grade-readout">{wheelText(rgb)}</div>
      <div className="grade-level" inert={disabled || undefined}>
        <AnimField id={id} prop={levelProp} label="level" title={`${wheel} level, red, green and blue together (-100 to 100)`} feel={`grade${cap(wheel)}Y` as FeelKey} />
      </div>
    </div>
  );
});
