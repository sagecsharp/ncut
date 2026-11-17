import { useEditor } from '../../store/editorStore';
import type { EditorState } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import type { TrimEdge } from '../../store/ui';
import { clipEnd } from '../../lib/timelineOps';
import { CLIP_INSET, computeLayout } from './layout';
import { touchingAfter } from './trimModes';

/** where the mark goes as one string, so the component renders only when it moves: 'kind|x|y|h', or '' for none */
function markKey(s: EditorState, e: TrimEdge | null): string {
  const p = s.project;
  if (!e || !p) return '';
  const c = p.clips.find((x) => x.id === e.clipId);
  if (!c) return '';
  const i = p.tracks.findIndex((t) => t.id === c.trackId);
  if (i < 0) return '';
  const layout = computeLayout(p.tracks);
  const y = layout.tops[i]! + CLIP_INSET;
  const h = layout.heights[i]! - 2 * CLIP_INSET;
  const both = e.both && e.edge === 'end' && touchingAfter(p, c) !== null;
  const kind = both ? 'both' : e.edge;
  const x = Math.round((e.edge === 'end' ? clipEnd(c) : c.start) * s.zoom);
  return `${kind}|${x}|${y}|${h}`;
}

/** the selected edge: a bar along the edge, the height of the clip, with ticks into the clip: [ or ] or ][ */
export function TrimEdgeMark() {
  const edge = useUi((s) => s.trimEdge);
  const key = useEditor((s) => markKey(s, edge));
  if (!key) return null;
  const [kind, x, y, h] = key.split('|') as [string, string, string, string];
  return (
    <div className="timeline-trim-edge" data-kind={kind} aria-hidden="true" style={{ transform: `translate3d(${x}px,${y}px,0)`, height: `${h}px` }}>
      {kind !== 'end' ? <span className="is-right is-top" /> : null}
      {kind !== 'end' ? <span className="is-right is-bottom" /> : null}
      {kind !== 'start' ? <span className="is-left is-top" /> : null}
      {kind !== 'start' ? <span className="is-left is-bottom" /> : null}
    </div>
  );
}
