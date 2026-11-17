import { useRef } from 'react';
import { ArrowLeftToLine, ArrowRightToLine, Check, ChevronsDownUp, ChevronsUpDown, ClipboardPaste, Copy, Crosshair, Eye, Focus, Link2, ListChecks, Maximize2, Plus, Scissors, Spline, Trash2 } from 'lucide-react';
import { EASINGS } from '../../lib/anim';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { KeyRef } from '../../store/ui';
import type { Easing } from '../../types';
import { MenuKeys } from '../shell/MenuKeys';
import { reasonFor, reasonSnapshot } from '../shell/reasons';
import { tip } from '../shell/tip';
import { addKeyOnLine, easeKeysNow, fitGraphAll, fitGraphSelected, joinHandlesNow } from './graphActions';
import { useGraph } from './graphState';
import { copyKeysNow, cutKeysNow, deleteKeysNow, pasteKeysNow, selectAllKeysNow, setKeysEaseNow, shownKeyClipIds } from './keyLaneActions';
import { useKeyPanel } from './keyPanelState';
import { allKeyRefs, liveKeySel, refIndex } from './keySelection';
import { useFloatingMenu } from './menuBehavior';

export interface KeyMenuOpen {
  x: number;
  y: number;
  /** the pressed key (it is selected first), or null for empty space */
  target: KeyRef | null;
  /** opened from the keyboard: the focus goes to the first item */
  focusFirst?: boolean;
}

/** a spot on a line of the graph, clip time t */
export interface KeyMenuLine {
  clipId: string;
  prop: string;
  t: number;
}

export interface KeyMenuProps extends KeyMenuOpen {
  /** the graph view: the menu was opened on a line, away from its keys */
  line?: KeyMenuLine | null;
  folded: ReadonlySet<string>;
  onFold(next: ReadonlySet<string>): void;
  onClose(): void;
}

