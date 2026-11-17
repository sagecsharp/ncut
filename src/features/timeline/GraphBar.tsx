/**
 * the bar over the graph: value or speed, fit, ease the selected keyframes, and number boxes for the value of the selected
 * keyframes of the active line and for the handle on each side of them. every change is a KeyPlan through applyKeyPlan.
 */
import { ArrowLeftToLine, ArrowRightToLine, Focus, Link2, Magnet, Maximize2, Spline } from 'lucide-react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useRef } from 'react';
import { SliderField } from '../../components/ui/SliderField';
import type { SliderSource } from '../../components/ui/SliderField';
import { roundShown } from '../../components/ui/numberFormat';
import { partHandles } from '../../lib/keyBezier';
import type { HandleSide } from '../../lib/keyBezier';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import type { KeyRef } from '../../store/ui';
import type { Project } from '../../types';
import { beginEdit, cancelEdit, endEdit, liveOpts } from '../properties/edit';
import { resolveFeel } from '../properties/fieldFeel';
import type { FeelEntry } from '../properties/fieldFeel';
import { useFeelCtx } from '../properties/feelContext';
import { REASON_TEXT, reasonFor, reasonSnapshot } from '../shell/reasons';
import { tip } from '../shell/tip';
import { easeKeysNow, fitGraphAll, fitGraphSelected, joinHandlesNow, toggleAutoFit } from './graphActions';
import type { GraphLine } from './graphModel';
import { planHandleSet, planKeyValue } from './graphPlan';
import { useGraph } from './graphState';
import { applyKeyPlan } from './keyLaneActions';
import { laneId, liveKeySel, refIndex } from './keySelection';
import './graph.css';

export interface GraphBarProps {
  /** the lines the plot shows */
  lines: readonly GraphLine[];
}

/** the influence box, in %: 0.1 to 100 */
const INFLUENCE: FeelEntry = { unit: '%', min: 0.1, max: 100, soft: [0, 100], step: 1, precision: 1, snap: 10, perPx: 0.5, rest: 33.3 };

/** every number equal (relative 1e-9): that number, else null */
function same(list: readonly number[]): number | null {
  if (list.length === 0) return null;
  const a = list[0]!;
  return list.every((x) => Math.abs(x - a) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(x))) ? a : null;
}

interface HandleInfo {
  /** the selected keys that have a handle on that side */
  refs: KeyRef[];
  influence: number | null;
  speed: number | null;
}

/** the effective handle on one side of each selected key: a named part shows its twin. mixed is null */
function handleInfo(lines: ReadonlyMap<string, GraphLine>, sel: readonly KeyRef[], side: HandleSide): HandleInfo {
  const refs: KeyRef[] = [];
  const inf: number[] = [];
  const spd: number[] = [];
  for (const r of sel) {
    const line = lines.get(laneId(r.clipId, r.prop));
    if (!line) continue;
    const i = refIndex(line.clip, r);
    const keys = line.keys;
    if (i < 0) continue;
    const ph = side === 'out' ? (i < keys.length - 1 ? partHandles(keys[i]!, keys[i + 1]!) : null) : i > 0 ? partHandles(keys[i - 1]!, keys[i]!) : null;
    if (!ph) continue;
    const h = side === 'out' ? ph.out : ph.in;
    refs.push(r);
    inf.push(h.influence * 100);
    spd.push(h.speed * line.feel.scale);
  }
  return { refs, influence: same(inf), speed: same(spd) };
}

