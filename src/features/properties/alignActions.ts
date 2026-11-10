import { getClipBox } from '../../engine/draw';
import { resolveClip, valueAt } from '../../lib/anim';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import type { Clip, Project, VisualClip } from '../../types';
import { isVisualClip } from '../../types';
import { alignMoves, boxesBounds, canvasBounds, isAlignable, spreadMoves } from './alignLogic';
import type { AlignBox, AlignKind, AlignMove, SpreadAxis } from './alignLogic';

/** the visual clips among these that align can move: flat, not attached, on an unlocked track */
export function alignableClips(project: Pick<Project, 'clips' | 'tracks'>, ids: readonly string[]): VisualClip[] {
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id));
  return project.clips.filter((c): c is VisualClip => ids.includes(c.id) && isVisualClip(c) && isAlignable(c) && !locked.has(c.trackId));
}

/** the playhead held inside a clip (what the transform fields and keyframes use) */
function timeIn(clip: Clip): number {
  return clamp(usePlayback.getState().time, clip.start, clip.start + clip.duration);
}

/** the box of a clip on the canvas at the playhead (keyframes applied, rotation ignored) */
function boxOf(project: Project, clip: VisualClip): AlignBox {
  const b = getClipBox(project, resolveClip(clip, timeIn(clip)));
  return { id: clip.id, cx: b.cx, cy: b.cy, width: b.width, height: b.height };
}

/** x / y of every moved clip changes by its delta, through the same path as the transform fields; one undo step */
function applyMoves(moves: readonly AlignMove[]): void {
  const st = useEditor.getState();
  const writes: { id: string; prop: 'x' | 'y'; time: number; value: number }[] = [];
  for (const m of moves) {
    const clip = st.project?.clips.find((c) => c.id === m.id);
    if (!clip || !isVisualClip(clip)) continue;
    const time = timeIn(clip);
    for (const [prop, d] of [['x', m.dx], ['y', m.dy]] as const) {
      if (d === 0) continue;
      const now = valueAt(clip, prop, time) ?? clip.transform[prop];
      writes.push({ id: m.id, prop, time, value: Math.round((now + d) * 100) / 100 });
    }
  }
  if (writes.length === 0) return;
  st.pushHistory();
  for (const w of writes) st.setClipValue(w.id, w.prop, w.time, w.value, { skipHistory: true });
}

/** align to the canvas (one clip) or to the bounds of the selection (several) */
export function alignSelection(ids: readonly string[], kind: AlignKind, to: 'canvas' | 'selection'): void {
  const p = useEditor.getState().project;
  if (!p) return;
  const boxes = alignableClips(p, ids).map((c) => boxOf(p, c));
  const bounds = to === 'canvas' ? canvasBounds(p.width, p.height) : boxesBounds(boxes);
  if (!bounds) return;
  applyMoves(alignMoves(boxes, kind, bounds));
}

/** equal gaps between the selected clips along one axis (3 or more) */
export function spreadSelection(ids: readonly string[], axis: SpreadAxis): void {
  const p = useEditor.getState().project;
  if (!p) return;
  applyMoves(spreadMoves(alignableClips(p, ids).map((c) => boxOf(p, c)), axis));
}
