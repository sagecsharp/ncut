import { memo } from 'react';
import { Crosshair } from 'lucide-react';
import type { Track } from '../../types';
import { useEditor } from '../../store/editorStore';
import { useSource } from '../../store/source';
import { useUi } from '../../store/ui';
import { REASON_TEXT } from '../shell/reasons';
import { tip } from '../shell/tip';
import { landsOn } from './editPlan';
import { toggleTargetOf, useIsTarget, useTargets } from './editTargets';
import { useSoundApart } from './soundSetting';
import './editTargets.css';

/** the crosshair of a track header: where the picture or the sound of an edit from the source view goes. mounted only while the source view has media */
export const TargetToggle = memo(function TargetToggle({ track }: { track: Track }) {
  const on = useIsTarget(track);
  const targets = useTargets();
  const apart = useSoundApart((s) => s.apart);
  const assetId = useSource((s) => s.assetId);
  const kind = useEditor((s) => s.project?.assets.find((a) => a.id === assetId)?.kind ?? null);
  const hasAudio = useEditor((s) => s.project?.assets.find((a) => a.id === assetId)?.hasAudio ?? false);
  const part = track.kind === 'video' ? 'picture' : 'sound';
  const name = `${part} target`;
  const lands = on && kind !== null && landsOn(track.kind, { kind, hasAudio }, targets.picture !== false, apart);
  const does =
    !on || lands
      ? `insert, overwrite, fit and append put the ${part} on this track. a click on the lit one turns the ${part} off`
      : track.kind === 'video'
        ? 'the picture target. a sound file has no picture, so nothing lands here'
        : kind === 'video' && hasAudio
          ? 'the sound target. this video keeps its sound in its own clip, so nothing lands here. "separate sound on drop" in the settings changes that'
          : 'the sound target. this media has no sound, so nothing lands here';
  return (
    <>
      <button
        type="button"
        className={`icon-btn icon-btn-sm timeline-head-target${on ? ' is-active' : ''}`}
        aria-label={name}
        aria-pressed={on}
        onClick={() => {
          if (!toggleTargetOf(track)) useUi.getState().toast(REASON_TEXT.trackLocked);
        }}
        {...tip(name, { does, on, off: track.locked && !on ? REASON_TEXT.trackLocked : null })}
      >
        <Crosshair size={13} />
      </button>
      {lands ? <span className={`timeline-head-target-bar${track.locked ? ' is-locked' : ''}`} aria-hidden="true" /> : null}
    </>
  );
});
