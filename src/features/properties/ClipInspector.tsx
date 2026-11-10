import { memo } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, Crosshair, Italic, Maximize, Minimize, RotateCcw } from 'lucide-react';
import { NumberField } from '../../components/ui/NumberField';
import { containSize, getClipBox } from '../../engine/draw';
import { hasKeyframes } from '../../lib/anim';
import { FontPicker } from '../fonts/FontPicker';
import { formatTimecode } from '../../lib/time';
import { useAsset, useClip, useEditor } from '../../store/editorStore';
import type { Clip, TextAlign, VisualClip } from '../../types';
import { DEFAULT_TRANSFORM, MAX_SPEED, MIN_CLIP_DURATION, MIN_SPEED, isTimedClip, isVisualClip } from '../../types';
import { AnimField } from './AnimField';
import { EffectSection } from './EffectSection';
import { AnimationSection, CameraSection, ThreeDSection } from './Sections3d';
import { TextAnimSection, TextStyleSection } from './TextStyle';
import { TransitionSection } from './TransitionSection';
import { setValuesNow } from './animEdit';
import { ColorField, Pair, Row, Section } from './controls';
import { beginEdit, liveOpts } from './edit';

const actions = () => useEditor.getState();

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
}

const ClipSection = memo(function ClipSection({ id, trackId, name, start, duration, srcIn, srcOut, fps }: ClipSectionProps) {
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
            onStart={beginEdit}
            onChange={(v) => {
              // a rejected move leaves the store untouched, so the field falls back to the real value
              actions().moveClips([{ id, trackId, start: v }], liveOpts());
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
            onStart={beginEdit}
            onChange={(v) => actions().trimClip(id, 'end', start + v, liveOpts())}
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
    </Section>
  );
});

/* ---------- transform ---------- */

interface TransformSectionProps {
  id: string;
  mediaW: number;
  mediaH: number;
}

const TransformSection = memo(function TransformSection({ id, mediaW, mediaH }: TransformSectionProps) {
  const hasMedia = mediaW > 0 && mediaH > 0;

  const fill = () => {
    const p = actions().project;
    if (!p) return;
    const fit = containSize(mediaW, mediaH, p.width, p.height);
    const cover = Math.max(p.width / fit.width, p.height / fit.height);
    setValuesNow(id, { x: 0, y: 0, scale: cover });
  };

  return (
    <Section id="transform" title="transform">
      <AnimField id={id} prop="x" label="pos x" title="x offset from the canvas center (px)" suffix="px" step={1} precision={0} />
      <AnimField id={id} prop="y" label="pos y" title="y offset from the canvas center (px)" suffix="px" step={1} precision={0} />
      <AnimField id={id} prop="scale" label="scale" title="scale (%)" scale={100} suffix="%" min={1} max={1000} step={1} precision={0} />
      <AnimField id={id} prop="rotation" label="rotation" title="rotation (degrees)" suffix="deg" min={-3600} max={3600} step={1} precision={1} />
      <AnimField id={id} prop="opacity" label="opacity" title="opacity (%)" scale={100} suffix="%" min={0} max={100} step={1} precision={0} slider />
      <div className="props-buttons">
        <button type="button" className="btn btn-sm" title="center on the canvas" onClick={() => setValuesNow(id, { x: 0, y: 0 })}>
          <Crosshair size={14} />
          center
        </button>
        {hasMedia ? (
          <>
            <button type="button" className="btn btn-sm" title="fit inside the canvas (scale 100%)" onClick={() => setValuesNow(id, { x: 0, y: 0, scale: 1 })}>
              <Minimize size={14} />
              fit
            </button>
            <button type="button" className="btn btn-sm" title="scale to cover the whole canvas" onClick={fill}>
              <Maximize size={14} />
              fill
            </button>
          </>
        ) : null}
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
          onStart={beginEdit}
          onChange={(v) => actions().setClipSpeed(id, v, liveOpts())}
        />
      </Row>
      <div className="props-buttons">
        {SPEED_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={`btn btn-sm${Math.abs(speed - p) < 0.001 ? ' btn-primary' : ''}`}
            title={`set speed to ${p}x`}
            onClick={() => actions().setClipSpeed(id, p)}
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
  align: TextAlign;
  color: string;
  background: string | null;
}

const ALIGNS: { value: TextAlign; title: string; icon: typeof AlignLeft }[] = [
  { value: 'left', title: 'align left', icon: AlignLeft },
  { value: 'center', title: 'align center', icon: AlignCenter },
  { value: 'right', title: 'align right', icon: AlignRight },
];

const TextSection = memo(function TextSection({ id, text, fontFamily, fontSize, bold, italic, align, color, background }: TextSectionProps) {
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
      <Row label="style" title="bold, italic and alignment">
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

/** shape thickness used while none is set: the clip's own height, like the renderer */
function defaultThickness(clip: VisualClip): number {
  const p = useEditor.getState().project;
  if (!p) return 100;
  const h = getClipBox(p, clip).height / Math.max(0.01, clip.transform.scale);
  return Math.max(1, Math.round(h));
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
        <ClipSection
          id={clip.id}
          trackId={clip.trackId}
          name={clip.name}
          start={clip.start}
          duration={clip.duration}
          srcIn={timed ? clip.trimStart : null}
          srcOut={timed ? clip.trimStart + clip.duration * clip.speed : null}
          fps={fps}
        />
        {hasKeyframes(clip) ? <AnimationSection id={clip.id} keyframes={clip.keyframes!} start={clip.start} duration={clip.duration} /> : null}
        {clip.type === 'effect' ? <EffectSection id={clip.id} name={clip.name} effect={clip.effect} params={clip.params} /> : null}
        {clip.type === 'camera' ? <CameraSection id={clip.id} /> : null}
        {clip.type === 'text' ? (
          <TextSection
            id={clip.id}
            text={clip.text}
            fontFamily={clip.fontFamily}
            fontSize={clip.fontSize}
            bold={clip.fontWeight >= 700}
            italic={clip.italic}
            align={clip.align}
            color={clip.color}
            background={clip.background}
          />
        ) : null}
        {clip.type === 'text' ? <TextStyleSection clip={clip} /> : null}
        {clip.type === 'text' ? <TextAnimSection clip={clip} /> : null}
        {clip.type !== 'audio' && clip.type !== 'effect' && clip.type !== 'camera' ? (
          <TransformSection id={clip.id} mediaW={asset?.width ?? 0} mediaH={asset?.height ?? 0} />
        ) : null}
        {isVisualClip(clip) ? (
          <ThreeDSection
            id={clip.id}
            threeD={!!clip.threeD}
            lookAt={clip.lookAt ?? 'none'}
            shape={clip.shape ?? 'plane'}
            shapeDepth={clip.shapeDepth}
            defaultDepth={clip.threeD && (clip.shape === 'box' || clip.shape === 'cylinder') ? defaultThickness(clip) : 0}
          />
        ) : null}
        {isVisualClip(clip) ? <TransitionSection clip={clip} transition={clip.transition} /> : null}
        {hasAudio && (clip.type === 'video' || clip.type === 'audio') ? <AudioSection id={clip.id} muted={clip.muted} /> : null}
        {clip.type === 'video' || clip.type === 'audio' ? <SpeedSection id={clip.id} speed={clip.speed} /> : null}
        <FadeSection id={clip.id} fadeIn={clip.fadeIn} fadeOut={clip.fadeOut} duration={clip.duration}
          hint={clip.type === 'effect' ? 'fades ramp the effect strength in and out' : undefined}
        />
      </div>
    </section>
  );
}
