import { useShallow } from 'zustand/react/shallow';
import { SHAPE_NAME, readShape, soundIndex } from '../../lib/audioCross';
import { FADE_SHAPES } from '../../types';
import type { FadeShape } from '../../types';
import { useEditor } from '../../store/editorStore';
import { Pair, Row } from './controls';

const SHAPES: readonly FadeShape[] = ['linear', ...FADE_SHAPES.filter((s) => s !== 'linear')];

/** the shape of the fades of the sound: linear is the old fade. a fade of 0 or a crossfaded end has nothing to shape */
export function FadeShapeRow({ id }: { id: string }) {
  // only the six values it draws: an edit elsewhere does not re-render this
  const [fadeIn, fadeOut, inShape, outShape, xin, xout] = useEditor(
    useShallow((s) => {
      const p = s.project;
      const c = p?.clips.find((x) => x.id === id);
      if (!p || !c || (c.type !== 'video' && c.type !== 'audio')) return [-1, 0, undefined, undefined, false, false] as const;
      const snd = soundIndex(p).get(id);
      return [c.fadeIn, c.fadeOut, c.fadeInShape, c.fadeOutShape, !!snd?.xin, !!snd?.xout] as const;
    }),
  );
  if (fadeIn < 0) return null;
  const shapes = { fadeInShape: inShape, fadeOutShape: outShape };
  const set = (which: 'fadeInShape' | 'fadeOutShape', v: string): void => {
    useEditor.getState().updateClip(id, { [which]: v === 'linear' ? null : (v as FadeShape) });
  };
  const one = (which: 'fadeInShape' | 'fadeOutShape', label: 'in' | 'out', fade: number, crossed: boolean) => (
    <>
      <span className="field-label">{label}</span>
      {crossed ? (
        <select className="select props-grow" title={`the ${label} of this clip is a crossfade`} aria-label={`sound shape ${label}`} value="crossfade" disabled>
          <option value="crossfade">crossfade</option>
        </select>
      ) : (
        <select
          className="select props-grow"
          title={`the shape of the fade ${label}`}
          aria-label={`sound shape ${label}`}
          value={readShape(shapes[which], 'linear')}
          disabled={fade <= 0}
          onChange={(e) => set(which, e.target.value)}
        >
          {SHAPES.map((s) => (
            <option key={s} value={s}>
              {SHAPE_NAME[s]}
            </option>
          ))}
        </select>
      )}
    </>
  );
  return (
    <Row label="shape" title="the shape of the fade for the sound. the picture always fades straight">
      <Pair>
        {one('fadeInShape', 'in', fadeIn, xin)}
        {one('fadeOutShape', 'out', fadeOut, xout)}
      </Pair>
    </Row>
  );
}
