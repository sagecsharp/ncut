import { memo, useMemo } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, Crosshair, Italic, Maximize, Minimize, RotateCcw, SquareDashed, Strikethrough, Underline } from 'lucide-react';
import { NumberField } from '../../components/ui/NumberField';
import { getClipBox } from '../../engine/draw';
import { FontPicker } from '../fonts/FontPicker';
import { formatTimecode } from '../../lib/time';
import { useAsset, useClip, useEditor } from '../../store/editorStore';
import type { ClipMove } from '../../store/editorStore';
import { applyFollowerSpans, followBase, markFollowGesture } from '../timeline/followApply';
import { withFollowerMovesFrom } from '../timeline/followMoves';
import type { Clip, MediaKind, TextAlign, VisualClip } from '../../types';
import { DEFAULT_TRANSFORM, MAX_SPEED, MIN_CLIP_DURATION, MIN_SPEED, isTimedClip, isVisualClip } from '../../types';
import { AnimField, InspectedClip } from './AnimField';
import { AlignButtons } from './AlignButtons';
import { ClipEffectsSection } from './ClipEffectsSection';
import { EffectSection } from './EffectSection';
import { FocusSection } from './FocusSection';
import { AnimationSection, CameraSection, ThreeDSection } from './Sections3d';
import { BeatSyncSection, TempoSection } from './BeatSections';
import { hasKeys } from './keyActions';
import { LookSection } from './LookSection';
import { ColorSection } from './ColorSection';
import { MaskSection } from './MaskSection';
import { SwapMedia } from './SwapMedia';
import { LinksSection } from './AttachSection';
import { ClipMotionSection } from './MotionSection';
import { ShapeSection } from './ShapeSection';
import { PathSection } from './PathSection';
import { RepeatSection } from './RepeatSection';
import { TextAnimSection, TextStyleSection } from './TextStyle';
import { TransitionSection } from './TransitionSection';
import { setValuesNow } from './animEdit';
import { ColorField, Pair, Row, Section } from './controls';
import { beginEdit, liveOpts } from './edit';
import { coverScale } from './shapeLogic';

const actions = () => useEditor.getState();

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
          <NumberField
            label="in"
            suffix="s"
            title="start on the timeline (seconds)"
            value={start}
            min={0}
            step={0.05}
            precision={2}
            onStart={beginFollowEdit}
            onChange={(v) => {
              // a rejected move leaves the store untouched, so the field falls back to the real value
              // effects put on this clip go with it, in the same call (one undo step)
              const st = useEditor.getState();
              const moves: ClipMove[] = [{ id, trackId, start: v }];
              const base = followBase(st.project);
              actions().moveClips(st.project && base ? withFollowerMovesFrom(base.clips, st.project.clips, st.project.tracks, moves) : moves, liveOpts());
            }}
          />
          <NumberField
            label="len"
            suffix="s"
            title="duration (seconds)"
            value={duration}
            min={MIN_CLIP_DURATION}
            step={0.05}
            precision={2}
            onStart={beginFollowEdit}
            onChange={(v) => trimWithEffects(id, start + v)}
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

/* ---------- transform ---------- */

