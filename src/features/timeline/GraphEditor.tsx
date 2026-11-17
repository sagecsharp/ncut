/**
 * the graph view of the keyframe panel: the bar, then the list of lines beside the plot. it mounts only while the panel is
 * open in graph mode. this file builds the lines, holds the windows (auto fit, frozen from a press to the release) and
 * answers the fit commands.
 */
import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { RefObject } from 'react';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { partHandles } from '../../lib/keyBezier';
import type { Clip } from '../../types';
import type { Win } from './graphState';
import { useGraph } from './graphState';
import { timelineCommands } from './commands';
import { graphCommands } from './graphActions';
import { buildGraphLines, fitWindows } from './graphModel';
import type { GraphLine } from './graphModel';
import { GraphBar } from './GraphBar';
import { GraphList } from './GraphList';
import { GraphPlot } from './GraphPlot';
import { keyRefFilter } from './keyLaneActions';
import { laneId, liveKeySel, refIndex, shownKeyClips } from './keySelection';
import type { KeyMenuOpen, KeyMenuProps } from './KeyMenu';
import './graph.css';

export interface GraphEditorProps {
  getScroller(): HTMLDivElement | null;
  onMenu(open: KeyMenuOpen & Pick<KeyMenuProps, 'line'>): void;
  anchor: RefObject<(() => KeyMenuOpen) | null>;
}

/** a window widened to hold v, with a little room past it */
function widen(w: Win, v: number): Win {
  const room = 0.08 * (w.hi - w.lo);
  return { lo: v < w.lo ? v - room : w.lo, hi: v > w.hi ? v + room : w.hi };
}

