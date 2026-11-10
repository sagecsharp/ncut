import { useRef } from 'react';
import { Blend, Box, Copy, Diamond, Link2, Link2Off, ListEnd, MousePointer2, Paperclip, Replace, Scissors, Snowflake, Square, Trash2, Volume2, VolumeX } from 'lucide-react';
import { hasKeyframes } from '../../lib/anim';
import { isVisualClip } from '../../types';
import { clipEnd } from '../../lib/timelineOps';
import { childrenOf, parentOf } from '../../lib/links';
import { attachClips } from '../properties/attachActions';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { freezeAtPlayhead, groupIdsNow, ungroupIdsNow } from './actions';
import { useFloatingMenu } from './menuBehavior';
import { swapCandidates } from './swap';

interface Props {
  x: number;
  y: number;
  clipId: string;
  onClose(): void;
}

/** right click menu for a clip. closes on outside click, escape, scroll, resize and blur. */
export function ClipMenu({ x, y, clipId, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const clip = useEditor((s) => s.project?.clips.find((c) => c.id === clipId));
  const selection = useEditor((s) => s.selection);

  const pos = useFloatingMenu(ref, x, y, onClose);

  if (!clip) return null;
  const ids = selection.includes(clipId) ? selection : [clipId];
  const time = usePlayback.getState().time;
  const canSplit = !!useEditor
    .getState()
    .project?.clips.some((c) => ids.includes(c.id) && time > c.start + 0.05 && time < clipEnd(c) - 0.05);
  const timed = clip.type === 'video' || clip.type === 'audio';
  const muted = (clip.type === 'video' || clip.type === 'audio') && clip.muted;
  const project = useEditor.getState().project;
  const picked = (project?.clips ?? []).filter((c) => ids.includes(c.id));
  const withTransition = picked.filter((c) => isVisualClip(c) && c.transition);
  const withKeys = picked.filter((c) => hasKeyframes(c));
  const visual = picked.filter(isVisualClip);
  const grouped = picked.some((c) => c.group);
  const children = project ? childrenOf(project, clip.id) : [];
  const parent = project ? parentOf(project, clip) : null;
  const attached = project ? picked.filter(isVisualClip).filter((c) => parentOf(project, c)) : [];
  const inClip = time >= clip.start && time <= clipEnd(clip);
  const is3d = visual.length > 0 && visual.every((c) => c.threeD);

  const swaps = project ? swapCandidates(project.assets, clip) : [];
  const canSplitAll = !!project?.clips.some((c) => time > c.start + 0.05 && time < clipEnd(c) - 0.05);

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div ref={ref} className="menu timeline-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      <button
        className="menu-item"
        role="menuitem"
        disabled={!canSplit}
        title="split the selected clips at the playhead"
        onClick={run(() => useEditor.getState().splitClips(usePlayback.getState().time, ids))}
      >
        <Scissors size={14} />
        split at playhead
      </button>
      <button
        className="menu-item"
        role="menuitem"
        disabled={!canSplitAll}
        title="split every clip on every track at the playhead"
        onClick={run(() => {
          const st = useEditor.getState();
          st.splitClips(usePlayback.getState().time, st.project?.clips.map((c) => c.id) ?? []);
        })}
      >
        <Scissors size={14} />
        split all tracks here
      </button>
      <button
        className="menu-item"
        role="menuitem"
        title="duplicate the selected clips"
        onClick={run(() => useEditor.getState().duplicateClips(ids))}
      >
        <Copy size={14} />
        duplicate
      </button>
      <div className="menu-sep" />
      <button
        className="menu-item"
        role="menuitem"
        title="delete the selected clips"
        onClick={run(() => useEditor.getState().deleteClips(ids))}
      >
        <Trash2 size={14} />
        delete
      </button>
      <button
        className="menu-item"
        role="menuitem"
        title="delete and close the gap"
        onClick={run(() => useEditor.getState().deleteClips(ids, { ripple: true }))}
      >
        <ListEnd size={14} />
        ripple delete
      </button>
      {ids.length > 1 || grouped || children.length > 0 || parent || attached.length > 0 || clip.type === 'video' ? <div className="menu-sep" /> : null}
      {ids.length > 1 ? (
        <button className="menu-item" role="menuitem" title="move and edit these clips as one (ctrl+g)" onClick={run(() => groupIdsNow(ids))}>
          <Link2 size={14} />
          group
        </button>
      ) : null}
      {grouped ? (
        <button className="menu-item" role="menuitem" title="split the group apart (ctrl+shift+g)" onClick={run(() => ungroupIdsNow(ids))}>
          <Link2Off size={14} />
          ungroup
        </button>
      ) : null}
      {children.length > 0 ? (
        <button
          className="menu-item"
          role="menuitem"
          title="select this clip and the clips attached to it"
          onClick={run(() => useEditor.getState().select([clip.id, ...children.map((c) => c.id)], 'replace'))}
        >
          <MousePointer2 size={14} />
          select attached clips
        </button>
      ) : null}
      {parent ? (
        <button
          className="menu-item"
          role="menuitem"
          title="select the clip this one is attached to"
          onClick={run(() => useEditor.getState().select([parent.id], 'replace'))}
        >
          <Paperclip size={14} />
          select what it is attached to
        </button>
      ) : null}
      {attached.length > 0 ? (
        <button
          className="menu-item"
          role="menuitem"
          title="detach the selected clips, they stay where they are"
          onClick={run(() => {
            // the shared action: one undo step, keeps the place on screen, leaves animated values alone
            attachClips(
              attached.map((c) => c.id),
              null,
            );
          })}
        >
          <Paperclip size={14} />
          detach
        </button>
      ) : null}
      {clip.type === 'video' ? (
        <button
          className="menu-item"
          role="menuitem"
          disabled={!inClip}
          title={inClip ? 'turn the frame at the playhead into a still (shift+f)' : 'move the playhead onto the clip first'}
          onClick={run(freezeAtPlayhead)}
        >
          <Snowflake size={14} />
          freeze frame
        </button>
      ) : null}
      {swaps.length > 0 ? (
        <>
          <div className="menu-sep" />
          <div className="menu-hint" aria-hidden="true">
            swap media
          </div>
          {swaps.map((a) => (
            <button
              key={a.id}
              className="menu-item"
              role="menuitem"
              title={`replace this clip's media with ${a.name}`}
              onClick={run(() => {
                if (!useEditor.getState().replaceClipAsset(clip.id, a.id)) useUi.getState().toast('could not swap the media');
              })}
            >
              <Replace size={14} />
              <span className="timeline-menu-asset">{a.name}</span>
            </button>
          ))}
        </>
      ) : null}
      {withTransition.length > 0 || withKeys.length > 0 || visual.length > 0 ? <div className="menu-sep" /> : null}
      {withTransition.length > 0 ? (
        <button
          className="menu-item"
          role="menuitem"
          title="remove the transition from the selected clips"
          onClick={run(() => {
            const st = useEditor.getState();
            st.pushHistory();
            for (const c of withTransition) st.updateClip(c.id, { transition: null }, { skipHistory: true });
          })}
        >
          <Blend size={14} />
          remove transition
        </button>
      ) : null}
      {withKeys.length > 0 ? (
        <button
          className="menu-item"
          role="menuitem"
          title="remove every keyframe of the selected clips (values stay as they are at the playhead)"
          onClick={run(() => {
            const st = useEditor.getState();
            const now = usePlayback.getState().time;
            st.pushHistory();
            for (const c of withKeys) st.clearKeyframes(c.id, Math.min(clipEnd(c), Math.max(c.start, now)), undefined, { skipHistory: true });
          })}
        >
          <Diamond size={14} />
          clear keyframes
        </button>
      ) : null}
      {visual.length > 0 ? (
        <button
          className="menu-item"
          role="menuitem"
          title={is3d ? 'make the selected clips flat 2d again' : 'place the selected clips in 3d space'}
          onClick={run(() => {
            const st = useEditor.getState();
            st.pushHistory();
            for (const c of visual) st.updateClip(c.id, { threeD: !is3d }, { skipHistory: true });
          })}
        >
          {is3d ? <Square size={14} /> : <Box size={14} />}
          {is3d ? 'make 2d' : 'make 3d'}
        </button>
      ) : null}
      {timed ? (
        <>
          <div className="menu-sep" />
          <button
            className="menu-item"
            role="menuitem"
            title={muted ? 'unmute the clip audio' : 'mute the clip audio'}
            onClick={run(() => {
              const st = useEditor.getState();
              const next = !muted;
              st.pushHistory();
              for (const id of ids) {
                const c = st.project?.clips.find((x) => x.id === id);
                if (c && (c.type === 'video' || c.type === 'audio')) {
                  useEditor.getState().updateClip(id, { muted: next }, { skipHistory: true });
                }
              }
            })}
          >
            {muted ? <Volume2 size={14} /> : <VolumeX size={14} />}
            {muted ? 'unmute' : 'mute'}
          </button>
        </>
      ) : null}
    </div>
  );
}