const TransformSection = memo(function TransformSection({ id }: { id: string }) {
  const ids = useMemo(() => [id], [id]);
  // fill: scale so the clip's box (media, text or shape) covers the whole canvas
  const fill = () => {
    const p = actions().project;
    const clip = p?.clips.find((c) => c.id === id);
    if (!p || !clip || !isVisualClip(clip)) return;
    const box = getClipBox(p, clip);
    setValuesNow(id, { x: 0, y: 0, scale: coverScale(clip.transform.scale, box.width, box.height, p.width, p.height) });
  };

  return (
    <Section id="transform" title="transform">
      <AnimField id={id} prop="x" label="pos x" title="x offset from the canvas center (px)" suffix="px" step={1} precision={0} />
      <AnimField id={id} prop="y" label="pos y" title="y offset from the canvas center (px)" suffix="px" step={1} precision={0} />
      <AnimField id={id} prop="scale" label="scale" title="scale (%)" scale={100} suffix="%" min={1} max={1000} step={1} precision={0} />
      <AnimField id={id} prop="rotation" label="rotation" title="rotation (degrees)" suffix="deg" min={-3600} max={3600} step={1} precision={1} />
      <AnimField id={id} prop="opacity" label="opacity" title="opacity (%)" scale={100} suffix="%" min={0} max={100} step={1} precision={0} slider />
      <AlignButtons ids={ids} />
      <div className="props-buttons">
        <button type="button" className="btn btn-sm" title="center on the canvas" onClick={() => setValuesNow(id, { x: 0, y: 0 })}>
          <Crosshair size={14} />
          center
        </button>
        <button type="button" className="btn btn-sm" title="scale 100%, centered" onClick={() => setValuesNow(id, { x: 0, y: 0, scale: 1 })}>
          <Minimize size={14} />
          fit
        </button>
        <button type="button" className="btn btn-sm" title="scale to cover the whole canvas" onClick={fill}>
          <Maximize size={14} />
          fill
        </button>
        <button
          type="button"
          className="btn btn-sm"
          title="reset the transform"
          onClick={() => setValuesNow(id, { x: 0, y: 0, scale: DEFAULT_TRANSFORM.scale, rotation: 0, opacity: 1 })}
        >
          <RotateCcw size={14} />
          reset
        </button>
      </div>
    </Section>
  );
});

/* ---------- audio ---------- */

const AudioSection = memo(function AudioSection({ id, muted }: { id: string; muted: boolean }) {
  return (
    <Section id="audio" title="audio">
      <AnimField id={id} prop="volume" label="volume" title="volume (%)" scale={100} suffix="%" min={0} max={200} step={1} precision={0} slider />
      <Row label="mute" title="silence this clip">
        <input
          type="checkbox"
          className="checkbox"
          title="mute"
          checked={muted}
          onChange={(e) => actions().updateClip(id, { muted: e.target.checked })}
        />
      </Row>
    </Section>
  );
});

/* ---------- speed ---------- */

const SPEED_PRESETS = [0.5, 1, 1.5, 2];

