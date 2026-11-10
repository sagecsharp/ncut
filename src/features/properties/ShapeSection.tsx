import { Eraser, PenLine } from 'lucide-react';
import { memo } from 'react';
import { useEditor } from '../../store/editorStore';
import type { ShapeClip, ShapeKind } from '../../types';
import { AnimField } from './AnimField';
import { ColorField, Row, SelectRow, Section, Switch } from './controls';
import { patchClip } from './edit';
import {
  DEFAULT_SHAPE_STROKE,
  SHAPE_LABELS,
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
      <AnimField id={id} prop="width" label="width" title="width of the figure (px, at scale 100%)" suffix="px" min={1} max={20000} step={1} precision={0} />
      <AnimField id={id} prop="height" label="height" title="height of the figure (px, at scale 100%)" suffix="px" min={1} max={20000} step={1} precision={0} />
      {hasPoints(clip.kind) ? (
        <AnimField id={id} prop="points" label="points" title="number of corners (3 to 12)" min={3} max={12} step={1} precision={0} />
      ) : null}
      {clip.kind === 'star' ? (
        <AnimField id={id} prop="inner" label="inner" title="inner radius of the star (% of the outer radius)" scale={100} suffix="%" min={10} max={95} step={1} precision={0} />
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
                <AnimField id={id} prop="gradientAngle" label="angle" title="gradient direction (degrees, 0 = left to right, 90 = top to bottom)" suffix="deg" min={-360} max={360} step={1} precision={0} />
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
        <AnimField id={id} prop="stroke.width" label="width" title="outline width (px)" suffix="px" min={0.5} max={500} step={0.5} precision={1} />
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
