import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Blend, Box, Copy, Diamond, ListEnd, Scissors, Square, Trash2, Volume2, VolumeX } from 'lucide-react';
import { hasKeyframes } from '../../lib/anim';
import { isVisualClip } from '../../types';
import { clipEnd } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';

interface Props {
  x: number;
  y: number;
  clipId: string;
  onClose(): void;
}

/** right click menu for a clip. closes on outside click, escape, scroll, resize and blur. */
export function ClipMenu({ x, y, clipId, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const clip = useEditor((s) => s.project?.clips.find((c) => c.id === clipId));
  const selection = useEditor((s) => s.selection);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('wheel', onClose, { capture: true, passive: true });
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('wheel', onClose, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

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
  const is3d = visual.length > 0 && visual.every((c) => c.threeD);

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
