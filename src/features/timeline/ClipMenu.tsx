import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, ListEnd, Scissors, Trash2, Volume2, VolumeX } from 'lucide-react';
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
