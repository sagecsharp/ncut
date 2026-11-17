import { memo, useCallback, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowLeftRight, Camera, ClipboardPaste, Copy, Eraser, FlipHorizontal2, Maximize, MoveHorizontal, RectangleHorizontal, RectangleVertical, Repeat, RotateCcw, Waves } from 'lucide-react';
import { hasKeyframes, valueAt } from '../../lib/anim';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import type { Clip, Keyframes, LookAt, Shape3D } from '../../types';
import { SHAPES_3D } from '../../types';
import { AnimField } from './AnimField';
import { setValuesNow } from './animEdit';
import { tip } from '../shell/tip';
import { FeelField, Row, SelectRow, Section, Switch, useSelectOpen } from './controls';
import { wiggleFeel } from './fieldFeel';
import { targetLabelOf, targetOptions } from './targets';
import { CAMERA_MOVES, cameraMove, moveProps } from './cameraMoves';
import type { CameraMoveId, CameraValues } from './cameraMoves';
import { LIT_ON } from '../../engine/scene3d/light';
import { beginEdit, liveOpts, patchClip } from './edit';
import { ParentSelect } from './AttachSection';
import { FacesSection } from './FacesSection';
import { faceNames } from '../../engine/scene3d/faces';
import { lookTargetOptions } from './parentOptions';
import { currentLabel } from './selectModel';
import { copyKeysAction, fitKeysAction, pasteKeysAction, repeatKeysAction, reverseKeysAction, wiggleAction, wiggleDefault, wiggleProps } from './keyActions';
import { useKeyClipboard } from './keyClipboard';
import { dropToFloor, frameWithCamera, layFlat, putInFrontOfCamera, standUp } from './placeActions';

const actions = () => useEditor.getState();

/* ---------- animation summary + key tools ---------- */

export const AnimationSection = memo(function AnimationSection({
  id,
  keyframes,
  start,
  duration,
}: {
  id: string;
  keyframes?: Keyframes;
  start: number;
  duration: number;
}) {
  let keys = 0;
  let props = 0;
  for (const k in keyframes) {
    const n = keyframes[k]!.length;
    if (n > 0) {
      keys += n;
      props += 1;
    }
  }
  const has = keys > 0;
  const off = has ? null : 'no keyframes on this clip yet';
  const copied = useKeyClipboard();
  const clip = useEditor((s) => s.project?.clips.find((c) => c.id === id));
  const choices = useMemo(() => (clip ? wiggleProps(clip) : []), [clip?.type, clip && 'threeD' in clip ? clip.threeD : false]); // eslint-disable-line react-hooks/exhaustive-deps
  const [prop, setProp] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [perSecond, setPerSecond] = useState(4);
  const chosen = choices.find((c) => c.prop === prop) ?? choices[0];
  const amt0 = clip && chosen ? wiggleDefault(clip, chosen.prop) : 1;
  const amt = amount ?? amt0;
  return (
    <Section id="animation" title="animation">
      <div className="props-stat">
        <span className="props-hint" title="keyframes on this clip">
          {has ? `${keys} ${keys === 1 ? 'keyframe' : 'keyframes'} on ${props} ${props === 1 ? 'value' : 'values'}` : 'no keyframes yet'}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!has}
          title="clear keyframes: values stay as they are at the playhead."
          onClick={() => actions().clearKeyframes(id, clamp(usePlayback.getState().time, start, start + duration))}
        >
          <Eraser size={14} />
          clear all
        </button>
      </div>
      <div className="props-buttons">
        <button type="button" className="icon-btn icon-btn-sm" disabled={!has} {...tip('reverse', { does: 'play the keyframes backwards', off })} aria-label="reverse keyframes" onClick={() => reverseKeysAction(id)}>
          <FlipHorizontal2 size={14} />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" disabled={!has} {...tip('fit to clip', { does: 'stretch the keyframes over the whole clip', off })} aria-label="fit keyframes to the clip" onClick={() => fitKeysAction(id)}>
          <MoveHorizontal size={14} />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" disabled={!has} {...tip('play twice', { does: 'the keyframes play twice in the same time', off })} aria-label="play the keyframes twice" onClick={() => repeatKeysAction(id, false)}>
          <Repeat size={14} />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" disabled={!has} {...tip('ping pong', { does: 'forward, then backward, in the same time', off })} aria-label="repeat keyframes as ping pong" onClick={() => repeatKeysAction(id, true)}>
          <ArrowLeftRight size={14} />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" disabled={!has} {...tip('copy keyframes', { off })} aria-label="copy keyframes" onClick={() => copyKeysAction(id)}>
          <Copy size={14} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          disabled={!copied}
          {...tip('paste keyframes', { does: 'the first keyframe lands on the playhead', off: copied ? null : 'copy keyframes first' })}
          aria-label="paste keyframes"
          onClick={() => pasteKeysAction(id)}
        >
          <ClipboardPaste size={14} />
        </button>
      </div>
      {chosen ? (
        <>
          <SelectRow
            label="wiggle"
            title="the value to shake"
            value={chosen.prop}
            options={choices.map((c) => [c.prop, c.label])}
            onChange={(v) => {
              setProp(v);
              setAmount(null);
            }}
          />
          <Row label="amount" title="how far it strays from the value at the playhead">
            <FeelField local feel={wiggleFeel(amt0)} value={amt} title="amount" onChange={setAmount} />
          </Row>
          <Row label="per second" title="keyframes per second: higher is faster and jumpier">
            <FeelField local feel="wigglePerSecond" value={perSecond} title="keyframes per second" onChange={setPerSecond} />
          </Row>
          <div className="props-buttons">
            <button
              type="button"
              className="btn btn-sm"
              title="shake this value over the whole clip. replaces its keyframes."
              onClick={() => wiggleAction(id, chosen.prop, amt, perSecond)}
            >
              <Waves size={14} />
              add wiggle
            </button>
          </div>
        </>
      ) : null}
    </Section>
  );
});

