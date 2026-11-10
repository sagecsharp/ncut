import { memo, useMemo } from 'react';
import { NumberField } from '../../components/ui/NumberField';
import {
  CLIP_MOTIONS_IN,
  CLIP_MOTIONS_LOOP,
  CLIP_MOTIONS_OUT,
  DEFAULT_CLIP_MOTION_IN,
  DEFAULT_CLIP_MOTION_LOOP,
  DEFAULT_CLIP_MOTION_OUT,
} from '../../engine/clipAnim';
import { MOTION_BLUR_STYLES } from '../../types';
import type { ClipAnim, MotionBlurStyle, VisualClip } from '../../types';
import { Row, Section, SliderRow, Switch } from './controls';
import { DEFAULT_MOTION_BLUR, setBlurStyle, setBlurValue } from './colorLogic';
import { visibleMotions } from './motionLogic';
import { beginEdit, patchClip } from './edit';

interface AnimRowProps {
  label: string;
  title: string;
  list: { id: string; name: string }[];
  value: ClipAnim | null | undefined;
  defaultDuration: number;
  durationTitle: string;
  /** live = the duration field is being scrubbed (one undo step per gesture) */
  onChange: (next: ClipAnim | null, live: boolean) => void;
}

/** none + a list of ready-made motions, with a duration field once one is picked. shared by text and clip motion. */
export function MotionRow({ label, title, list, value, defaultDuration, durationTitle, onChange }: AnimRowProps) {
  const known = value ? list.some((a) => a.id === value.id) : true;
  return (
    <Row label={label} title={title}>
      <select
        className="select"
        title={title}
        aria-label={title}
        value={value?.id ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : { id: e.target.value, duration: value?.duration ?? defaultDuration }, false)}
      >
        <option value="">none</option>
        {value && !known ? <option value={value.id}>{value.id}</option> : null}
        {list.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {value ? (
        <NumberField
          className="props-num"
          suffix="s"
          title={durationTitle}
          value={value.duration}
          min={0.1}
          max={10}
          step={0.1}
          precision={2}
          onStart={beginEdit}
          onChange={(v) => onChange({ id: value.id, duration: v }, true)}
        />
      ) : null}
    </Row>
  );
}

const BLUR_KINDS: Record<MotionBlurStyle, { label: string; title: string }> = {
  even: { label: 'smooth', title: 'smooth: an even smear of the whole movement' },
  trail: { label: 'trail', title: 'trail: the clip stays sharp where it is and leaves a fading tail behind it' },
  ghost: { label: 'ghost', title: 'ghost: a few separate see-through copies behind the clip (a strobe look)' },
};

export const ClipMotionSection = memo(function ClipMotionSection({ clip }: { clip: VisualClip }) {
  const id = clip.id;
  const threeD = !!clip.threeD;
  const listIn = useMemo(() => visibleMotions(CLIP_MOTIONS_IN, threeD, clip.motionIn?.id), [threeD, clip.motionIn?.id]);
  const listOut = useMemo(() => visibleMotions(CLIP_MOTIONS_OUT, threeD, clip.motionOut?.id), [threeD, clip.motionOut?.id]);
  const listLoop = useMemo(() => visibleMotions(CLIP_MOTIONS_LOOP, threeD, clip.motionLoop?.id), [threeD, clip.motionLoop?.id]);
  const set = (key: 'motionIn' | 'motionOut' | 'motionLoop') => (next: ClipAnim | null, live: boolean) => patchClip(id, { [key]: next }, live);
  return (
    <Section id="motion" title={clip.type === 'text' ? 'clip motion' : 'motion'}>
      <MotionRow
        label="in"
        title="how the clip appears"
        list={listIn}
        value={clip.motionIn}
        defaultDuration={DEFAULT_CLIP_MOTION_IN}
        durationTitle="how long the entrance takes (seconds)"
        onChange={set('motionIn')}
      />
      <MotionRow
        label="out"
        title="how the clip leaves"
        list={listOut}
        value={clip.motionOut}
        defaultDuration={DEFAULT_CLIP_MOTION_OUT}
        durationTitle="how long the exit takes (seconds)"
        onChange={set('motionOut')}
      />
      <MotionRow
        label="loop"
        title="a motion that repeats while the clip is on screen"
        list={listLoop}
        value={clip.motionLoop}
        defaultDuration={DEFAULT_CLIP_MOTION_LOOP}
        durationTitle="seconds per cycle"
        onChange={set('motionLoop')}
      />
      <Row label="motion blur" title="blur how the clip moves" wide>
        <Switch
          checked={!!clip.motionBlur}
          title="motion blur on or off"
          onChange={(on) => patchClip(id, { motionBlur: on ? { ...DEFAULT_MOTION_BLUR } : null })}
        />
      </Row>
      {clip.motionBlur ? (
        <>
          <Row label="kind" title="what the blur looks like">
            <div className="props-seg">
              {MOTION_BLUR_STYLES.map((k) => {
                const on = (clip.motionBlur?.style ?? 'even') === k;
                return (
                  <button
                    key={k}
                    type="button"
                    className={`btn btn-sm${on ? ' btn-primary' : ''}`}
                    title={BLUR_KINDS[k].title}
                    aria-pressed={on}
                    onClick={() => patchClip(id, { motionBlur: setBlurStyle(clip.motionBlur, k) })}
                  >
                    {BLUR_KINDS[k].label}
                  </button>
                );
              })}
            </div>
          </Row>
          <SliderRow
            label="amount"
            title="how long the shutter stays open, as a share of one frame (%)"
            value={Math.round(clip.motionBlur.shutter * 100)}
            min={0}
            max={200}
            suffix="%"
            disabled={!!clip.threeD}
            onChange={(v) => patchClip(id, { motionBlur: setBlurValue(clip.motionBlur, 'shutter', v / 100) }, true)}
          />
          <SliderRow
            label="smoothness"
            title="how many copies are mixed. more is smoother and slower."
            value={clip.motionBlur.samples}
            min={2}
            max={32}
            disabled={!!clip.threeD}
            onChange={(v) => patchClip(id, { motionBlur: setBlurValue(clip.motionBlur, 'samples', v) }, true)}
          />
        </>
      ) : null}
      <div className="props-hint">
        blurs how the clip moves (keyframes, motions). for 3d clips use the motion blur effect instead
      </div>
    </Section>
  );
});
