import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, Crosshair, Ellipsis, Italic, Maximize, Minimize, RotateCcw, SquareDashed, Strikethrough, Underline } from 'lucide-react';
import { getClipBox } from '../../engine/draw';
import { pivotOffset } from '../../engine/pivot';
import { FontPicker } from '../fonts/FontPicker';
import { isAnimated, resolveClip } from '../../lib/anim';
import { formatTimecode } from '../../lib/time';
import { usePlayback } from '../../store/playback';
import { useAsset, useClip, useEditor } from '../../store/editorStore';
import type { ClipMove } from '../../store/editorStore';
import { applyFollowerSpans, followBase, markFollowGesture } from '../timeline/followApply';
import { withFollowerMovesFrom } from '../timeline/followMoves';
import { useUi } from '../../store/ui';
import { tip } from '../shell/tip';
import { openClipMenuAt } from '../timeline/commands';
import type { Clip, EffectClip, MediaKind, Project, TextAlign, Transform, VisualClip } from '../../types';
import { DEFAULT_TRANSFORM, isTimedClip, isVisualClip } from '../../types';
import { AnimField, InspectedClip } from './AnimField';
import { BendSection } from './BendSection';
import { PivotRow } from './PivotRow';
import { FeelContext, useCanvasFeelCtx } from './feelContext';
import { AlignButtons } from './AlignButtons';
import { ClipEffectsSection } from './ClipEffectsSection';
import { EffectSection } from './EffectSection';
import { EffectBeatSection } from './EffectBeatSection';
import { FocusSection } from './FocusSection';
import { AnimationSection, CameraSection, ThreeDSection } from './Sections3d';
import { BeatSyncSection, TempoSection } from './BeatSections';
import { hasKeys } from './keyActions';
import { LookSection } from './LookSection';
import { ColorSection } from './ColorSection';
import { GradeSection } from './GradeSection';
import { AudioSection } from './AudioSection';
import { OnSidesNote } from './FacesSection';
import { MaskSection } from './MaskSection';
import { MatteSection, MatteSourceNote } from './MatteSection';
import { CrossfadeSection } from './CrossfadeSection';
import { FadeShapeRow } from './FadeShapeRow';
import { SwapMedia } from './SwapMedia';
import { LinksSection } from './AttachSection';
import { hasLinks } from '../../lib/links';
import { GRADE_EFFECT, canGrade } from '../../lib/gradeData';
import { hasSoundApart } from '../../lib/soundPair';
import { ClipMotionSection } from './MotionSection';
import { ShapeSection } from './ShapeSection';
import { PathSection } from './PathSection';
import { RepeatSection } from './RepeatSection';
import { TextAnimSection, TextStyleSection } from './TextStyle';
import { TransitionSection } from './TransitionSection';
import { setValuesNow } from './animEdit';
import { ColorField, FeelField, Pair, Row, Section } from './controls';
import { beginEdit, liveOpts } from './edit';
import { handFocusTo, takesFocus } from './focusHandoff';
import { STRETCH_REST, coverScale, thicknessAtRest } from './shapeLogic';
import { InspectorTabs, rememberTab, rememberedTab } from './TabBar';
import { onTab, resolveTab, revealTab, sectionsOf, tabsFor } from './clipTabs';
import type { InspectorTab, SectionId } from './clipTabs';

const actions = () => useEditor.getState();

/** the newest reveal ask a tab switch has answered, so a new inspector does not answer an old one */
let tabRevealHandled = 0;

/** a field interaction starts: undo step + follower snapshot */
function beginFollowEdit(): void {
  beginEdit();
  markFollowGesture();
}

/** change the length of a clip; effects put on it get the same new span (one undo step, like the drag) */
function trimWithEffects(id: string, end: number): void {
  const opts = liveOpts();
  const before = followBase(useEditor.getState().project);
  actions().trimClip(id, 'end', end, opts);
  applyFollowerSpans(before, id, opts);
}

/** change the speed of a clip (which changes its length); effects put on it get the same new span, one undo step */
function setSpeedWithEffects(id: string, speed: number, live: boolean): void {
  let opts = live ? liveOpts() : undefined;
  const cur = useEditor.getState().project;
  const before = live ? followBase(cur) : cur;
  if (!opts) {
    actions().pushHistory();
    opts = { skipHistory: true };
  }
  actions().setClipSpeed(id, speed, opts);
  applyFollowerSpans(before, id, opts);
}

