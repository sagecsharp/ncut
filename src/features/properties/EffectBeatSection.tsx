/**
 * "on the beat" of an effect clip: the effect follows the tempo of a clip with sound. a pulse that hits on every
 * cycle line, and (for effects that repeat on their own) a lock that makes their rhythm one cycle per beat cycle.
 * evaluated when a frame is drawn, so it stays right when the effect or the music is moved, trimmed or split.
 */
import { memo, useMemo } from 'react';
import { getEffect } from '../../engine/effects/registry';
import { parseEffectBeat } from '../../lib/tempo';
import { useEditor } from '../../store/editorStore';
import { beatSources } from '../timeline/tempoActions';
import { Row, Section, SelectRow, SliderRow, Switch } from './controls';
import { FOLLOW_OFF, FOLLOW_UNDER, changedBeat, everyOptions, followPatch, followValue, lockTitle } from './effectBeatLogic';
import { patchClip } from './edit';

export const EffectBeatSection = memo(function EffectBeatSection({ id, effect, beat: raw }: { id: string; effect: string; beat?: unknown }) {
  const beat = parseEffectBeat(raw);
  const def = getEffect(effect);
  // a string, so the section only draws again when the list of tempos really changes (not on every edit)
  const listed = useEditor((s) => {
    const clip = s.project?.clips.find((c) => c.id === id);
    return s.project && clip ? JSON.stringify(beatSources(s.project, clip).map((b) => [b.id, b.label])) : '[]';
  });
  const sources = useMemo(() => JSON.parse(listed) as [string, string][], [listed]);
  const lock = def ? lockTitle(def) : null;

  const follow = followValue(beat, sources.map((s) => s[0]));
  const set = (next: ReturnType<typeof followPatch>, live = false) => patchClip(id, { beat: next }, live);

  return (
    <Section id="effect-beat" title="on the beat">
      {sources.length === 0 && !beat ? (
        <div className="props-hint">set a tempo on a clip with sound first. then the effect can hit on its beat.</div>
      ) : (
        <>
          <SelectRow
            label="follow"
            title="the clip whose tempo this effect follows"
            value={follow}
            options={[[FOLLOW_OFF, 'off'], [FOLLOW_UNDER, 'the sound under it'], ...sources]}
            onChange={(v) => set(followPatch(beat, v))}
          />
          {beat ? (
            <>
              <SelectRow label="every" title="one cycle of the effect every this many beats" value={String(beat.every)} options={everyOptions(beat.every)} onChange={(v) => set(changedBeat(beat, { every: Number(v) }))} />
              <SliderRow
                label="pulse"
                title="how hard the effect hits on every cycle: full strength on the beat, falling off until the next one (%)"
                value={Math.round(beat.pulse * 100)}
                min={0}
                max={100}
                suffix="%"
                onChange={(v) => set(changedBeat(beat, { pulse: v / 100 }), true)}
              />
              {lock ? (
                <Row label="lock" title={lock}>
                  <Switch checked={beat.lock} title={lock} onChange={(on) => set(changedBeat(beat, { lock: on }))} />
                </Row>
              ) : null}
              {sources.length === 0 ? <div className="props-hint">no clip has a tempo now, so the effect runs plain</div> : null}
            </>
          ) : null}
        </>
      )}
    </Section>
  );
});
