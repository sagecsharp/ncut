import { roundShown } from '../../components/ui/numberFormat';
import { memo, useMemo } from 'react';
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
import { FeelField, Row, Section, SliderRow, Switch } from './controls';
import type { FeelKey } from './fieldFeel';
import { DEFAULT_MOTION_BLUR, setBlurStyle, setBlurValue } from './colorLogic';
import { visibleMotions } from './motionLogic';
import { patchClip } from './edit';

interface AnimRowProps {
  label: string;
  title: string;
  list: { id: string; name: string }[];
  value: ClipAnim | null | undefined;
  defaultDuration: number;
  durationTitle: string;
  /** the duration field's feel: the in and out time or the loop time */
  feel: Extract<FeelKey, 'motionDuration' | 'motionLoop'>;
  /** live = the duration field is being scrubbed (one undo step per gesture) */
  onChange: (next: ClipAnim | null, live: boolean) => void;
  /** several clips that differ here: the list shows "mixed" until something is picked (it then goes to all of them) */
  mixed?: boolean;
}

const MIXED = '__mixed';

/** none + a list of ready-made motions, with a duration field once one is picked. shared by text and clip motion. */
export function MotionRow({ label, title, list, value, defaultDuration, durationTitle, feel, onChange, mixed = false }: AnimRowProps) {
  const known = value ? list.some((a) => a.id === value.id) : true;
  return (
    <Row label={label} title={title}>
      <select
        className="select"
        title={title}
        aria-label={title}
        value={mixed ? MIXED : (value?.id ?? '')}
        onChange={(e) => {
          if (e.target.value === MIXED) return;
          onChange(e.target.value === '' ? null : { id: e.target.value, duration: value?.duration ?? defaultDuration }, false);
        }}
      >
        {mixed ? (
          <option value={MIXED} disabled>
            mixed
          </option>
        ) : null}
        <option value="">none</option>
        {value && !known ? <option value={value.id}>{value.id}</option> : null}
        {list.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {value ? (
        <FeelField
          className="props-num"
          feel={feel}
          rest={defaultDuration}
          title={durationTitle}
          value={value.duration}
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
        feel="motionDuration"
        onChange={set('motionIn')}
      />
      <MotionRow
        label="out"
        title="how the clip leaves"
        list={listOut}
        value={clip.motionOut}
        defaultDuration={DEFAULT_CLIP_MOTION_OUT}
        durationTitle="how long the exit takes (seconds)"
        feel="motionDuration"
        onChange={set('motionOut')}
      />
      <MotionRow
        label="loop"
        title="a motion that repeats while the clip is on screen"
        list={listLoop}
        value={clip.motionLoop}
        defaultDuration={DEFAULT_CLIP_MOTION_LOOP}
        durationTitle="seconds per cycle"
        feel="motionLoop"
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
            label="shutter"
            title="how long the shutter stays open, as a share of one frame (%)"
            value={roundShown(clip.motionBlur.shutter * 100, 0)}
            feel="blurAmount"
            onChange={(v) => patchClip(id, { motionBlur: setBlurValue(clip.motionBlur, 'shutter', v / 100) }, true)}
          />
          <SliderRow
            label="smoothness"
            title="how many copies are mixed. more is smoother and slower."
            value={clip.motionBlur.samples}
            feel="blurSmoothness"
            onChange={(v) => patchClip(id, { motionBlur: setBlurValue(clip.motionBlur, 'samples', v) }, true)}
          />
        </>
      ) : null}
      <div className="props-hint">
        blurs how the clip moves (keyframes, motions), in 2d and in 3d. a camera move is blurred by the motion blur effect
      </div>
    </Section>
  );
});
