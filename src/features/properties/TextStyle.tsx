import { memo } from 'react';
import { NumberField } from '../../components/ui/NumberField';
import {
  DEFAULT_TEXT_ANIM_IN,
  DEFAULT_TEXT_ANIM_LOOP,
  DEFAULT_TEXT_ANIM_OUT,
  TEXT_ANIMS_IN,
  TEXT_ANIMS_LOOP,
  TEXT_ANIMS_OUT,
} from '../../engine/textAnim';
import { useEditor } from '../../store/editorStore';
import type { ClipPatch } from '../../store/editorStore';
import type { TextAnim, TextClip, TextGradient, TextHighlight, TextShadow, TextStroke } from '../../types';
import { ColorField, Row, Section, SelectRow, Switch } from './controls';
import { beginEdit, liveOpts } from './edit';
import { MotionRow } from './MotionSection';
import { defaultSecondColor } from './shapeLogic';

const actions = () => useEditor.getState();

const DEFAULT_STROKE: TextStroke = { color: '#000000', width: 0.08 };
const DEFAULT_HIGHLIGHT: TextHighlight = { color: '#ffe14d', mode: 'fill' };
const DEFAULT_HIGHLIGHT_BOX = '#000000';
const DEFAULT_SHADOW: TextShadow = { color: '#000000', opacity: 0.6, blur: 0.1, distance: 0.08, angle: 45 };

/** a percent field for a fraction stored in the clip */
function Pct({
  label,
  title,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  title: string;
  value: number;
  min: number;
  max: number;
  onChange: (fraction: number) => void;
}) {
  return (
    <Row label={label} title={title}>
      <NumberField
        className="props-grow"
        suffix="%"
        title={title}
        value={Math.round(value * 100)}
        min={min}
        max={max}
        precision={0}
        onStart={beginEdit}
        onChange={(v) => onChange(v / 100)}
      />
    </Row>
  );
}