export function GraphEditor({ getScroller, onMenu, anchor }: GraphEditorProps) {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const kind = useGraph((s) => s.kind);
  const autoFit = useGraph((s) => s.autoFit);
  const hidden = useGraph((s) => s.hidden);
  const stored = useGraph((s) => s.windows);

  // the same clip objects give the same array, so an edit of something else does not rebuild the lines
  const prevShown = useRef<Clip[]>([]);
  const shown = useMemo(() => {
    const next = project ? shownKeyClips(project, selection) : [];
    const prev = prevShown.current;
    if (prev.length === next.length && prev.every((c, i) => c === next[i])) return prev;
    prevShown.current = next;
    return next;
  }, [project, selection]);
  const pw = project?.width;
  const ph = project?.height;
  const pfps = project?.fps;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(() => (project ? buildGraphLines(project, shown, new Set()) : []), [shown, pw, ph, pfps]);
  const lines = useMemo(() => all.filter((l) => !hidden.has(l.id)), [all, hidden]);

  // lines of clips that are not shown any more are forgotten
  const shownIds = shown.map((c) => c.id).join('\u0001');
  useEffect(() => {
    useGraph.getState().pruneTo(shown.map((c) => c.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownIds]);

  // the windows hold still from a press to the release
  const frozen = useRef<Record<string, Win> | null>(null);
  const [gen, release] = useReducer((n: number) => n + 1, 0);
  const hold = useMemo(
    () => ({
      freeze: (w: Record<string, Win>) => {
        frozen.current = w;
      },
      release: () => {
        if (!frozen.current) return;
        frozen.current = null;
        release();
      },
    }),
    [],
  );
  // windows are tied to a kind: a new kind fits once. with auto fit off the shown windows are held
  const lastShown = useRef<Record<string, Win>>({});
  const lastKind = useRef(kind);
  const windows = useMemo<Record<string, Win>>(() => {
    if (frozen.current) return frozen.current;
    const fit = fitWindows(lines, kind);
    const changed = lastKind.current !== kind;
    lastKind.current = kind;
    if (changed) lastShown.current = {};
    const out = autoFit ? fit : { ...fit, ...(changed ? {} : (stored ?? lastShown.current)) };
    lastShown.current = out;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, kind, autoFit, stored, gen]);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    useGraph.getState().setWindows(null);
  }, [kind]);

  // what the fit commands read, set during render so a command never sees an old frame
  const now = useRef({ lines, kind });
  now.current = { lines, kind };
  const shownIdSet = useMemo(() => new Set(lines.map((l) => l.id)), [lines]);
  const shows = useRef(shownIdSet);
  shows.current = shownIdSet;

  useEffect(() => {
    const frameAll = () => {
      const g = useGraph.getState();
      g.setAutoFit(true);
      const { lines: ls } = now.current;
      if (ls.length === 0) return;
      timelineCommands.fitTimes?.(Math.min(...ls.map((l) => l.start)), Math.max(...ls.map((l) => l.start + l.duration)));
    };
    const frameSelected = () => {
      const p = useEditor.getState().project;
      const { lines: ls, kind: k } = now.current;
      const byId = new Map<string, GraphLine>(ls.map((l) => [l.id, l]));
      const refs = p ? liveKeySel(p, useUi.getState().keySel).filter((r) => byId.has(laneId(r.clipId, r.prop))) : [];
      if (refs.length === 0) {
        frameAll();
        return;
      }
      const times = refs.map((r) => byId.get(laneId(r.clipId, r.prop))!.start + r.t);
      const lo = Math.min(...times);
      const hi = Math.max(...times);
      timelineCommands.fitTimes?.(lo, hi);
      const g = useGraph.getState();
      g.setAutoFit(false);
      const wins: Record<string, Win> = { ...fitWindows(ls, k, lo, hi) };
      // the windows also hold the control points of the selected keys
      for (const r of refs) {
        const line = byId.get(laneId(r.clipId, r.prop))!;
        const i = refIndex(line.clip, r);
        let w = wins[line.group];
        if (i < 0 || !w) continue;
        const keys = line.keys;
        const key = keys[i]!;
        for (const side of ['out', 'in'] as const) {
          const nb = side === 'out' ? keys[i + 1] : keys[i - 1];
          if (!nb) continue;
          const ph = side === 'out' ? partHandles(key, nb) : partHandles(nb, key);
          if (!ph) continue;
          const h = side === 'out' ? ph.out : ph.in;
          const dir = side === 'out' ? 1 : -1;
          const span = Math.abs(nb.t - key.t);
          const v = k === 'speed' ? h.speed : key.v + dir * h.speed * h.influence * span;
          w = widen(w, v * line.feel.scale);
        }
        wins[line.group] = w;
      }
      g.setWindows(wins);
    };
    graphCommands.frameAll = frameAll;
    graphCommands.frameSelected = frameSelected;
    keyRefFilter.shows = (r) => shows.current.has(laneId(r.clipId, r.prop));
    const pending = useGraph.getState().pendingFit;
    if (pending) {
      if (pending === 'all') frameAll();
      else frameSelected();
      useGraph.getState().setPendingFit(null);
    }
    return () => {
      graphCommands.frameAll = undefined;
      graphCommands.frameSelected = undefined;
      keyRefFilter.shows = undefined;
    };
  }, []);

  const emptyText =
    shown.length === 0
      ? 'select clips to see their values as lines here'
      : all.length === 0
        ? 'the selected clips have no keyframes yet: key a value in the properties first'
        : lines.length === 0
          ? 'every line is hidden: click a swatch on the left to show one'
          : null;

  return (
    <div className="graph-editor" role="group" aria-label={`${kind} graph of the selected clips`} onFocus={() => useUi.getState().setKeyFocus(true)}>
      <GraphBar lines={lines} />
      <div className="graph-main">
        <GraphList shown={shown} lines={all} />
        <GraphPlot lines={lines} shown={shown} kind={kind} windows={windows} freeze={hold.freeze} release={hold.release} emptyText={emptyText} getScroller={getScroller} onMenu={onMenu} anchor={anchor} />
      </div>
    </div>
  );
}
