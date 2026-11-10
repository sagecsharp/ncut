import { memo } from 'react';
import { VolumeX } from 'lucide-react';
import type { Clip, MediaAsset } from '../../types';
import { ClipCanvas } from './ClipCanvas';
import { CLIP_INSET } from './layout';

interface Props {
  clip: Clip;
  selected: boolean;
  zoom: number;
  laneH: number;
  asset: MediaAsset | undefined;
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
  const label = clip.type === 'text' ? clip.text.replace(/\s+/g, ' ') : clip.name;
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
        {muted ? <VolumeX size={11} aria-label="muted" /> : null}
        <span className="timeline-clip-name">{label}</span>
      </div>
      <div className="timeline-trim is-start" data-trim="start" style={{ width: handleW }} />
      <div className="timeline-trim is-end" data-trim="end" style={{ width: handleW }} />
    </div>
  );
});
