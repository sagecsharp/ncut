/**
 * tempo of a clip with sound (bpm: detected, typed or tapped, and where a beat falls) and the tools that put
 * the keyframes of any clip on that beat (loop, ping pong, fit, snap).
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, AudioLines, Drum, Eraser, Magnet, MoveHorizontal, Repeat } from 'lucide-react';
import { NumberField } from '../../components/ui/NumberField';
import { BPM_MAX, BPM_MIN, TAP_GAP_MS, parseBeatOffset, parseBpm, scaleBpm, tapBpm } from '../../lib/tempo';
import { useEditor } from '../../store/editorStore';
import { beatSources, detectBpm } from '../timeline/tempoActions';
import { Row, Section, SelectRow } from './controls';
import { beginEdit, patchClip } from './edit';
import { fitKeysToBeatAction, loopKeysOnBeatAction, snapKeysToBeatAction } from './keyActions';

/* ---------- tempo of a sound ---------- */

export const TempoSection = memo(function TempoSection({ id, bpm: rawBpm, beatOffset, speed }: { id: string; bpm?: number | null; beatOffset?: number | null; speed: number }) {
  const bpm = parseBpm(rawBpm);
  const offset = parseBeatOffset(beatOffset);
  const taps = useRef<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [tapped, setTapped] = useState(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (tapTimer.current !== null) clearTimeout(tapTimer.current);
    },
    [],
  );
  const s = speed > 0 ? speed : 1;

  const tap = () => {
    const now = performance.now();
    const last = taps.current[taps.current.length - 1];
    if (last === undefined || now - last > TAP_GAP_MS) {
      // a new run: its first result makes the undo step, the following taps refine it
      taps.current = [];
      beginEdit();
    }
    taps.current.push(now);
    setTapped(taps.current.length);
    // a pause ends the run: the button stops asking for "1 more"
    if (tapTimer.current !== null) clearTimeout(tapTimer.current);
    tapTimer.current = setTimeout(() => setTapped(0), TAP_GAP_MS);
    // what is tapped is what is heard: on a clip that plays faster or slower the sound itself has another tempo
    const heard = tapBpm(taps.current);
    const v = heard !== null ? parseBpm(Math.round((heard / s) * 100) / 100) : null;
    if (v !== null) patchClip(id, { bpm: v }, true);
  };

  const listen = () => {
    if (busy) return;
    setBusy(true);
    void detectBpm(id).finally(() => setBusy(false));
  };

  const half = bpm !== null ? scaleBpm(bpm, 0.5) : null;
  const double = bpm !== null ? scaleBpm(bpm, 2) : null;
  return (
    <Section id="tempo" title="tempo">
      {bpm !== null ? (
        <>
          <Row label="bpm" title="beats per minute of this sound at normal speed">
            <NumberField
              className="props-num-wide"
              title={`beats per minute (${BPM_MIN} to ${BPM_MAX})`}
              value={bpm}
              min={BPM_MIN}
              max={BPM_MAX}
              step={1}
              precision={2}
              onStart={beginEdit}
              // the field shows two decimals of a tempo that is kept finer: handing the shown number back (enter
              // without typing) is no change
              onChange={(v) => {
                if (Math.round(v * 100) !== Math.round(bpm * 100)) patchClip(id, { bpm: v }, true);
              }}
            />
          </Row>
          <Row label="first beat" title="where a beat falls in the sound, in seconds from its start. nudge it until the ticks on the clip sit on the hits">
            <NumberField
              className="props-num-wide"
              suffix="s"
              title="where a beat falls (seconds into the sound)"
              value={offset}
              step={0.01}
              precision={3}
              onStart={beginEdit}
              onChange={(v) => patchClip(id, { beatOffset: v }, true)}
            />
          </Row>
          <div className="props-hint">
            a beat every {(60 / (bpm * s)).toFixed(3)} s{Math.abs(s - 1) > 0.001 ? ` (${Math.round(bpm * s * 100) / 100} bpm at ${s}x)` : ''}
          </div>
        </>
      ) : (
        <div className="props-hint">no tempo yet. let ncut listen, tap along, or start from 120 and type it.</div>
      )}
      <div className="props-buttons">
        <button type="button" className="btn btn-sm" disabled={busy} title="listen to the sound and find its tempo and where the beats fall" onClick={listen}>
          <AudioLines size={14} />
          {busy ? 'listening' : 'detect'}
        </button>
        <button type="button" className="btn btn-sm" title="tap along with the music: three taps or more set the tempo" onClick={tap}>
          <Drum size={14} />
          {tapped > 0 && tapped < 3 ? `tap ${3 - tapped} more` : 'tap'}
        </button>
        {bpm === null ? (
          <button type="button" className="btn btn-sm" title="start from 120 bpm and type the real one" onClick={() => patchClip(id, { bpm: 120 })}>
            120
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-sm" disabled={half === null} title="half time: the detector heard it twice as fast" onClick={() => patchClip(id, { bpm: half })}>
              /2
            </button>
            <button type="button" className="btn btn-sm" disabled={double === null} title="double time: the detector heard it half as fast" onClick={() => patchClip(id, { bpm: double })}>
              x2
            </button>
            <button type="button" className="btn btn-sm" title="forget the tempo of this clip" onClick={() => patchClip(id, { bpm: null, beatOffset: null })}>
              <Eraser size={14} />
              clear
            </button>
          </>
        )}
      </div>
    </Section>
  );
});

