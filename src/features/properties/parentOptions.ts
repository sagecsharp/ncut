import { canBeParent, wouldCycle } from '../../lib/links';
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
  const from = project.clips.filter((c) => ids.includes(c.id) && isVisualClip(c));
  if (from.length === 0) return [];
  const cands = project.clips.filter(
    (c) => canBeParent(c) && !ids.includes(c.id) && !ids.some((id) => wouldCycle(project, id, c.id)),
  );
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

/** labels (name, + type when repeated, + number) and the overlap-first order shared by the clip pickers */
function labelOptions(cands: Clip[], from: Clip[]): ParentOption[] {
  const names = cands.map(baseName);
  const count = new Map<string, number>();
  for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  const typed = cands.map((c, i) => ((count.get(names[i]!) ?? 0) > 1 && names[i] !== c.type ? `${names[i]} (${c.type})` : names[i]!));
  const total = new Map<string, number>();
  for (const l of typed) total.set(l, (total.get(l) ?? 0) + 1);
  const seen = new Map<string, number>();
  const all = cands.map((c, i): ParentOption => {
    const l = typed[i]!;
    let label = l;
    if ((total.get(l) ?? 0) > 1) {
      const n = (seen.get(l) ?? 0) + 1;
      seen.set(l, n);
      label = `${l} ${n}`;
    }
    const overlaps = from.some((f) => f.start < c.start + c.duration && c.start < f.start + f.duration);
    return { id: c.id, label, overlaps };
  });
  return [...all.filter((o) => o.overlaps), ...all.filter((o) => !o.overlaps)];
}

/** true when an animated x / y / scale / rotation exists (those keys are left alone when attaching) */
export function hasAnimatedPose(clip: Clip): boolean {
  const kf = clip.keyframes;
  if (!kf) return false;
  return ['x', 'y', 'scale', 'rotation'].some((p) => (kf[p]?.length ?? 0) > 0);
}
