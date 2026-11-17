/**
 * the rows of the keyframe panel: pure, no react, no dom. one clip row per shown clip (its keys merged), then one value row
 * per keyed value the clip can animate. a value is a line of the clip's keyframes record.
 */
import { animProps } from '../../lib/anim';
import { getEffect } from '../../engine/effects/registry';
import type { KeyRef } from '../../store/ui';
import type { Clip, Keyframe, Project } from '../../types';
import { clipDisplayName } from './effectTarget';
import { KEY_HIT_PX, KEY_MERGE_PX, hitKeyAt } from './keyGeometry';
import { KEY_REF_EPS } from './keySelection';

export const CLIP_ROW_H = 22;
export const VALUE_ROW_H = 18;

/** one value of a clip row: its whole key list */
export interface LaneValue { prop: string; keys: readonly Keyframe[] }

export interface LaneRow {
  kind: 'clip' | 'value';
  clipId: string;
  /** null on a clip row */
  prop: string | null;
  label: string;
  /** top of the row, px from the top of the rows */
  y: number;
  h: number;
  /** the clip's start and length, timeline seconds */
  start: number;
  duration: number;
  /** a value row: the whole list (shapes need the neighbours). a clip row: empty */
  keys: readonly Keyframe[];
  /** a value row: its inside keys are keys[from] .. keys[to - 1] */
  from: number;
  to: number;
  /** clip-local seconds, ascending. a value row: its inside times. a clip row: the union of its values' inside times, equal ones (KEY_REF_EPS) once */
  times: readonly number[];
  /** it has keys and none of them inside the clip */
  outside: boolean;
  folded: boolean;
  /** a clip row: every keyed value, folded or not */
  values?: LaneValue[];
}

/** the values of a clip that have keys and that the clip can animate: its animProps in their order, then `p.<key>` of an effect clip in its params order */
export function keyedValues(clip: Clip): { prop: string; label: string }[] {
  const kf = clip.keyframes;
  const out: { prop: string; label: string }[] = [];
  if (!kf) return out;
  for (const a of animProps(clip)) if ((kf[a.prop]?.length ?? 0) > 0) out.push({ prop: a.prop, label: a.label });
  if (clip.type === 'effect') {
    const def = getEffect(clip.effect);
    if (def) {
      for (const q of def.params) {
        const prop = `p.${q.key}`;
        if ((kf[prop]?.length ?? 0) > 0 && !out.some((o) => o.prop === prop)) out.push({ prop, label: q.label });
      }
    }
  }
  return out;
}

/** the inside range of a sorted key list: [from, to) with t in [-KEY_REF_EPS, duration + KEY_REF_EPS] */
function insideRange(keys: readonly Keyframe[], duration: number): [number, number] {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.t < -KEY_REF_EPS) lo = mid + 1;
    else hi = mid;
  }
  const from = lo;
  hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.t <= duration + KEY_REF_EPS) lo = mid + 1;
    else hi = mid;
  }
  return [from, lo];
}

function build(clips: readonly Clip[], folded: ReadonlySet<string>): LaneRow[] {
  const rows: LaneRow[] = [];
  let y = 0;
  for (const clip of clips) {
    const isFolded = folded.has(clip.id);
    const defs = keyedValues(clip);
    const values: LaneValue[] = [];
    const valueRows: LaneRow[] = [];
    const all: number[] = [];
    for (const d of defs) {
      const keys = clip.keyframes![d.prop]!;
      values.push({ prop: d.prop, keys });
      const [from, to] = insideRange(keys, clip.duration);
      const times: number[] = [];
      for (let i = from; i < to; i++) {
        times.push(keys[i]!.t);
        all.push(keys[i]!.t);
      }
      valueRows.push({
        kind: 'value',
        clipId: clip.id,
        prop: d.prop,
        label: d.label,
        y: 0,
        h: VALUE_ROW_H,
        start: clip.start,
        duration: clip.duration,
        keys,
        from,
        to,
        times,
        outside: keys.length > 0 && from === to,
        folded: false,
      });
    }
    all.sort((a, b) => a - b);
    const merged: number[] = [];
    for (const t of all) if (merged.length === 0 || t - merged[merged.length - 1]! > KEY_REF_EPS) merged.push(t);
    rows.push({
      kind: 'clip',
      clipId: clip.id,
      prop: null,
      label: clipDisplayName(clip),
      y,
      h: CLIP_ROW_H,
      start: clip.start,
      duration: clip.duration,
      keys: [],
      from: 0,
      to: 0,
      times: merged,
      outside: values.length > 0 && merged.length === 0,
      folded: isFolded,
      values,
    });
    y += CLIP_ROW_H;
    if (!isFolded) {
      for (const r of valueRows) {
        r.y = y;
        y += VALUE_ROW_H;
        rows.push(r);
      }
    }
  }
  return rows;
}

let memo: { clips: readonly Clip[]; list: readonly Clip[]; folded: ReadonlySet<string>; rows: LaneRow[] } | null = null;

/** the rows of the clips, top to bottom, y from 0. memoized on the project's clips, the shown clips and the folds */
export function buildLaneRows(p: Project, clips: readonly Clip[], folded: ReadonlySet<string>): LaneRow[] {
  if (memo && memo.clips === p.clips && memo.folded === folded && memo.list.length === clips.length && memo.list.every((c, i) => c === clips[i])) return memo.rows;
  const rows = build(clips, folded);
  memo = { clips: p.clips, list: [...clips], folded, rows };
  return rows;
}

