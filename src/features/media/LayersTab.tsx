import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react';
import { Box, Camera, Crosshair, Eye, EyeOff, Film, Image as ImageIcon, Link2, Lock, Pencil, Shapes, Sparkles, SquareDashed, Type, Unlink } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEditor } from '../../store/editorStore';
import type { ClipPatch } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { attachClips } from '../properties/attachActions';
import { expandGroups, parentOf } from '../../lib/links';
import { isCameraClip, isVisualClip } from '../../types';
import type { ClipType, Project } from '../../types';
import { buildLayerTree, canAttach } from './layers';
import type { LayerNode, LayersMode } from './layers';

const TYPE_ICON: Record<ClipType, LucideIcon> = {
  video: Film,
  image: ImageIcon,
  audio: Film,
  text: Type,
  shape: Shapes,
  effect: Sparkles,
  camera: Camera,
};

const MIME = 'application/x-ncut-layer';
/** while playing the outline refreshes at most this often */
const PLAY_REFRESH_MS = 250;

/** attach (parentId) or detach (null) one clip, keeping its place on screen. one undo step. */
function reparent(clipId: string, parentId: string | null): void {
  const st = useEditor.getState();
  const project: Project | null = st.project;
  if (!project) return;
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip || !isVisualClip(clip)) return;
  if (parentId !== null && !canAttach(project, clipId, parentId)) return;
  if ((clip.parent ?? null) === parentId) return;
  // the shared action: one undo step, keeps the place on screen, leaves animated values alone, 3d for a camera
  attachClips([clipId], parentId);
}

interface RowProps {
  node: LayerNode;
  /** name of the clip it is attached to, or null */
  attachedName: string | null;
  selected: boolean;
  dragging: boolean;
  dropping: boolean;
  onPick: (e: MouseEvent, node: LayerNode) => void;
  onOpen: (node: LayerNode) => void;
  onKey: (e: KeyboardEvent, node: LayerNode) => void;
  onDragStart: (e: DragEvent, node: LayerNode) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent, node: LayerNode) => void;
  onDragLeave: (node: LayerNode) => void;
  onDrop: (e: DragEvent, node: LayerNode) => void;
  onDetach: (node: LayerNode) => void;
  renaming: boolean;
  onToggleTrack: (node: LayerNode) => void;
  onStartRename: (node: LayerNode) => void;
  onCommitRename: (node: LayerNode, name: string) => void;
  onCancelRename: () => void;
}

