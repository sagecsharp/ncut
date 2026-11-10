import { memo } from 'react';
import { Circle, Heart, RectangleHorizontal, Square, SquareSplitHorizontal, Star, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { MaskShape, VisualClip } from '../../types';
import { AnimField } from './AnimField';
import { Row, Section, Switch } from './controls';
import { patchClip } from './edit';
import { MASK_RANGES, MASK_SHAPE_LABELS, maskFields, newMask, setMaskShape } from './maskLogic';
import type { MaskKey } from './maskLogic';

const SHAPE_ICONS: Record<MaskShape, LucideIcon> = {
  rect: Square,
  ellipse: Circle,
  split: SquareSplitHorizontal,
  band: RectangleHorizontal,
  star: Star,
  heart: Heart,
};

const SHAPE_TITLES: Record<MaskShape, string> = {
  rect: 'box: a rectangle',
  ellipse: 'oval: a circle or ellipse',
  split: 'half: a straight edge, one side is hidden',
  band: 'strip: a stripe across the picture',
  star: 'star',
  heart: 'heart',
};

export const MaskSection = memo(function MaskSection({ clip }: { clip: VisualClip }) {
  const id = clip.id;
  const mask = clip.mask ?? null;
  const fields = mask ? maskFields(mask.shape) : null;

  const slider = (key: MaskKey, label: string, title: string, suffix = '%') => {
    if (!mask) return null;
    const { min, max } = MASK_RANGES[key];
    const deg = key === 'rotation';
    return (
      <AnimField
        id={id}
        prop={'mask.' + key}
        label={label}
        title={title}
        scale={deg ? 1 : 100}
        min={min}
        max={max}
        precision={deg ? 1 : 0}
        step={deg ? 0.5 : 1}
        suffix={suffix}
        slider
      />
    );
  };

  return (
    <Section id="mask" title="mask">
      <Row label="mask" title="show only part of the picture" wide>
        <Switch checked={!!mask} title="mask on or off" onChange={(on) => patchClip(id, { mask: on ? newMask() : null })} />
      </Row>
      {mask && fields ? (
        <>
          <Row label="shape" title="the figure that stays visible">
            <div className="props-seg" role="group" aria-label="mask shape">
              {MASK_SHAPE_LABELS.map(([shape, label]) => {
                const Icon = SHAPE_ICONS[shape];
                return (
                  <button
                    key={shape}
                    type="button"
                    className={`icon-btn${mask.shape === shape ? ' is-active' : ''}`}
                    title={SHAPE_TITLES[shape] ?? label}
                    aria-label={label}
                    aria-pressed={mask.shape === shape}
                    onClick={() => patchClip(id, { mask: setMaskShape(mask, shape) })}
                  >
                    <Icon size={14} />
                  </button>
                );
              })}
            </div>
          </Row>
          {slider('x', 'x', 'move the mask left or right (% of the picture)')}
          {slider('y', 'y', 'move the mask up or down (% of the picture)')}
          {fields.width ? slider('width', 'width', 'width of the mask (% of the picture)') : null}
          {fields.height ? slider('height', mask.shape === 'band' ? 'thickness' : 'height', 'height of the mask (% of the picture)') : null}
          {slider('rotation', 'turn', 'turn the mask (degrees)', 'deg')}
          {slider('feather', 'soft edge', 'how soft the edge is (%)')}
          {fields.radius ? slider('radius', 'corners', 'round the corners of the box (%)') : null}
          <Row label="flip" title="show the outside instead" wide>
            <Switch checked={mask.invert} title="show the outside instead" onChange={(on) => patchClip(id, { mask: { ...mask, invert: on } })} />
          </Row>
          <div className="props-buttons">
            <button type="button" className="btn btn-sm" title="remove the mask" onClick={() => patchClip(id, { mask: null })}>
              <Trash2 size={14} />
              remove mask
            </button>
          </div>
        </>
      ) : null}
    </Section>
  );
});
