import { useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SliderSource } from '../../components/ui/SliderField';
import { roundShown } from '../../components/ui/numberFormat';
import type { Span } from '../../components/ui/sliderMath';
import { valueAt } from '../../lib/anim';
import { clamp } from '../../lib/time';
import { useEditor, type ClipValueEdit } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import type { Clip } from '../../types';
import { FeelField, Row } from './controls';
import { beginEdit, liveOpts } from './edit';
import { useFeelCtx } from './feelContext';
import { FEEL, resolveFeel, type FeelKey } from './fieldFeel';
import { deltaText, multiValue, sharedShown, type MultiMode } from './multiEdit';
import { offsetTargets } from './selectionSets';

interface MultiFieldProps {
  /** the selection as a set (MultiControls builds it once) */
  want: ReadonlySet<string>;
  label: string;
  title: string;
  feel: FeelKey;
  /** an anim prop ('x', 'opacity', 'volume', 'amount' ...) or a plain clip field ('fadeIn', 'fadeOut') */
  prop: string;
  pick(c: Clip): boolean;
  /** default 'add' */
  mode?: MultiMode;
  /** only the field, for a Pair (label = the inner label) */
  bare?: boolean;
  wide?: boolean;
  /** fades: [0, min(shortest, 5)] */
  soft?: Span;
}

const MIXED_ADD = 'the clips differ: a drag moves each one by the same amount, a typed number sets them all';
const MIXED_TIMES = 'the clips differ: a drag scales each one by the same factor, a typed number sets them all';

/** the selected clips that pass `pick`, in project order. a store selector can return it (useShallow) */
function pickTargets(clips: readonly Clip[] | undefined, want: ReadonlySet<string>, pick: (c: Clip) => boolean): Clip[] {
  const out: Clip[] = [];
  if (!clips) return out;
  for (const c of clips) if (want.has(c.id) && pick(c)) out.push(c);
  return out;
}

type FadeProp = 'fadeIn' | 'fadeOut';
const isFade = (prop: string): prop is FadeProp => prop === 'fadeIn' || prop === 'fadeOut';

/** the stored value of a clip for the field, at a timeline time */
function storedOf(c: Clip, prop: string, time: number): number {
  if (isFade(prop)) return c[prop] || 0;
  return valueAt(c, prop, clamp(time, c.start, c.start + c.duration)) ?? 0;
}

/** one field for many clips: a shared value or "mixed", a drag moves each clip by the same amount (or factor) */
export function MultiField(p: MultiFieldProps) {
  const { want, label, title, prop, pick, bare, wide } = p;
  const mode = p.mode ?? 'add';
  const ctx = useFeelCtx();
  const feel = resolveFeel(FEEL[p.feel], ctx, p.soft ? { soft: p.soft } : undefined);
  const { scale, precision, unit } = feel;
  const fade = isFade(prop);

  const targets = useEditor(useShallow((s) => pickTargets(s.project?.clips, want, pick)));
  const anyKeyed = !fade && targets.some((c) => (c.keyframes?.[prop]?.length ?? 0) > 0);
  const staticShared = useMemo(
    () => sharedShown(targets.map((c) => roundShown(storedOf(c, prop, c.start) * scale, precision)), precision),
    [targets, prop, scale, precision],
  );
  // a selection without keys does no work per frame: the selector returns the memoized constant
  const shared = usePlayback((s) =>
    anyKeyed ? sharedShown(targets.map((c) => roundShown(storedOf(c, prop, s.time) * scale, precision)), precision) : staticShared,
  );

  const mixedFrom = mode === 'times' ? 100 : 0;
  const t0 = useRef(0);
  const from = useRef(0);
  const starts = useRef(new Map<string, number>());
  const [dragV, setDragV] = useState<number | null>(null);

  const mixed = shared === null;
  const press = () => {
    setDragV(null);
    const pb = usePlayback.getState();
    if (anyKeyed && pb.playing) pb.pause();
  };
  const readStarts = (): void => {
    const m = new Map<string, number>();
    for (const c of targets) m.set(c.id, storedOf(c, prop, t0.current));
    starts.current = m;
  };
  const start = () => {
    press();
    t0.current = usePlayback.getState().time;
    from.current = shared ?? mixedFrom;
    readStarts();
    setDragV(null);
    beginEdit();
  };

  const write = (ids: readonly string[], value: (id: string) => number): void => {
    const state = useEditor.getState();
    if (fade) {
      const opts = liveOpts();
      for (const c of targets) {
        if (!ids.includes(c.id)) continue;
        state.updateClip(c.id, { [prop]: clamp(value(c.id), 0, c.duration) }, opts);
      }
      return;
    }
    const edits: ClipValueEdit[] = ids.map((id) => ({ id, prop, time: t0.current, value: value(id) }));
    state.setClipValues(edits, liveOpts());
  };

  const change = (v: number, source: SliderSource): void => {
    const ids = targets.map((c) => c.id);
    if (source === 'type' || source === 'reset') {
      write(ids, () => v / scale);
      return;
    }
    if (source === 'key') {
      // each arrow is one more step from where the clips are now
      from.current = shared ?? mixedFrom;
      readStarts();
    }
    setDragV(v);
    const state = useEditor.getState();
    const moved = fade ? ids : offsetTargets(state.project?.clips, ids, prop);
    write(moved, (id) => multiValue(mode, starts.current.get(id) ?? 0, from.current, v, scale));
  };

  const fieldTitle = mixed ? `${title}\n${mode === 'times' ? MIXED_TIMES : MIXED_ADD}` : title;
  const field = (
    <FeelField
      feel={p.feel}
      soft={p.soft}
      {...(mixed && mode === 'add' ? { min: -Infinity, max: Infinity } : {})}
      value={shared}
      label={bare ? label : undefined}
      ariaLabel={bare ? undefined : label}
      title={fieldTitle}
      mixedFrom={mixedFrom}
      dragText={mixed && dragV !== null ? deltaText(mode, from.current, dragV, precision, unit) : null}
      disabled={targets.length === 0}
      onStart={start}
      onPress={press}
      onChange={(v, source) => change(v, source)}
    />
  );
  if (bare) return field;
  return (
    <Row label={label} title={fieldTitle} wide={wide}>
      {field}
    </Row>
  );
}
