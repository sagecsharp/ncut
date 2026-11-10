import { memo } from 'react';
import { NumberField } from '../../components/ui/NumberField';
import {
  CLIP_MOTIONS_IN,
  CLIP_MOTIONS_LOOP,
  CLIP_MOTIONS_OUT,
  DEFAULT_CLIP_MOTION_IN,
  DEFAULT_CLIP_MOTION_LOOP,
  DEFAULT_CLIP_MOTION_OUT,
} from '../../engine/clipAnim';
import type { ClipAnim, VisualClip } from '../../types';
import { Row, Section } from './controls';
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

export const ClipMotionSection = memo(function ClipMotionSection({ clip }: { clip: VisualClip }) {
  const id = clip.id;
  const set = (key: 'motionIn' | 'motionOut' | 'motionLoop') => (next: ClipAnim | null, live: boolean) => patchClip(id, { [key]: next }, live);
  return (
    <Section id="motion" title={clip.type === 'text' ? 'clip motion' : 'motion'}>
      <MotionRow
        label="in"
        title="how the clip appears"
        list={CLIP_MOTIONS_IN}
        value={clip.motionIn}
        defaultDuration={DEFAULT_CLIP_MOTION_IN}
        durationTitle="how long the entrance takes (seconds)"
        onChange={set('motionIn')}
      />
      <MotionRow
        label="out"
        title="how the clip leaves"
        list={CLIP_MOTIONS_OUT}
        value={clip.motionOut}
        defaultDuration={DEFAULT_CLIP_MOTION_OUT}
        durationTitle="how long the exit takes (seconds)"
        onChange={set('motionOut')}
      />
      <MotionRow
        label="loop"
        title="a motion that repeats while the clip is on screen"
        list={CLIP_MOTIONS_LOOP}
        value={clip.motionLoop}
        defaultDuration={DEFAULT_CLIP_MOTION_LOOP}
        durationTitle="seconds per cycle"
        onChange={set('motionLoop')}
      />
    </Section>
  );
});
