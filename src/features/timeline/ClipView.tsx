import { memo } from 'react';
import { Camera, Crop, Link2, Paperclip, Shapes, Sparkles, VolumeX, Wind } from 'lucide-react';
import type { Clip, MediaAsset } from '../../types';
import { hasKeyframes } from '../../lib/anim';
import { canBeParent } from '../../lib/links';
import { isVisualClip } from '../../types';
import { useEditor } from '../../store/editorStore';
import { ClipCanvas } from './ClipCanvas';
import { KeyMarks } from './KeyMarks';
import { CLIP_INSET } from './layout';

interface Props {
  clip: Clip;
  selected: boolean;
  zoom: number;
  laneH: number;
  asset: MediaAsset | undefined;
}

/** small mark for a clip attached to another one. only mounted for attached clips, so it is the only one subscribing. */
function AttachMark({ parentId }: { parentId: string }) {
  const name = useEditor((s) => {
    const p = s.project?.clips.find((c) => c.id === parentId);
    if (!p || !canBeParent(p)) return null;
    return p.type === 'text' ? p.text.replace(/\s+/g, ' ') : p.type === 'shape' ? p.name || p.kind : p.name;
  });
  if (name === null) return null;
  return <Paperclip size={11} aria-label={`attached to ${name}`} className="timeline-clip-icon">
    <title>{`attached to ${name}`}</title>
  </Paperclip>;
}

/**
 * one clip box. positioned with a transform, width from duration * zoom. memoized on the clip
 * object itself, so editing one clip never re-renders its neighbours.
 */
export const ClipView = memo(function ClipView({ clip, selected, zoom, laneH, asset }: Props) {
  const x = clip.start * zoom;
  const w = Math.max(2, clip.duration * zoom);
  const h = laneH - CLIP_INSET * 2;
  const handleW = Math.round(Math.min(7, Math.max(2, w / 3)));
  const muted = (clip.type === 'video' || clip.type === 'audio') && clip.muted;
  let label = clip.type === 'text' ? clip.text.replace(/\s+/g, ' ') : clip.type === 'shape' ? clip.name || clip.kind : clip.name;
  const isEffect = clip.type === 'effect';
  if (clip.type === 'effect' && w >= 96) {
    const pct = Math.round(clip.amount * 100);
    if (pct !== 100) label = `${label} ${pct}%`;
  }
  // marks for features a clip may use. a plain field read, nothing is subscribed or computed
  const hasMask = isVisualClip(clip) && !!clip.mask;
  const hasBlur = isVisualClip(clip) && !!clip.motionBlur;
  const fadeIn = clip.fadeIn * zoom;
  const fadeOut = clip.fadeOut * zoom;

  return (
    <div
      className={`timeline-clip is-${clip.type}${selected ? ' is-selected' : ''}${muted ? ' is-muted' : ''}`}
      data-clip-id={clip.id}
      style={{ transform: `translate3d(${x}px,0,0)`, width: w, height: h }}
    >
      {(clip.type === 'video' || clip.type === 'audio') && asset ? <ClipCanvas clip={clip} asset={asset} zoom={zoom} innerH={h - 2} /> : null}
      {fadeIn > 1 ? <div className="timeline-fade is-in" style={{ width: Math.min(fadeIn, w) }} /> : null}
      {fadeOut > 1 ? <div className="timeline-fade is-out" style={{ width: Math.min(fadeOut, w) }} /> : null}
      <div className="timeline-clip-label">
        {clip.group ? (
          <Link2 size={11} className="timeline-clip-icon" aria-label="in a group">
            <title>in a group</title>
          </Link2>
        ) : null}
        {isVisualClip(clip) && clip.parent ? <AttachMark parentId={clip.parent} /> : null}
        {muted ? <VolumeX size={11} aria-label="muted" /> : null}
        {isEffect && w >= 40 ? <Sparkles size={11} aria-hidden="true" className="timeline-clip-icon" /> : null}
        {clip.type === 'shape' && w >= 40 ? <Shapes size={11} aria-hidden="true" className="timeline-clip-icon" /> : null}
        {clip.type === 'camera' && w >= 40 ? <Camera size={11} aria-hidden="true" className="timeline-clip-icon" /> : null}
        <span className="timeline-clip-name">{label}</span>
      </div>
      {(hasMask || hasBlur) && w >= 40 ? (
        <div className="timeline-clip-marks">
          {hasMask ? (
            <Crop size={11} aria-label="has a mask">
              <title>has a mask</title>
            </Crop>
          ) : null}
          {hasBlur ? (
            <Wind size={11} aria-label="has motion blur">
              <title>has motion blur</title>
            </Wind>
          ) : null}
        </div>
      ) : null}
      {hasKeyframes(clip) ? <KeyMarks clip={clip} zoom={zoom} clipH={h} /> : null}
      <div className="timeline-trim is-start" data-trim="start" style={{ width: handleW }} />
      <div className="timeline-trim is-end" data-trim="end" style={{ width: handleW }} />
    </div>
  );
});
