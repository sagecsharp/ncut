import { roundShown } from '../../components/ui/numberFormat';
import { Eraser, PenLine } from 'lucide-react';
import { memo } from 'react';
import { NumberField } from '../../components/ui/NumberField';
import { useEditor } from '../../store/editorStore';
import type { ShapeClip, ShapeKind } from '../../types';
import { AnimField } from './AnimField';
import { ColorField, Row, SelectRow, Section, Switch } from './controls';
import { beginEdit, patchClip } from './edit';
import {
  DEFAULT_GRADIENT_ANGLE,
  DEFAULT_SHAPE_STROKE,
  DEFAULT_STAR_INNER,
  SHAPE_LABELS,
  defaultPoints,
  defaultSecondColor,
  hasPoints,
} from './shapeLogic';

/** how long the one click draw on / wipe off animations take (s), shorter when the clip is */
const DRAW_SECONDS = 1;

/** draw on: drawEnd 0 -> 1 from the clip start. wipe off: drawStart 0 -> 1 ending at the clip end. one undo step. */
function animateDraw(clip: ShapeClip, prop: 'drawEnd' | 'drawStart'): void {
  const st = useEditor.getState();
  const span = Math.min(DRAW_SECONDS, clip.duration);
  if (!(span > 0)) return;
  const from = prop === 'drawEnd' ? clip.start : clip.start + clip.duration - span;
  const to = from + span;
  st.pushHistory();
  // start clean: older keys of this value would fight the new ones
  st.clearKeyframes(clip.id, from, prop, { skipHistory: true });
  st.setKeyframe(clip.id, prop, from, 0, 'ease', { skipHistory: true });
  st.setKeyframe(clip.id, prop, to, 1, 'ease', { skipHistory: true });
}

export const ShapeSection = memo(function ShapeSection({ clip }: { clip: ShapeClip }) {
  const id = clip.id;
  const filled = clip.filled !== false;
  const { stroke, color2 } = clip;
  const angle = clip.gradientAngle ?? DEFAULT_GRADIENT_ANGLE;
  const radial = !!clip.gradientRadial;
  const set = (patch: Record<string, unknown>) => patchClip(id, patch, true);

  return (
    <Section id="shape" title="shape">
      <SelectRow
        label="kind"
        title="what figure is drawn"
        value={clip.kind}
        options={SHAPE_LABELS}
        onChange={(v) => patchClip(id, { kind: v as ShapeKind })}
      />
      <Row label="size" title="width and height of the figure (px, at scale 100%)">
        <NumberField
          label="w"
          className="props-grow"
          suffix="px"
          title="width (px)"
          value={clip.width}
          min={1}
          max={20000}
          precision={0}
          onStart={beginEdit}
          onChange={(v) => set({ width: v })}
        />
        <NumberField
          label="h"
          className="props-grow"
          suffix="px"
          title="height (px)"
          value={clip.height}
          min={1}
          max={20000}
          precision={0}
          onStart={beginEdit}
          onChange={(v) => set({ height: v })}
        />
      </Row>
      {hasPoints(clip.kind) ? (
        <Row label="points" title="number of corners (3 to 12)">
          <NumberField
            className="props-grow"
            title="number of corners"
            value={clip.points ?? defaultPoints(clip.kind)}
            min={3}
            max={12}
            precision={0}
            onStart={beginEdit}
            onChange={(v) => set({ points: Math.round(v) })}
          />
        </Row>
      ) : null}
      {clip.kind === 'star' ? (
        <Row label="inner" title="inner radius of the star (% of the outer radius)">
          <NumberField
            className="props-grow"
            suffix="%"
            title="inner radius (%)"
            value={roundShown((clip.inner ?? DEFAULT_STAR_INNER) * 100, 0)}
            min={10}
            max={95}
            precision={0}
            onStart={beginEdit}
            onChange={(v) => set({ inner: v / 100 })}
          />
        </Row>
      ) : null}

      <Row label="fill" title="fill the figure with color">
        <Switch checked={filled} title="fill on or off" onChange={(v) => patchClip(id, { filled: v ? null : false })} />
        {filled ? <ColorField title="fill color" value={clip.color} onChange={(c) => set({ color: c })} /> : null}
      </Row>
      {filled ? (
        <>
          <Row label="gradient" title="blend into a second color">
            <Switch
              checked={!!color2}
              title="gradient on or off"
              onChange={(v) => patchClip(id, { color2: v ? defaultSecondColor(clip.color) : null })}
            />
            {color2 ? <ColorField title="second color" value={color2} onChange={(c) => set({ color2: c })} /> : null}
          </Row>
          {color2 ? (
            <>
              <Row label="radial" title="run the gradient from the center outwards">
                <Switch checked={radial} title="radial on or off" onChange={(v) => patchClip(id, { gradientRadial: v ? true : null })} />
              </Row>
              {!radial ? (
                <Row label="angle" title="gradient direction (degrees, 0 = left to right, 90 = top to bottom)">
                  <NumberField
                    className="props-grow"
                    suffix="deg"
                    title="gradient angle (degrees)"
                    value={angle}
                    min={-360}
                    max={360}
                    precision={0}
                    onStart={beginEdit}
                    onChange={(v) => set({ gradientAngle: v })}
                  />
                </Row>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      <Row label="outline" title="a line around the figure">
        <Switch
          checked={!!stroke}
          title="outline on or off"
          onChange={(v) => patchClip(id, { stroke: v ? { ...DEFAULT_SHAPE_STROKE } : null })}
        />
        {stroke ? <ColorField title="outline color" value={stroke.color} onChange={(c) => set({ stroke: { ...stroke, color: c } })} /> : null}
      </Row>
      {stroke ? (
        <Row label="width" title="outline width (px)">
          <NumberField
            className="props-grow"
            suffix="px"
            title="outline width (px)"
            value={stroke.width}
            min={0.5}
            max={500}
            step={0.5}
            precision={1}
            onStart={beginEdit}
            onChange={(v) => set({ stroke: { ...stroke, width: v } })}
          />
        </Row>
      ) : null}

      {stroke || clip.kind === 'line' || clip.kind === 'arrow' ? (
        <>
          <AnimField
            wide
            slider
            id={id}
            prop="drawStart"
            label="draw from"
            title="where the drawn part of the outline starts (% of its length)"
            scale={100}
            suffix="%"
            min={0}
            max={100}
            step={1}
            precision={0}
          />
          <AnimField
            wide
            slider
            id={id}
            prop="drawEnd"
            label="draw to"
            title="where the drawn part of the outline ends (% of its length)"
            scale={100}
            suffix="%"
            min={0}
            max={100}
            step={1}
            precision={0}
          />
          <div className="props-buttons">
            <button
              type="button"
              className="btn btn-sm"
              title="the outline draws itself on over the first second of the clip"
              onClick={() => animateDraw(clip, 'drawEnd')}
            >
              <PenLine size={14} />
              animate: draw on
            </button>
            <button
              type="button"
              className="btn btn-sm"
              title="the outline wipes itself off over the last second of the clip"
              onClick={() => animateDraw(clip, 'drawStart')}
            >
              <Eraser size={14} />
              wipe off
            </button>
          </div>
        </>
      ) : (
        <Row label="draw on" title="draw the outline of the figure over time">
          <span className="props-hint">add an outline to draw it on</span>
        </Row>
      )}
    </Section>
  );
});