/* ---------- clip ---------- */

interface ClipSectionProps {
  id: string;
  trackId: string;
  name: string;
  start: number;
  duration: number;
  /** source in/out in seconds, null for clips without a timed source */
  srcIn: number | null;
  srcOut: number | null;
  fps: number;
  /** video / image / audio clips: the media they use, for "swap media" */
  mediaId: string | null;
  mediaKind: MediaKind | null;
}

const ClipSection = memo(function ClipSection({ id, trackId, name, start, duration, srcIn, srcOut, fps, mediaId, mediaKind }: ClipSectionProps) {
  return (
    <Section id="clip" title="clip">
      <Row label="name" title="clip name">
        <input
          className="input"
          title="clip name"
          value={name}
          onFocus={beginEdit}
          onChange={(e) => actions().updateClip(id, { name: e.target.value }, liveOpts())}
        />
      </Row>
      <Row label="timing" title="start and duration in seconds">
        <Pair>
          <FeelField
            label="in"
            feel="clipIn"
            title="start on the timeline (seconds)"
            value={start}
            onStart={beginFollowEdit}
            onChange={(v) => {
              // a rejected move leaves the store untouched, so the field falls back to the real value
              // effects put on this clip go with it, in the same call (one undo step)
              const st = useEditor.getState();
              const moves: ClipMove[] = [{ id, trackId, start: v }];
              const base = followBase(st.project);
              actions().moveClips(st.project && base ? withFollowerMovesFrom(base.clips, st.project.clips, st.project.tracks, moves) : moves, liveOpts());
              return useEditor.getState().project?.clips.find((c) => c.id === id)?.start ?? v;
            }}
          />
          <FeelField
            label="len"
            feel="clipLen"
            title="duration (seconds)"
            value={duration}
            onStart={beginFollowEdit}
            onChange={(v) => {
              trimWithEffects(id, start + v);
              return useEditor.getState().project?.clips.find((c) => c.id === id)?.duration ?? v;
            }}
          />
        </Pair>
      </Row>
      {srcIn !== null && srcOut !== null ? (
        <div className="props-stat" title="range of the source file used by this clip">
          <span className="field-label">source</span>
          <span className="mono">
            {formatTimecode(srcIn, fps)} - {formatTimecode(srcOut, fps)}
          </span>
        </div>
      ) : null}
      {mediaId && mediaKind ? <SwapMedia id={id} assetId={mediaId} kind={mediaKind} /> : null}
    </Section>
  );
});

/** a clip with its keyed values at the playhead written in (the same object when it has no keys) */
function clipNow<T extends Clip>(clip: T): T {
  const t = Math.min(clip.start + clip.duration, Math.max(clip.start, usePlayback.getState().time));
  return resolveClip(clip, t) as T;
}

/* ---------- transform ---------- */

/** x / y that put the picture's middle where 0 0 puts the position: the pivot's step from the middle at the new pose. 0 0 without a pivot */
function centeredXY(p: Project, now: VisualClip, over: Partial<Transform>): { x: number; y: number } {
  if (!now.pivot) return { x: 0, y: 0 };
  const clip = { ...now, transform: { ...now.transform, ...over } } as VisualClip;
  const box = getClipBox(p, clip);
  const o = pivotOffset(clip.transform, !!clip.threeD, box.px ?? 0, box.py ?? 0);
  return { x: Math.round(o[0] * 100) / 100, y: Math.round(o[1] * 100) / 100 };
}

/** centeredXY for the clip as it is right now in the store (0 0 when it is not a picture clip) */
function centeredNow(id: string, over: Partial<Transform>): { x: number; y: number } {
  const p = actions().project;
  const clip = p?.clips.find((c) => c.id === id);
  if (!p || !clip || !isVisualClip(clip)) return { x: 0, y: 0 };
  return centeredXY(p, clipNow(clip), over);
}

