import { memo } from 'react';
import { RotateCcw } from 'lucide-react';
import { DEFAULT_CHROMA_KEY } from '../../engine/clipLook';
import type { ChromaKey, VisualClip } from '../../types';
import { AnimField } from './AnimField';
import { resetWithKeys } from './animEdit';
import { ColorField, Row, Section, Switch } from './controls';
import { patchClip } from './edit';
import type { AdjustKey } from './colorLogic';

const ROWS: { key: AdjustKey; label: string; title: string; scale: number; max: number; suffix: string }[] = [
  { key: 'brightness', label: 'brightness', title: 'brightness (-100 darker, 100 brighter). double click to reset.', scale: 100, max: 100, suffix: '' },
  { key: 'contrast', label: 'contrast', title: 'contrast (-100 flat, 100 strong). double click to reset.', scale: 100, max: 100, suffix: '' },
  { key: 'saturation', label: 'saturation', title: 'saturation (-100 gray, 100 vivid). double click to reset.', scale: 100, max: 100, suffix: '' },
  { key: 'temperature', label: 'warmth', title: 'warmth (-100 cool, 100 warm). double click to reset.', scale: 100, max: 100, suffix: '' },
  { key: 'hue', label: 'hue', title: 'turn the colors around the color wheel (degrees). double click to reset.', scale: 1, max: 180, suffix: 'deg' },
];

const ADJUST_PROPS = ROWS.map((r) => 'adjust.' + r.key);

/** the color correction has something to reset: a value is set, or a value is animated */
function adjustActive(clip: VisualClip): boolean {
  return !!clip.adjust || ADJUST_PROPS.some((p) => !!clip.keyframes?.[p]?.length);
}

const KEY_COLORS: { label: string; color: string }[] = [
  { label: 'green', color: '#00d000' },
  { label: 'blue', color: '#0050ff' },
  { label: 'white', color: '#ffffff' },
];

/** color correction for every visual clip, and green screen for video and image */
export const ColorSection = memo(function ColorSection({ clip }: { clip: VisualClip }) {
  const id = clip.id;
  const key: ChromaKey | null = clip.chromaKey ?? null;
  const keyable = clip.type === 'video' || clip.type === 'image';
  const setKey = (patch: Partial<ChromaKey>, live = true) => {
    if (key) patchClip(id, { chromaKey: { ...key, ...patch } }, live);
  };

  return (
    <Section id="color" title="color">
      {ROWS.map(({ key: k, label, title, scale, max, suffix }) => (
        <AnimField
          key={k}
          id={id}
          prop={'adjust.' + k}
          label={label}
          title={title}
          scale={scale}
          suffix={suffix}
          min={-max}
          max={max}
          step={1}
          precision={0}
          slider
          reset={0}
        />
      ))}
      <div className="props-buttons">
        <button type="button" className="btn btn-sm" title="set every color value back to 0" disabled={!adjustActive(clip)} onClick={() => resetWithKeys(id, ADJUST_PROPS, { adjust: null })}>
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
              <AnimField
                id={id}
                prop="chromaKey.tolerance"
                label="range"
                title="how far from the color still gets removed (%)"
                scale={100}
                suffix="%"
                min={0}
                max={100}
                step={1}
                precision={0}
                slider
              />
              <AnimField
                id={id}
                prop="chromaKey.softness"
                label="soft edge"
                title="how soft the edge of the cut out is (%)"
                scale={100}
                suffix="%"
                min={0}
                max={100}
                step={1}
                precision={0}
                slider
              />
              <AnimField
                id={id}
                prop="chromaKey.spill"
                label="clean edges"
                title="take the leftover color out of the edges (%)"
                scale={100}
                suffix="%"
                min={0}
                max={100}
                step={1}
                precision={0}
                slider
              />
            </>
          ) : null}
        </>
      ) : null}
    </Section>
  );
});
