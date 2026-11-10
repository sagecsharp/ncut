import type { Clip, Track } from '../../types';
import { isVisualClip } from '../../types';

export interface TargetOption {
  id: string;
  label: string;
}

const MAX_LABEL = 26;

function baseLabel(c: Clip): string {
  if (c.type === 'text') {
    const line = c.text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
    if (line) return line.length > MAX_LABEL ? `${line.slice(0, MAX_LABEL - 1)}...` : line;
  }
  const name = c.name.trim();
  return name || c.type;
}

/**
 * every visual clip as an option for the camera's "look at". label = name or text; when two clips would
 * read the same the track name is added, and when that still repeats a number is appended.
 */
export function targetOptions(clips: readonly Clip[], tracks: readonly Track[]): TargetOption[] {
  const visual = clips.filter(isVisualClip);
  const trackName = new Map(tracks.map((t) => [t.id, t.name]));
  const trackIndex = new Map(tracks.map((t, i) => [t.id, i]));
  visual.sort((a, b) => (trackIndex.get(a.trackId) ?? 0) - (trackIndex.get(b.trackId) ?? 0) || a.start - b.start);
  const labels = visual.map(baseLabel);
  const count = new Map<string, number>();
  for (const l of labels) count.set(l, (count.get(l) ?? 0) + 1);
  const withTrack = visual.map((c, i) => ((count.get(labels[i]!) ?? 0) > 1 ? `${labels[i]} (${trackName.get(c.trackId) ?? 'track'})` : labels[i]!));
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const l of withTrack) total.set(l, (total.get(l) ?? 0) + 1);
  return visual.map((c, i) => {
    const l = withTrack[i]!;
    if ((total.get(l) ?? 0) <= 1) return { id: c.id, label: l };
    const n = (seen.get(l) ?? 0) + 1;
    seen.set(l, n);
    return { id: c.id, label: `${l} ${n}` };
  });
}
