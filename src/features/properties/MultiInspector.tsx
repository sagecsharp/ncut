import { memo } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import { NumberField } from '../../components/ui/NumberField';
import { useEditor } from '../../store/editorStore';
import { useShallow } from 'zustand/react/shallow';
import { isVisualClip } from '../../types';
import type { VisualClip } from '../../types';
import { LookButtons } from './LookSection';
import { Pair, Row, Section, SliderRow, Switch } from './controls';
import { beginEdit, liveOpts } from './edit';

interface Summary {
  video: number;
  image: number;
  audio: number;
  text: number;
  shape: number;
  effect: number;
  camera: number;
  visual: number;
  /** every selected visual clip is 3d */
  allThreeD: boolean;
  audible: number;
  /** values of the first matching clip, shown as the shared value */
  opacity: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  allMuted: boolean;
  minDuration: number;
}

function summarize(ids: string[]): Summary {
  const s = useEditor.getState();
  const p = s.project;
  const out: Summary = {
    video: 0,
    image: 0,
    audio: 0,
    text: 0,
    shape: 0,
    effect: 0,
    camera: 0,
    visual: 0,
    allThreeD: true,
    audible: 0,
    opacity: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    allMuted: true,
    minDuration: Infinity,
  };
  if (!p) return out;
  const set = new Set(ids);
  let first = true;
  for (const c of p.clips) {
    if (!set.has(c.id)) continue;
    out[c.type] += 1;
    out.minDuration = Math.min(out.minDuration, c.duration);
    if (first) {
      out.fadeIn = c.fadeIn;
      out.fadeOut = c.fadeOut;
      first = false;
    }
    if (isVisualClip(c)) {
      if (out.visual === 0) out.opacity = c.transform.opacity;
      out.visual += 1;
      if (!c.threeD) out.allThreeD = false;
    }
    if (c.type === 'audio' || (c.type === 'video' && (p.assets.find((a) => a.id === c.assetId)?.hasAudio ?? true))) {
      if (out.audible === 0) out.volume = c.volume;
      out.audible += 1;
      if (!c.muted) out.allMuted = false;
    }
  }
  if (!Number.isFinite(out.minDuration)) out.minDuration = 0;
  return out;
}

/** ids of the selected clips matching a predicate, read at event time */
function targets(ids: string[], pick: (c: ReturnType<typeof getClips>[number]) => boolean): string[] {
  const set = new Set(ids);
  return getClips().filter((c) => set.has(c.id) && pick(c)).map((c) => c.id);
}
function getClips() {
  return useEditor.getState().project?.clips ?? [];
}

const MultiControls = memo(function MultiControls({ ids, sum }: { ids: string[]; sum: Summary }) {
  const setOpacity = (v: number) => {
    const o = liveOpts();
    for (const id of targets(ids, isVisualClip)) useEditor.getState().updateTransform(id, { opacity: v / 100 }, o);
  };
  const setThreeD = (on: boolean) => {
    const st = useEditor.getState();
    st.pushHistory();
    for (const id of targets(ids, isVisualClip)) st.updateClip(id, { threeD: on }, { skipHistory: true });
  };
  const setVolume = (v: number) => {
    const o = liveOpts();
    for (const id of targets(ids, (c) => c.type === 'audio' || c.type === 'video')) {
      useEditor.getState().updateClip(id, { volume: v / 100 }, o);
    }
  };
  const setFade = (key: 'fadeIn' | 'fadeOut', v: number) => {
    const o = liveOpts();
    for (const id of ids) useEditor.getState().updateClip(id, { [key]: v }, o);
  };
  const toggleMute = (muted: boolean) => {
    const st = useEditor.getState();
    st.pushHistory();
    for (const id of targets(ids, (c) => c.type === 'audio' || c.type === 'video')) {
      st.updateClip(id, { muted }, { skipHistory: true });
    }
  };

  const source = useEditor((s) => {
    const c = s.project?.clips.find((k) => ids.includes(k.id) && isVisualClip(k));
    return c as VisualClip | undefined;
  });
  return (
    <>
      {sum.visual > 0 ? (
        <Section id="m-visual" title="visual">
          <SliderRow label="opacity" title="opacity of all selected visual clips (%)" value={sum.opacity * 100} min={0} max={100} suffix="%" onChange={setOpacity} />
          <Row label="3d" title="put all selected visual clips in 3d space or back to flat">
            <Switch checked={sum.allThreeD} title="3d on or off for all selected visual clips" onChange={setThreeD} />
          </Row>
          {source ? <LookButtons source={source} ids={ids} /> : null}
        </Section>
      ) : null}
      {sum.audible > 0 ? (
        <Section id="m-audio" title="audio">
          <SliderRow label="volume" title="volume of all selected audio clips (%)" value={sum.volume * 100} min={0} max={200} suffix="%" onChange={setVolume} />
          <Row label="mute" title="silence all selected audio clips">
            <input
              type="checkbox"
              className="checkbox"
              title="mute all"
              checked={sum.allMuted}
              onChange={(e) => toggleMute(e.target.checked)}
            />
          </Row>
        </Section>
      ) : null}
      <Section id="m-fades" title="fades">
        <Row label="fade" title="fade in and fade out in seconds">
          <Pair>
            <NumberField
              label="in"
              suffix="s"
              title="fade in (seconds)"
              value={sum.fadeIn}
              min={0}
              max={sum.minDuration}
              step={0.1}
              precision={2}
              onStart={beginEdit}
              onChange={(v) => setFade('fadeIn', v)}
            />
            <NumberField
              label="out"
              suffix="s"
              title="fade out (seconds)"
              value={sum.fadeOut}
              min={0}
              max={sum.minDuration}
              step={0.1}
              precision={2}
              onStart={beginEdit}
              onChange={(v) => setFade('fadeOut', v)}
            />
          </Pair>
        </Row>
        {sum.effect > 0 ? <div className="props-hint">fades ramp the strength of effect clips</div> : null}
      </Section>
    </>
  );
});

export function MultiInspector() {
  const ids = useEditor((s) => s.selection);
  const sum = useEditor(useShallow((s) => (s.project ? summarize(s.selection) : summarize([]))));
  const parts = (['video', 'image', 'audio', 'text', 'shape', 'effect', 'camera'] as const)
    .filter((k) => sum[k] > 0)
    .map((k) => `${sum[k]} ${k}`)
    .join(', ');

  return (
    <section className="panel props-panel">
      <div className="panel-header">
        <span className="panel-title">{ids.length} clips selected</span>
      </div>
      <div className="panel-body">
        <div className="props-summary" title="selected clips by type">
          {parts}
        </div>
        <div className="props-buttons props-buttons-top">
          <button type="button" className="btn btn-sm" title="duplicate selected clips" onClick={() => useEditor.getState().duplicateClips(ids)}>
            <Copy size={14} />
            duplicate
          </button>
          <button type="button" className="btn btn-sm btn-danger" title="delete selected clips" onClick={() => useEditor.getState().deleteClips(ids)}>
            <Trash2 size={14} />
            delete
          </button>
        </div>
        <MultiControls ids={ids} sum={sum} />
      </div>
    </section>
  );
}
