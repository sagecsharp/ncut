/** the part of editorStore.select that decides which of the asked ids can be selected */
import type { Project } from '../types';

/**
 * the ids that name a clip of the project on a track that is not locked, in the order asked (an id asked twice
 * stays twice, an unknown id is dropped). one lookup table per call instead of a scan of the clips for every id.
 * where a clip id (or a track id) is there more than once the first one counts, like Array.find.
 */
export function selectableIds(project: Pick<Project, 'clips' | 'tracks'>, ids: readonly string[]): string[] {
  const trackOf = new Map<string, string>();
  for (const c of project.clips) if (!trackOf.has(c.id)) trackOf.set(c.id, c.trackId);
  const locked = new Map<string, boolean>();
  for (const t of project.tracks) if (!locked.has(t.id)) locked.set(t.id, t.locked ?? false);
  const out: string[] = [];
  for (const id of ids) {
    const trackId = trackOf.get(id);
    if (trackId === undefined) continue;
    if (!(locked.get(trackId) ?? false)) out.push(id);
  }
  return out;
}