/* ---------- 3d ---------- */

const LOOK_AT: [LookAt, string][] = [
  ['none', 'off'],
  ['camera', 'face camera'],
  ['cameraY', 'face camera, stay upright'],
  ['clip', 'a clip'],
];
const SHAPE_NAMES: Record<Shape3D, string> = {
  plane: 'plane',
  box: 'box',
  sphere: 'sphere',
  cylinder: 'cylinder',
  cone: 'cone',
  pyramid: 'pyramid',
  torus: 'ring',
  capsule: 'capsule',
  prism: 'prism',
  hexagon: 'hexagon',
  star: 'star',
  heart: 'heart',
};
const SHAPES: [Shape3D, string][] = SHAPES_3D.map((s) => [s, SHAPE_NAMES[s]]);

/** "which clip": the clip a 3d clip faces (lookAt 'clip'). the name beside it selects that clip. */
const LookTargetRow = memo(function LookTargetRow({ id, target }: { id: string; target: string | null }) {
  // the label of the clip it faces (null: none or not a choice). the full list is only built while the select is open.
  const picked = useEditor((s) => (target && s.project ? currentLabel(lookTargetOptions(s.project, id), target) : null));
  const build = useCallback((clips: readonly Clip[]) => lookTargetOptions({ clips }, id), [id]);
  return (
    <>
      <ParentSelect
        label="which clip"
        title="the clip this one looks at"
        value={target ?? ''}
        current={picked}
        build={build}
        onPick={(tid) => patchClip(id, { lookTarget: tid })}
      />
      {target && picked !== null ? (
        <div className="props-stat">
          <button type="button" className="btn btn-sm" title="select the clip this one looks at" onClick={() => actions().select([target])}>
            {picked}
          </button>
        </div>
      ) : null}
    </>
  );
});

/** one row of 3d placement helpers for a clip: camera, floor and tilt shortcuts, each one undo step */
const PlaceRow = memo(function PlaceRow({ id }: { id: string }) {
  return (
    <div className="props-buttons" role="group" aria-label="place">
      <button
        type="button"
        className="btn btn-sm"
        title="in front of the camera: turns the clip 3d and puts it in the middle of the camera view, facing it. a flat clip gets the distance where it keeps its 2d size, a 3d clip keeps its distance."
        onClick={() => putInFrontOfCamera([id])}
      >
        <Camera size={14} />
        in front of camera
      </button>
      <button
        type="button"
        className="btn btn-sm"
        title="frame with the camera: moves the camera at the playhead so this clip fills about 80% of the frame, seen straight on. adds a camera if there is none. turns the clip 3d."
        onClick={() => frameWithCamera(id)}
      >
        <Maximize size={14} />
        frame with camera
      </button>
      <button type="button" className="btn btn-sm" title="lay flat: tilt the clip 90 degrees, like a floor" onClick={() => layFlat([id])}>
        <RectangleHorizontal size={14} />
        lay flat
      </button>
      <button type="button" className="btn btn-sm" title="stand up: tilt back to 0 degrees" onClick={() => standUp([id])}>
        <RectangleVertical size={14} />
        stand up
      </button>
      <button type="button" className="btn btn-sm" title="on the floor: move the clip down so its bottom edge sits on the bottom of the frame" onClick={() => dropToFloor([id])}>
        <ArrowDownToLine size={14} />
        on the floor
      </button>
    </div>
  );
});

