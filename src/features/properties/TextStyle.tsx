import { roundShown } from '../../components/ui/numberFormat';
import { memo, useMemo } from 'react';
import { NumberField } from '../../components/ui/NumberField';
import { COUNTER_TOKEN, DEFAULT_COUNTER } from '../../engine/counter';
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
import type { TextAnim, TextClip, TextCounter, TextExtrude, TextGradient, TextHighlight, TextShadow, TextStroke } from '../../types';
import { AnimField } from './AnimField';
import { ColorField, Row, Section, SelectRow, Switch } from './controls';
import { beginEdit, liveOpts } from './edit';
import { MotionRow } from './MotionSection';
import { defaultSecondColor } from './shapeLogic';
import { SPLIT_MODES, splitPlans, splitReason, splitText } from './textSplitActions';
import { textSignature } from '../../engine/text';

const actions = () => useEditor.getState();

const DEFAULT_STROKE: TextStroke = { color: '#000000', width: 0.08 };
const DEFAULT_STROKE2: TextStroke = { color: '#ffffff', width: 0.06 };
const DEFAULT_HIGHLIGHT: TextHighlight = { color: '#ffe14d', mode: 'fill' };
const DEFAULT_HIGHLIGHT_BOX = '#000000';
const DEFAULT_EXTRUDE: TextExtrude = { depth: 0.2, angle: 135, color: '#555555' };
const DEFAULT_SHADOW: TextShadow = { color: '#000000', opacity: 0.6, blur: 0.1, distance: 0.08, angle: 45 };

/**
 * a percent field for a fraction stored in the clip. with `prop` it is an animatable field of that clip (its own diamond and
 * keys, see lib/anim.ts), the value then goes through the key list instead of `onChange`.
 */
