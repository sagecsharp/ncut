import { Contrast } from 'lucide-react';
import { MATTE_MODE_WORDS, matteState } from '../../engine/matte';
import { useEditor } from '../../store/editorStore';
import type { ClipMatte } from '../../types';
import { clipDisplayName } from './effectTarget';
import './matteMark.css';

/** small mark for a clip with a matte. only mounted for those, so it is the only one subscribing. one string: the name and what the matte does now. */
export function MatteMark({ clipId, matte }: { clipId: string; matte: ClipMatte }) {
  const text = useEditor((s) => {
    const p = s.project;
    const src = p?.clips.find((c) => c.id === matte.clip);
    const name = src ? clipDisplayName(src) : 'a clip that is gone';
    const state = p ? matteState(p, clipId) : 'none';
    return state === 'on' || state === 'apart' ? `matte: ${name}, ${MATTE_MODE_WORDS[matte.mode]}` : `matte: ${name}, off`;
  });
  const off = text.endsWith(', off');
  return (
    <Contrast size={11} aria-label={text} className={off ? 'timeline-clip-icon is-off' : 'timeline-clip-icon'}>
      <title>{text}</title>
    </Contrast>
  );
}
