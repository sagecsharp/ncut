import { memo } from 'react';
import { Eraser, RotateCcw } from 'lucide-react';
import { NumberField } from '../../components/ui/NumberField';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import type { Keyframes, LookAt, Shape3D } from '../../types';
import { AnimField } from './AnimField';
import { setValuesNow } from './animEdit';
import { Row, SelectRow, Section, Switch } from './controls';
import { beginEdit, liveOpts } from './edit';

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
];
const SHAPES: [Shape3D, string][] = [
  ['plane', 'plane'],
  ['box', 'box'],
  ['sphere', 'sphere'],
  ['cylinder', 'cylinder'],
];

interface ThreeDProps {
  id: string;
  threeD: boolean;
  lookAt: LookAt;
  shape: Shape3D;
  shapeDepth: number | undefined;
  /** thickness used while shapeDepth is missing */
  defaultDepth: number;
}

export const ThreeDSection = memo(function ThreeDSection({ id, threeD, lookAt, shape, shapeDepth, defaultDepth }: ThreeDProps) {
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
            label="look at camera"
            title="make this clip face the camera"
            value={lookAt}
            options={LOOK_AT}
            onChange={(v) => actions().updateClip(id, { lookAt: v as LookAt })}
          />
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

const CAMERA_HOME = { x: 0, y: 0, z: 0, pan: 0, tilt: 0, roll: 0, fov: 50 };

export const CameraSection = memo(function CameraSection({ id }: { id: string }) {
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
      <div className="props-hint">the camera for every 3d clip while this clip is active</div>
      <div className="props-buttons">
        <button type="button" className="btn btn-sm" title="back to the home view (all 0, field of view 50)" onClick={() => setValuesNow(id, CAMERA_HOME)}>
          <RotateCcw size={14} />
          reset
        </button>
      </div>
    </Section>
  );
});
