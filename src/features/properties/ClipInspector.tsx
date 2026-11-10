import { memo } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, Crosshair, Italic, Maximize, Minimize, RotateCcw } from 'lucide-react';
import { NumberField } from '../../components/ui/NumberField';
import { containSize } from '../../engine/draw';
import { FONT_FAMILIES } from '../../lib/factory';
import { formatTimecode } from '../../lib/time';
import { useAsset, useClip, useEditor } from '../../store/editorStore';
import type { Clip, TextAlign, Transform } from '../../types';
import { DEFAULT_TRANSFORM, MAX_SPEED, MIN_CLIP_DURATION, MIN_SPEED, isTimedClip } from '../../types';
import { ColorField, Pair, Row, Section, SliderRow } from './controls';
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
  transform: Transform;
  mediaW: number;
  mediaH: number;
}

const TransformSection = memo(function TransformSection({ id, transform: t, mediaW, mediaH }: TransformSectionProps) {
  const set = (patch: Partial<Transform>) => actions().updateTransform(id, patch, liveOpts());
  const hasMedia = mediaW > 0 && mediaH > 0;

  const fill = () => {
    const p = actions().project;
    if (!p) return;
    const fit = containSize(mediaW, mediaH, p.width, p.height);
    const cover = Math.max(p.width / fit.width, p.height / fit.height);
    actions().updateTransform(id, { x: 0, y: 0, scale: cover });
  };

  return (
    <Section id="transform" title="transform">
      <Row label="position" title="offset from the canvas center in pixels">
        <Pair>
          <NumberField label="x" suffix="px" title="x offset (px)" value={t.x} step={1} precision={0} onStart={beginEdit} onChange={(v) => set({ x: v })} />
          <NumberField label="y" suffix="px" title="y offset (px)" value={t.y} step={1} precision={0} onStart={beginEdit} onChange={(v) => set({ y: v })} />
        </Pair>
      </Row>
      <Row label="scale" title="scale and rotation">
        <Pair>
          <NumberField
            label="s"
            suffix="%"
            title="scale (%)"
            value={t.scale * 100}
            min={1}
            max={1000}
            precision={0}
            onStart={beginEdit}
            onChange={(v) => set({ scale: v / 100 })}
          />
          <NumberField
            label="r"
            suffix="deg"
            title="rotation (degrees)"
            value={t.rotation}
            min={-360}
            max={360}
            precision={1}
            onStart={beginEdit}
            onChange={(v) => set({ rotation: v })}
          />
        </Pair>
      </Row>
      <SliderRow
        label="opacity"
        title="opacity (%)"
        value={t.opacity * 100}
        min={0}
        max={100}
        suffix="%"
        onChange={(v) => set({ opacity: v / 100 })}
      />
      <div className="props-buttons">
        <button type="button" className="btn btn-sm" title="center on the canvas" onClick={() => actions().updateTransform(id, { x: 0, y: 0 })}>
          <Crosshair size={14} />
          center
        </button>
        {hasMedia ? (
          <>
            <button type="button" className="btn btn-sm" title="fit inside the canvas (scale 100%)" onClick={() => actions().updateTransform(id, { x: 0, y: 0, scale: 1 })}>
              <Minimize size={14} />
              fit
            </button>
            <button type="button" className="btn btn-sm" title="scale to cover the whole canvas" onClick={fill}>
              <Maximize size={14} />
              fill
            </button>
          </>
        ) : null}
        <button type="button" className="btn btn-sm" title="reset the transform" onClick={() => actions().updateTransform(id, { ...DEFAULT_TRANSFORM })}>
          <RotateCcw size={14} />
          reset
        </button>
      </div>
    </Section>
  );
});

/* ---------- audio ---------- */

const AudioSection = memo(function AudioSection({ id, volume, muted }: { id: string; volume: number; muted: boolean }) {
  return (
    <Section id="audio" title="audio">
      <SliderRow
        label="volume"
        title="volume (%)"
        value={volume * 100}
        min={0}
        max={200}
        suffix="%"
        onChange={(v) => actions().updateClip(id, { volume: v / 100 }, liveOpts())}
      />
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

const FadeSection = memo(function FadeSection({ id, fadeIn, fadeOut, duration }: { id: string; fadeIn: number; fadeOut: number; duration: number }) {
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
  const fonts = FONT_FAMILIES.includes(fontFamily) ? FONT_FAMILIES : [fontFamily, ...FONT_FAMILIES];
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
        <select
          className="select"
          title="font family"
          value={fontFamily}
          onChange={(e) => actions().updateClip(id, { fontFamily: e.target.value })}
        >
          {fonts.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
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
        {clip.type !== 'audio' && clip.type !== 'effect' ? (
          <TransformSection id={clip.id} transform={clip.transform} mediaW={asset?.width ?? 0} mediaH={asset?.height ?? 0} />
        ) : null}
        {hasAudio && (clip.type === 'video' || clip.type === 'audio') ? (
          <AudioSection id={clip.id} volume={clip.volume} muted={clip.muted} />
        ) : null}
        {clip.type === 'video' || clip.type === 'audio' ? <SpeedSection id={clip.id} speed={clip.speed} /> : null}
        <FadeSection id={clip.id} fadeIn={clip.fadeIn} fadeOut={clip.fadeOut} duration={clip.duration} />
      </div>
    </section>
  );
}