const SpeedSection = memo(function SpeedSection({ id, speed }: { id: string; speed: number }) {
  return (
    <Section id="speed" title="speed">
      <Row label="speed" title="playback speed">
        <NumberField
          className="props-num-wide"
          suffix="x"
          title="playback speed (0.25 to 4)"
          value={speed}
          min={MIN_SPEED}
          max={MAX_SPEED}
          step={0.05}
          precision={2}
          onStart={beginFollowEdit}
          onChange={(v) => setSpeedWithEffects(id, v, true)}
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
  hint,
}: {
  id: string;
  fadeIn: number;
  fadeOut: number;
  duration: number;
  hint?: string;
}) {
  return (
    <Section id="fades" title="fades">
      <Row label="fade" title="fade in and fade out in seconds">
        <Pair>
          <NumberField
            label="in"
            suffix="s"
            title="fade in (seconds)"
            value={fadeIn}
            min={0}
            max={duration}
            step={0.1}
            precision={2}
            onStart={beginEdit}
            onChange={(v) => actions().updateClip(id, { fadeIn: v }, liveOpts())}
          />
          <NumberField
            label="out"
            suffix="s"
            title="fade out (seconds)"
            value={fadeOut}
            min={0}
            max={duration}
            step={0.1}
            precision={2}
            onStart={beginEdit}
            onChange={(v) => actions().updateClip(id, { fadeOut: v }, liveOpts())}
          />
        </Pair>
      </Row>
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
      <Row label="size" title="font size in canvas pixels">
        <NumberField
          className="props-num-wide"
          suffix="px"
          title="font size (px)"
          value={fontSize}
          min={4}
          max={1000}
          precision={0}
          onStart={beginEdit}
          onChange={(v) => actions().updateClip(id, { fontSize: v }, liveOpts())}
        />
      </Row>
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
function defaultThickness(clip: VisualClip): number {
  const p = useEditor.getState().project;
  if (!p) return 100;
  const box = getClipBox(p, clip);
  const side = clip.shape === 'box' ? box.height : box.width;
  return Math.max(1, Math.round(side / Math.max(0.01, clip.transform.scale)));
}

function typeLabel(clip: Clip): string {
  return clip.type;
}

export function ClipInspector({ id }: { id: string }) {
  const clip = useClip(id);
  const fps = useEditor((s) => s.project?.fps ?? 30);
  const asset = useAsset(clip && 'assetId' in clip ? clip.assetId : undefined);
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

  return (
    <section className="panel props-panel">
      <div className="panel-header">
        <span className="panel-title" title={clip.name}>
          {clip.name || typeLabel(clip)}
        </span>
        <span className="props-tag">{typeLabel(clip)}</span>
      </div>
      <div className="panel-body">
        <InspectedClip.Provider value={clip}>
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
        <AnimationSection id={clip.id} keyframes={clip.keyframes} start={clip.start} duration={clip.duration} />
        <BeatSyncSection id={clip.id} has={hasKeys(clip)} />
        {clip.type === 'effect' ? <EffectSection id={clip.id} name={clip.name} effect={clip.effect} params={clip.params} target={clip.target} /> : null}
        {clip.type === 'camera' ? <CameraSection id={clip.id} target={clip.target ?? null} /> : null}
        {clip.type === 'camera' ? <FocusSection clip={clip} /> : null}
        {clip.type === 'text' ? (
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
        {clip.type === 'text' ? <TextStyleSection clip={clip} /> : null}
        {clip.type === 'text' ? <TextAnimSection clip={clip} /> : null}
        {clip.type === 'shape' ? <ShapeSection clip={clip} /> : null}
        {clip.type !== 'audio' && clip.type !== 'effect' && clip.type !== 'camera' ? (
          <TransformSection id={clip.id} />
        ) : null}
        {isVisualClip(clip) ? (
          <ThreeDSection
            id={clip.id}
            threeD={!!clip.threeD}
            lookAt={clip.lookAt ?? 'none'}
            lookTarget={clip.lookTarget ?? null}
            shape={clip.shape ?? 'plane'}
            shapeDepth={clip.shapeDepth}
            defaultDepth={clip.threeD && clip.shape && clip.shape !== 'plane' && clip.shape !== 'sphere' ? defaultThickness(clip) : 0}
          />
        ) : null}
        {isVisualClip(clip) ? <PathSection id={clip.id} /> : null}
        {isVisualClip(clip) ? <RepeatSection id={clip.id} /> : null}
        <LinksSection clip={clip} />
        {isVisualClip(clip) ? <LookSection clip={clip} /> : null}
        {isVisualClip(clip) ? <ColorSection clip={clip} /> : null}
        {isVisualClip(clip) ? <MaskSection clip={clip} /> : null}
        {isVisualClip(clip) ? <ClipEffectsSection clip={clip} /> : null}
        {isVisualClip(clip) ? <ClipMotionSection clip={clip} /> : null}
        {isVisualClip(clip) ? <TransitionSection clip={clip} transition={clip.transition} /> : null}
        {hasAudio && (clip.type === 'video' || clip.type === 'audio') ? <AudioSection id={clip.id} muted={clip.muted} /> : null}
        {hasAudio && (clip.type === 'video' || clip.type === 'audio') ? <TempoSection id={clip.id} bpm={clip.bpm} beatOffset={clip.beatOffset} speed={clip.speed} /> : null}
        {clip.type === 'video' || clip.type === 'audio' ? <SpeedSection id={clip.id} speed={clip.speed} /> : null}
        <FadeSection id={clip.id} fadeIn={clip.fadeIn} fadeOut={clip.fadeOut} duration={clip.duration}
          hint={clip.type === 'effect' ? 'fades ramp the effect strength in and out' : undefined}
        />
        </InspectedClip.Provider>
      </div>
    </section>
  );
}