/* ---------- keyframes on the beat ---------- */

const LENGTHS: [string, string][] = [
  ['0.5', '1/2 beat'],
  ['1', '1 beat'],
  ['2', '2 beats'],
  ['4', '4 beats (a bar)'],
  ['8', '8 beats'],
  ['16', '16 beats'],
];
const LINES: [string, string][] = [
  ['1', 'beats'],
  ['2', 'half beats'],
  ['4', 'quarter beats'],
];

export const BeatSyncSection = memo(function BeatSyncSection({ id, has }: { id: string; has: boolean }) {
  // a string, so the section only draws again when the list of tempos really changes (not on every edit)
  const listed = useEditor((s) => {
    const clip = s.project?.clips.find((c) => c.id === id);
    return s.project && clip ? JSON.stringify(beatSources(s.project, clip).map((b) => [b.id, b.label])) : '[]';
  });
  const sources = useMemo(() => JSON.parse(listed) as [string, string][], [listed]);
  const [picked, setPicked] = useState('');
  const [length, setLength] = useState('4');
  const [lines, setLines] = useState('1');
  const source = sources.find((s) => s[0] === picked) ?? sources[0];
  const beats = Number(length);
  return (
    <Section id="beat-sync" title="on the beat">
      {!source ? (
        <div className="props-hint">no tempo in this project yet. give a clip with sound a bpm (its tempo section), then keyframes can follow its beat.</div>
      ) : (
        <>
          <SelectRow label="beat of" title="the clip whose tempo the keyframes follow" value={source[0]} options={sources} onChange={setPicked} />
          <SelectRow label="length" title="how many beats one round of the loop, or the fitted animation, lasts" value={length} options={LENGTHS} onChange={setLength} />
          <div className="props-buttons">
            <button
              type="button"
              className="btn btn-sm"
              disabled={!has}
              title="loop: the animation starts on a beat and its first beats (the length above) repeat until the clip ends. edit the first round and press again to carry it through"
              onClick={() => loopKeysOnBeatAction(id, source[0], beats, false)}
            >
              <Repeat size={14} />
              loop
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!has}
              title="ping pong: like loop, every second round plays backwards so nothing jumps"
              onClick={() => loopKeysOnBeatAction(id, source[0], beats, true)}
            >
              <ArrowLeftRight size={14} />
              ping pong
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!has}
              title="fit: stretch the whole animation so it starts on a beat and lasts exactly the length above"
              onClick={() => fitKeysToBeatAction(id, source[0], beats)}
            >
              <MoveHorizontal size={14} />
              fit
            </button>
          </div>
          <SelectRow label="snap to" title="the lines keyframes snap to" value={lines} options={LINES} onChange={setLines} />
          <div className="props-buttons">
            <button type="button" className="btn btn-sm" disabled={!has} title="move every keyframe of this clip to the nearest line" onClick={() => snapKeysToBeatAction(id, source[0], Number(lines))}>
              <Magnet size={14} />
              snap keyframes
            </button>
          </div>
        </>
      )}
    </Section>
  );
});
