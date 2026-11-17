import { memo } from 'react';
import { Headphones, Volume2, VolumeX } from 'lucide-react';
import type { Track } from '../../../types';
import type { ActionOpts } from '../../../store/editorStore';
import { useEditor } from '../../../store/editorStore';
import { useSolo } from '../../../store/solo';
import { outputGain, soloSet, trackPan, trackVolume } from '../../../lib/mix';
import { OUTPUT_TAP } from '../../preview/meterTaps';
import { FeelField } from '../../properties/controls';
import { liveOpts } from '../../properties/edit';
import { tip } from '../../shell/tip';
import { DbField } from './DbField';
import { Fader } from './Fader';
import { Meter } from './Meter';

interface Props {
  /** null = the output strip */
  track: Track | null;
  /** a selected clip is on this track */
  current: boolean;
}

/** one strip of the mixer: name, pan, meter and fader, level, mute and solo. the output strip has no pan, mute or solo */
export const Strip = memo(function Strip({ track, current }: Props) {
  const id = track?.id ?? 'output';
  const out = useEditor((s) => (s.project ? outputGain(s.project) : 1));
  const solo = useSolo((s) => s.solo);
  const on = useSolo((s) => !!track && s.solo.includes(track.id));
  const unheard = useEditor((s) => {
    if (!track || !s.project) return false;
    const set = soloSet(s.project, solo);
    return !!set && !set.has(track.id);
  });
  const gain = track ? trackVolume(track) : out;

  const write = (g: number | null, opts?: ActionOpts) => {
    if (track) useEditor.getState().updateTrack(track.id, { volume: g }, opts);
    else useEditor.getState().updateProject({ output: g === null ? null : { volume: g } }, opts);
  };

  return (
    <div
      className={'mixer-strip' + (track ? '' : ' is-output') + (current ? ' is-current' : '') + (unheard ? ' is-unheard' : '')}
      data-strip={id}
    >
      <div className="mixer-name-row">
        {track ? (
          <span className="mixer-name" title={`${track.kind} track: ${track.name}`}>{track.name}</span>
        ) : (
          <span
            className="mixer-name"
            {...tip('output', { does: 'the level of everything together: what gets exported. the preview volume in the transport only changes what you hear' })}
          >
            output
          </span>
        )}
      </div>
      <div className="mixer-pan-row">
        {track ? (
          <FeelField
            feel="trackPan"
            value={trackPan(track) * 100}
            ariaLabel="pan"
            title="where the track sits between the left (-100) and the right (100) speaker. 0 = the middle"
            className="mixer-pan"
            onChange={(v) => {
              useEditor.getState().updateTrack(track.id, { pan: v / 100 }, liveOpts());
            }}
          />
        ) : null}
      </div>
      <div className="mixer-fader-row">
        <Meter tap={track ? track.id : OUTPUT_TAP} />
        <Fader gain={gain} write={write} />
      </div>
      <div className="mixer-level-row">
        <DbField gain={gain} write={write} />
      </div>
      <div className="mixer-btn-row">
        {track ? (
          <>
            <button
              type="button"
              className={'icon-btn icon-btn-sm' + (track.muted ? ' is-active' : '')}
              aria-label="mute track"
              aria-pressed={track.muted}
              {...tip('mute track', { does: 'no sound from this track', on: track.muted })}
              onClick={() => useEditor.getState().updateTrack(track.id, { muted: !track.muted })}
            >
              {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
            </button>
            <button
              type="button"
              className={'icon-btn icon-btn-sm' + (on ? ' is-solo' : '')}
              aria-label="solo track"
              aria-pressed={on}
              {...tip('solo track', { does: 'hear only the tracks on solo. for listening only: it is not saved and the export has every track. alt+click: solo only this track', on })}
              onClick={(e) => useSolo.getState().toggleSolo(track.id, e.altKey)}
            >
              <Headphones size={13} />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
});
