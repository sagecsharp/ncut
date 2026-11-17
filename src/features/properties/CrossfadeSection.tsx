import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { AudioWaveform, Eraser } from 'lucide-react';
import { DEFAULT_CROSSFADE, FADE_SHAPES } from '../../types';
import type { AudioClip, FadeShape, Project, VideoClip } from '../../types';
import { SHAPE_NAME, cleanCrossfade, crossfadeSpan, hasSound, soundAfter, soundBefore } from '../../lib/audioCross';
import { useEditor } from '../../store/editorStore';
import { useTimeDisplay } from '../../store/timeDisplay';
import { crossfadeWithTransitionNow, setCrossfadeNow } from '../timeline/crossfadeActions';
import { oneTake, placeOf, planSetCrossfade } from '../timeline/crossfadePlan';
import type { Place } from '../timeline/crossfadePlan';
import { CROSS_WAITS, crossLengthText, crossShortText } from '../timeline/crossfadeText';
import { tip } from '../shell/tip';
import { FeelField, Row, Section } from './controls';
import { liveOpts } from './edit';

type SoundClip = VideoClip | AudioClip;

const PLACE_OPTIONS: [string, string][] = [
  ['center', 'centered on the edit'],
  ['start', 'starts at the edit'],
  ['end', 'ends at the edit'],
];
const SHAPE_TITLE = 'equal power: keeps the loudness of two different sounds. linear: straight, for two parts of one take. smooth: slow at both ends';
const name = (c: SoundClip): string => c.name || c.type;

interface PartProps {
  p: Project;
  where: 'start' | 'end';
  /** the clip that holds the crossfade: the clip after the edit */
  to: SoundClip | null;
  /** the clip before the edit */
  from: SoundClip | null;
}

