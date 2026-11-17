import { useMemo } from 'react';
import { valueAt } from '../../lib/anim';
import { GRADE_KEYS, GRADE_PROPS } from '../../lib/gradeData';
import type { GradeKey } from '../../lib/gradeData';
import { clamp } from '../../lib/time';
import { usePlayback } from '../../store/playback';
import type { Clip } from '../../types';

export type GradeValues = Readonly<Record<GradeKey, number>>;

/** the 16 numbers at a time, as one text (the selector of a store hook must return something that compares equal) */
function textAt(clip: Clip, time: number): string {
  const t = clamp(time, clip.start, clip.start + clip.duration);
  return GRADE_PROPS.map((p) => Math.round((valueAt(clip, p, t) ?? 0) * 1e4) / 1e4).join(',');
}

/**
 * the 16 wheel numbers of a clip at the playhead (held inside the clip). the playhead is read only when the clip has a
 * key on a grade number, so a still grade never renders on a frame
 */
export function useGradeValues(clip: Clip): GradeValues {
  const keyed = GRADE_PROPS.some((p) => (clip.keyframes?.[p]?.length ?? 0) > 0);
  const still = useMemo(() => textAt(clip, clip.start), [clip]);
  const text = usePlayback((s) => (keyed ? textAt(clip, s.time) : still));
  return useMemo(() => {
    const parts = text.split(',');
    const out = {} as Record<GradeKey, number>;
    GRADE_KEYS.forEach((k, i) => {
      out[k] = Number(parts[i]) || 0;
    });
    return out;
  }, [text]);
}
