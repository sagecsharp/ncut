import { memo, useMemo } from 'react';
import { Eraser, RotateCcw } from 'lucide-react';
import { hasKeyframes, valueAt } from '../../lib/anim';
import { NumberField } from '../../components/ui/NumberField';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import type { Keyframes, LookAt, Shape3D } from '../../types';
import { SHAPES_3D } from '../../types';
import { AnimField } from './AnimField';
import { setValuesNow } from './animEdit';
import { Row, SelectRow, Section, Switch } from './controls';
import { targetOptions } from './targets';
import { CAMERA_MOVES, cameraMove, moveProps } from './cameraMoves';
import type { CameraMoveId, CameraValues } from './cameraMoves';
import { beginEdit, liveOpts, patchClip } from './edit';
import { ParentSelect } from './AttachSection';
import { lookTargetOptions } from './parentOptions';

const actions = () => useEditor.getState();

/* ---------- animation summary ---------- */

export const AnimationSection = memo(function AnimationSection({
  id,
  keyframes,
  start,
  duration,
}: {
  id: string;
  keyframes: Keyframes;
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
  return (
    <Section id="animation" title="animation">
      <div className="props-stat">
        <span className="props-hint" title="keyframes on this clip">
          {keys} {keys === 1 ? 'keyframe' : 'keyframes'} on {props} {props === 1 ? 'value' : 'values'}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          title="remove every keyframe. values stay as they are at the playhead."
          onClick={() => actions().clearKeyframes(id, clamp(usePlayback.getState().time, start, start + duration))}
        >
          <Eraser size={14} />
          clear all
        </button>
      </div>
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
};
const SHAPES: [Shape3D, string][] = SHAPES_3D.map((s) => [s, SHAPE_NAMES[s]]);

/** "which clip": the clip a 3d clip faces (lookAt 'clip'). the name beside it selects that clip. */
const LookTargetRow = memo(function LookTargetRow({ id, target }: { id: string; target: string | null }) {
  const clips = useEditor((s) => s.project?.clips);
  const options = useMemo(() => (clips ? lookTargetOptions({ clips }, id) : []), [clips, id]);
  const picked = target ? options.find((o) => o.id === target) : undefined;
  return (
    <>
      <ParentSelect
        label="which clip"
        title="the clip this one keeps facing"
        value={target ?? ''}
        options={options}
        onPick={(tid) => patchClip(id, { lookTarget: tid })}
      />
      {picked ? (
        <div className="props-stat">
          <button type="button" className="btn btn-sm" title="select the clip this one faces" onClick={() => actions().select([picked.id])}>
            {picked.label}
          </button>
        </div>
      ) : null}
    </>
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
}

export const ThreeDSection = memo(function ThreeDSection({ id, threeD, lookAt, lookTarget, shape, shapeDepth, defaultDepth }: ThreeDProps) {
  return (
    <Section id="threed" title="3d">
      <Row label="3d" title="place this clip in 3d space" wide>
        <Switch checked={threeD} title="3d on or off" onChange={(v) => actions().updateClip(id, { threeD: v })} />
      </Row>
      {threeD ? (
        <>
          <AnimField wide id={id} prop="z" label="depth" title="depth: how far away from the viewer (px)" suffix="px" step={1} precision={0} />
          <AnimField wide id={id} prop="rotX" label="tilt" title="tilt: lean the top edge away or toward you (degrees)" suffix="deg" step={1} precision={1} />
          <AnimField wide id={id} prop="rotY" label="turn" title="turn: face left or right (degrees)" suffix="deg" step={1} precision={1} />
          <SelectRow
            wide
            label="look at"
            title="make this clip face the camera or another clip"
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
          {shape === 'box' || shape === 'cylinder' ? (
            <Row label="thickness" title="thickness of the shape (px)" wide>
              <NumberField
                className="props-grow"
                suffix="px"
                title="thickness (px)"
                value={shapeDepth ?? defaultDepth}
                min={1}
                max={10000}
                precision={0}
                onStart={beginEdit}
                onChange={(v) => actions().updateClip(id, { shapeDepth: v }, liveOpts())}
              />
            </Row>
          ) : null}
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
          title="remove every keyframe of the camera. values stay as they are at the playhead."
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

export const CameraSection = memo(function CameraSection({ id, target }: { id: string; target: string | null }) {
  const clips = useEditor((s) => s.project?.clips);
  const tracks = useEditor((s) => s.project?.tracks);
  const options = useMemo(() => (clips && tracks ? targetOptions(clips, tracks) : []), [clips, tracks]);
  const known = target !== null && options.some((o) => o.id === target);
  return (
    <Section id="camera" title="camera">
      <AnimField wide id={id} prop="x" label="move right" title="move the camera right (px)" suffix="px" step={1} precision={0} />
      <AnimField wide id={id} prop="y" label="move down" title="move the camera down (px)" suffix="px" step={1} precision={0} />
      <AnimField wide id={id} prop="z" label="move forward" title="move the camera forward, into the scene (px)" suffix="px" step={1} precision={0} />
      <AnimField wide id={id} prop="pan" label="pan" title="pan: look left or right (degrees)" suffix="deg" step={1} precision={1} />
      <AnimField wide id={id} prop="tilt" label="tilt" title="tilt: look up or down (degrees)" suffix="deg" step={1} precision={1} />
      <AnimField wide id={id} prop="roll" label="roll" title="roll: turn the picture clockwise (degrees)" suffix="deg" step={1} precision={1} />
      <AnimField
        wide
        slider
        id={id}
        prop="fov"
        label="field of view"
        title="field of view in degrees. smaller zooms in."
        suffix="deg"
        min={5}
        max={150}
        step={1}
        precision={0}
      />
      <SelectRow
        wide
        label="look at"
        title="keep the camera pointed at a clip"
        value={known ? target : ''}
        options={[['', 'none'], ...options.map((o): [string, string] => [o.id, o.label])]}
        onChange={(v) => patchClip(id, { target: v === '' ? null : v })}
      />
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