/** inline name editor of a row: enter commits, escape cancels, blur commits */
function RenameInput({ node, onCommit, onCancel }: { node: LayerNode; onCommit: (name: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(node.name);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(draft);
    else onCancel();
  };
  return (
    <input
      className="input input-sm layers-rename"
      value={draft}
      autoFocus
      title="clip name (enter to save, escape to cancel)"
      aria-label="clip name"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
    />
  );
}

const LayerRow = memo(function LayerRow(p: RowProps) {
  const { node } = p;
  const Icon = TYPE_ICON[node.type];
  const attached = p.attachedName !== null;
  const cls = ['layers-row', p.selected ? 'is-selected' : '', node.hidden ? 'is-hidden' : '', p.dragging ? 'is-dragging' : '', p.dropping ? 'is-drop' : '']
    .filter(Boolean)
    .join(' ');
  const draggable = !node.locked && (node.type !== 'audio' && node.type !== 'effect' && node.type !== 'camera');
  return (
    <div
      className={cls}
      role="treeitem"
      aria-selected={p.selected}
      aria-level={node.depth + 1}
      aria-label={node.name}
      tabIndex={0}
      data-id={node.id}
      draggable={draggable}
      title={node.hidden ? `${node.name} (track hidden)` : node.name}
      style={{ paddingLeft: 6 + node.depth * 14 }}
      onClick={(e) => p.onPick(e, node)}
      onDoubleClick={() => p.onOpen(node)}
      onKeyDown={(e) => p.onKey(e, node)}
      onDragStart={(e) => p.onDragStart(e, node)}
      onDragEnd={p.onDragEnd}
      onDragOver={(e) => p.onDragOver(e, node)}
      onDragLeave={() => p.onDragLeave(node)}
      onDrop={(e) => p.onDrop(e, node)}
    >
      <Icon size={13} className="layers-icon" />
      {p.renaming ? (
        <RenameInput node={node} onCommit={(name) => p.onCommitRename(node, name)} onCancel={p.onCancelRename} />
      ) : (
        <span className="layers-name">{node.name}</span>
      )}
      {node.masked ? (
        <span className="layers-flag" title="has a mask">
          <SquareDashed size={12} aria-label="has a mask" />
        </span>
      ) : null}
      {node.looksAt !== null ? (
        <span className="layers-flag" title={`looks at ${node.looksAt}`}>
          <Crosshair size={12} aria-label={`looks at ${node.looksAt}`} />
        </span>
      ) : null}
      {node.threeD ? (
        <span className="layers-badge" title="3d clip">
          <Box size={10} />
          3d
        </span>
      ) : null}
      {attached ? (
        <span className="layers-flag" title={`attached to ${p.attachedName}`}>
          <Link2 size={12} aria-label={`attached to ${p.attachedName}`} />
        </span>
      ) : null}
      {node.locked ? (
        <span className="layers-flag" title="track is locked">
          <Lock size={11} aria-label="locked" />
        </span>
      ) : null}
      {node.canRename && !node.locked && !p.renaming ? (
        <button
          className="icon-btn icon-btn-sm layers-act"
          title="rename (f2)"
          aria-label={`rename ${node.name}`}
          onClick={(e) => {
            e.stopPropagation();
            p.onStartRename(node);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Pencil size={12} />
        </button>
      ) : null}
      {node.firstOfTrack ? (
        <button
          className="icon-btn icon-btn-sm layers-act layers-eye"
          title={node.hidden ? 'show this track (all its clips)' : 'hide this track (all its clips)'}
          aria-label={node.hidden ? 'show this track' : 'hide this track'}
          aria-pressed={node.hidden}
          onClick={(e) => {
            e.stopPropagation();
            p.onToggleTrack(node);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {node.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
      ) : null}
      {attached && !node.locked ? (
        <button
          className="icon-btn icon-btn-sm layers-detach"
          title="detach (keeps its place)"
          aria-label={`detach ${node.name}`}
          onClick={(e) => {
            e.stopPropagation();
            p.onDetach(node);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Unlink size={12} />
        </button>
      ) : null}
    </div>
  );
});

export function LayersTab() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const [mode, setMode] = useState<LayersMode>('now');
  const fps = project?.fps ?? 30;
  const [frame, setFrame] = useState(() => Math.floor(usePlayback.getState().time * fps + 1e-6));
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [overRest, setOverRest] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // follow the playhead outside react render: paused = every frame change, playing = a few times a second
  useEffect(() => {
    let last = 0;
    const apply = (time: number) => {
      const f = Math.floor(time * fps + 1e-6);
      setFrame((cur) => (cur === f ? cur : f));
    };
    apply(usePlayback.getState().time);
    return usePlayback.subscribe((s, prev) => {
      if (s.time === prev.time && s.playing === prev.playing) return;
      if (s.playing) {
        const now = performance.now();
        if (now - last < PLAY_REFRESH_MS) return;
        last = now;
      }
      apply(s.time);
    });
  }, [fps]);

  const keyFrame = mode === 'all' ? 0 : frame;
  const nodes = useMemo(() => (project ? buildLayerTree(project, keyFrame / fps, mode) : []), [project, mode, keyFrame, fps]);
  // id -> name of the clip it is attached to (for the link icon of nested rows too)
  const attachedNames = useMemo(() => {
    const m = new Map<string, string>();
    if (!project) return m;
    const byId = new Map(project.clips.map((c) => [c.id, c]));
    for (const n of nodes) {
      const c = byId.get(n.id);
      const par = c ? parentOf(project, c) : null;
      if (par) m.set(n.id, par.type === 'text' ? par.text.replace(/\s+/g, ' ').trim() || par.name : par.name || par.type);
    }
    return m;
  }, [project, nodes]);
  const selected = useMemo(() => new Set(selection), [selection]);

  const dragAttached = !!dragId && attachedNames.has(dragId);

  const onPick = useCallback((e: MouseEvent, node: LayerNode) => {
    const st = useEditor.getState();
    if (!st.project) return;
    const ids = expandGroups(st.project, [node.id]);
    st.select(ids, e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'add' : 'replace');
  }, []);

  const onOpen = useCallback((node: LayerNode) => {
    const st = useEditor.getState();
    const clip = st.project?.clips.find((c) => c.id === node.id);
    if (!clip) return;
    const t = usePlayback.getState().time;
    if (t < clip.start || t >= clip.start + clip.duration) usePlayback.getState().seek(clip.start);
    st.select(expandGroups(st.project!, [node.id]));
  }, []);

  const onToggleTrack = useCallback((node: LayerNode) => {
    const track = useEditor.getState().project?.tracks.find((t) => t.id === node.trackId);
    if (track) useEditor.getState().updateTrack(track.id, { hidden: !track.hidden });
  }, []);
  const onStartRename = useCallback((node: LayerNode) => {
    if (node.canRename && !node.locked) setRenamingId(node.id);
  }, []);
  const onCancelRename = useCallback(() => setRenamingId(null), []);
  const onCommitRename = useCallback((node: LayerNode, name: string) => {
    setRenamingId(null);
    const clean = name.trim();
    if (clean && clean !== node.name) useEditor.getState().updateClip(node.id, { name: clean });
  }, []);

  const onKey = useCallback(
    (e: KeyboardEvent, node: LayerNode) => {
      if (e.key === 'F2') {
        e.preventDefault();
        onStartRename(node);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onOpen(node);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        let i = nodes.findIndex((n) => n.id === node.id) + step;
        while (i >= 0 && i < nodes.length && nodes[i]!.locked) i += step;
        const next = nodes[i];
        if (!next) return;
        useEditor.getState().select([next.id]);
        listRef.current?.querySelector<HTMLElement>(`[data-id="${next.id}"]`)?.focus();
      }
    },
    [nodes, onOpen, onStartRename],
  );

  const clearDrag = useCallback(() => {
    setDragId(null);
    setOverId(null);
    setOverRest(false);
  }, []);

  const onDragStart = useCallback((e: DragEvent, node: LayerNode) => {
    e.dataTransfer.setData(MIME, node.id);
    e.dataTransfer.effectAllowed = 'move';
    setDragId(node.id);
  }, []);

  const onDragOver = useCallback(
    (e: DragEvent, node: LayerNode) => {
      const p = useEditor.getState().project;
      if (!dragId || !p || !canAttach(p, dragId, node.id)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setOverId((cur) => (cur === node.id ? cur : node.id));
    },
    [dragId],
  );
  const onDragLeave = useCallback((node: LayerNode) => setOverId((cur) => (cur === node.id ? null : cur)), []);

  const onDrop = useCallback(
    (e: DragEvent, node: LayerNode) => {
      const id = e.dataTransfer.getData(MIME);
      const p = useEditor.getState().project;
      if (!id || !p || !canAttach(p, id, node.id)) return;
      e.preventDefault();
      e.stopPropagation();
      clearDrag();
      reparent(id, node.id);
    },
    [clearDrag],
  );

  const onDetach = useCallback((node: LayerNode) => reparent(node.id, null), []);

  const restOver = (e: DragEvent) => {
    if (!dragId || !dragAttached) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOverRest(true);
  };
  const restDrop = (e: DragEvent) => {
    const id = e.dataTransfer.getData(MIME);
    if (!id) return;
    e.preventDefault();
    clearDrag();
    reparent(id, null);
  };

  return (
    <div className="media-tab layers-tab">
      <div className="layers-head">
        <div className="layers-seg" role="group" aria-label="which clips to list">
          <button
            className={`btn btn-sm btn-ghost${mode === 'now' ? ' is-active' : ''}`}
            title="clips under the playhead"
            aria-pressed={mode === 'now'}
            onClick={() => setMode('now')}
          >
            on screen
          </button>
          <button
            className={`btn btn-sm btn-ghost${mode === 'all' ? ' is-active' : ''}`}
            title="every picture, camera and effect clip"
            aria-pressed={mode === 'all'}
            onClick={() => setMode('all')}
          >
            all
          </button>
        </div>
        <span className="layers-count mono" title="clips listed">
          {nodes.length}
        </span>
      </div>

      <div className="layers-scroll" onDragEnd={clearDrag}>
        {nodes.length === 0 ? (
          <div className="empty">{mode === 'now' ? 'nothing on screen at the playhead' : 'no clips yet'}</div>
        ) : (
          <div ref={listRef} className="layers-list" role="tree" aria-label="layers">
            {nodes.map((n) => (
              <LayerRow
                key={n.id}
                node={n}
                attachedName={attachedNames.get(n.id) ?? null}
                selected={selected.has(n.id)}
                dragging={dragId === n.id}
                dropping={overId === n.id}
                onPick={onPick}
                onOpen={onOpen}
                onKey={onKey}
                onDragStart={onDragStart}
                onDragEnd={clearDrag}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                onDetach={onDetach}
                renaming={renamingId === n.id}
                onToggleTrack={onToggleTrack}
                onStartRename={onStartRename}
                onCommitRename={onCommitRename}
                onCancelRename={onCancelRename}
              />
            ))}
          </div>
        )}
        <div
          className={`layers-rest${dragId && dragAttached ? ' is-armed' : ''}${overRest ? ' is-drop' : ''}`}
          onDragOver={restOver}
          onDragLeave={() => setOverRest(false)}
          onDrop={restDrop}
        >
          {dragId && dragAttached ? <span>drop here to detach</span> : null}
        </div>
      </div>
    </div>
  );
}