function Pct({
  id,
  prop,
  label,
  title,
  value,
  min,
  max,
  onChange,
}: {
  id?: string;
  prop?: string;
  label: string;
  title: string;
  value: number;
  min: number;
  max: number;
  onChange: (fraction: number) => void;
}) {
  if (id !== undefined && prop !== undefined) {
    return <AnimField id={id} prop={prop} label={label} title={title} scale={100} suffix="%" min={min} max={max} step={1} precision={0} />;
  }
  return (
    <Row label={label} title={title}>
      <NumberField
        className="props-grow"
        suffix="%"
        title={title}
        value={roundShown(value * 100, 0)}
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
  const { stroke, stroke2, shadow, gradient, highlight, extrude, counter } = clip;
  const isTime = counter?.format === 'time';
  const setCounter = (patch: Partial<TextCounter>) => {
    if (counter) actions().updateClip(id, { counter: { ...counter, ...patch } }, liveOpts());
  };
  const setGradient = (patch: Partial<TextGradient>) => {
    if (gradient) actions().updateClip(id, { gradient: { ...gradient, ...patch } }, liveOpts());
  };
  const setStroke = (patch: Partial<TextStroke>) => {
    if (stroke) actions().updateClip(id, { stroke: { ...stroke, ...patch } }, liveOpts());
  };
  const setStroke2 = (patch: Partial<TextStroke>) => {
    if (stroke2) actions().updateClip(id, { stroke2: { ...stroke2, ...patch } }, liveOpts());
  };
  const setHighlight = (patch: Partial<TextHighlight>) => {
    if (highlight) actions().updateClip(id, { highlight: { ...highlight, ...patch } }, liveOpts());
  };
  const setExtrude = (patch: Partial<TextExtrude>) => {
    if (extrude) actions().updateClip(id, { extrude: { ...extrude, ...patch } }, liveOpts());
  };
  const setShadow = (patch: Partial<TextShadow>) => {
    if (shadow) actions().updateClip(id, { shadow: { ...shadow, ...patch } }, liveOpts());
  };

  // what each split mode would make. only the layout of the text matters, so it follows the text signature
  const sig = textSignature(clip);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const plans = useMemo(() => splitPlans(clip), [sig]);

  return (
    <Section id="text-style" title="text style">
      <Pct id={id} prop="letterSpacing"
        label="spacing"
        title="space between letters (% of the font size)"
        value={clip.letterSpacing ?? 0}
        min={-50}
        max={200}
        onChange={(v) => actions().updateClip(id, { letterSpacing: v }, liveOpts())}
      />
      <Pct id={id} prop="lineHeight"
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
        <Pct id={id} prop="stroke.width" label="width" title="outline width (% of the font size)" value={stroke.width} min={1} max={50} onChange={(v) => setStroke({ width: v })} />
      ) : null}
      {stroke || stroke2 || clip.hollow ? (
        <>
          <Row label="2nd outline" title="another line around the first outline, like a sticker">
            <Switch
              checked={!!stroke2}
              title="second outline on or off"
              onChange={(v) => actions().updateClip(id, { stroke2: v ? { ...DEFAULT_STROKE2 } : null })}
            />
            {stroke2 ? <ColorField title="second outline color" value={stroke2.color} onChange={(c) => setStroke2({ color: c })} /> : null}
          </Row>
          {stroke2 ? (
            <Pct id={id} prop="stroke2.width"
              label="width"
              title="second outline width, outside the first one (% of the font size)"
              value={stroke2.width}
              min={1}
              max={50}
              onChange={(v) => setStroke2({ width: v })}
            />
          ) : null}
        </>
      ) : null}
      <Row label="hollow" title="only the outline shows">
        <Switch checked={!!clip.hollow} title="only the outline shows" onChange={(v) => actions().updateClip(id, { hollow: v })} />
      </Row>

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
          <Pct id={id} prop="shadow.opacity" label="opacity" title="shadow opacity (%)" value={shadow.opacity} min={0} max={100} onChange={(v) => setShadow({ opacity: v })} />
          <Pct id={id} prop="shadow.blur" label="blur" title="shadow softness (% of the font size)" value={shadow.blur} min={0} max={100} onChange={(v) => setShadow({ blur: v })} />
          <Pct id={id} prop="shadow.distance"
            label="distance"
            title="how far the shadow falls (% of the font size)"
            value={shadow.distance}
            min={0}
            max={100}
            onChange={(v) => setShadow({ distance: v })}
          />
          <AnimField id={id} prop="shadow.angle" label="angle" title="direction the shadow falls (degrees, 0 = right, 90 = down)" suffix="deg" min={-360} max={360} step={1} precision={0} />
        </>
      ) : null}

      <Row label="depth" title="a solid side behind the letters, like block letters or a long shadow">
        <Switch
          checked={!!extrude}
          title="depth on or off"
          onChange={(v) => actions().updateClip(id, { extrude: v ? { ...DEFAULT_EXTRUDE } : null })}
        />
        {extrude ? <ColorField title="depth color" value={extrude.color} onChange={(c) => setExtrude({ color: c })} /> : null}
      </Row>
      {extrude ? (
        <>
          <Pct id={id} prop="extrude.depth" label="length" title="how far the side reaches (% of the font size)" value={extrude.depth} min={1} max={100} onChange={(v) => setExtrude({ depth: v })} />
          <AnimField id={id} prop="extrude.angle" label="angle" title="direction the side reaches (degrees, 0 = right, 90 = down)" suffix="deg" min={0} max={360} step={1} precision={0} />
          {clip.threeD ? (
            <AnimField id={id} prop="scaleZ" label="scale z" title="stretch the depth of the letters in 3d only, on top of scale (%)" scale={100} suffix="%" min={1} max={1000} step={1} precision={0} />
          ) : null}
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
          <AnimField id={id} prop="gradient.angle" label="angle" title="gradient direction (degrees, 0 = left to right, 90 = top to bottom)" suffix="deg" min={-360} max={360} step={1} precision={0} />
        </>
      ) : null}

      <AnimField id={id} prop="curve" label="curve" title="bend each line along a circle (degrees of arc, + arch, - smile, 0 straight)" suffix="deg" min={-360} max={360} step={1} precision={0} />
      <AnimField id={id} prop="wrapWidth" label="wrap" title="wrap lines longer than this width (px, 0 = off)" suffix="px" min={0} max={20000} step={1} precision={0} />

      <Row label="counter" title="a number that counts up or down over the length of the clip">
        <Switch
          checked={!!counter}
          title="counter on or off"
          onChange={(v) => actions().updateClip(id, { counter: v ? { ...DEFAULT_COUNTER } : null })}
        />
      </Row>
      {counter ? (
        <>
          <Row label="from" title={isTime ? 'seconds at the start' : 'the number at the start'}>
            <NumberField
              className="props-grow"
              title="counter start number"
              value={counter.from}
              min={-1000000000}
              max={1000000000}
              precision={4}
              onStart={beginEdit}
              onChange={(v) => setCounter({ from: v })}
            />
          </Row>
          <Row label="to" title={isTime ? 'seconds at the end' : 'the number at the end'}>
            <NumberField
              className="props-grow"
              title="counter end number"
              value={counter.to}
              min={-1000000000}
              max={1000000000}
              precision={4}
              onStart={beginEdit}
              onChange={(v) => setCounter({ to: v })}
            />
          </Row>
          <SelectRow
            label="show as"
            title="a plain number, or a time (the numbers are seconds: 90 reads 1:30)"
            value={counter.format ?? 'number'}
            options={[
              ['number', 'number'],
              ['time', 'time'],
            ]}
            onChange={(v) => setCounter({ format: v === 'time' ? 'time' : 'number' })}
          />
          <Row label="decimals" title={isTime ? 'digits after the seconds (0 to 4)' : 'digits after the point (0 to 4)'}>
            <NumberField
              className="props-grow"
              title="counter decimals (0 to 4)"
              value={counter.decimals}
              min={0}
              max={4}
              precision={0}
              onStart={beginEdit}
              onChange={(v) => setCounter({ decimals: Math.min(4, Math.max(0, Math.round(v))) })}
            />
          </Row>
          {isTime ? null : (
            <Row label="1,000" title="group the digits in threes">
              <Switch
                checked={!!counter.separator}
                title="thousands separator on or off"
                onChange={(v) => actions().updateClip(id, { counter: { ...counter, separator: v } })}
              />
            </Row>
          )}
          <Row label="steady digits" title="every digit takes the same width, so the text around the number does not jiggle">
            <Switch checked={!!counter.fixedWidth} title="steady digits on or off" onChange={(v) => setCounter({ fixedWidth: v })} />
          </Row>
          <SelectRow
            label="pace"
            title="how the number moves"
            value={counter.ease ?? 'out'}
            options={[
              ['linear', 'steady'],
              ['out', 'fast then slow'],
              ['in-out', 'slow fast slow'],
            ]}
            onChange={(v) => setCounter({ ease: v === 'linear' ? 'linear' : v === 'in-out' ? 'in-out' : 'out' })}
          />
          <Row label="hold at end" title="seconds at the end of the clip where the final number just stays">
            <NumberField
              className="props-grow"
              suffix="s"
              title="hold at end (seconds)"
              value={counter.hold ?? 0}
              min={0}
              max={3600}
              precision={2}
              onStart={beginEdit}
              onChange={(v) => setCounter({ hold: v })}
            />
          </Row>
          <p className="props-hint">
            {COUNTER_TOKEN} in the text is where the number goes
          </p>
        </>
      ) : null}

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
          <Pct id={id} prop="backgroundRadius"
            label="corners"
            title="corner roundness of the box (0 square, 100 pill)"
            value={clip.backgroundRadius ?? 0}
            min={0}
            max={100}
            onChange={(v) => actions().updateClip(id, { backgroundRadius: v }, liveOpts())}
          />
          <Pct id={id} prop="backgroundPadding"
            label="padding"
            title="space between the text and the edge of the box (% of the font size)"
            value={clip.backgroundPadding ?? 0.3}
            min={0}
            max={200}
            onChange={(v) => actions().updateClip(id, { backgroundPadding: v }, liveOpts())}
          />
          <Row label="per line" title="one box per line, like captions">
            <Switch
              checked={!!clip.backgroundPerLine}
              title="one box per line, like captions"
              onChange={(v) => actions().updateClip(id, { backgroundPerLine: v })}
            />
          </Row>
        </>
      ) : null}

      <Row label="split into" title="turn the text into one text clip per letter, word or line, each where it is now">
        <div className="props-seg">
          {SPLIT_MODES.map((mode) => {
            const reason = splitReason(plans?.[mode]);
            return (
              <button
                key={mode}
                type="button"
                className="btn btn-sm"
                disabled={reason !== null}
                title={reason ?? `split into ${mode}: one text clip each, grouped`}
                aria-label={`split into ${mode}`}
                onClick={() => splitText(id, mode)}
              >
                {mode}
              </button>
            );
          })}
        </div>
      </Row>
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
