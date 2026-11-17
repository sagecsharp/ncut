/**
 * the keyframe panel: under the tracks, one row per animated value of the selected clips. it mounts only while open.
 * this file holds the height, the head, the menu request and the folds. the rows are KeyLanes.
 */
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useUi } from '../../store/ui';
import { tip } from '../shell/tip';
import { GraphEditor } from './GraphEditor';
import { KeyLanes } from './KeyLanes';
import { KeyMenu } from './KeyMenu';
import type { KeyMenuOpen, KeyMenuProps } from './KeyMenu';
import { closeKeyPanel, followKeySel, keyPanelCommands } from './keyLaneActions';
import { GRAPH_H_DEFAULT, KEY_PANEL_H_DEFAULT, KEY_PANEL_H_MAX, KEY_PANEL_H_MIN, keyPanelHeight, useKeyPanel } from './keyPanelState';
import './graph.css';
import './keyPanel.css';

export interface KeyPanelProps {
  getScroller(): HTMLDivElement | null;
}

const clampH = (px: number) => Math.round(Math.min(KEY_PANEL_H_MAX, Math.max(KEY_PANEL_H_MIN, px)));

export function KeyPanel({ getScroller }: KeyPanelProps) {
  const height = useKeyPanel((s) => keyPanelHeight(s));
  const graph = useKeyPanel((s) => s.mode === 'graph');
  const picked = useUi((s) => s.keySel.length);
  const [menu, setMenu] = useState<(KeyMenuOpen & Pick<KeyMenuProps, 'line'>) | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<(() => KeyMenuOpen) | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; start: number; size: number } | null>(null);

  useEffect(() => {
    const off = followKeySel();
    keyPanelCommands.openMenu = () => {
      const a = anchor.current?.();
      const r = panelRef.current?.getBoundingClientRect();
      setMenu({ x: a?.x ?? r?.left ?? 0, y: a?.y ?? r?.top ?? 0, target: a?.target ?? null, focusFirst: true });
    };
    return () => {
      off();
      keyPanelCommands.openMenu = undefined;
      useUi.getState().setKeyFocus(false);
    };
  }, []);

  // a view swap unmounts the focused body: the key focus goes with it
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else useUi.getState().setKeyFocus(false);
  }, [graph]);

  // the height on screen: the css caps what the pref says
  const shownHeight = (fallback = height) => {
    const h = panelRef.current?.getBoundingClientRect().height;
    return h ? clampH(h) : fallback;
  };

  // ----- the grip: drag up grows the panel. the style is set live, the pref when the pointer lets go -----
  const onGripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const now = shownHeight();
    drag.current = { y: e.clientY, start: now, size: now };
  };
  const onGripMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const panel = panelRef.current;
    if (!d || !panel) return;
    d.size = clampH(d.start + (d.y - e.clientY));
    panel.style.height = `${d.size}px`;
  };
  const onGripUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d) useKeyPanel.getState().setHeight(shownHeight(d.size));
  };
  const onGripKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const step = e.shiftKey ? 32 : 8;
    useKeyPanel.getState().setHeight(shownHeight() + (e.key === 'ArrowUp' ? step : -step));
  };

  /** the rows | graph switch: the arrows swap the view and the focus goes with it */
  const onSwitchKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const to = graph ? 'keys' : 'graph';
    useKeyPanel.getState().setMode(to);
    (e.currentTarget.children[to === 'keys' ? 0 : 1] as HTMLElement | undefined)?.focus();
  };

  return (
    <div
      ref={panelRef}
      className="key-panel"
      style={{ height }}
      onBlur={(e) => {
        const to = e.relatedTarget;
        if (!(to instanceof Node) || !e.currentTarget.contains(to)) useUi.getState().setKeyFocus(false);
      }}
    >
      <div
        className="key-panel-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="keyframe panel height"
        aria-valuenow={height}
        aria-valuemin={KEY_PANEL_H_MIN}
        aria-valuemax={KEY_PANEL_H_MAX}
        tabIndex={0}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        onKeyDown={onGripKey}
        onDoubleClick={() => useKeyPanel.getState().setHeight(graph ? GRAPH_H_DEFAULT : KEY_PANEL_H_DEFAULT)}
      />
      <div className="key-panel-head">
        <span className="key-panel-title">keyframes</span>
        {picked > 0 ? <span className="key-panel-count">{picked} selected</span> : null}
        <span className="key-panel-spacer" />
        <div className="graph-switch" role="radiogroup" aria-label="keyframe panel view" onKeyDown={onSwitchKey}>
          <button
            type="button"
            role="radio"
            aria-checked={!graph}
            tabIndex={graph ? -1 : 0}
            className={`graph-switch-btn${graph ? '' : ' is-active'}`}
            {...tip('rows', { does: 'one row per value, its keyframes as diamonds', keys: 'key-graph' })}
            onClick={() => useKeyPanel.getState().setMode('keys')}
          >
            rows
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={graph}
            tabIndex={graph ? 0 : -1}
            className={`graph-switch-btn${graph ? ' is-active' : ''}`}
            {...tip('graph', { does: 'one line per value over time. drag keyframes in time and value, drag their handles to shape how the value moves', keys: 'key-graph' })}
            onClick={() => useKeyPanel.getState().setMode('graph')}
          >
            graph
          </button>
        </div>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="close the keyframe panel" {...tip('close', { does: 'hide the keyframe panel', keys: 'key-panel' })} onClick={closeKeyPanel}>
          <X size={14} />
        </button>
      </div>
      {graph ? <GraphEditor getScroller={getScroller} onMenu={setMenu} anchor={anchor} /> : <KeyLanes getScroller={getScroller} folded={folded} onFold={setFolded} onMenu={setMenu} anchor={anchor} />}
      {menu ? <KeyMenu {...menu} folded={folded} onFold={setFolded} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