interface ThreeDProps {
  id: string;
  threeD: boolean;
  lookAt: LookAt;
  lookTarget: string | null;
  shape: Shape3D;
  shapeDepth: number | undefined;
  /** thickness used while shapeDepth is missing */
  defaultDepth: number;
  /** the clip has a stored lit value (0 included) or keys on lit */
  lit: boolean;
}

/** on = the lit amount of the switch. off = no value and no keys, as one undo step. a drag to 0 keeps the value, so the slider stays mounted */
function setLit(id: string, on: boolean): void {
  const st = actions();
  if (on) {
    st.updateClip(id, { lit: LIT_ON });
    return;
  }
  beginEdit();
  st.clearKeyframes(id, usePlayback.getState().time, 'lit', liveOpts());
  patchClip(id, { lit: null }, true);
}

export const ThreeDSection = memo(function ThreeDSection({ id, threeD, lookAt, lookTarget, shape, shapeDepth, defaultDepth, lit }: ThreeDProps) {
  return (
    <Section id="threed" title="3d">
      <Row label="3d" title="place this clip in 3d space" wide>
        <Switch checked={threeD} title="3d on or off" onChange={(v) => actions().updateClip(id, { threeD: v })} />
      </Row>
      <PlaceRow id={id} />
      {threeD ? (
        <>
          <AnimField wide id={id} prop="z" label="depth" title="depth: how far away from the viewer (px)" feel="z" />
          <AnimField wide id={id} prop="rotX" label="tilt" title="tilt: lean the top edge away or toward you (degrees)" feel="rotX" />
          <AnimField wide id={id} prop="rotY" label="turn" title="turn: look left or right (degrees)" feel="rotY" />
          <SelectRow
            wide
            label="look at"
            title="keep this clip turned to the camera or another clip"
            value={lookAt}
            options={LOOK_AT}
            onChange={(v) => patchClip(id, v === 'clip' ? { lookAt: v } : { lookAt: v, lookTarget: null })}
          />
          {lookAt === 'clip' ? <LookTargetRow id={id} target={lookTarget} /> : null}
          <SelectRow
            wide
            label="shape"
            title="what the clip is wrapped on"
            value={shape}
            options={SHAPES}
            onChange={(v) => actions().updateClip(id, { shape: v as Shape3D })}
          />
          {shape !== 'plane' && shape !== 'sphere' ? (
            <AnimField wide id={id} prop="shapeDepth" label="thickness" title="thickness of the shape (px)" feel="shapeDepth" fallback={defaultDepth} />
          ) : null}
          {shape !== 'plane' ? (
            <AnimField wide id={id} prop="scaleZ" label="scale z" title="stretch the depth only, on top of scale (%)" feel="scaleZ" />
          ) : null}
          <Row label="lit" title="shade this clip with the light of the scene (project, light). it only darkens or tints: in a dark scene the clip gets darker" wide>
            <Switch checked={lit} title="lit on or off" onChange={(on) => setLit(id, on)} />
          </Row>
          {lit ? (
            <AnimField wide id={id} prop="lit" label="how lit" title="how much the light changes this clip (%). 0 = as it is. lower it when the clip gets too dark" feel="lit" />
          ) : null}
          {faceNames(shape).length > 0 ? <FacesSection id={id} shape={shape} /> : null}
        </>
      ) : null}
      <div className="props-hint">3d clips share one space and one camera. add a camera clip to move through it.</div>
    </Section>
  );
});

/* ---------- camera clip ---------- */

const CAMERA_PROPS: (keyof CameraValues)[] = ['x', 'y', 'z', 'pan', 'tilt', 'roll', 'fov'];

