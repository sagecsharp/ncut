import { useEffect, useMemo } from 'react';
import { NumberField } from '../../components/ui/NumberField';
import { cameraFromClip, cameraRig, homeDistance } from '../../engine/scene3d/camera';
import { focusDistanceForPoint } from '../../engine/scene3d/focus';
import { worldCenterOf } from '../../engine/parent';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { CameraClip, Clip, Project } from '../../types';
import { isVisualClip } from '../../types';
import { AnimField } from './AnimField';
import { Row, Section, useSelectOpen } from './controls';
import { beginEdit, liveOpts } from './edit';
import { targetOptions } from './targets';

const actions = () => useEditor.getState();

/** how far from the camera a clip's center is at the playhead (along the view direction), or null */
function distanceToClip(project: Project, cam: CameraClip, clip: Clip, time: number): number | null {
  if (!isVisualClip(clip)) return null;
  const t = clamp(time, cam.start, cam.start + cam.duration);
  const rig = cameraRig(cameraFromClip(cam, t, project), project.width, project.height);
  return focusDistanceForPoint(rig.eye, rig.forward, worldCenterOf(project, clip, clamp(t, clip.start, clip.start + clip.duration)));
}

/** "from a clip": always reads "pick a clip..." (or "no 3d clips"), so the list of 3d clips is only built while the select is open */
function FromClip({ any3d, off, onPick }: { any3d: boolean; off: boolean; onPick: (id: string) => void }) {
  const { open, handlers } = useSelectOpen();
  const clips = useEditor((s) => (open ? s.project?.clips : undefined));
  const tracks = useEditor((s) => (open ? s.project?.tracks : undefined));
  const options = useMemo(() => {
    if (!open || !clips || !tracks) return [];
    const threeD = new Set(clips.filter((c) => isVisualClip(c) && c.threeD).map((c) => c.id));
    return targetOptions(clips, tracks).filter((o) => threeD.has(o.id));
  }, [open, clips, tracks]);
  return (
    <select
      className="select"
      title="set the focus distance to where a 3d clip is at the playhead"
      aria-label="set focus from a clip"
      disabled={!any3d || off}
      value=""
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value);
      }}
      {...handlers}
    >
      <option value="">{!any3d ? 'no 3d clips' : 'pick a clip...'}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** depth of field controls of a camera clip (CameraClip.focusStrength and friends). */
export function FocusSection({ clip }: { clip: CameraClip }) {
  const id = clip.id;
  const height = useEditor((s) => s.project?.height ?? 1080);
  const home = homeDistance(height);
  const keyed = (prop: string) => (clip.keyframes?.[prop]?.length ?? 0) > 0;
  const blurOn = (clip.focusStrength ?? 0) > 0 || keyed('focusStrength');
  const hasTarget = useEditor((s) => !!clip.target && !!s.project?.clips.some((c) => c.id === clip.target && isVisualClip(c)));
  // is there any 3d clip to focus on (the list itself is only built while its select is open)
  const any3d = useEditor((s) => !!s.project?.clips.some((c) => isVisualClip(c) && c.threeD));
  const following = !!clip.focusOnTarget && hasTarget;

  // a missing focus distance means "the home distance". write it down once blur is on, so it can be edited and keyed.
  // it equals what was drawn already, so it is not an undo step of its own.
  useEffect(() => {
    if (blurOn && clip.focusDistance === undefined && !keyed('focusDistance')) {
      actions().updateClip(id, { focusDistance: Math.round(home) }, { skipHistory: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blurOn, clip.focusDistance, id, home]);

  const pickClip = (cid: string) => {
    const st = actions();
    const p = st.project;
    const target = p?.clips.find((c) => c.id === cid);
    if (!p || !target) return;
    const t = clamp(usePlayback.getState().time, clip.start, clip.start + clip.duration);
    const d = distanceToClip(p, clip, target, t);
    if (d === null) {
      useUi.getState().toast('that clip is behind the camera', 'info');
      return;
    }
    // one undo step (a key when the distance is animated)
    st.setClipValue(id, 'focusDistance', t, Math.max(1, Math.round(d)));
  };

  return (
    <Section id="focus" title="focus">
      <AnimField
        wide
        slider
        id={id}
        prop="focusStrength"
        label="blur"
        title="depth of field: 3d clips go soft away from the focus distance. 0 = off."
        scale={100}
        suffix="%"
        min={0}
        max={100}
        step={1}
        precision={0}
      />
      {blurOn ? (
        <>
          {following ? (
            <Row label="distance" title="the focus follows the clip the camera looks at" wide>
              <span className="props-hint">follows the target</span>
            </Row>
          ) : (
            <AnimField
              wide
              slider
              id={id}
              prop="focusDistance"
              label="distance"
              title="how far from the camera (px) things are sharp"
              suffix="px"
              min={1}
              max={Math.round(home * 6)}
              step={10}
              precision={0}
              fallback={Math.round(home)}
            />
          )}
          <Row label="sharp zone" title="depth around the focus distance (px) that stays sharp" wide>
            <NumberField
              className="props-grow"
              title="sharp zone (px)"
              suffix="px"
              value={clip.focusRange ?? 0}
              min={0}
              max={Math.round(home * 6)}
              step={10}
              precision={0}
              onStart={beginEdit}
              onChange={(v) => actions().updateClip(id, { focusRange: v }, liveOpts())}
            />
          </Row>
          <Row
            label="follow target"
            title={hasTarget ? 'keep the clip the camera looks at in focus' : 'needs a clip in the camera "look at" first'}
            wide
          >
            <input
              type="checkbox"
              className="checkbox"
              title={hasTarget ? 'keep the clip the camera looks at in focus' : 'needs a clip in the camera "look at" first'}
              aria-label="follow target"
              disabled={!hasTarget}
              checked={following}
              onChange={(e) => actions().updateClip(id, { focusOnTarget: e.target.checked })}
            />
          </Row>
          <Row label="from a clip" title="set the focus distance to where a 3d clip is right now" wide>
            <FromClip any3d={any3d} off={following} onPick={pickClip} />
          </Row>
        </>
      ) : null}
      <div className="props-hint">only 3d clips go soft. flat clips stay sharp.</div>
    </Section>
  );
}
