/**
 * actions of the scene view's header buttons and keys: view presets, look through the project camera, frame the
 * selection, and write the current view into a camera clip. they read and write the stores directly.
 */
import { type CameraRig, cameraAt, cameraClipAt, cameraRig, homeDistance } from '../../engine/scene3d/camera';
import type { Vec3 } from '../../engine/scene3d/math';
import { resolveClip } from '../../lib/anim';
import { clipEnd } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { Clip, Project } from '../../types';
import { isVisualClip } from '../../types';
import { asScenePlane, clipQuad } from './overlayMath';
import { type ViewPreset, cameraToOrbit, currentOrbit, frameOrbit, orbitToCameraValues, toCamera3D, useSceneCamera, viewPreset } from './sceneCamera';

export function viewRig(project: Project): CameraRig {
  return cameraRig(toCamera3D(currentOrbit(project), project), project.width, project.height);
}

/** a bounding sphere of a clip in the scene view: a visual clip's plane, or a camera clip's eye */
export function frameTarget(project: Project, clip: Clip, time: number, rig: CameraRig): { center: Vec3; radius: number } | null {
  if (time < clip.start - 1e-6 || time >= clipEnd(clip) - 1e-6) return null;
  if (clip.type === 'camera') {
    const r = resolveClip(clip, time);
    return { center: [project.width / 2 + r.x, project.height / 2 + r.y, -homeDistance(project.height) + r.z], radius: project.height * 0.5 };
  }
  if (!isVisualClip(clip)) return null;
  const w = clipQuad(project, asScenePlane(clip), time, rig).world;
  return {
    center: [(w[0][0] + w[2][0]) / 2, (w[0][1] + w[2][1]) / 2, (w[0][2] + w[2][2]) / 2],
    radius: Math.max(20, Math.hypot(w[0][0] - w[2][0], w[0][1] - w[2][1], w[0][2] - w[2][2]) / 2),
  };
}

export function setViewPreset(name: ViewPreset): void {
  const project = useEditor.getState().project;
  if (project) useSceneCamera.getState().set(viewPreset(name, project));
}

/** look through the project camera as it is at the playhead (roll and fov cannot be shown by an orbit) */
export function viewThroughCamera(): void {
  const project = useEditor.getState().project;
  if (!project) return;
  useSceneCamera.getState().set(cameraToOrbit(cameraAt(project, usePlayback.getState().time), project));
}

/** orbit target on the first selected clip that is on screen now; the distance makes it fill about half the view */
export function frameSelected(): void {
  const { project, selection } = useEditor.getState();
  if (!project) return;
  const time = usePlayback.getState().time;
  const rig = viewRig(project);
  for (const id of selection) {
    const clip = project.clips.find((c) => c.id === id);
    const t = clip ? frameTarget(project, clip, time, rig) : null;
    if (t) {
      useSceneCamera.getState().set(frameOrbit(currentOrbit(project), t.center, t.radius, project, 0.5));
      return;
    }
  }
  useUi.getState().toast('select a clip that is on screen to frame it');
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * write the scene view into the camera clip in charge at the playhead (x y z pan tilt, roll 0 - through
 * setClipValue so animated values get a key). makes a camera clip at the playhead when there is none.
 * one undo step.
 */
export function cameraToView(): void {
  const store = useEditor.getState();
  const project = store.project;
  if (!project) return;
  const time = usePlayback.getState().time;
  const ui = useUi.getState();
  const values = orbitToCameraValues(currentOrbit(project), project);
  let clip = cameraClipAt(project, time);
  let id: string;
  if (clip) {
    id = clip.id;
    store.pushHistory();
  } else {
    // the new clip's own undo step covers the writes below
    id = store.addCamera({ start: time });
    if (!id) return;
  }
  const opts = { skipHistory: true } as const;
  const after = useEditor.getState();
  clip = after.project?.clips.find((c) => c.id === id) as typeof clip;
  if (clip && clip.target) {
    // a target makes the camera aim at that clip: the view would fight it
    after.updateClip(id, { target: null }, opts);
    ui.toast('the camera had a target: cleared it so it can follow the view');
  }
  for (const [prop, v] of [
    ['x', values.x],
    ['y', values.y],
    ['z', values.z],
    ['pan', values.pan],
    ['tilt', values.tilt],
    ['roll', values.roll],
  ] as const) {
    after.setClipValue(id, prop, time, round2(v), opts);
  }
}
