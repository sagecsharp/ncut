import { animProps } from '../../lib/anim';
import { GRADE_EFFECT } from '../../lib/gradeData';
import { getEffect } from '../../engine/effects/registry';
import type { Clip, ClipType } from '../../types';
import { DEFAULT_FEEL_CTX, FEEL, effectFeel, resolveFeel } from './fieldFeel';
import type { Feel, FeelCtx, FeelEntry } from './fieldFeel';

interface Row { types: readonly ClipType[]; entry: FeelEntry }

/** the FEEL rows that edit an animated value, by the value's name. built once */
let rows: Map<string, Row[]> | null = null;
function byProp(): Map<string, Row[]> {
  if (rows) return rows;
  rows = new Map();
  for (const entry of Object.values(FEEL) as FeelEntry[]) {
    if (!entry.anim) continue;
    const list = rows.get(entry.anim.prop);
    const row = { types: entry.anim.types, entry };
    if (list) list.push(row);
    else rows.set(entry.anim.prop, [row]);
  }
  return rows;
}

/** the feel of one animated value: the FEEL row of that value for this clip type, a grade effect clip's wheel numbers like the grade section shows them, an effect param by its def, else the animProps range */
export function feelForProp(prop: string, clip: Clip, ctx: FeelCtx = DEFAULT_FEEL_CTX): Feel {
  const list = byProp().get(prop);
  const row = list?.find((r) => r.types.includes(clip.type));
  if (row) return resolveFeel(row.entry, ctx);
  if (clip.type === 'effect') {
    if (prop.startsWith('grade.') && clip.effect === GRADE_EFFECT && list && list.length > 0) return resolveFeel(list[0]!.entry, ctx);
    if (prop.startsWith('p.')) {
      const param = getEffect(clip.effect)?.params.find((q) => q.key === prop.slice(2));
      if (param) return resolveFeel(effectFeel(param), ctx);
    }
  }
  const info = animProps(clip).find((a) => a.prop === prop);
  return resolveFeel({ unit: info?.unit ?? '', min: info?.min, max: info?.max, soft: null, step: 0.01 }, ctx);
}