const TransformSection = memo(function TransformSection({ id }: { id: string }) {
  const ids = useMemo(() => [id], [id]);
  const hasPivot = useEditor((s) => {
    const c = s.project?.clips.find((k) => k.id === id);
    return !!c && isVisualClip(c) && !!c.pivot;
  });
  // fill: scale so the clip's box (media, text or shape) covers the whole canvas
  const fill = () => {
    const p = actions().project;
    const clip = p?.clips.find((c) => c.id === id);
    if (!p || !clip || !isVisualClip(clip)) return;
    // the clip as it is right now: a keyed size or text size changes its box
    const now = clipNow(clip);
    const box = getClipBox(p, now);
    const scale = coverScale(now.transform.scale, box.width, box.height, p.width, p.height);
    setValuesNow(id, { ...centeredXY(p, now, { scale }), scale });
  };
  const fit = () => {
    const over = { scale: 1, ...STRETCH_REST };
    setValuesNow(id, { ...centeredNow(id, over), ...over });
  };
  const reset = () => {
    const over = { scale: DEFAULT_TRANSFORM.scale, ...STRETCH_REST, rotation: 0 };
    setValuesNow(id, { ...centeredNow(id, over), ...over, opacity: 1 });
  };

  return (
    <Section id="transform" title="transform">
      <AnimField
        id={id}
        prop="x"
        label="pos x"
        title={hasPivot ? 'x of the pivot from the canvas center (px)' : 'x offset from the canvas center (px)'}
        feel="x"
      />
      <AnimField
        id={id}
        prop="y"
        label="pos y"
        title={hasPivot ? 'y of the pivot from the canvas center (px)' : 'y offset from the canvas center (px)'}
        feel="y"
      />
      <AnimField id={id} prop="scale" label="scale" title="scale (%)" feel="scale" />
      <AnimField id={id} prop="scaleX" label="scale x" title="stretch the width only, on top of scale (%)" feel="scaleX" />
      <AnimField id={id} prop="scaleY" label="scale y" title="stretch the height only, on top of scale (%)" feel="scaleY" />
      <AnimField id={id} prop="rotation" label="rotation" title="rotation (degrees)" feel="rotation" />
      <PivotRow id={id} />
      <AnimField id={id} prop="opacity" label="opacity" title="opacity (%)" feel="opacity" />
      <AlignButtons ids={ids} />
      <div className="props-buttons">
        <button type="button" className="btn btn-sm" title="center on the canvas" onClick={() => setValuesNow(id, centeredNow(id, {}))}>
          <Crosshair size={14} />
          center
        </button>
        <button type="button" className="btn btn-sm" title="scale 100%, no stretch, centered" onClick={fit}>
          <Minimize size={14} />
          fit
        </button>
        <button type="button" className="btn btn-sm" title="scale to cover the whole canvas (a stretch stays)" onClick={fill}>
          <Maximize size={14} />
          fill
        </button>
        <button type="button" className="btn btn-sm" title="reset the transform" onClick={reset}>
          <RotateCcw size={14} />
          reset
        </button>
      </div>
    </Section>
  );
});

/* ---------- speed ---------- */

const SPEED_PRESETS = [0.5, 1, 1.5, 2];

const SpeedSection = memo(function SpeedSection({ id, speed }: { id: string; speed: number }) {
  return (
    <Section id="speed" title="speed">
      <Row label="speed" title="playback speed">
        <FeelField
          feel="speed"
          title="playback speed (0.25 to 4)"
          value={speed}
          onStart={beginFollowEdit}
          onChange={(v) => {
            setSpeedWithEffects(id, v, true);
            const kept = useEditor.getState().project?.clips.find((c) => c.id === id);
            return kept && 'speed' in kept ? kept.speed : v;
          }}
        />
      </Row>
      <div className="props-buttons">
        {SPEED_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={`btn btn-sm${Math.abs(speed - p) < 0.001 ? ' btn-primary' : ''}`}
            title={`set speed to ${p}x`}
            onClick={() => {
              if (Math.abs(speed - p) >= 0.001) setSpeedWithEffects(id, p, false);
            }}
          >
            {p}x
          </button>
        ))}
      </div>
    </Section>
  );
});

/* ---------- fades ---------- */

