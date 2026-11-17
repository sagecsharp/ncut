import { memo } from 'react';
import { AudioLines, Film, Merge, MoveHorizontal, Split } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useEditor } from '../../store/editorStore';
import { tip } from '../shell/tip';
import { markFollowGesture } from '../timeline/followApply';
import { joinSoundNow, selectSideNow, separateSoundNow, setPairSpeed, syncSoundNow } from '../timeline/soundActions';
import { pairSummary } from '../timeline/soundPlan';
import { FeelField, Row, Section } from './controls';
import { beginEdit } from './edit';

const SPEED_PRESETS = [0.5, 1, 1.5, 2];

/** picture and sound of a video as two clips: separate, join, speed and sync of the selected pairs */
export const PairSection = memo(function PairSection({ ids }: { ids: readonly string[] }) {
  const sum = useEditor(useShallow((s) => pairSummary(s.project, ids)));
  if (sum.pairs + sum.separable === 0) return null;
  const joinOff = typeof sum.joinWhy === 'string' ? sum.joinWhy : null;
  return (
    <Section id="m-sound" title="picture and sound">
      {sum.pairs > 0 ? (
        <>
          <Row label="speed" title="speed of picture and sound together (0.25 to 4): they stay in sync">
            <FeelField
              feel="speed"
              title="speed of picture and sound together (0.25 to 4): they stay in sync"
              value={sum.speed}
              onStart={() => {
                beginEdit();
                markFollowGesture();
              }}
              onChange={(v) => setPairSpeed(ids, v, true)}
            />
          </Row>
          <div className="props-buttons">
            {SPEED_PRESETS.map((p) => {
              const cls = Math.abs(sum.speed - p) < 0.001 ? 'btn btn-sm btn-primary' : 'btn btn-sm';
              return (
                <button
                  key={p}
                  type="button"
                  className={cls}
                  {...tip(`${p}x`, { does: `set the speed of picture and sound to ${p}x` })}
                  onClick={() => setPairSpeed(ids, p, false)}
                >
                  {p}x
                </button>
              );
            })}
          </div>
        </>
      ) : null}
      <div className="props-buttons">
        {sum.separable > 0 ? (
          <button
            type="button"
            className="btn btn-sm"
            {...tip('separate sound', { does: 'put the sound on an audio track as a clip of its own, grouped with the picture', keys: 'separate-sound' })}
            onClick={() => separateSoundNow(ids)}
          >
            <Split size={14} />
            separate sound
          </button>
        ) : null}
        {sum.pairs > 0 ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={joinOff !== null}
            {...tip('join sound back', { does: 'remove the sound clip: the picture plays its own sound again', keys: 'separate-sound', off: joinOff })}
            onClick={() => joinSoundNow(ids)}
          >
            <Merge size={14} />
            join sound back
          </button>
        ) : null}
        {sum.outOfSync > 0 ? (
          <button
            type="button"
            className="btn btn-sm"
            {...tip('move into sync', { does: 'move the selected clips into sync with their picture or sound' })}
            onClick={() => syncSoundNow(ids, 'move')}
          >
            <MoveHorizontal size={14} />
            move into sync
          </button>
        ) : null}
        {sum.pairs > 0 ? (
          <>
            <button
              type="button"
              className="btn btn-sm"
              {...tip('select only the sound', { does: 'select only the sound of the selected clips' })}
              onClick={() => selectSideNow(ids, 'sound')}
            >
              <AudioLines size={14} />
              select only the sound
            </button>
            <button
              type="button"
              className="btn btn-sm"
              {...tip('select only the picture', { does: 'select only the picture of the selected clips' })}
              onClick={() => selectSideNow(ids, 'picture')}
            >
              <Film size={14} />
              select only the picture
            </button>
          </>
        ) : null}
      </div>
      <div className="props-hint">alt+click one side, or select only the sound, to trim it alone: a j cut or an l cut</div>
    </Section>
  );
});