/** right click menu of the keyframe panel. it lives inside .key-panel and outside the body, so the focus here keeps keyFocus */
export function KeyMenu({ x, y, target, line, focusFirst, folded, onFold, onClose }: KeyMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const project = useEditor((s) => s.project);
  const keySel = useUi((s) => s.keySel);
  const graph = useKeyPanel((s) => s.mode === 'graph');
  const pos = useFloatingMenu(ref, x, y, onClose, { focusFirst });

  const snap = reasonSnapshot();
  const run = (fn: () => void) => () => {
    fn();
    // the item unmounts with the menu: keep focus in the panel so the key focus does not stay stale
    document.querySelector<HTMLElement>('.key-panel-body, .graph-plot')?.focus({ preventScroll: true });
    onClose();
  };
  const pasteOff = reasonFor('keys-paste', snap);
  const clipIds = shownKeyClipIds();
  const anyOpen = clipIds.some((id) => !folded.has(id));

  /** the ease every selected key has, per ease id */
  const sel = project ? liveKeySel(project, keySel) : [];
  const easeOf = (r: KeyRef): Easing | null => {
    const clip = project?.clips.find((c) => c.id === r.clipId);
    const i = clip ? refIndex(clip, r) : -1;
    return clip && i >= 0 ? clip.keyframes![r.prop]![i]!.ease : null;
  };
  const eases = sel.map(easeOf);
  const customOn = eases.length > 0 && eases.every((v) => v === 'bezier');
  const customOff = reasonFor('keys-ease-bezier', snap);
  const easyOff = reasonFor('key-easy-ease', snap);
  const intoOff = reasonFor('key-ease-into', snap);
  const outOfOff = reasonFor('key-ease-out-of', snap);
  const joinOff = reasonFor('keys-join-handles', snap);

  const goTo = () => {
    const clip = project?.clips.find((c) => c.id === target?.clipId);
    if (clip && target) usePlayback.getState().seek(Math.max(0, clip.start + target.t));
  };
  const selectValue = () => {
    if (!project || !target) return;
    useUi.getState().setKeySel(allKeyRefs(project, [target.clipId]).filter((r) => r.prop === target.prop));
  };

  return (
    <div ref={ref} className="menu timeline-menu key-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      {target ? (
        <>
          {EASINGS.map((e) => {
            const checked = eases.length > 0 && eases.every((v) => v === e.id);
            return (
              <button
                key={e.id}
                className="menu-item"
                role="menuitemradio"
                aria-checked={checked}
                {...tip(e.label, { does: 'how the value moves from each selected keyframe to the next', side: 'right', off: reasonFor(`keys-ease-${e.id}`, snap) })}
                onClick={run(() => setKeysEaseNow(e.id))}
              >
                <span className="key-menu-check">{checked ? <Check size={14} /> : null}</span>
                {e.label}
              </button>
            );
          })}
          <button
            className="menu-item"
            role="menuitemradio"
            aria-checked={customOn}
            {...tip('custom', { side: 'right', does: 'keeps the shape and gives the part after the keyframe handles to drag in the graph', off: customOff })}
            onClick={run(() => setKeysEaseNow('bezier'))}
          >
            <span className="key-menu-check">{customOn ? <Check size={14} /> : null}</span>
            custom
          </button>
          <div className="menu-sep" />
          <button className="menu-item" role="menuitem" disabled={easyOff !== null} {...tip('easy ease', { does: 'the value slows down into and out of the selected keyframes', side: 'right', keys: 'key-easy-ease', off: easyOff })} onClick={run(() => easeKeysNow('easy'))}>
            <Spline size={14} />
            easy ease
            <MenuKeys id="key-easy-ease" />
          </button>
          <button className="menu-item" role="menuitem" disabled={intoOff !== null} {...tip('ease into', { does: 'the value slows down as it arrives at the selected keyframes', side: 'right', keys: 'key-ease-into', off: intoOff })} onClick={run(() => easeKeysNow('into'))}>
            <ArrowRightToLine size={14} />
            ease into
            <MenuKeys id="key-ease-into" />
          </button>
          <button className="menu-item" role="menuitem" disabled={outOfOff !== null} {...tip('ease out of', { does: 'the value starts slowly as it leaves the selected keyframes', side: 'right', keys: 'key-ease-out-of', off: outOfOff })} onClick={run(() => easeKeysNow('outOf'))}>
            <ArrowLeftToLine size={14} />
            ease out of
            <MenuKeys id="key-ease-out-of" />
          </button>
          <button className="menu-item" role="menuitem" disabled={joinOff !== null} {...tip('join handles', { does: 'the same speed on both sides of the selected keyframes, so the value passes them smoothly', side: 'right', off: joinOff })} onClick={run(joinHandlesNow)}>
            <Link2 size={14} />
            join handles
          </button>
          <div className="menu-sep" />
          <button className="menu-item" role="menuitem" {...tip('copy', { does: 'remember the selected keyframes', side: 'right', keys: 'copy' })} onClick={run(copyKeysNow)}>
            <Copy size={14} />
            copy
            <MenuKeys id="copy" />
          </button>
          <button className="menu-item" role="menuitem" {...tip('copy and delete', { does: 'remember the selected keyframes and delete them', side: 'right', keys: 'cut' })} onClick={run(cutKeysNow)}>
            <Scissors size={14} />
            copy and delete
            <MenuKeys id="cut" />
          </button>
          <button
            className="menu-item"
            role="menuitem"
            disabled={pasteOff !== null}
            {...tip('paste at the playhead', { does: 'the first copied keyframe lands on the playhead', side: 'right', keys: 'paste', off: pasteOff })}
            onClick={run(pasteKeysNow)}
          >
            <ClipboardPaste size={14} />
            paste at the playhead
            <MenuKeys id="paste" />
          </button>
          <button className="menu-item" role="menuitem" {...tip('delete', { does: 'delete the selected keyframes', side: 'right', keys: 'delete' })} onClick={run(deleteKeysNow)}>
            <Trash2 size={14} />
            delete
            <MenuKeys id="delete" />
          </button>
          <div className="menu-sep" />
          <button className="menu-item" role="menuitem" {...tip('go to this keyframe', { does: 'move the playhead to it', side: 'right' })} onClick={run(goTo)}>
            <Crosshair size={14} />
            go to this keyframe
          </button>
          <button className="menu-item" role="menuitem" {...tip('select every keyframe of this value', { does: 'every keyframe of this value on this clip', side: 'right' })} onClick={run(selectValue)}>
            <ListChecks size={14} />
            select every keyframe of this value
          </button>
        </>
      ) : (
        <>
          {graph && line ? (
            <>
              <button className="menu-item" role="menuitem" {...tip('add a keyframe here', { does: 'a keyframe on this line at this time, the line keeps its shape', side: 'right' })} onClick={run(() => addKeyOnLine(line.clipId, line.prop, line.t))}>
                <Plus size={14} />
                add a keyframe here
              </button>
              <div className="menu-sep" />
            </>
          ) : null}
          <button
            className="menu-item"
            role="menuitem"
            disabled={pasteOff !== null}
            {...tip('paste at the playhead', { does: 'the first copied keyframe lands on the playhead', side: 'right', keys: 'paste', off: pasteOff })}
            onClick={run(pasteKeysNow)}
          >
            <ClipboardPaste size={14} />
            paste at the playhead
            <MenuKeys id="paste" />
          </button>
          <button
            className="menu-item"
            role="menuitem"
            disabled={reasonFor('keys-select-all', snap) !== null}
            {...tip('select every keyframe', { does: 'every keyframe of the selected clips', side: 'right', keys: 'select-all', off: reasonFor('keys-select-all', snap) })}
            onClick={run(selectAllKeysNow)}
          >
            <ListChecks size={14} />
            select every keyframe
            <MenuKeys id="select-all" />
          </button>
          <div className="menu-sep" />
          {graph ? (
            <>
              <button className="menu-item" role="menuitem" {...tip('fit all', { does: 'show every line and the whole of the selected clips. turns auto fit on', side: 'right' })} onClick={run(fitGraphAll)}>
                <Maximize2 size={14} />
                fit all
              </button>
              <button className="menu-item" role="menuitem" {...tip('fit the selected keyframes', { does: 'zoom to the selected keyframes, in time and value', side: 'right', keys: 'key-graph-keys' })} onClick={run(fitGraphSelected)}>
                <Focus size={14} />
                fit the selected keyframes
              </button>
              <button className="menu-item" role="menuitem" {...tip('show every line', { does: 'show the lines you switched off', side: 'right' })} onClick={run(() => useGraph.getState().showAll())}>
                <Eye size={14} />
                show every line
              </button>
            </>
          ) : (
            <button
              className="menu-item"
              role="menuitem"
              disabled={clipIds.length === 0}
              {...tip(anyOpen ? 'fold every clip' : 'unfold every clip', { does: anyOpen ? 'show only the clip rows' : 'show the rows of every value', side: 'right' })}
              onClick={run(() => onFold(anyOpen ? new Set(clipIds) : new Set()))}
            >
              {anyOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
              {anyOpen ? 'fold every clip' : 'unfold every clip'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
