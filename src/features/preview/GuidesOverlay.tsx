import { memo } from 'react';
import { guideLines, useGuides } from './guides';

const L = guideLines();

/** thirds + center cross + title safe box over the picture. pointer events pass through to the overlay below. */
export const GuidesOverlay = memo(function GuidesOverlay() {
  const on = useGuides((s) => s.on);
  if (!on) return null;
  return (
    <svg className="preview-guides" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {[true, false].map((under) => (
        <g key={String(under)} className={under ? 'preview-guides-under' : 'preview-guides-line'}>
          {L.v.map((x) => (
            <line key={`v${x}`} x1={x} y1={0} x2={x} y2={100} vectorEffect="non-scaling-stroke" />
          ))}
          {L.h.map((y) => (
            <line key={`h${y}`} x1={0} y1={y} x2={100} y2={y} vectorEffect="non-scaling-stroke" />
          ))}
          <rect x={L.safe.x} y={L.safe.y} width={L.safe.w} height={L.safe.h} fill="none" vectorEffect="non-scaling-stroke" />
        </g>
      ))}
    </svg>
  );
});