/** one edit of the clip: its start (from the clip before) or its end (into the clip after) */
function Part({ p, where, to, from }: PartProps) {
  const mode = useTimeDisplay((s) => s.mode);
  const fps = p.fps || 30;
  const text = (sec: number): string => crossLengthText(sec, fps, mode);
  const cur = to ? cleanCrossfade(to.crossfade) : null;
  const live = !!to && !!from && hasSound(p, to) && hasSound(p, from);
  if (!to || (!live && !cur)) return <div className="props-hint">{`nothing with sound touches the ${where}`}</div>;
  const toId = to.id;
  const head = !from ? `at the ${where}` : where === 'start' ? `at the start, from "${name(from)}"` : `at the end, into "${name(to)}"`;
  const locked = !!p.tracks.find((t) => t.id === to.trackId)?.locked;
  const lockedOff = locked ? 'the track is locked' : null;
  const remove = (
    <div className="props-buttons">
      <button
        type="button"
        className="btn btn-sm"
        disabled={locked}
        {...tip('remove crossfade', { does: 'the edit is a hard edit for the sound again', off: lockedOff })}
        onClick={() => setCrossfadeNow(toId, { remove: true })}
      >
        <Eraser size={14} />
        remove crossfade
      </button>
    </div>
  );
  if (!cur) {
    const plan = planSetCrossfade(p, toId, { length: DEFAULT_CROSSFADE, place: 'center' });
    const off = typeof plan === 'string' ? plan : null;
    return (
      <>
        <div className="props-hint">{head}</div>
        <div className="props-buttons">
          <button
            type="button"
            className="btn btn-sm"
            disabled={off !== null}
            {...tip('add crossfade', { does: `the sound of the clip before fades out while this one fades in, over ${DEFAULT_CROSSFADE}s centered on the edit`, off })}
            onClick={() => setCrossfadeNow(toId, { length: DEFAULT_CROSSFADE, place: 'center' })}
          >
            <AudioWaveform size={14} />
            add crossfade
          </button>
        </div>
      </>
    );
  }
  if (!live) {
    return (
      <>
        <div className="props-hint">{head}</div>
        <div className="props-hint">{CROSS_WAITS}</div>
        {remove}
      </>
    );
  }
  if (!from) return null;
  const span = crossfadeSpan(p, to);
  const shape: FadeShape = cur.shape ?? 'power';
  const place = placeOf(cur, fps);
  const withTransition = to.type === 'video' && !!to.transition;
  const followsTransition = !!cur.withTransition && withTransition;
  const placeOptions: [string, string][] = place === 'custom' ? [['custom', 'as dragged'], ...PLACE_OPTIONS] : PLACE_OPTIONS;
  const hints: string[] = [];
  if (span && (span.shortBefore || span.shortAfter)) {
    const why = [span.shortBefore ? crossShortText('before', span.shortBefore, name(from), name(to)) : '', span.shortAfter ? crossShortText('after', span.shortAfter, name(from), name(to)) : ''].filter(Boolean).join(', ');
    hints.push(`only ${text(span.before + span.after)} of ${text(span.wantBefore + span.wantAfter)} fits: ${why}`);
  }
  if (shape === 'power' && oneTake(from, to)) hints.push('the same take on both sides: linear keeps the level, equal power lifts it 3 db in the middle');
  for (const c of [from, to]) if (c.muted) hints.push(`"${name(c)}" is muted: the other fades from or to nothing`);
  return (
    <>
      <div className="props-hint">{head}</div>
      <Row label="length" title={`how long the crossfade at the ${where} is, before and after the edit together (seconds)`}>
        <FeelField
          feel="crossfade"
          title={`crossfade length at the ${where} (seconds)`}
          value={span ? span.wantBefore + span.wantAfter : cur.before + cur.after}
          disabled={locked || followsTransition}
          onChange={(v) => setCrossfadeNow(toId, { length: v }, liveOpts()) ?? undefined}
        />
      </Row>
      <Row label="place" title="where the crossfade sits on the edit">
        <select
          className="select"
          title="where the crossfade sits on the edit"
          aria-label="place"
          value={place}
          disabled={locked}
          onChange={(e) => {
            if (e.target.value !== 'custom') setCrossfadeNow(toId, { place: e.target.value as Exclude<Place, 'custom'> });
          }}
        >
          {placeOptions.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Row>
      <Row label="shape" title={SHAPE_TITLE}>
        <select className="select" title={SHAPE_TITLE} aria-label="shape" value={shape} disabled={locked} onChange={(e) => setCrossfadeNow(toId, { shape: e.target.value as FadeShape })}>
          {FADE_SHAPES.map((s) => (
            <option key={s} value={s}>
              {SHAPE_NAME[s]}
            </option>
          ))}
        </select>
      </Row>
      {withTransition ? (
        <Row label="transition" title="the crossfade follows the transition of this clip: the same length and place">
          <input
            type="checkbox"
            className="checkbox"
            title="same length as the transition"
            aria-label="same length as the transition"
            checked={followsTransition}
            disabled={locked}
            onChange={(e) => crossfadeWithTransitionNow(toId, e.target.checked)}
          />
        </Row>
      ) : null}
      {remove}
      {hints.map((h) => (
        <div key={h} className="props-hint">
          {h}
        </div>
      ))}
    </>
  );
}

/** the sound fading across the edits at the start and the end of the clip */
export const CrossfadeSection = memo(function CrossfadeSection({ id }: { id: string }) {
  // only what the parts read: an edit elsewhere does not re-render this
  const [clip, before, after, fps, locked] = useEditor(
    useShallow((s) => {
      const p = s.project;
      const c = p?.clips.find((x) => x.id === id);
      if (!p || !c || (c.type !== 'video' && c.type !== 'audio')) return [null, null, null, 0, false] as const;
      const a = soundAfter(p, c);
      return [c, soundBefore(p, c), a, p.fps, !!p.tracks.find((t) => t.id === c.trackId)?.locked] as const;
    }),
  );
  void fps;
  void locked;
  const p = useEditor.getState().project;
  if (!p || !clip) return <Section id="crossfade" title="crossfade">{null}</Section>;
  return (
    <Section id="crossfade" title="crossfade">
      <Part p={p} where="start" to={clip} from={before} />
      <Part p={p} where="end" to={after} from={clip} />
    </Section>
  );
});
