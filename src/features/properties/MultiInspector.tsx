import { memo, useCallback, useMemo, useState } from 'react';
import { AlignHorizontalJustifyStart, CopyPlus, Ellipsis, Flag, Group, Trash2, Ungroup } from 'lucide-react';
import { PIVOT_SPOTS, pivotOf, spotOf } from '../../engine/pivot';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { useShallow } from 'zustand/react/shallow';
import type { Clip } from '../../types';
import { isVisualClip } from '../../types';
import { canGrade } from '../../lib/gradeData';
import { hasSoundApart, muteTargets } from '../../lib/soundPair';
import { PairSection } from './PairSection';
import { AddEffect } from './ClipEffectsSection';
import { takesEffect } from './clipEffectActions';
import { tip } from '../shell/tip';
import { openClipMenuAt } from '../timeline/commands';
import { AlignButtons } from './AlignButtons';
import { ArrangeSection } from './ArrangeSection';
import { CascadeSection } from './CascadeSection';
import { SplitButtons } from './SplitButtons';
import { LookButtons } from './LookSection';
import { MultiBendSection } from './BendSection';
import { MultiGradeSection } from './MultiGradeSection';
import { MultiField } from './MultiField';
import { PivotDots } from './PivotRow';
import { setPivotMany } from './pivotActions';
import { FeelContext, useCanvasFeelCtx } from './feelContext';
import { ParentSelect } from './AttachSection';
import { attachClips } from './attachActions';
import { parentOptions } from './parentOptions';
import { Pair, Row, Section, SelectRow, Switch } from './controls';
import { handFocusTo, takesFocus } from './focusHandoff';
import { fitToMarkers, makeRow } from '../timeline/sequenceActions';
import type { FitSpan } from '../timeline/sequenceActions';
import { currentLabel } from './selectModel';
import { anyGrouped, firstVisual, sharedParent, visualIdsOf } from './selectionSets';

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
    allMuted: true,
    minDuration: Infinity,
  };
  if (!p) return out;
  const set = new Set(ids);
  for (const c of p.clips) {
    if (!set.has(c.id)) continue;
    out[c.type] += 1;
    out.minDuration = Math.min(out.minDuration, c.duration);
    if (isVisualClip(c)) {
      out.visual += 1;
      if (!c.threeD) out.allThreeD = false;
    }
  }
  // a picture with its sound apart stands for its sound clips
  for (const c of muteTargets(p.clips, ids)) {
    if (c.type === 'audio' || (c.type === 'video' && (p.assets.find((a) => a.id === c.assetId)?.hasAudio ?? true))) {
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

/** a clip with sound of its own: a picture whose sound is apart has none (its sound clip has it) */
function hasOwnSound(c: Clip): boolean {
  return (c.type === 'audio' || c.type === 'video') && !hasSoundApart(getClips(), c.id);
}

/** the spot id all selected picture clips sit on ('' = they differ or there is none) */
function sharedSpotId(clips: readonly Clip[] | undefined, want: ReadonlySet<string>): string {
  let id: string | null = null;
  if (!clips) return '';
  for (const c of clips) {
    if (!want.has(c.id) || !isVisualClip(c)) continue;
    const spot = spotOf(pivotOf(c));
    if (!spot) return '';
    if (id === null) id = spot.id;
    else if (id !== spot.id) return '';
  }
  return id ?? '';
}

/** "attach all to": the picker reads the clips itself (only while open), so the rest of the controls do not re-render with every clip edit */
function AttachAll({ ids, want }: { ids: string[]; want: ReadonlySet<string> }) {
  const value = useEditor((s) => sharedParent(s.project?.clips, want));
  const current = useEditor((s) => (value && s.project ? currentLabel(parentOptions(s.project, ids), value) : null));
  const build = useCallback((clips: readonly Clip[]) => parentOptions({ clips }, ids), [ids]);
  return (
    <ParentSelect
      label="attach all to"
      title="attach every selected visual clip to a clip or a camera. they keep their place on screen."
      value={value}
      current={current}
      build={build}
      onPick={(pid) => attachClips(ids, pid)}
    />
  );
}

const MultiControls = memo(function MultiControls({ ids, sum }: { ids: string[]; sum: Summary }) {
  const setThreeD = (on: boolean) => {
    const st = useEditor.getState();
    st.pushHistory();
    for (const id of targets(ids, isVisualClip)) st.updateClip(id, { threeD: on }, { skipHistory: true });
  };
  const toggleMute = (muted: boolean) => {
    const st = useEditor.getState();
    st.pushHistory();
    for (const c of muteTargets(getClips(), ids)) {
      st.updateClip(c.id, { muted }, { skipHistory: true });
    }
  };

  // the selected ids as a Set, built once per selection: filters below are O(clips) instead of O(clips * selected)
  const want = useMemo(() => new Set(ids), [ids]);
  const gradable = useEditor((s) => (s.project?.clips ?? []).filter((c) => want.has(c.id) && canGrade(c)).length);
  // the selected clips an effect can be put on (video, image, text, shape)
  const fxTargets = useEditor((s) => (s.project?.clips ?? []).filter((c) => want.has(c.id) && takesEffect(c)).length);

  // useShallow: the same list of ids keeps its identity, so the button groups below do not re-render on every drag frame
  const visualIds = useEditor(useShallow((s) => visualIdsOf(s.project?.clips, want)));

  const seqCount = sum.video + sum.image + sum.audio + sum.text + sum.shape;
  const markerCount = useEditor((s) => s.project?.markers?.length ?? 0);
  const [span, setSpan] = useState<FitSpan>(1);
  const fadeSoft = useMemo<[number, number]>(() => [0, Math.min(sum.minDuration, 5)], [sum.minDuration]);

  const source = useEditor((s) => firstVisual(s.project?.clips, want));
  // the spot id every selected picture clip shares ('' = they differ): a string, so the selector stays stable
  const sharedSpot = useEditor((s) => sharedSpotId(s.project?.clips, want));
  const allSame = PIVOT_SPOTS.find((p) => p.id === sharedSpot) ?? null;
  return (
    <>
      {sum.visual > 0 ? (
        <Section id="m-transform" title="transform">
          <MultiField want={want} label="pos x" title="x offset from the canvas center, for every selected clip (px)" feel="x" prop="x" pick={isVisualClip} />
          <MultiField want={want} label="pos y" title="y offset from the canvas center, for every selected clip (px)" feel="y" prop="y" pick={isVisualClip} />
          <MultiField want={want} label="scale" title="scale of every selected clip (%)" feel="scale" prop="scale" mode="times" pick={isVisualClip} />
          <MultiField want={want} label="rotation" title="rotation of every selected clip (degrees)" feel="rotation" prop="rotation" pick={isVisualClip} />
          <Row label="pivot" title="set the pivot of every selected clip to the same spot of each. none of them moves">
            <PivotDots value={allSame} onPick={(s) => setPivotMany(visualIds, s)} />
          </Row>
          <MultiField want={want} label="opacity" title="opacity of all selected visual clips (%)" feel="opacity" prop="opacity" pick={isVisualClip} />
          {sum.allThreeD ? (
            <>
              <MultiField want={want} wide label="depth" title="depth of every selected 3d clip: how far away from the viewer (px)" feel="z" prop="z" pick={isVisualClip} />
              <MultiField want={want} wide label="tilt" title="tilt of every selected 3d clip (degrees)" feel="rotX" prop="rotX" pick={isVisualClip} />
              <MultiField want={want} wide label="turn" title="turn of every selected 3d clip (degrees)" feel="rotY" prop="rotY" pick={isVisualClip} />
            </>
          ) : null}
          <div className="props-hint">
            a drag moves every clip by the same amount (scale: by the same factor), a typed number sets them all. a clip attached to another selected clip goes
            with it
          </div>
        </Section>
      ) : null}
      {sum.visual > 0 ? (
        <Section id="m-visual" title="visual">
          <Row label="3d" title="put all selected visual clips in 3d space or back to flat">
            <Switch checked={sum.allThreeD} title="3d on or off for all selected visual clips" onChange={setThreeD} />
          </Row>
          <AttachAll ids={ids} want={want} />
          {source ? <LookButtons source={source} ids={ids} /> : null}
        </Section>
      ) : null}
      {gradable > 0 ? <MultiGradeSection ids={ids} want={want} /> : null}
      {sum.visual > 0 ? (
        <Section id="m-align" title="align">
          <AlignButtons ids={visualIds} />
          {visualIds.length > 1 ? <SplitButtons ids={visualIds} /> : null}
        </Section>
      ) : null}
      {visualIds.length > 1 ? (
        <Section id="m-bend" title="bend">
          <MultiBendSection ids={visualIds} />
        </Section>
      ) : null}
      {visualIds.length > 1 ? (
        <Section id="m-arrange" title="arrange in 3d">
          <ArrangeSection ids={ids} />
        </Section>
      ) : null}
      {sum.audible > 0 ? (
        <Section id="m-audio" title="audio">
          <MultiField want={want} label="volume" title="volume of all selected audio clips (%)" feel="volume" prop="volume" pick={hasOwnSound} />
          <MultiField want={want} label="pan" title="pan of all selected clips with sound: -100 left, 100 right, 0 the middle" feel="soundPan" prop="pan" pick={hasOwnSound} />
          <Row label="mute" title="mute all selected audio clips">
            <input
              type="checkbox"
              className="checkbox"
              title="mute all selected audio clips"
              checked={sum.allMuted}
              onChange={(e) => toggleMute(e.target.checked)}
            />
          </Row>
        </Section>
      ) : null}
      {sum.video + sum.audio > 0 ? <PairSection ids={ids} /> : null}
      {sum.effect > 0 || fxTargets > 0 ? (
        <Section id="m-effects" title="effects">
          {sum.effect > 0 ? (
            <MultiField want={want} label="strength" title="how strong every selected effect clip is (%)" feel="effectAmount" prop="amount" pick={(c) => c.type === 'effect'} />
          ) : null}
          {fxTargets > 0 ? (
            <Row label="add effect" title="put the same effect on each selected clip (one effect clip per clip, one undo step)" wide>
              <AddEffect clipIds={ids} title={`put an effect on each of the ${fxTargets} selected clips`} />
            </Row>
          ) : null}
        </Section>
      ) : null}
      {seqCount > 1 ? (
        <Section id="m-sequence" title="sequence">
          <div className="props-buttons">
            <button type="button" className="btn btn-sm" title="lay the selected clips end to end on one track, in order of their start" onClick={() => makeRow(ids)}>
              <AlignHorizontalJustifyStart size={14} />
              in a row
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={markerCount === 0}
              title={markerCount === 0 ? 'no markers yet: mark the beats of a clip first' : 'lay the clips end to end, each one starting on a marker and ending on a later one'}
              onClick={() => fitToMarkers(ids, span)}
            >
              <Flag size={14} />
              fit to markers
            </button>
          </div>
          <SelectRow
            label="span"
            title="how many markers each clip spans when fitting to the markers"
            value={String(span)}
            options={[
              ['1', 'every beat'],
              ['2', 'every 2nd'],
              ['4', 'every 4th'],
            ]}
            onChange={(v) => setSpan(v === '4' ? 4 : v === '2' ? 2 : 1)}
          />
        </Section>
      ) : null}
      <Section id="m-cascade" title="cascade" defaultOpen={false}>
        <CascadeSection hasVisual={visualIds.length > 0} />
      </Section>
      <Section id="m-fades" title="fades">
        <Row label="fade" title="fade in and fade out in seconds">
          <Pair>
            <MultiField want={want} bare label="in" title="fade in (seconds)" feel="fade" prop="fadeIn" soft={fadeSoft} pick={() => true} />
            <MultiField want={want} bare label="out" title="fade out (seconds)" feel="fade" prop="fadeOut" soft={fadeSoft} pick={() => true} />
          </Pair>
        </Row>
        {sum.effect > 0 ? <div className="props-hint">fades ramp the strength of effect clips</div> : null}
      </Section>
    </>
  );
});

export function MultiInspector() {
  const feelCtx = useCanvasFeelCtx();
  const ids = useEditor((s) => s.selection);
  const anyGroup = useEditor((s) => anyGrouped(s.project?.clips, s.selection));
  const sum = useEditor(useShallow((s) => (s.project ? summarize(s.selection) : summarize([]))));
  const parts = (['video', 'image', 'audio', 'text', 'shape', 'effect', 'camera'] as const)
    .filter((k) => sum[k] > 0)
    .map((k) => `${sum[k]} ${k}`)
    .join(', ');

  return (
    <FeelContext.Provider value={feelCtx}>
      <section className="panel props-panel">
        <div className="panel-header">
          <span className="panel-title">{ids.length} clips selected</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            ref={takesFocus('project')}
          onClick={() => {
            handFocusTo('back');
            useUi.getState().showProjectPanel(true);
          }}
            {...tip('project', { does: 'canvas, sky, fog and light. the selection stays' })}
          >
            project
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="clip menu"
            onClick={(e) => openClipMenuAt(e.currentTarget, ids[0]!)}
            {...tip('clip menu', { does: 'the right click menu of this clip', keys: 'clip-menu' })}
          >
            <Ellipsis size={14} />
          </button>
        </div>
        <div className="panel-body">
          <div className="props-summary" title="selected clips by type">
            {parts}
          </div>
          <div className="props-buttons props-buttons-top">
            <button type="button" className="btn btn-sm" title="duplicate selected clips" onClick={() => useEditor.getState().duplicateClips(ids)}>
              <CopyPlus size={14} />
              duplicate
            </button>
            <button type="button" className="btn btn-sm" title="group the selected clips so they move, copy and delete together" onClick={() => useEditor.getState().groupClips(ids)}>
              <Group size={14} />
              group
            </button>
            {anyGroup ? (
              <button type="button" className="btn btn-sm" title="ungroup the selected clips" onClick={() => useEditor.getState().ungroupClips(ids)}>
                <Ungroup size={14} />
                ungroup
              </button>
            ) : null}
            <button type="button" className="btn btn-sm btn-danger" title="delete selected clips" onClick={() => useEditor.getState().deleteClips(ids)}>
              <Trash2 size={14} />
              delete
            </button>
          </div>
          <MultiControls ids={ids} sum={sum} />
        </div>
      </section>
    </FeelContext.Provider>
  );
}
