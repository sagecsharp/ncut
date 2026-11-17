/**
 * the list of lines at the left of the graph: a clip row (kind chip, name, fold) and under it one row per animated value,
 * with a swatch in the line's color and dash. 20 px rows, only the visible ones are made. no value at the playhead.
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import type { Clip } from '../../types';
import { tip } from '../shell/tip';
import { useGraph } from './graphState';
import type { GraphLine } from './graphModel';
import { allKeyRefs, laneId, liveKeySel, pickKeys } from './keySelection';
import type { PickMode } from './keySelection';
import { HEADER_W } from './layout';
import './graph.css';

const ROW_H = 20;

interface ClipRow {
  kind: 'clip';
  clip: Clip;
  folded: boolean;
  y: number;
}
interface LineRow {
  kind: 'line';
  line: GraphLine;
  y: number;
}
type Row = ClipRow | LineRow;

export interface GraphListProps {
  /** the shown clips, in panel order */
  shown: readonly Clip[];
  /** every line of the shown clips, hidden ones too */
  lines: readonly GraphLine[];
}

const chipOf = (clip: Clip): string => (clip.type === 'camera' ? 'shape' : clip.type);
const modeOf = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): PickMode => (e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'add' : 'replace');

/** the rows: each clip that has lines, then its lines unless it is folded */
function buildRows(shown: readonly Clip[], lines: readonly GraphLine[], folded: ReadonlySet<string>): Row[] {
  const out: Row[] = [];
  let y = 0;
  for (const clip of shown) {
    const mine = lines.filter((l) => l.clipId === clip.id);
    if (mine.length === 0) continue;
    const isFolded = folded.has(clip.id);
    out.push({ kind: 'clip', clip, folded: isFolded, y });
    y += ROW_H;
    if (isFolded) continue;
    for (const line of mine) {
      out.push({ kind: 'line', line, y });
      y += ROW_H;
    }
  }
  return out;
}

/** a hidden line has no selectable key: its refs leave the key selection */
function dropHiddenRefs(): void {
  const hidden = useGraph.getState().hidden;
  const ui = useUi.getState();
  const next = ui.keySel.filter((r) => !hidden.has(laneId(r.clipId, r.prop)));
  if (next.length !== ui.keySel.length) ui.setKeySel(next);
}

export function GraphList({ shown, lines }: GraphListProps) {
  const hidden = useGraph((s) => s.hidden);
  const active = useGraph((s) => s.active);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(160);
  const [cur, setCur] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const wantFocus = useRef<number | null>(null);

  const rows = buildRows(shown, lines, folded);
  const total = rows.length * ROW_H;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 1);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + 1);
  const at = Math.min(cur, Math.max(0, rows.length - 1));

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    setHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // a key press moved the cursor: bring the row into view and give it the focus once it exists
  useEffect(() => {
    const want = wantFocus.current;
    const el = listRef.current;
    if (want === null || !el) return;
    const row = el.querySelector<HTMLElement>(`[data-row="${want}"]`);
    if (!row) return;
    wantFocus.current = null;
    row.focus({ preventScroll: true });
  });

  const ids = lines.map((l) => l.id);
  const toggleFold = (id: string) => {
    const next = new Set(folded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFolded(next);
  };
  const toggleLine = (id: string) => {
    useGraph.getState().toggleHidden(id);
    dropHiddenRefs();
  };
  const onlyLine = (id: string) => {
    useGraph.getState().showOnly(id, ids);
    dropHiddenRefs();
  };
  /** the line becomes the active one and its keys the selection */
  const pickLine = (line: GraphLine, mode: PickMode) => {
    useGraph.getState().setActive(line.id);
    const p = useEditor.getState().project;
    if (!p || useGraph.getState().hidden.has(line.id)) return;
    const refs = allKeyRefs(p, [line.clipId]).filter((r) => r.prop === line.prop);
    useUi.getState().setKeySel(pickKeys(liveKeySel(p, useUi.getState().keySel), refs, mode));
  };

  const moveTo = (i: number) => {
    const n = Math.max(0, Math.min(rows.length - 1, i));
    setCur(n);
    wantFocus.current = n;
    const el = listRef.current;
    if (!el) return;
    const top = n * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, i: number, row: Row) => {
    if (e.ctrlKey || e.metaKey) return;
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey) {
      e.preventDefault();
      moveTo(i + (e.key === 'ArrowUp' ? -1 : 1));
      return;
    }
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      if (row.kind === 'clip') toggleFold(row.clip.id);
      else if (e.altKey) onlyLine(row.line.id);
      else toggleLine(row.line.id);
      return;
    }
    if (e.key === 'Enter' && !e.altKey) {
      e.preventDefault();
      if (row.kind === 'clip') toggleFold(row.clip.id);
      else pickLine(row.line, e.shiftKey ? 'add' : 'replace');
    }
  };

  const onSwatch = (e: ReactMouseEvent, id: string) => {
    e.stopPropagation();
    if (e.altKey) onlyLine(id);
    else toggleLine(id);
  };

  return (
    <div ref={listRef} className="graph-list" style={{ width: HEADER_W }} role="group" aria-label="lines of the selected clips" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div className="graph-list-rows" style={{ height: total }}>
        {rows.slice(first, end).map((row, k) => {
          const i = first + k;
          const common = { 'data-row': i, tabIndex: i === at ? 0 : -1, style: { top: row.y, height: ROW_H }, onFocus: () => setCur(i), onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => onKeyDown(e, i, row) };
          if (row.kind === 'clip') {
            return (
              <div key={`c/${row.clip.id}`} className="graph-row is-clip" {...common}>
                <button type="button" className="graph-caret" tabIndex={-1} aria-label={`${row.folded ? 'unfold' : 'fold'} ${row.clip.name}`} onClick={() => toggleFold(row.clip.id)}>
                  {row.folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
                <span className="graph-chip" style={{ background: `var(--clip-${chipOf(row.clip)})` }} />
                <span className="graph-name">{row.clip.name}</span>
              </div>
            );
          }
          const l = row.line;
          const on = !hidden.has(l.id);
          return (
            <div key={`l/${l.id}`} className={`graph-row is-line${active === l.id ? ' is-active' : ''}`} {...common}>
              <button type="button" className="graph-swatch" tabIndex={-1} aria-pressed={on} aria-label={`show ${l.label}`} {...tip(l.label, { does: 'show or hide this line. alt+click shows only this one' })} onClick={(e) => onSwatch(e, l.id)}>
                <svg width="16" height="8" aria-hidden="true">
                  <line x1="0" y1="4" x2="16" y2="4" stroke={`var(${l.color})`} strokeWidth="2" strokeDasharray={l.dash.length > 0 ? l.dash.join(' ') : undefined} />
                </svg>
              </button>
              <button type="button" className="graph-name" tabIndex={-1} onClick={(e) => pickLine(l, modeOf(e))}>
                {l.label}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
