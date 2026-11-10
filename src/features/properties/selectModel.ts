/**
 * what a clip picker (ParentSelect) shows, as plain data. the open model is the full list (what the
 * select always rendered); the closed model is the one choice that is selected, so a closed select does
 * not mount hundreds of <option>s. both give the selected entry the same value and the same text.
 */
import type { ParentOption } from './parentOptions';

export interface SelectChoice {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface ParentSelectModel {
  /** value of the <select> */
  selected: string;
  /** the entries before the groups: "various", the empty choice, "missing clip" (open), or just the selected one (closed) */
  head: SelectChoice[];
  /** clips on screen at the same time (open only) */
  near: ParentOption[];
  far: ParentOption[];
}

export const MIXED = '__mixed';

/** the label of the option with this id, or null when there is none (the "missing clip" case) */
export function currentLabel(options: readonly ParentOption[], value: string | null): string | null {
  if (!value) return null;
  return options.find((o) => o.id === value)?.label ?? null;
}

/** value: a clip id, '' for nothing, null when the clips differ */
export function openModel(value: string | null, options: readonly ParentOption[], noneLabel: string): ParentSelectModel {
  const known = value === null || value === '' || options.some((o) => o.id === value);
  const head: SelectChoice[] = [];
  if (value === null) head.push({ value: MIXED, label: 'various', disabled: true });
  head.push({ value: '', label: noneLabel });
  if (!known && value !== null) head.push({ value, label: 'missing clip' });
  return {
    selected: value ?? MIXED,
    head,
    near: options.filter((o) => o.overlaps),
    far: options.filter((o) => !o.overlaps),
  };
}

/** current: label of the selected clip (currentLabel of the full list), null when it is not one of the choices */
export function closedModel(value: string | null, current: string | null, noneLabel: string): ParentSelectModel {
  const selected = value ?? MIXED;
  const head: SelectChoice[] =
    value === null
      ? [{ value: MIXED, label: 'various', disabled: true }]
      : value === ''
        ? [{ value: '', label: noneLabel }]
        : [{ value, label: current ?? 'missing clip' }];
  return { selected, head, near: [], far: [] };
}

/** the text a select shows for its selected value (what the person reads) */
export function shownLabel(model: ParentSelectModel): string | null {
  for (const h of model.head) if (h.value === model.selected) return h.label;
  for (const o of [...model.near, ...model.far]) if (o.id === model.selected) return o.label;
  return null;
}