export const TextStyleSection = memo(function TextStyleSection({ clip }: { clip: TextClip }) {
  const id = clip.id;
  const { stroke, shadow, gradient, highlight } = clip;
  const setGradient = (patch: Partial<TextGradient>) => {
    if (gradient) actions().updateClip(id, { gradient: { ...gradient, ...patch } }, liveOpts());
  };
  const setStroke = (patch: Partial<TextStroke>) => {
    if (stroke) actions().updateClip(id, { stroke: { ...stroke, ...patch } }, liveOpts());
  };
  const setHighlight = (patch: Partial<TextHighlight>) => {
    if (highlight) actions().updateClip(id, { highlight: { ...highlight, ...patch } }, liveOpts());
  };
  const setShadow = (patch: Partial<TextShadow>) => {
    if (shadow) actions().updateClip(id, { shadow: { ...shadow, ...patch } }, liveOpts());
  };

  return (
    <Section id="text-style" title="text style">
      <Pct
        label="spacing"
        title="space between letters (% of the font size)"
        value={clip.letterSpacing ?? 0}
        min={-50}
        max={200}
        onChange={(v) => actions().updateClip(id, { letterSpacing: v }, liveOpts())}
      />
      <Pct
        label="line gap"
        title="space between lines (% of the font size)"
        value={clip.lineHeight ?? 1.25}
        min={50}
        max={300}
        onChange={(v) => actions().updateClip(id, { lineHeight: v }, liveOpts())}
      />
      <Row label="capitals" title="draw the text in capital letters">
        <Switch checked={!!clip.uppercase} title="capitals on or off" onChange={(v) => actions().updateClip(id, { uppercase: v })} />
      </Row>

      <Row label="outline" title="a line around the letters">
        <Switch
          checked={!!stroke}
          title="outline on or off"
          onChange={(v) => actions().updateClip(id, { stroke: v ? { ...DEFAULT_STROKE } : null })}
        />
        {stroke ? <ColorField title="outline color" value={stroke.color} onChange={(c) => setStroke({ color: c })} /> : null}
      </Row>
      {stroke ? (
        <Pct label="width" title="outline width (% of the font size)" value={stroke.width} min={1} max={50} onChange={(v) => setStroke({ width: v })} />
      ) : null}

      <Row label="shadow" title="a shadow behind the letters">
        <Switch
          checked={!!shadow}
          title="shadow on or off"
          onChange={(v) => actions().updateClip(id, { shadow: v ? { ...DEFAULT_SHADOW } : null })}
        />
        {shadow ? <ColorField title="shadow color" value={shadow.color} onChange={(c) => setShadow({ color: c })} /> : null}
      </Row>
      {shadow ? (
        <>
          <Pct label="opacity" title="shadow opacity (%)" value={shadow.opacity} min={0} max={100} onChange={(v) => setShadow({ opacity: v })} />
          <Pct label="blur" title="shadow softness (% of the font size)" value={shadow.blur} min={0} max={100} onChange={(v) => setShadow({ blur: v })} />
          <Pct
            label="distance"
            title="how far the shadow falls (% of the font size)"
            value={shadow.distance}
            min={0}
            max={100}
            onChange={(v) => setShadow({ distance: v })}
          />
          <Row label="angle" title="direction the shadow falls (degrees, 0 = right, 90 = down)">
            <NumberField
              className="props-grow"
              suffix="deg"
              title="shadow angle (degrees)"
              value={shadow.angle}
              min={-360}
              max={360}
              precision={0}
              onStart={beginEdit}
              onChange={(v) => setShadow({ angle: v })}
            />
          </Row>
        </>
      ) : null}

      <Row label="gradient" title="fill the letters with a gradient instead of one color">
        <Switch
          checked={!!gradient}
          title="gradient on or off"
          onChange={(v) =>
            actions().updateClip(id, { gradient: v ? { from: clip.color, to: defaultSecondColor(clip.color), angle: 0 } : null })
          }
        />
        {gradient ? <ColorField title="gradient start color" value={gradient.from} onChange={(c) => setGradient({ from: c })} /> : null}
      </Row>
      {gradient ? (
        <>
          <Row label="to" title="gradient end color">
            <ColorField title="gradient end color" value={gradient.to} onChange={(c) => setGradient({ to: c })} />
          </Row>
          <Row label="angle" title="gradient direction (degrees, 0 = left to right, 90 = top to bottom)">
            <NumberField
              className="props-grow"
              suffix="deg"
              title="gradient angle (degrees)"
              value={gradient.angle}
              min={-360}
              max={360}
              precision={0}
              onStart={beginEdit}
              onChange={(v) => setGradient({ angle: v })}
            />
          </Row>
        </>
      ) : null}

      <Row label="curve" title="bend each line along a circle (degrees of arc, + arch, - smile, 0 straight)">
        <NumberField
          className="props-grow"
          suffix="deg"
          title="curve (degrees, 0 = straight)"
          value={clip.curve ?? 0}
          min={-360}
          max={360}
          precision={0}
          onStart={beginEdit}
          onChange={(v) => actions().updateClip(id, { curve: v === 0 ? null : v } as ClipPatch, liveOpts())}
        />
      </Row>
      <Row label="wrap" title="wrap lines longer than this width (px, 0 = off)">
        <NumberField
          className="props-grow"
          suffix="px"
          title="wrap width (px, 0 = off)"
          value={clip.wrapWidth ?? 0}
          min={0}
          max={20000}
          precision={0}
          onStart={beginEdit}
          onChange={(v) => actions().updateClip(id, { wrapWidth: v === 0 ? null : v } as ClipPatch, liveOpts())}
        />
      </Row>

      <Row label="karaoke" title="light up the words one after another over the length of the clip">
        <Switch
          checked={!!highlight}
          title="karaoke on or off"
          onChange={(v) => actions().updateClip(id, { highlight: v ? { ...DEFAULT_HIGHLIGHT } : null })}
        />
        {highlight ? <ColorField title="color of the lit words" value={highlight.color} onChange={(c) => setHighlight({ color: c })} /> : null}
      </Row>
      {highlight ? (
        <>
          <SelectRow
            label="lit"
            title="one word at a time, or every word up to the current one"
            value={highlight.mode}
            options={[
              ['word', 'one word'],
              ['fill', 'fill up'],
            ]}
            onChange={(v) => setHighlight({ mode: v === 'word' ? 'word' : 'fill' })}
          />
          <Row label="box" title="a box behind the word that is lit">
            <Switch
              checked={!!highlight.background}
              title="box behind the lit word on or off"
              onChange={(v) => setHighlight({ background: v ? DEFAULT_HIGHLIGHT_BOX : null })}
            />
            {highlight.background ? (
              <ColorField title="color of the box behind the lit word" value={highlight.background} onChange={(c) => setHighlight({ background: c })} />
            ) : null}
          </Row>
        </>
      ) : null}

      {clip.background !== null ? (
        <>
          <Pct
            label="corners"
            title="corner roundness of the box (0 square, 100 pill)"
            value={clip.backgroundRadius ?? 0}
            min={0}
            max={100}
            onChange={(v) => actions().updateClip(id, { backgroundRadius: v }, liveOpts())}
          />
          <Pct
            label="padding"
            title="space between the text and the edge of the box (% of the font size)"
            value={clip.backgroundPadding ?? 0.3}
            min={0}
            max={200}
            onChange={(v) => actions().updateClip(id, { backgroundPadding: v }, liveOpts())}
          />
        </>
      ) : null}
    </Section>
  );
});

/* ---------- text animation ---------- */

export const TextAnimSection = memo(function TextAnimSection({ clip }: { clip: TextClip }) {
  const id = clip.id;
  const set = (key: 'animIn' | 'animOut' | 'animLoop') => (next: TextAnim | null, live: boolean) =>
    actions().updateClip(id, { [key]: next }, live ? liveOpts() : undefined);
  return (
    <Section id="text-anim" title="text animation">
      <MotionRow
        label="in"
        title="how the text appears"
        list={TEXT_ANIMS_IN}
        value={clip.animIn}
        defaultDuration={DEFAULT_TEXT_ANIM_IN}
        durationTitle="how long the entrance takes (seconds)"
        onChange={set('animIn')}
      />
      <MotionRow
        label="out"
        title="how the text leaves"
        list={TEXT_ANIMS_OUT}
        value={clip.animOut}
        defaultDuration={DEFAULT_TEXT_ANIM_OUT}
        durationTitle="how long the exit takes (seconds)"
        onChange={set('animOut')}
      />
      <MotionRow
        label="loop"
        title="a motion that repeats while the text is on screen"
        list={TEXT_ANIMS_LOOP}
        value={clip.animLoop}
        defaultDuration={DEFAULT_TEXT_ANIM_LOOP}
        durationTitle="seconds per cycle"
        onChange={set('animLoop')}
      />
    </Section>
  );
});
