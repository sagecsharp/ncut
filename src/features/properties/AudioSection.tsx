import { memo } from 'react';
import { AudioLines, Film, Merge, Split } from 'lucide-react';
import { useEditor } from '../../store/editorStore';
import { tip } from '../shell/tip';
import { TrackMixRow } from '../media/mixer/TrackMixRow';
import { joinSoundNow, selectSideNow, separateSoundNow } from '../timeline/soundActions';
import { soundMenu, soundRole } from '../timeline/soundPlan';
import { AnimField } from './AnimField';
import { Row, Section } from './controls';

const actions = () => useEditor.getState();

/* ---------- audio ---------- */

export const AudioSection = memo(function AudioSection({ id, muted }: { id: string; muted: boolean }) {
  const role = useEditor((s) => (s.project ? soundRole(s.project, id) : 'none'));
  // 'yes' = can join, a string = why not, null = nothing to join
  const join = useEditor((s) => (s.project && (role === 'apart' || role === 'sound') ? soundMenu(s.project, [id], id).join : null));
  const joinOff = join !== null && join !== 'yes' ? join : null;
  const joinButton = (
    <button
      type="button"
      className="btn btn-sm"
      disabled={joinOff !== null}
      {...tip('join sound back', { does: 'remove the sound clip: the picture plays its own sound again', keys: 'separate-sound', off: joinOff })}
      onClick={() => joinSoundNow([id])}
    >
      <Merge size={14} />
      join sound back
    </button>
  );

  if (role === 'apart') {
    return (
      <Section id="audio" title="audio">
        <div className="props-hint">the sound of this video is a clip of its own on an audio track: volume, pan, mute and tempo are set there</div>
        <div className="props-buttons">
          <button
            type="button"
            className="btn btn-sm"
            {...tip('select the sound', { does: 'select the sound clip alone, to trim it on its own (a j or l cut)' })}
            onClick={() => selectSideNow([id], 'sound')}
          >
            <AudioLines size={14} />
            select the sound
          </button>
          {joinButton}
        </div>
      </Section>
    );
  }
  return (
    <Section id="audio" title="audio">
      <AnimField id={id} prop="volume" label="volume" title="volume (%)" feel="volume" />
      <AnimField id={id} prop="pan" label="pan" title="pan: where the sound sits, from the left (-100) to the right (100) speaker. 0 = the middle" feel="soundPan" />
      <Row label="mute" title="mute this clip: no sound from it">
        <input
          type="checkbox"
          className="checkbox"
          title="mute"
          checked={muted}
          onChange={(e) => actions().updateClip(id, { muted: e.target.checked })}
        />
      </Row>
      <TrackMixRow id={id} />
      {role === 'sound' ? (
        <>
          <div className="props-hint">the sound of a video</div>
          <div className="props-buttons">
            <button
              type="button"
              className="btn btn-sm"
              {...tip('select the picture', { does: 'select the picture alone, to trim it on its own' })}
              onClick={() => selectSideNow([id], 'picture')}
            >
              <Film size={14} />
              select the picture
            </button>
            {joinButton}
          </div>
        </>
      ) : null}
      {role === 'separable' ? (
        <div className="props-buttons">
          <button
            type="button"
            className="btn btn-sm"
            {...tip('separate sound', { does: 'put the sound on an audio track as a clip of its own, grouped with this video', keys: 'separate-sound' })}
            onClick={() => separateSoundNow([id])}
          >
            <Split size={14} />
            separate sound
          </button>
        </div>
      ) : null}
    </Section>
  );
});
