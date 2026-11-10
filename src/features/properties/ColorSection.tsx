import { memo } from 'react';
import { RotateCcw } from 'lucide-react';
import { NumberField } from '../../components/ui/NumberField';
import { DEFAULT_ADJUST, DEFAULT_CHROMA_KEY } from '../../engine/clipLook';
import type { ChromaKey, VisualClip } from '../../types';
import { ColorField, Row, Section, SliderRow, Switch } from './controls';
import { beginEdit, patchClip } from './edit';
import { setAdjustValue } from './colorLogic';
import type { AdjustKey } from './colorLogic';

const ROWS: { key: AdjustKey; label: string; title: string; scale: number; max: number; suffix: string }[] = [
  { key: 'brightness', label: 'brightness', title: 'brightness (-100 darker, 100 brighter). double click to reset.', scale: 100, max: 100, suffix: '' },
  { key: 'contrast', label: 'contrast', title: 'contrast (-100 flat, 100 strong). double click to reset.', scale: 100, max: 100, suffix: '' },
  { key: 'saturation', label: 'saturation', title: 'saturation (-100 gray, 100 vivid). double click to reset.', scale: 100, max: 100, suffix: '' },
  { key: 'temperature', label: 'warmth', title: 'warmth (-100 cool, 100 warm). double click to reset.', scale: 100, max: 100, suffix: '' },
  { key: 'hue', label: 'hue', title: 'turn the colors around the color wheel (degrees). double click to reset.', scale: 1, max: 180, suffix: 'deg' },
];

const KEY_COLORS: { label: string; color: string }[] = [
  { label: 'green', color: '#00d000' },
  { label: 'blue', color: '#0050ff' },
  { label: 'white', color: '#ffffff' },
];

/** color correction for every visual clip, and green screen for video and image */
export const ColorSection = memo(function ColorSection({ clip }: { clip: VisualClip }) {
  const id = clip.id;
  const adjust = clip.adjust ?? DEFAULT_ADJUST;
  const key: ChromaKey | null = clip.chromaKey ?? null;
  const keyable = clip.type === 'video' || clip.type === 'image';
  const setKey = (patch: Partial<ChromaKey>, live = true) => {
    if (key) patchClip(id, { chromaKey: { ...key, ...patch } }, live);
  };

  return (
    <Section id="color" title="color">
      {ROWS.map(({ key: k, label, title, scale, max, suffix }) => (
        <Row key={k} label={label} title={title}>
          <input
            type="range"
            className="range props-range"
            title={title}
            aria-label={label}
            min={-max}
            max={max}
            step={1}
            value={Math.round(adjust[k] * scale)}
            onPointerDown={beginEdit}
            onKeyDown={(e) => {
              if (!e.repeat) beginEdit();
            }}
            onDoubleClick={() => patchClip(id, { adjust: setAdjustValue(clip.adjust, k, 0) })}
            onChange={(e) => patchClip(id, { adjust: setAdjustValue(clip.adjust, k, Number(e.target.value) / scale) }, true)}
          />
          <NumberField
            className="props-num"
            title={title}
            value={Math.round(adjust[k] * scale)}
            min={-max}
            max={max}
            step={1}
            precision={0}
            suffix={suffix}
            onStart={beginEdit}
            onChange={(v) => patchClip(id, { adjust: setAdjustValue(clip.adjust, k, v / scale) }, true)}
          />
          <button
            type="button"
            className="icon-btn"
            title={`reset ${label}`}
            aria-label={`reset ${label}`}
            disabled={adjust[k] === 0}
            onClick={() => patchClip(id, { adjust: setAdjustValue(clip.adjust, k, 0) })}
          >
            <RotateCcw size={14} />
          </button>
        </Row>
      ))}
      <div className="props-buttons">
        <button type="button" className="btn btn-sm" title="set every color value back to 0" disabled={!clip.adjust} onClick={() => patchClip(id, { adjust: null })}>
          <RotateCcw size={14} />
          reset color
        </button>
      </div>
      {keyable ? (
        <>
          <Row label="remove a color" title="make one color see-through (green screen)" wide>
            <Switch
              checked={!!key}
              title="remove a color on or off"
              onChange={(on) => patchClip(id, { chromaKey: on ? { ...DEFAULT_CHROMA_KEY } : null })}
            />
          </Row>
          {key ? (
            <>
              <Row label="color" title="the color to remove">
                <ColorField title="color to remove" value={key.color} onChange={(c) => setKey({ color: c })} />
              </Row>
              <div className="props-buttons">
                {KEY_COLORS.map((q) => (
                  <button key={q.label} type="button" className="btn btn-sm" title={`remove ${q.label}`} onClick={() => setKey({ color: q.color }, false)}>
                    {q.label}
                  </button>
                ))}
              </div>
              <SliderRow
                label="range"
                title="how far from the color still gets removed (%)"
                value={Math.round(key.tolerance * 100)}
                min={0}
                max={100}
                suffix="%"
                onChange={(v) => setKey({ tolerance: v / 100 })}
              />
              <SliderRow
                label="soft edge"
                title="how soft the edge of the cut out is (%)"
                value={Math.round(key.softness * 100)}
                min={0}
                max={100}
                suffix="%"
                onChange={(v) => setKey({ softness: v / 100 })}
              />
              <SliderRow
                label="clean edges"
                title="take the leftover color out of the edges (%)"
                value={Math.round(key.spill * 100)}
                min={0}
                max={100}
                suffix="%"
                onChange={(v) => setKey({ spill: v / 100 })}
              />
            </>
          ) : null}
        </>
      ) : null}
    </Section>
  );
});