/** the rows [first, end) that meet the view from scrollTop, height tall */
export function visibleRows(rows: readonly LaneRow[], scrollTop: number, height: number): [number, number] {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = rows[mid]!;
    if (r.y + r.h <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  const first = lo;
  hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.y < scrollTop + height) lo = mid + 1;
    else hi = mid;
  }
  return [first, Math.max(first, lo)];
}

/** the row at y (px from the top of the rows), or -1 */
export function rowAt(rows: readonly LaneRow[], y: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = rows[mid]!;
    if (r.y + r.h <= y) lo = mid + 1;
    else hi = mid;
  }
  const r = rows[lo];
  return r && y >= r.y && y < r.y + r.h ? lo : -1;
}

/** x of a clip-local time in a row: exact, a key at 0 sits on the clip start */
export function laneKeyX(row: LaneRow, t: number, zoom: number, scrollLeft: number): number {
  return (row.start + t) * zoom - scrollLeft;
}

/** the index range [lo, hi) of the row's times that can show in x from -margin to width + margin */
export function visibleTimes(row: LaneRow, zoom: number, scrollLeft: number, width: number, margin = 64): [number, number] {
  const t = row.times;
  const left = (scrollLeft - margin) / zoom - row.start;
  const right = (scrollLeft + width + margin) / zoom - row.start;
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! < left) lo = mid + 1;
    else hi = mid;
  }
  const a = lo;
  hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! <= right) lo = mid + 1;
    else hi = mid;
  }
  return [a, lo];
}

/** the inside keys of a value at the given clip-local times (within KEY_REF_EPS), as refs */
function refsAt(clipId: string, prop: string, keys: readonly Keyframe[], duration: number, at: readonly number[]): KeyRef[] {
  const [from, to] = insideRange(keys, duration);
  const out: KeyRef[] = [];
  for (let i = from; i < to; i++) {
    const t = keys[i]!.t;
    if (at.some((a) => Math.abs(a - t) <= KEY_REF_EPS)) out.push({ clipId, prop, t });
  }
  return out;
}

/** the keys under a press at x on row i: the nearest within KEY_HIT_PX and every key within KEY_MERGE_PX of its x. a clip row gives each value's keys at those times */
export function hitLane(rows: readonly LaneRow[], i: number, x: number, zoom: number, scrollLeft: number): KeyRef[] {
  const row = rows[i];
  if (!row) return [];
  const px = (t: number) => laneKeyX(row, t, zoom, scrollLeft);
  const j = hitKeyAt(row.times, px, x, KEY_HIT_PX);
  if (j < 0) return [];
  const cx = px(row.times[j]!);
  const near: number[] = [];
  for (let k = j; k >= 0 && Math.abs(px(row.times[k]!) - cx) < KEY_MERGE_PX; k--) near.unshift(row.times[k]!);
  for (let k = j + 1; k < row.times.length && Math.abs(px(row.times[k]!) - cx) < KEY_MERGE_PX; k++) near.push(row.times[k]!);
  if (row.kind === 'value') return near.map((t) => ({ clipId: row.clipId, prop: row.prop!, t }));
  const out: KeyRef[] = [];
  for (const v of row.values ?? []) out.push(...refsAt(row.clipId, v.prop, v.keys, row.duration, near));
  return out;
}

/** the keys of the rows whose middle is inside the box (y in row space) and whose x is inside it */
export function keysInBox(rows: readonly LaneRow[], box: { x0: number; x1: number; y0: number; y1: number }, zoom: number, scrollLeft: number): KeyRef[] {
  const x0 = Math.min(box.x0, box.x1);
  const x1 = Math.max(box.x0, box.x1);
  const y0 = Math.min(box.y0, box.y1);
  const y1 = Math.max(box.y0, box.y1);
  const out: KeyRef[] = [];
  const seen = new Set<string>();
  const add = (clipId: string, prop: string, t: number) => {
    const id = `${clipId}\u0000${prop}\u0000${Math.round(t / KEY_REF_EPS)}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ clipId, prop, t });
  };
  for (const row of rows) {
    const mid = row.y + row.h / 2;
    if (mid < y0 || mid > y1) continue;
    if (row.kind === 'value') {
      for (let k = row.from; k < row.to; k++) {
        const t = row.keys[k]!.t;
        const x = laneKeyX(row, t, zoom, scrollLeft);
        if (x >= x0 && x <= x1) add(row.clipId, row.prop!, t);
      }
    } else {
      for (const v of row.values ?? []) {
        const [from, to] = insideRange(v.keys, row.duration);
        for (let k = from; k < to; k++) {
          const t = v.keys[k]!.t;
          const x = laneKeyX(row, t, zoom, scrollLeft);
          if (x >= x0 && x <= x1) add(row.clipId, v.prop, t);
        }
      }
    }
  }
  return out;
}

/** every inside key of a row as refs: a value row its own, a clip row all of its values' */
export function rowKeyRefs(row: LaneRow): KeyRef[] {
  const out: KeyRef[] = [];
  if (row.kind === 'value') {
    for (let k = row.from; k < row.to; k++) out.push({ clipId: row.clipId, prop: row.prop!, t: row.keys[k]!.t });
    return out;
  }
  for (const v of row.values ?? []) {
    const [from, to] = insideRange(v.keys, row.duration);
    for (let k = from; k < to; k++) out.push({ clipId: row.clipId, prop: v.prop, t: v.keys[k]!.t });
  }
  return out;
}

/** does the sorted key list have a key at t, within KEY_REF_EPS */
export function hasKeyAt(keys: readonly Keyframe[], t: number): boolean {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.t < t - KEY_REF_EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo < keys.length && Math.abs(keys[lo]!.t - t) <= KEY_REF_EPS;
}
