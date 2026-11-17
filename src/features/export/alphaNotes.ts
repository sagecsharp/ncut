/**
 * what keeps a see-through export from being see-through, found in the project before it is made. pure.
 * a sky fills the picture, an effect on the whole picture writes an opaque result, a blend over nothing is drawn as
 * normal. each note is one line for the dialog, the export warnings and the mcp.
 */
import type { Project } from '../../types';
import { isVisualClip } from '../../types';
import { isTargetedEffect } from '../../engine/clipFx';
import { getEffect } from '../../engine/effects/registry';
import { skyUsable } from '../../engine/scene3d/sky';
import { TEXT } from './delivery';
import type { TimeRange } from './range';

export interface AlphaNote { kind: 'sky' | 'effect' | 'blend'; text: string; clipId?: string; at: number }

const hundredth = (n: number): number => Math.round(n * 100) / 100;

/** the notes for the stretch of the timeline an export covers, sorted by time, each text once */
export function alphaNotes(project: Project, range: TimeRange): AlphaNote[] {
  const notes: AlphaNote[] = [];
  if (skyUsable(project)) notes.push({ kind: 'sky', text: TEXT.sky, at: 0 });
  const shown = new Set<string>();
  for (const track of project.tracks) if (track.kind === 'video' && !track.hidden) shown.add(track.id);
  for (const clip of project.clips) {
    if (!shown.has(clip.trackId)) continue;
    const end = clip.start + clip.duration;
    if (!(clip.start < range.end && end > range.start)) continue;
    if (clip.type === 'effect') {
      const def = getEffect(clip.effect);
      if (!def || def.temporal || def.alpha === 'own' || isTargetedEffect(clip)) continue;
      const a = hundredth(Math.max(clip.start, range.start));
      const b = hundredth(Math.min(end, range.end));
      notes.push({ kind: 'effect', text: TEXT.effect(def.name, a, b), clipId: clip.id, at: a });
    } else if (isVisualClip(clip) && clip.blend && clip.blend !== 'normal') {
      notes.push({ kind: 'blend', text: TEXT.blend(clip.name, clip.blend), clipId: clip.id, at: Math.max(clip.start, range.start) });
    }
  }
  notes.sort((x, y) => x.at - y.at);
  const seen = new Set<string>();
  return notes.filter((n) => {
    if (seen.has(n.text)) return false;
    seen.add(n.text);
    return true;
  });
}