const FadeSection = memo(function FadeSection({
  id,
  fadeIn,
  fadeOut,
  duration,
  sound,
  hint,
}: {
  id: string;
  fadeIn: number;
  fadeOut: number;
  duration: number;
  sound: boolean;
  hint?: string;
}) {
  return (
    <Section id="fades" title="fades">
      <Row label="fade" title="fade in and fade out in seconds">
        <Pair>
          <FeelField
            label="in"
            feel="fade"
            title="fade in (seconds)"
            value={fadeIn}
            max={duration}
            soft={[0, Math.min(duration, 5)]}
            onChange={(v) => {
              actions().updateClip(id, { fadeIn: v }, liveOpts());
              return useEditor.getState().project?.clips.find((c) => c.id === id)?.fadeIn ?? v;
            }}
          />
          <FeelField
            label="out"
            feel="fade"
            title="fade out (seconds)"
            value={fadeOut}
            max={duration}
            soft={[0, Math.min(duration, 5)]}
            onChange={(v) => {
              actions().updateClip(id, { fadeOut: v }, liveOpts());
              return useEditor.getState().project?.clips.find((c) => c.id === id)?.fadeOut ?? v;
            }}
          />
        </Pair>
      </Row>
      {sound ? <FadeShapeRow id={id} /> : null}
      {hint ? <div className="props-hint">{hint}</div> : null}
    </Section>
  );
});

/* ---------- text ---------- */

interface TextSectionProps {
  id: string;
  text: string;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  hollow: boolean;
  align: TextAlign;
  color: string;
  background: string | null;
}

const ALIGNS: { value: TextAlign; title: string; icon: typeof AlignLeft }[] = [
  { value: 'left', title: 'align left', icon: AlignLeft },
  { value: 'center', title: 'align center', icon: AlignCenter },
  { value: 'right', title: 'align right', icon: AlignRight },
];

