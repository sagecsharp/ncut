export interface MotionListItem {
  id: string;
  name: string;
  threeD?: boolean;
}

/**
 * the motions a menu offers: 3d-only ones are hidden for a 2d clip, unless the clip already has that
 * one stored (so the select is never blank).
 */
export function visibleMotions<T extends MotionListItem>(list: readonly T[], threeD: boolean, currentId: string | undefined): T[] {
  if (threeD) return list as T[];
  return list.filter((m) => !m.threeD || m.id === currentId);
}