export function GraphBar({ lines }: GraphBarProps) {
  const project = useEditor((s) => s.project);
  const keySel = useUi((s) => s.keySel);
  const kind = useGraph((s) => s.kind);
  const autoFit = useGraph((s) => s.autoFit);
  const activeId = useGraph((s) => s.active);
  const ctx = useFeelCtx();
  const edit = useRef<{ base: Project; refs: KeyRef[]; shown: number | null; sel: KeyRef[] } | null>(null);

  const sel = project ? liveKeySel(project, keySel) : [];
  const byId = new Map(lines.map((l) => [l.id, l]));
  const firstSel = sel.find((r) => byId.has(laneId(r.clipId, r.prop)));
  const line = byId.get(activeId ?? '') ?? (firstSel ? byId.get(laneId(firstSel.clipId, firstSel.prop)) : undefined);
  const mine = line ? sel.filter((r) => laneId(r.clipId, r.prop) === line.id) : [];

  const snap = reasonSnapshot();
  const easyOff = reasonFor('key-easy-ease', snap);
  const intoOff = reasonFor('key-ease-into', snap);
  const outOfOff = reasonFor('key-ease-out-of', snap);
  const joinOff = reasonFor('keys-join-handles', snap);

  // ----- value -----
  const scale = line?.feel.scale ?? 1;
  const valueFeel = line ? line.feel : resolveFeel({ unit: '', soft: null, step: 0.01 }, ctx);
  const shownValue = (() => {
    if (!line || mine.length === 0) return null;
    const vs: number[] = [];
    for (const r of mine) {
      const i = refIndex(line.clip, r);
      if (i >= 0) vs.push(line.keys[i]!.v * scale);
    }
    const v = same(vs);
    return v === null ? null : roundShown(v, valueFeel.precision);
  })();
  const valueOff = mine.length === 0 ? REASON_TEXT.selectKeys : false;
  const onValueStart = () => {
    beginEdit();
    const p = useEditor.getState().project;
    if (p) edit.current = { base: p, refs: mine, shown: shownValue, sel: liveKeySel(p, useUi.getState().keySel) };
  };
  const onValue = (v: number, source: SliderSource) => {
    const e = edit.current;
    const live = useEditor.getState().project;
    if (!e || !live) return;
    // typing and the reset set the value. a drag adds the move to the keys as they were. an arrow adds one step to them as they are
    const plan =
      source === 'type' || source === 'reset'
        ? planKeyValue(e.base, e.refs, { set: v / scale })
        : source === 'key'
          ? planKeyValue(live, e.refs, { add: (v - (shownValue ?? 0)) / scale })
          : planKeyValue(e.base, e.refs, { add: (v - (e.shown ?? 0)) / scale });
    if (plan.writes.length > 0) applyKeyPlan({ ...plan, sel: e.sel }, liveOpts());
  };

  // ----- handles -----
  // influence is a share, so it spans every selected line. speed has the unit of one line: only the active line's keys
  const ins = handleInfo(byId, sel, 'in');
  const outs = handleInfo(byId, sel, 'out');
  const insSpeed = handleInfo(byId, mine, 'in');
  const outsSpeed = handleInfo(byId, mine, 'out');
  const unit = line ? line.feel.unit : '';
  const speedFeel = resolveFeel({ unit: `${unit}/s`, soft: null, step: Math.max(valueFeel.step, 0.01) * 10, precision: 1, perPx: Math.max(valueFeel.step, 0.01) * 2, rest: 0 }, ctx);
  const influenceFeel = resolveFeel(INFLUENCE, ctx);
  const onHandleStart = (info: HandleInfo, shown: number | null) => () => {
    beginEdit();
    const p = useEditor.getState().project;
    if (p) edit.current = { base: p, refs: info.refs, shown, sel: liveKeySel(p, useUi.getState().keySel) };
  };
  const onHandle = (side: HandleSide, field: 'influence' | 'speed') => (v: number) => {
    const e = edit.current;
    if (!e) return;
    const change = field === 'influence' ? { influence: v / 100 } : { speed: v / scale };
    const plan = planHandleSet(e.base, e.refs, side, change, true);
    if (plan.writes.length > 0) applyKeyPlan({ ...plan, sel: e.sel }, liveOpts());
  };

  const handleBox = (side: HandleSide, info: HandleInfo, sp: HandleInfo) => {
    const off = info.refs.length === 0 ? REASON_TEXT.noHandles : false;
    const speedOff = sp.refs.length === 0 ? REASON_TEXT.noHandles : false;
    const word = side === 'in' ? 'into' : 'out of';
    return (
      <div className="graph-bar-group" key={side}>
        <span className="graph-bar-label">{side}</span>
        <div className="graph-bar-box" {...tip('influence', { does: 'how far the handle reaches toward the neighbour keyframe. more makes the slow part last longer', off })}>
          <SliderField
            value={info.influence === null ? null : roundShown(info.influence, 1)}
            onChange={onHandle(side, 'influence')}
            onStart={onHandleStart(info, info.influence)}
            onEnd={endEdit}
            onCancel={cancelEdit}
            min={influenceFeel.min}
            max={influenceFeel.max}
            soft={influenceFeel.soft}
            step={influenceFeel.step}
            precision={influenceFeel.precision}
            snap={influenceFeel.snap}
            perPx={influenceFeel.perPx}
            rest={influenceFeel.rest}
            mixedFrom={33.3}
            suffix={influenceFeel.unit}
            disabled={off !== false}
            ariaLabel={`influence ${word} the selected keyframes`}
          />
        </div>
        <div className="graph-bar-box" {...tip('speed', { does: 'how fast the value changes right at the keyframe, per second. 0 makes it stop there', off: speedOff })}>
          <SliderField
            value={sp.speed === null ? null : roundShown(sp.speed, speedFeel.precision)}
            onChange={onHandle(side, 'speed')}
            onStart={onHandleStart(sp, sp.speed)}
            onEnd={endEdit}
            onCancel={cancelEdit}
            min={speedFeel.min}
            max={speedFeel.max}
            soft={speedFeel.soft}
            step={speedFeel.step}
            precision={speedFeel.precision}
            snap={speedFeel.snap}
            perPx={speedFeel.perPx}
            rest={speedFeel.rest}
            mixedFrom={0}
            suffix={speedFeel.unit}
            disabled={speedOff !== false}
            ariaLabel={`speed ${word} the selected keyframes`}
          />
        </div>
      </div>
    );
  };

  const onKindKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    useGraph.getState().setKind(kind === 'value' ? 'speed' : 'value');
  };

  return (
    <div className="graph-bar">
      <div className="graph-kind" role="radiogroup" aria-label="graph kind" onKeyDown={onKindKey}>
        <button
          type="button"
          role="radio"
          aria-checked={kind === 'value'}
          tabIndex={kind === 'value' ? 0 : -1}
          className={`graph-kind-btn${kind === 'value' ? ' is-active' : ''}`}
          {...tip('value graph', { does: 'the height of a line is the value. steep means fast, flat means still' })}
          onClick={() => useGraph.getState().setKind('value')}
        >
          value
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={kind === 'speed'}
          tabIndex={kind === 'speed' ? 0 : -1}
          className={`graph-kind-btn${kind === 'speed' ? ' is-active' : ''}`}
          {...tip('speed graph', { does: 'the height of a line is how fast the value changes, per second. 0 means still, a jump is a sudden change of speed' })}
          onClick={() => useGraph.getState().setKind('speed')}
        >
          speed
        </button>
      </div>
      <span className="graph-bar-sep" />
      <div className="graph-bar-group">
        <button type="button" className="icon-btn icon-btn-sm" aria-label="fit all" {...tip('fit all', { does: 'show every line and the whole of the selected clips. turns auto fit on' })} onClick={fitGraphAll}>
          <Maximize2 size={14} />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="fit selected" {...tip('fit selected', { does: 'zoom to the selected keyframes, in time and value', keys: 'key-graph-keys' })} onClick={fitGraphSelected}>
          <Focus size={14} />
        </button>
        <button
          type="button"
          className={`icon-btn icon-btn-sm graph-bar-btn${autoFit ? ' is-active' : ''}`}
          aria-label="auto fit"
          aria-pressed={autoFit}
          {...tip('auto fit', { does: 'keep every shown line inside the panel height while you work', on: autoFit })}
          onClick={toggleAutoFit}
        >
          <Magnet size={14} />
        </button>
      </div>
      <span className="graph-bar-sep" />
      <div className="graph-bar-group">
        <button type="button" className="icon-btn icon-btn-sm" aria-label="easy ease" disabled={easyOff !== null} {...tip('easy ease', { does: 'the value slows down into and out of the selected keyframes', keys: 'key-easy-ease', off: easyOff })} onClick={() => easeKeysNow('easy')}>
          <Spline size={14} />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="ease into" disabled={intoOff !== null} {...tip('ease into', { does: 'the value slows down as it arrives at the selected keyframes', keys: 'key-ease-into', off: intoOff })} onClick={() => easeKeysNow('into')}>
          <ArrowRightToLine size={14} />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="ease out of" disabled={outOfOff !== null} {...tip('ease out of', { does: 'the value starts slowly as it leaves the selected keyframes', keys: 'key-ease-out-of', off: outOfOff })} onClick={() => easeKeysNow('outOf')}>
          <ArrowLeftToLine size={14} />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="join handles" disabled={joinOff !== null} {...tip('join handles', { does: 'the same speed on both sides of the selected keyframes, so the value passes them smoothly', off: joinOff })} onClick={joinHandlesNow}>
          <Link2 size={14} />
        </button>
      </div>
      <span className="graph-bar-sep" />
      <div className="graph-bar-group">
        <span className="graph-bar-label">value</span>
        <div className="graph-bar-box" {...tip('value', { does: 'the value of the selected keyframes of the active line. drag to move them together, type to set them', off: valueOff })}>
          <SliderField
            value={shownValue}
            onChange={onValue}
            onStart={onValueStart}
            onEnd={endEdit}
            onCancel={cancelEdit}
            min={valueFeel.min}
            max={valueFeel.max}
            soft={valueFeel.soft}
            step={valueFeel.step}
            precision={valueFeel.precision}
            snap={valueFeel.snap}
            perPx={valueFeel.perPx}
            origin={valueFeel.origin}
            rest={valueFeel.rest}
            mixedFrom={0}
            suffix={valueFeel.unit || undefined}
            disabled={valueOff !== false}
            ariaLabel="value of the selected keyframes"
          />
        </div>
      </div>
      {handleBox('in', ins, insSpeed)}
      {handleBox('out', outs, outsSpeed)}
    </div>
  );
}
