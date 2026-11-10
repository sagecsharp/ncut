import { memo, useState } from 'react';
import { Route, Trash2 } from 'lucide-react';
import { NumberField } from '../../components/ui/NumberField';
import { useClip } from '../../store/editorStore';
import { isVisualClip } from '../../types';
import { Row, Section } from './controls';
import { applyPath, removePath } from './pathActions';
import { DEFAULT_PATH, MAX_TURNS, MIN_TURNS, PATH_KINDS } from './pathMoves';
import type { PathKind, PathOptions } from './pathMoves';
import './path.css';

/** the choices stay while the app is open, so the next clip starts with the same ones */
let remembered: PathOptions = { ...DEFAULT_PATH };

/**
 * "path": a ready-made motion path for the clip, written as ordinary keyframes on its position so
 * they stay editable. "apply" replaces the position keys (one undo step), "remove" takes them off.
 */
export const PathSection = memo(function PathSection({ id }: { id: string }) {
  const clip = useClip(id);
  const [vals, setVals] = useState<PathOptions>(remembered);
  if (!clip || !isVisualClip(clip)) return null;

  const set = (patch: Partial<PathOptions>) => {
    remembered = { ...remembered, ...patch };
    setVals(remembered);
  };
  const kind = PATH_KINDS.find((k) => k.id === vals.kind) ?? PATH_KINDS[0]!;
  const lapsTitle =
    vals.kind === 'hop'
      ? 'how many hops over the clip'
      : vals.kind === 'swing'
        ? 'how many swings over the clip'
        : vals.kind === 'zigzag'
          ? 'how many zigzags over the clip'
          : 'how many laps over the clip';

  return (
    <Section id="path" title="path" defaultOpen={false}>
      <Row label="kind" title="the shape of the path">
        <select className="select" title="the shape of the path" aria-label="path kind" value={vals.kind} onChange={(e) => set({ kind: e.target.value as PathKind })}>
          {PATH_KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </Row>
      <p className="path-hint">{kind.hint}</p>
      <Row label="size" title="how far the path reaches (px)">
        <NumberField className="props-num path-num" title="how far the path reaches (px)" value={vals.size} min={0} max={5000} step={10} precision={0} suffix="px" onChange={(v) => set({ size: v })} />
      </Row>
      <Row label="laps" title={lapsTitle}>
        <NumberField className="props-num path-num" title={lapsTitle} value={vals.turns} min={MIN_TURNS} max={MAX_TURNS} step={0.25} precision={2} onChange={(v) => set({ turns: v })} />
      </Row>
      <Row label="other way" title="go the other direction">
        <input type="checkbox" className="checkbox" title="go the other direction" checked={vals.reverse} onChange={(e) => set({ reverse: e.target.checked })} />
      </Row>
      <Row label="face ahead" title="turn the clip to face the way it moves (a hop stays as it is)" wide>
        <input type="checkbox" className="checkbox" title="turn the clip to look along the path" checked={vals.face} onChange={(e) => set({ face: e.target.checked })} />
      </Row>
      <div className="path-btns">
        <button type="button" className="btn btn-primary" title="write the path as keyframes on the position. replaces the keys it uses. one undo step." onClick={() => applyPath(id, vals)}>
          <Route size={14} />
          <span>apply</span>
        </button>
        <button type="button" className="btn" title="clear the x / y / z keys, the clip stays where it starts. the turning keys of 'face ahead' are left in place." onClick={() => removePath(id)}>
          <Trash2 size={14} />
          <span>remove</span>
        </button>
      </div>
    </Section>
  );
});