/** write the keys of a named move as ONE undo step; only the values the move uses lose their old keys */
function applyCameraMove(id: string, move: CameraMoveId): void {
  const st = actions();
  const p = st.project;
  const clip = p?.clips.find((c) => c.id === id);
  if (!p || !clip || clip.type !== 'camera') return;
  const cur = {} as CameraValues;
  for (const k of CAMERA_PROPS) cur[k] = valueAt(clip, k, clip.start) ?? clip[k];
  const keys = cameraMove(move, cur, clip.duration, p.fps);
  if (keys.length === 0) return;
  st.pushHistory();
  for (const prop of moveProps(keys)) st.clearKeyframes(id, clip.start, prop, { skipHistory: true });
  for (const k of keys) st.setKeyframe(id, k.prop, clip.start + k.t, k.v, k.ease, { skipHistory: true });
}

const CAMERA_HOME = { x: 0, y: 0, z: 0, pan: 0, tilt: 0, roll: 0, fov: 50 };

const CameraMoves = memo(function CameraMoves({ id }: { id: string }) {
  const animated = useEditor((s) => {
    const c = s.project?.clips.find((k) => k.id === id);
    return !!c && hasKeyframes(c);
  });
  return (
    <>
      <div className="props-hint">moves: ready-made camera animation over the whole clip. you can combine them.</div>
      <div className="props-buttons" role="group" aria-label="moves">
        {CAMERA_MOVES.map((m) => (
          <button key={m.id} type="button" className="btn btn-sm" title={m.title} onClick={() => applyCameraMove(id, m.id)}>
            {m.label}
          </button>
        ))}
        <button
          type="button"
          className="btn btn-sm"
          title="clear the keyframes of the camera: values stay as they are at the playhead."
          disabled={!animated}
          onClick={() => {
            const c = actions().project?.clips.find((k) => k.id === id);
            if (c) actions().clearKeyframes(id, clamp(usePlayback.getState().time, c.start, c.start + c.duration));
          }}
        >
          <Eraser size={14} />
          clear moves
        </button>
      </div>
    </>
  );
});

/** the camera's "look at" select. the list of clips is only built and rendered while the select is open. */
function CameraTarget({ id, target }: { id: string; target: string | null }) {
  const { open, handlers } = useSelectOpen();
  const current = useEditor((s) => (target && s.project ? targetLabelOf(s.project.clips, s.project.tracks, target) : null));
  const clips = useEditor((s) => (open ? s.project?.clips : undefined));
  const tracks = useEditor((s) => (open ? s.project?.tracks : undefined));
  const full = useMemo(() => (open && clips && tracks ? targetOptions(clips, tracks) : null), [open, clips, tracks]);
  const known = target !== null && (full ? full.some((o) => o.id === target) : current !== null);
  const options: [string, string][] = full
    ? [['', 'none'], ...full.map((o): [string, string] => [o.id, o.label])]
    : known && target !== null && current !== null
      ? [[target, current]]
      : [['', 'none']];
  return (
    <SelectRow
      wide
      label="look at"
      title="keep the camera pointed at a clip"
      value={known ? target : ''}
      options={options}
      onChange={(v) => patchClip(id, { target: v === '' ? null : v })}
      handlers={handlers}
    />
  );
}

export const CameraSection = memo(function CameraSection({ id, target }: { id: string; target: string | null }) {
  return (
    <Section id="camera" title="camera">
      <AnimField wide id={id} prop="x" label="move right" title="move the camera right (px)" feel="x" />
      <AnimField wide id={id} prop="y" label="move down" title="move the camera down (px)" feel="y" />
      <AnimField wide id={id} prop="z" label="move forward" title="move the camera forward, into the scene (px)" feel="cameraZ" />
      <AnimField wide id={id} prop="pan" label="pan" title="pan: look left or right (degrees)" feel="pan" />
      <AnimField wide id={id} prop="tilt" label="tilt" title="tilt: look up or down (degrees)" feel="cameraTilt" />
      <AnimField wide id={id} prop="roll" label="roll" title="roll: rotate the picture clockwise (degrees)" feel="roll" />
      <AnimField wide id={id} prop="fov" label="field of view" title="field of view in degrees. smaller zooms in." feel="fov" />
      <CameraTarget id={id} target={target} />
      <div className="props-hint">the camera keeps this clip centered. pan and tilt add an offset.</div>
      <div className="props-hint">the camera for every 3d clip while this clip is active</div>
      <CameraMoves id={id} />
      <div className="props-buttons">
        <button type="button" className="btn btn-sm" title="back to the home view (all 0, field of view 50)" onClick={() => setValuesNow(id, CAMERA_HOME)}>
          <RotateCcw size={14} />
          reset
        </button>
      </div>
    </Section>
  );
});