const TextSection = memo(function TextSection({ id, text, fontFamily, fontSize, bold, italic, underline, strike, hollow, align, color, background }: TextSectionProps) {
  return (
    <Section id="text" title="text">
      <textarea
        className="input props-textarea"
        title="text content"
        rows={3}
        value={text}
        onFocus={beginEdit}
        onChange={(e) => actions().updateClip(id, { text: e.target.value }, liveOpts())}
      />
      <Row label="font" title="font family">
        <FontPicker value={fontFamily} onChange={(f) => actions().updateClip(id, { fontFamily: f })} />
      </Row>
      <AnimField id={id} prop="fontSize" label="size" title="font size in canvas pixels" feel="fontSize" />
      <Row label="style" title="bold, italic, underline, strike, hollow and alignment">
        <div className="props-seg">
          <button
            type="button"
            className={`icon-btn${bold ? ' is-active' : ''}`}
            title="bold"
            aria-pressed={bold}
            onClick={() => actions().updateClip(id, { fontWeight: bold ? 400 : 700 })}
          >
            <Bold size={14} />
          </button>
          <button
            type="button"
            className={`icon-btn${italic ? ' is-active' : ''}`}
            title="italic"
            aria-pressed={italic}
            onClick={() => actions().updateClip(id, { italic: !italic })}
          >
            <Italic size={14} />
          </button>
          <button
            type="button"
            className={`icon-btn${underline ? ' is-active' : ''}`}
            title="underline"
            aria-label="underline"
            aria-pressed={underline}
            onClick={() => actions().updateClip(id, { underline: !underline })}
          >
            <Underline size={14} />
          </button>
          <button
            type="button"
            className={`icon-btn${strike ? ' is-active' : ''}`}
            title="strike through"
            aria-label="strike through"
            aria-pressed={strike}
            onClick={() => actions().updateClip(id, { strike: !strike })}
          >
            <Strikethrough size={14} />
          </button>
          <button
            type="button"
            className={`icon-btn${hollow ? ' is-active' : ''}`}
            title="hollow letters: only the outline shows"
            aria-label="hollow letters"
            aria-pressed={hollow}
            onClick={() => actions().updateClip(id, { hollow: !hollow })}
          >
            <SquareDashed size={14} />
          </button>
          <span className="props-seg-gap" />
          {ALIGNS.map(({ value, title, icon: Icon }) => (
            <button
              key={value}
              type="button"
              className={`icon-btn${align === value ? ' is-active' : ''}`}
              title={title}
              aria-pressed={align === value}
              onClick={() => actions().updateClip(id, { align: value })}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
      </Row>
      <Row label="color" title="text color">
        <ColorField title="text color" value={color} onChange={(c) => actions().updateClip(id, { color: c }, liveOpts())} />
      </Row>
      <Row label="box" title="background box behind the text">
        <input
          type="checkbox"
          className="checkbox"
          title="show a background box"
          checked={background !== null}
          onChange={(e) => actions().updateClip(id, { background: e.target.checked ? '#000000' : null })}
        />
        {background !== null ? (
          <ColorField title="box color" value={background} onChange={(c) => actions().updateClip(id, { background: c }, liveOpts())} />
        ) : null}
      </Row>
    </Section>
  );
});

/* ---------- root ---------- */

/** shape thickness used while none is set, like the renderer: a box is as deep as it is tall, the others as deep as they are wide */
function defaultThickness(stored: VisualClip): number {
  const p = useEditor.getState().project;
  if (!p) return 100;
  const clip = clipNow(stored);
  return thicknessAtRest(clip.shape, getClipBox(p, clip), clip.transform);
}

function typeLabel(clip: Clip): string {
  return clip.type;
}

export function ClipInspector({ id }: { id: string }) {
  const clip = useClip(id);
  const fps = useEditor((s) => s.project?.fps ?? 30);
  const asset = useAsset(clip && 'assetId' in clip ? clip.assetId : undefined);
  const [wanted, setWanted] = useState<InspectorTab>(rememberedTab);
  // an effect, camera or sound clip only has an "attach" section while it is linked to something
  const linked = useEditor((s) => !!clip && !!s.project && hasLinks(s.project, clip));
  const apart = useEditor((s) => clip?.type === 'video' && !!s.project && hasSoundApart(s.project.clips, id));
  const revealN = useUi((s) => s.reveal?.n ?? 0);
  useEffect(() => {
    if (revealN <= tabRevealHandled) return;
    tabRevealHandled = revealN;
    const next = revealTab(wanted, useUi.getState().reveal?.id ?? '');
    if (next) {
      rememberTab(next);
      setWanted(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealN]);
  const body = useRef<HTMLDivElement>(null);
  const feelCtx = useCanvasFeelCtx();
  if (!clip) {
    return (
      <section className="panel props-panel">
        <div className="panel-header">
          <span className="panel-title">properties</span>
        </div>
        <div className="panel-body">
          <div className="empty">clip not found</div>
        </div>
      </section>
    );
  }

  const timed = isTimedClip(clip);
  const hasAudio = clip.type === 'audio' || (clip.type === 'video' && (asset?.hasAudio ?? true));
  // which sections this clip has, which tabs that makes, and which sections show on the chosen tab
  const have = sectionsOf(clip.type, hasAudio, linked, clip.type === 'effect' && clip.effect === GRADE_EFFECT);
  const tabs = tabsFor(have);
  const tab = resolveTab(wanted, tabs);
  const show = (id: SectionId) => have.includes(id) && onTab(tab, id);
  const pick = (next: InspectorTab) => {
    rememberTab(next);
    setWanted(next);
    if (body.current) body.current.scrollTop = 0;
  };

  return (
    <section className="panel props-panel">
      <div className="panel-header">
        <span className="panel-title" title={clip.name}>
          {clip.name || typeLabel(clip)}
        </span>
        <span className="props-tag">{typeLabel(clip)}</span>
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
          onClick={(e) => openClipMenuAt(e.currentTarget, clip.id)}
          {...tip('clip menu', { does: 'the right click menu of this clip', keys: 'clip-menu' })}
        >
          <Ellipsis size={14} />
        </button>
      </div>
      <InspectorTabs tabs={tabs} active={tab} onPick={pick} />
      <div className="panel-body" ref={body}>
        <FeelContext.Provider value={feelCtx}>
        <InspectedClip.Provider value={clip}>
        {isVisualClip(clip) ? <OnSidesNote id={clip.id} /> : null}
        {isVisualClip(clip) ? <MatteSourceNote id={clip.id} /> : null}
        {show('clip') ? (
        <ClipSection
          id={clip.id}
          trackId={clip.trackId}
          name={clip.name}
          start={clip.start}
          duration={clip.duration}
          srcIn={timed ? clip.trimStart : null}
          srcOut={timed ? clip.trimStart + clip.duration * clip.speed : null}
          fps={fps}
          mediaId={clip.type === 'video' || clip.type === 'image' || clip.type === 'audio' ? clip.assetId : null}
          mediaKind={clip.type === 'video' || clip.type === 'image' || clip.type === 'audio' ? clip.type : null}
        />
        ) : null}
        {show('animation') ? <AnimationSection id={clip.id} keyframes={clip.keyframes} start={clip.start} duration={clip.duration} /> : null}
        {show('beat-sync') ? <BeatSyncSection id={clip.id} has={hasKeys(clip)} /> : null}
        {show('effect') && clip.type === 'effect' ? <EffectSection id={clip.id} name={clip.name} effect={clip.effect} params={clip.params} target={clip.target} /> : null}
        {show('effect-beat') && clip.type === 'effect' ? <EffectBeatSection id={clip.id} effect={clip.effect} beat={clip.beat} /> : null}
        {show('camera') && clip.type === 'camera' ? <CameraSection id={clip.id} target={clip.target ?? null} /> : null}
        {show('focus') && clip.type === 'camera' ? <FocusSection clip={clip} /> : null}
        {show('text') && clip.type === 'text' ? (
          <TextSection
            id={clip.id}
            text={clip.text}
            fontFamily={clip.fontFamily}
            fontSize={clip.fontSize}
            bold={clip.fontWeight >= 700}
            italic={clip.italic}
            underline={!!clip.underline}
            strike={!!clip.strike}
            hollow={!!clip.hollow}
            align={clip.align}
            color={clip.color}
            background={clip.background}
          />
        ) : null}
        {show('text-style') && clip.type === 'text' ? <TextStyleSection clip={clip} /> : null}
        {show('text-anim') && clip.type === 'text' ? <TextAnimSection clip={clip} /> : null}
        {show('shape') && clip.type === 'shape' ? <ShapeSection clip={clip} /> : null}
        {show('transform') ? (
          <TransformSection id={clip.id} />
        ) : null}
        {show('threed') && isVisualClip(clip) ? (
          <ThreeDSection
            id={clip.id}
            threeD={!!clip.threeD}
            lookAt={clip.lookAt ?? 'none'}
            lookTarget={clip.lookTarget ?? null}
            shape={clip.shape ?? 'plane'}
            shapeDepth={clip.shapeDepth}
            defaultDepth={clip.threeD && clip.shape && clip.shape !== 'plane' && clip.shape !== 'sphere' ? defaultThickness(clip) : 0}
            lit={clip.lit != null || isAnimated(clip, 'lit')}
          />
        ) : null}
        {show('bend') && isVisualClip(clip) ? <BendSection clip={clip} /> : null}
        {show('path') && isVisualClip(clip) ? <PathSection id={clip.id} /> : null}
        {show('repeat') && isVisualClip(clip) ? <RepeatSection id={clip.id} /> : null}
        {show('attach') ? <LinksSection clip={clip} /> : null}
        {show('look') && isVisualClip(clip) ? <LookSection clip={clip} /> : null}
        {show('color') && isVisualClip(clip) ? <ColorSection clip={clip} /> : null}
        {show('grade') && canGrade(clip) ? <GradeSection clip={clip as VisualClip | EffectClip} /> : null}
        {show('mask') && isVisualClip(clip) ? <MaskSection clip={clip} /> : null}
        {show('matte') && isVisualClip(clip) ? <MatteSection clip={clip} /> : null}
        {show('clip-effects') && isVisualClip(clip) ? <ClipEffectsSection clip={clip} /> : null}
        {show('motion') && isVisualClip(clip) ? <ClipMotionSection clip={clip} /> : null}
        {show('transition') && isVisualClip(clip) ? <TransitionSection clip={clip} transition={clip.transition} /> : null}
        {show('audio') && (clip.type === 'video' || clip.type === 'audio') ? <AudioSection id={clip.id} muted={clip.muted} /> : null}
        {show('crossfade') && (clip.type === 'video' || clip.type === 'audio') && !apart ? <CrossfadeSection id={clip.id} /> : null}
        {show('tempo') && (clip.type === 'video' || clip.type === 'audio') && !apart ? <TempoSection id={clip.id} bpm={clip.bpm} beatOffset={clip.beatOffset} speed={clip.speed} /> : null}
        {show('speed') && (clip.type === 'video' || clip.type === 'audio') ? <SpeedSection id={clip.id} speed={clip.speed} /> : null}
        {show('fades') ? (
          <FadeSection id={clip.id} fadeIn={clip.fadeIn} fadeOut={clip.fadeOut} duration={clip.duration} sound={(clip.type === 'audio' || (clip.type === 'video' && hasAudio)) && !apart}
            hint={clip.type === 'effect' ? 'fades ramp the effect strength in and out' : undefined}
          />
        ) : null}
        </InspectedClip.Provider>
        </FeelContext.Provider>
      </div>
    </section>
  );
}
