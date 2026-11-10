import { hasKeyedPose } from '../../engine/parent';
import { canBeParent, indexClips, wouldCycleAny } from '../../lib/links';
import type { Clip, Project } from '../../types';
import { isVisualClip } from '../../types';

export interface ParentOption {
  id: string;
  label: string;
  /** the option is on screen at the same time as the clip(s) */
  overlaps: boolean;
}

const MAX_LABEL = 24;

function baseName(c: Clip): string {
  if (c.type === 'text') {
    const line = c.text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
    if (line) return line.length > MAX_LABEL ? `${line.slice(0, MAX_LABEL - 1)}...` : line;
  }
  return c.name.trim() || c.type;
}

/**
 * the clips the given clips can be attached to: visual clips and cameras, never one of the clips
 * themselves and never one that would make a loop. clips that overlap any of them in time come first.
 * labels are the clip name, plus the type when two names are the same, plus a number if that still repeats.
 */
export function parentOptions(project: Pick<Project, 'clips'>, ids: readonly string[]): ParentOption[] {
  const want = new Set(ids);
  const from = project.clips.filter((c) => want.has(c.id) && isVisualClip(c));
  if (from.length === 0) return [];
  // one id index and one short chain walk per candidate instead of a linear find per selected clip and hop
  const index = indexClips(project.clips);
  const cands = project.clips.filter((c) => canBeParent(c) && !want.has(c.id) && !wouldCycleAny(index, want, c.id));
  return labelOptions(cands, from);
}

/**
 * the clips a 3d clip can face ("look at a clip"): visual clips and cameras except the clip itself.
 * a loop does not matter here (facing a clip never moves it). same labels and order as parentOptions.
 */
export function lookTargetOptions(project: Pick<Project, 'clips'>, id: string): ParentOption[] {
  const from = project.clips.filter((c) => c.id === id && isVisualClip(c));
  if (from.length === 0) return [];
  return labelOptions(
    project.clips.filter((c) => canBeParent(c) && c.id !== id),
    from,
  );
}

/**
 * the clips an effect clip can be put on ("applies to"): visual clips only (no cameras), never the effect itself.
 * clips that overlap the effect in time come first. same labels and order as parentOptions.
 */
export function effectTargetOptions(project: Pick<Project, 'clips'>, effectId: string): ParentOption[] {
  const from = project.clips.filter((c) => c.id === effectId);
  if (from.length === 0) return [];
  return labelOptions(
    project.clips.filter((c) => isVisualClip(c) && c.id !== effectId),
    from,
  );
}

/** labels (name, + type when repeated, + number) and the overlap-first order shared by the clip pickers */
function labelOptions(cands: Clip[], from: Clip[]): ParentOption[] {
  const names = cands.map(baseName);
  const count = new Map<string, number>();
  for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  const typed = cands.map((c, i) => ((count.get(names[i]!) ?? 0) > 1 && names[i] !== c.type ? `${names[i]} (${c.type})` : names[i]!));
  const total = new Map<string, number>();
  for (const l of typed) total.set(l, (total.get(l) ?? 0) + 1);
  const seen = new Map<string, number>();
  const overlapsAny = overlapTest(from);
  const all = cands.map((c, i): ParentOption => {
    const l = typed[i]!;
    let label = l;
    if ((total.get(l) ?? 0) > 1) {
      const n = (seen.get(l) ?? 0) + 1;
      seen.set(l, n);
      label = `${l} ${n}`;
    }
    const overlaps = overlapsAny(c);
    return { id: c.id, label, overlaps };
  });
  return [...all.filter((o) => o.overlaps), ...all.filter((o) => !o.overlaps)];
}

/** true when an animated x / y / scale / rotation exists (those keys are left alone when attaching) */
export function hasAnimatedPose(clip: Clip): boolean {
  return hasKeyedPose(clip);
}

/**
 * (c) => does c overlap any of the clips in time, exactly `from.some(f => f.start < c.end && c.start < f.end)`.
 * a few clips are tested one by one, many through their starts sorted with the running max of their ends.
 */
export function overlapTest(from: readonly Clip[]): (c: Clip) => boolean {
  const naive = (c: Clip) => from.some((f) => f.start < c.start + c.duration && c.start < f.start + f.duration);
  if (from.length <= 8) return naive;
  const sorted = [...from];
  for (const f of sorted) if (!Number.isFinite(f.start) || !Number.isFinite(f.start + f.duration)) return naive;
  sorted.sort((a, b) => a.start - b.start);
  const maxEnd: number[] = [];
  let m = -Infinity;
  for (const f of sorted) {
    m = Math.max(m, f.start + f.duration);
    maxEnd.push(m);
  }
  return (c) => {
    const end = c.start + c.duration;
    if (Number.isNaN(end) || Number.isNaN(c.start)) return naive(c);
    // how many clips start before the end of c
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.start < end) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && c.start < maxEnd[lo - 1]!;
  };
}
