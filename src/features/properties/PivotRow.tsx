import { memo } from 'react';
import { LocateFixed } from 'lucide-react';
import { percentOf } from '../../components/ui/numberFormat';
import { PIVOT_SPOTS, pivotOf, spotOf } from '../../engine/pivot';
import type { PivotSpot } from '../../engine/pivot';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { isVisualClip } from '../../types';
import type { Clip } from '../../types';
import { usePivotMode } from '../preview/pivotMode';
import { tip } from '../shell/tip';
import { Row, SliderRow } from './controls';
import { pivotModeBlocker, setPivot, setPivotAxis } from './pivotActions';

/** a live pivot step plans at the playhead: playing would move it every step */
const pauseForPivot = () => {
  const pb = usePlayback.getState();
  if (pb.playing) pb.pause();
};

/** what each dot says it does, in PIVOT_SPOTS order */
const SPOT_TITLES: readonly string[] = [
  'rotate and scale around the top left corner',
  'rotate and scale around the middle of the top edge',
  'rotate and scale around the top right corner',
  'rotate and scale around the middle of the left edge',
  'rotate and scale around the middle (no pivot)',
  'rotate and scale around the middle of the right edge',
  'rotate and scale around the bottom left corner',
  'rotate and scale around the middle of the bottom edge',
  'rotate and scale around the bottom right corner',
];

/** nine spot buttons. `value` = the lit spot (null = none lit). used by the transform section and the multi inspector */
export function PivotDots({ value, onPick, disabled }: { value: PivotSpot | null; onPick(spot: PivotSpot): void; disabled?: boolean }) {
  return (
    <div className="pivot-dots" role="group" aria-label="pivot spot">
      {PIVOT_SPOTS.map((s, i) => (
        <button
          key={s.id}
          type="button"
          className={`pivot-dot${value?.id === s.id ? ' is-active' : ''}`}
          {...tip(`pivot ${s.label}`, { does: SPOT_TITLES[i] })}
          aria-label={`pivot ${s.label}`}
          aria-pressed={value?.id === s.id}
          disabled={disabled}
          onClick={() => onPick(s)}
        />
      ))}
    </div>
  );
}

const pivotX = (c: Clip | undefined): number => (c && isVisualClip(c) ? pivotOf(c).x : 0);
const pivotY = (c: Clip | undefined): number => (c && isVisualClip(c) ? pivotOf(c).y : 0);

const KEYED = ['rotation', 'scale', 'scaleX', 'scaleY', 'rotX', 'rotY'] as const;

/** the pivot of one clip: the dots, x / y in % of its box and the move pivot mode. every change keeps the clip in place */
export const PivotRow = memo(function PivotRow({ id }: { id: string }) {
  // selectors return numbers, booleans and strings, so the row renders only when what it shows changes
  const x = useEditor((s) => pivotX(s.project?.clips.find((c) => c.id === id)));
  const y = useEditor((s) => pivotY(s.project?.clips.find((c) => c.id === id)));
  const locked = useEditor((s) => {
    const c = s.project?.clips.find((k) => k.id === id);
    return !!c && !!s.project?.tracks.find((t) => t.id === c.trackId)?.locked;
  });
  const hasKeys = useEditor((s) => {
    const c = s.project?.clips.find((k) => k.id === id);
    return !!c && KEYED.some((k) => (c.keyframes?.[k]?.length ?? 0) > 0);
  });
  const hasMotion = useEditor((s) => {
    const c = s.project?.clips.find((k) => k.id === id);
    return !!c && isVisualClip(c) && !!(c.motionIn || c.motionOut || c.motionLoop);
  });
  const looks = useEditor((s) => {
    const c = s.project?.clips.find((k) => k.id === id);
    return !!c && isVisualClip(c) && !!c.threeD && !!c.lookAt;
  });
  const on = usePivotMode((s) => s.on);
  const spot = spotOf({ x, y });
  const set = x !== 0 || y !== 0;

  const toggle = () => {
    if (on) {
      usePivotMode.getState().set(false);
      return;
    }
    const st = useEditor.getState();
    const why = pivotModeBlocker(st.project, [id]);
    if (why) {
      useUi.getState().toast(why);
      return;
    }
    // the mode works on the selected clip
    if (st.selection.length !== 1 || st.selection[0] !== id) st.select([id]);
    usePivotMode.getState().set(true);
  };

  return (
    <>
      <Row label="pivot" title="the point it rotates and scales around. pos x / y say where it is. the clip stays where it is when the pivot changes">
        <PivotDots value={spot} disabled={locked} onPick={(s) => setPivot(id, s.x === 0 && s.y === 0 ? null : { x: s.x, y: s.y })} />
      </Row>
      <SliderRow
        label="pivot x"
        feel="pivotX"
        title="the pivot left or right of the middle, in % of the clip's width (-50 = left edge, 50 = right edge)"
        value={percentOf(x)}
        disabled={locked}
        onStart={pauseForPivot}
        onChange={(v) => setPivotAxis(id, 'x', v / 100)}
      />
      <SliderRow
        label="pivot y"
        feel="pivotY"
        title="the pivot above or below the middle, in % of the clip's height (-50 = top edge, 50 = bottom edge)"
        value={percentOf(y)}
        disabled={locked}
        onStart={pauseForPivot}
        onChange={(v) => setPivotAxis(id, 'y', v / 100)}
      />
      <div className="props-buttons">
        <button
          type="button"
          className={`btn btn-sm${on ? ' is-active' : ''}`}
          aria-pressed={on}
          disabled={locked}
          title={locked ? 'this track is locked' : on ? 'done moving the pivot (esc)' : 'drag the pivot on the preview, or press where it goes. the clip stays where it is'}
          onClick={toggle}
        >
          <LocateFixed size={14} />
          move pivot
        </button>
      </div>
      {on ? (
        <div className="props-hint">
          drag the pivot on the preview, or press where it goes. it snaps to the corners, edges and middle and to other clips (alt: no snapping). esc: done
        </div>
      ) : null}
      {set && (hasKeys || hasMotion) ? (
        <div className="props-hint">its rotation or size has keys or a motion: a new pivot keeps it in place at the playhead (without the motion) and changes how it rotates elsewhere</div>
      ) : null}
      {looks ? (
        <div className="props-hint">it looks at something: a new pivot changes where it looks from, so a big picture can turn and shift a little</div>
      ) : null}
    </>
  );
});

